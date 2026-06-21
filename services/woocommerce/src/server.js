import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/woocommerce — a dependency-free fake of the WooCommerce REST API v3
// (/wp-json/wc/v3/...). Accepts Basic auth (consumer key/secret) or OAuth-style
// query params (consumer_key/consumer_secret) — any non-empty credential is
// accepted. JSON request/response. State is in-memory and ephemeral.
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

function wooError(code, message, status = 400) {
  return { code, message, data: { status } };
}

export class WoocommerceServer {
  constructor(port = 4759, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.products = new Map();
    this.orders = new Map();
    this.customers = new Map();
    this.counter = 0;
  }

  nextId() {
    this.counter += 1;
    return this.counter;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, wooError("internal_error", error.message || "Internal server error", 500));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-woocommerce");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Expect /wp-json/wc/v3/<resource>...
    if (parts[0] !== "wp-json" || parts[1] !== "wc" || parts[2] !== "v3") {
      return this.send(res, 404, wooError("rest_no_route", "No route was found matching the URL and request method.", 404));
    }

    if (!this.isAuthorized(req, url)) {
      return this.send(res, 401, wooError(
        "woocommerce_rest_authentication_error",
        "Consumer key is missing.",
        401,
      ));
    }

    const route = parts.slice(3);
    const resource = route[0];

    if (resource === "products") return this.handleCrud(req, res, route, body, this.products, "product");
    if (resource === "orders") return this.handleCrud(req, res, route, body, this.orders, "order");
    if (resource === "customers") return this.handleCrud(req, res, route, body, this.customers, "customer");

    return this.send(res, 404, wooError("rest_no_route", "No route was found matching the URL and request method.", 404));
  }

  handleCrud(req, res, route, body, store, kind) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, Array.from(store.values()).map(clone));
      }
      if (req.method === "POST") {
        const id = this.nextId();
        const record = {
          ...(isPlainObject(body) ? clone(body) : {}),
          id,
          date_created: nowIso(),
          date_modified: nowIso(),
        };
        if (kind === "order" && record.status === undefined) record.status = "pending";
        if (kind === "product" && record.status === undefined) record.status = "publish";
        store.set(id, record);
        return this.send(res, 201, clone(record));
      }
      return this.send(res, 405, wooError("rest_method_not_allowed", "Method not allowed.", 405));
    }

    const id = Number(route[1]);
    const record = store.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!record) return this.notFound(res, kind);
        return this.send(res, 200, clone(record));
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        if (!record) return this.notFound(res, kind);
        Object.assign(record, isPlainObject(body) ? clone(body) : {}, { id, date_modified: nowIso() });
        return this.send(res, 200, clone(record));
      }
      if (req.method === "DELETE") {
        if (!record) return this.notFound(res, kind);
        store.delete(id);
        return this.send(res, 200, clone(record));
      }
    }
    return this.send(res, 404, wooError("rest_no_route", "No route was found matching the URL and request method.", 404));
  }

  notFound(res, kind) {
    return this.send(res, 404, wooError(`woocommerce_rest_${kind}_invalid_id`, "Invalid ID.", 404));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, wooError("rest_no_route", "Not Found", 404));
  }

  root() {
    return {
      name: "woocommerce",
      version: "1.0",
      protocol: "woocommerce-rest-v3",
      documentation: "/docs/woocommerce.md",
    };
  }

  isAuthorized(req, url) {
    if (!this.requireAuth) return true;
    // Basic auth (consumer key/secret).
    if (/^Basic\s+\S+/i.test(req.headers.authorization || "")) return true;
    if (/^Bearer\s+\S+/i.test(req.headers.authorization || "")) return true;
    // OAuth-style query params.
    const ck = url.searchParams.get("consumer_key");
    const cs = url.searchParams.get("consumer_secret");
    if (ck && cs) return true;
    if (url.searchParams.get("oauth_consumer_key")) return true;
    return false;
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
          this.send(res, 400, wooError("rest_invalid_json", "Invalid JSON body", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, wooError("rest_invalid_json", "Invalid JSON body", 400));
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
