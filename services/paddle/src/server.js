import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/paddle — a dependency-free fake of the Paddle Billing API.
//   /products, /prices, /customers, /transactions, /subscriptions
// Bearer auth. JSON request/response. Responses follow Paddle's envelope:
//   single  -> { data: {...}, meta: { request_id } }
//   list    -> { data: [...], meta: { request_id, pagination: {...} } }
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pid(prefix) {
  return `${prefix}_${randomBytes(13).toString("hex").slice(0, 24)}`;
}

function requestId() {
  return randomBytes(8).toString("hex");
}

function paddleError(code, detail, type = "request_error", status = 400) {
  return {
    error: {
      type,
      code,
      detail,
      documentation_url: "https://developer.paddle.com/",
    },
    meta: { request_id: requestId() },
  };
}

const RESOURCES = {
  products: "pro",
  prices: "pri",
  customers: "ctm",
  transactions: "txn",
  subscriptions: "sub",
};

export class PaddleServer {
  constructor(port = 4765, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.stores = {
      products: new Map(),
      prices: new Map(),
      customers: new Map(),
      transactions: new Map(),
      subscriptions: new Map(),
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, paddleError("internal_error", error.message || "Internal server error", "api_error", 500));
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Paddle-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-paddle");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    const resourceKey = parts[0];
    const meta = RESOURCES[resourceKey];
    if (!meta) return this.send(res, 404, paddleError("not_found", "Entity not found", "request_error", 404));

    if (!this.isAuthorized(req)) {
      return this.send(res, 403, paddleError("authentication_missing", "Authentication header is missing", "request_error", 403));
    }

    return this.handleResource(req, res, resourceKey, meta, parts, body);
  }

  handleResource(req, res, resourceKey, prefix, parts, body) {
    const store = this.stores[resourceKey];

    if (parts.length === 1) {
      if (req.method === "POST") {
        const id = pid(prefix);
        const record = {
          id,
          ...(isPlainObject(body) ? clone(body) : {}),
          status: body && body.status ? body.status : "active",
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        store.set(id, record);
        return this.send(res, 201, { data: clone(record), meta: { request_id: requestId() } });
      }
      if (req.method === "GET") {
        const data = Array.from(store.values()).map(clone);
        return this.send(res, 200, {
          data,
          meta: {
            request_id: requestId(),
            pagination: { per_page: 50, next: null, has_more: false, estimated_total: data.length },
          },
        });
      }
      return this.send(res, 405, paddleError("method_not_allowed", "Method not allowed", "request_error", 405));
    }

    const id = parts[1];
    const record = store.get(id);
    if (parts.length === 2) {
      if (req.method === "GET") {
        if (!record) return this.notFound(res);
        return this.send(res, 200, { data: clone(record), meta: { request_id: requestId() } });
      }
      if (req.method === "PATCH" || req.method === "PUT") {
        if (!record) return this.notFound(res);
        Object.assign(record, isPlainObject(body) ? clone(body) : {}, { id, updated_at: nowIso() });
        return this.send(res, 200, { data: clone(record), meta: { request_id: requestId() } });
      }
    }
    return this.send(res, 404, paddleError("not_found", "Entity not found", "request_error", 404));
  }

  notFound(res) {
    return this.send(res, 404, paddleError("entity_not_found", "Entity not found", "request_error", 404));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, paddleError("not_found", "Not Found", "request_error", 404));
  }

  root() {
    return {
      name: "paddle",
      version: "1.0",
      protocol: "paddle-billing",
      documentation: "/docs/paddle.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, paddleError("bad_request", "Invalid request body", "request_error", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, paddleError("bad_request", "Invalid request body", "request_error", 400));
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}

const SENTINEL_BAD_JSON = Symbol("bad-json");
