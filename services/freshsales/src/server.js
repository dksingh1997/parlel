import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/freshsales — a tiny, dependency-free fake of the Freshsales
// (Freshworks CRM) API.
//
// Wire conventions replicated:
//   * Base path /api/{resource}  (contacts, leads, deals, sales_accounts).
//   * Header auth: Authorization: Token token=<api-key>  (or Bearer).
//   * Single resource wrapped under the singular key: { contact: {...} }.
//   * Collections wrapped under the plural key + meta:
//       { contacts: [...], meta: { total_pages, total, ... } }.
//   * Numeric auto-increment ids.
//   * Validation errors: HTTP 400 with { errors: { message: [...], <field>: [...] } }.
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

// plural -> singular
const RESOURCES = {
  contacts: "contact",
  leads: "lead",
  deals: "deal",
  sales_accounts: "sales_account",
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class FreshsalesServer {
  constructor(port = 4783, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.store = {};
    this.counters = {};
    for (const r of Object.keys(RESOURCES)) {
      this.store[r] = new Map();
      this.counters[r] = 0;
    }
  }

  _nextId(resource) {
    this.counters[resource] += 1;
    return this.counters[resource];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { errors: { message: [error.message || "Internal server error"] } });
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
    res.setHeader("server", "parlel-freshsales");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api") {
      return this.send(res, 404, { errors: { message: ["Not found"] } });
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { errors: { message: ["You have to be logged in to perform this action."], code: 401 } });
    }

    const resource = parts[1];
    if (!RESOURCES[resource]) {
      return this.send(res, 404, { errors: { message: ["Not found"] } });
    }
    const singular = RESOURCES[resource];

    // /api/{resource}
    if (parts.length === 2) {
      if (req.method === "GET") return this.list(res, resource);
      if (req.method === "POST") return this.create(res, resource, singular, body);
      return this.send(res, 405, { errors: { message: ["Method not allowed"] } });
    }

    // /api/{resource}/{id}
    if (parts.length === 3) {
      const id = Number(parts[2]);
      const rec = this.store[resource].get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, { errors: { message: ["Record not found"] } });
        return this.send(res, 200, { [singular]: clone(rec) });
      }
      if (req.method === "PUT") {
        if (!rec) return this.send(res, 404, { errors: { message: ["Record not found"] } });
        const payload = isPlainObject(body) && isPlainObject(body[singular]) ? body[singular] : {};
        Object.assign(rec, clone(payload));
        rec.id = id;
        rec.updated_at = now();
        return this.send(res, 200, { [singular]: clone(rec) });
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, { errors: { message: ["Record not found"] } });
        this.store[resource].delete(id);
        return this.send(res, 200, {});
      }
      return this.send(res, 405, { errors: { message: ["Method not allowed"] } });
    }

    return this.send(res, 404, { errors: { message: ["Not found"] } });
  }

  create(res, resource, singular, body) {
    const payload = isPlainObject(body) ? body[singular] : undefined;
    if (!isPlainObject(payload)) {
      return this.send(res, 400, { errors: { message: [`Missing ${singular} object`] } });
    }
    // Minimal field validation.
    if ((resource === "contacts" || resource === "leads")) {
      if (!payload.first_name && !payload.last_name && !payload.email) {
        return this.send(res, 400, { errors: { message: ["First name or last name or email is required"], last_name: ["can't be blank"] } });
      }
    }
    if (resource === "deals" && !payload.name) {
      return this.send(res, 400, { errors: { name: ["can't be blank"] } });
    }
    if (resource === "sales_accounts" && !payload.name) {
      return this.send(res, 400, { errors: { name: ["can't be blank"] } });
    }
    const id = this._nextId(resource);
    const ts = now();
    const rec = { id, ...clone(payload), created_at: ts, updated_at: ts };
    this.store[resource].set(id, rec);
    return this.send(res, 201, { [singular]: clone(rec) });
  }

  list(res, resource) {
    const all = Array.from(this.store[resource].values()).map(clone);
    return this.send(res, 200, {
      [resource]: all,
      meta: { total_pages: 1, total: all.length },
    });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { errors: { message: ["Not found"] } });
  }

  root() {
    return { name: "freshsales", version: "1", protocol: "freshsales-crm", documentation: "/docs/freshsales.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Token\s+token=\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, { errors: { message: ["Invalid JSON"] } });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { errors: { message: ["Invalid JSON"] } });
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
