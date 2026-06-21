import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/chargebee — a dependency-free fake of the Chargebee v2 API.
//   /api/v2/customers, /subscriptions, /invoices, /plans
// Basic auth (api key as username, blank password). Request bodies are
// application/x-www-form-urlencoded (incl. bracket notation); responses are
// JSON wrapped as { customer: {...} } or list { list: [{ customer: {...} }], next_offset }.
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cbId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function cbError(message, apiErrorCode = "param_required", httpStatusCode = 400) {
  return {
    message,
    type: "invalid_request",
    api_error_code: apiErrorCode,
    error_code: apiErrorCode,
    http_status_code: httpStatusCode,
  };
}

// urlencoded parser with bracket notation (subscription[plan_id]=basic).
function parseForm(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const val = decodeURIComponent(rawVal.replace(/\+/g, " "));
    const m = key.match(/^([^[]+)(?:\[([^\]]*)\])?/);
    if (!m) continue;
    if (m[2] !== undefined) {
      if (!isPlainObject(out[m[1]])) out[m[1]] = {};
      out[m[1]][m[2]] = val;
    } else {
      out[m[1]] = val;
    }
  }
  return out;
}

const RESOURCES = {
  customers: { singular: "customer", prefix: "cust" },
  subscriptions: { singular: "subscription", prefix: "sub" },
  invoices: { singular: "invoice", prefix: "inv" },
  plans: { singular: "plan", prefix: "plan" },
};

export class ChargebeeServer {
  constructor(port = 4764, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.stores = {
      customers: new Map(),
      subscriptions: new Map(),
      invoices: new Map(),
      plans: new Map(),
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, cbError(error.message || "Internal server error", "internal_error", 500));
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
    if (body === SENTINEL_BAD_BODY) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-chargebee");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Expect /api/v2/<resource>...
    if (parts[0] !== "api" || parts[1] !== "v2") {
      return this.send(res, 404, cbError("Sorry, we couldn't find that resource", "resource_not_found", 404));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, cbError("The api key is invalid", "api_authentication_failed", 401));
    }

    const resourceKey = parts[2];
    const meta = RESOURCES[resourceKey];
    if (!meta) return this.send(res, 404, cbError("Sorry, we couldn't find that resource", "resource_not_found", 404));

    return this.handleResource(req, res, resourceKey, meta, parts.slice(2), body);
  }

  handleResource(req, res, resourceKey, meta, route, body) {
    const store = this.stores[resourceKey];
    const { singular, prefix } = meta;

    if (route.length === 1) {
      if (req.method === "POST") {
        // Chargebee accepts top-level params; SDK nests under the resource name too.
        const params = isPlainObject(body[singular]) ? body[singular] : body;
        const id = params.id || cbId(prefix);
        const record = {
          ...clone(params),
          id,
          object: singular,
          created_at: now(),
          updated_at: now(),
          resource_version: Date.now(),
        };
        if (resourceKey === "subscriptions" && record.status === undefined) record.status = "active";
        if (resourceKey === "invoices" && record.status === undefined) record.status = "paid";
        store.set(id, record);
        return this.send(res, 200, { [singular]: clone(record) });
      }
      if (req.method === "GET") {
        const items = Array.from(store.values()).map((r) => ({ [singular]: clone(r) }));
        return this.send(res, 200, { list: items, next_offset: undefined });
      }
      return this.send(res, 405, cbError("Method not allowed", "method_not_allowed", 405));
    }

    const id = route[1];
    const record = store.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!record) return this.notFound(res, singular, id);
        return this.send(res, 200, { [singular]: clone(record) });
      }
      if (req.method === "POST") {
        if (!record) return this.notFound(res, singular, id);
        const params = isPlainObject(body[singular]) ? body[singular] : body;
        Object.assign(record, clone(params), { id, updated_at: now(), resource_version: Date.now() });
        return this.send(res, 200, { [singular]: clone(record) });
      }
    }
    // Action endpoints e.g. /subscriptions/:id/cancel
    if (route.length === 3 && req.method === "POST") {
      if (!record) return this.notFound(res, singular, id);
      const action = route[2];
      if (resourceKey === "subscriptions" && action === "cancel") record.status = "cancelled";
      record.updated_at = now();
      return this.send(res, 200, { [singular]: clone(record) });
    }
    return this.send(res, 404, cbError("Sorry, we couldn't find that resource", "resource_not_found", 404));
  }

  notFound(res, singular, id) {
    return this.send(res, 404, cbError(`Sorry, we couldn't find that ${singular} : ${id}`, "resource_not_found", 404));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, cbError("Not Found", "resource_not_found", 404));
  }

  root() {
    return {
      name: "chargebee",
      version: "1.0",
      protocol: "chargebee-v2",
      documentation: "/docs/chargebee.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Basic\s+\S+/i.test(req.headers.authorization || "");
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        const ct = (req.headers["content-type"] || "").toLowerCase();
        try {
          if (ct.includes("application/json")) {
            resolve(JSON.parse(data));
          } else {
            resolve(parseForm(data));
          }
        } catch {
          this.send(res, 400, cbError("Invalid request body", "invalid_request", 400));
          resolve(SENTINEL_BAD_BODY);
        }
      });
      req.on("error", () => {
        this.send(res, 400, cbError("Invalid request body", "invalid_request", 400));
        resolve(SENTINEL_BAD_BODY);
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

const SENTINEL_BAD_BODY = Symbol("bad-body");
