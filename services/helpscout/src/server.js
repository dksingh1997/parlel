import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/helpscout — a tiny, dependency-free fake of the Help Scout
// Mailbox API v2.
//
// Wire conventions replicated:
//   * POST /v2/oauth2/token -> { token_type:"bearer", access_token, expires_in }.
//   * Bearer (OAuth) auth for all /v2 resources.
//   * HAL list shape:
//       { _embedded: { conversations: [...] }, _links: {...}, page: {...} }.
//   * Single resources carry a HAL `_links` object.
//   * On create Help Scout returns 201 with a `Resource-ID` header and no body.
//   * Numeric auto-increment ids.
//   * Error envelope: { error, message } (and 400 validation { _embedded:{errors} }).
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

// resource path segment -> embedded collection key
const RESOURCES = {
  conversations: "conversations",
  customers: "customers",
  mailboxes: "mailboxes",
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

export class HelpscoutServer {
  constructor(port = 4786, options = {}) {
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
    this.tokens = new Set();
    this._seedMailboxes();
  }

  _seedMailboxes() {
    this.counters.mailboxes += 1;
    const id = this.counters.mailboxes;
    this.store.mailboxes.set(id, {
      id,
      name: "Parlel Support",
      slug: "parlel",
      email: "support@parlel.dev",
      createdAt: now(),
      _links: { self: { href: `${this._base()}/v2/mailboxes/${id}` } },
    });
  }

  _base() {
    return `http://${this.host}:${this.port}`;
  }

  _nextId(resource) {
    this.counters[resource] += 1;
    return this.counters[resource];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: "internal_error", message: error.message || "Internal server error" });
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
    res.setHeader("Access-Control-Expose-Headers", "Resource-ID, Location");
    res.setHeader("server", "parlel-helpscout");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v2") return this.send(res, 404, { error: "not_found", message: "not found" });

    // POST /v2/oauth2/token — unauthenticated token grant.
    if (parts[1] === "oauth2" && parts[2] === "token" && req.method === "POST") {
      return this.token(res, body);
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { error: "invalid_token", message: "Authentication failed" });
    }

    const resource = parts[1];
    if (!RESOURCES[resource]) {
      return this.send(res, 404, { error: "not_found", message: "not found" });
    }
    const embeddedKey = RESOURCES[resource];

    // /v2/{resource}
    if (parts.length === 2) {
      if (req.method === "GET") return this.list(res, resource, embeddedKey, url);
      if (req.method === "POST") return this.create(res, resource, body);
      return this.send(res, 405, { error: "method_not_allowed", message: "method not allowed" });
    }

    // /v2/{resource}/{id}
    if (parts.length === 3) {
      const id = Number(parts[2]);
      const rec = this.store[resource].get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, { error: "not_found", message: `${resource} not found` });
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        if (!rec) return this.send(res, 404, { error: "not_found", message: `${resource} not found` });
        Object.assign(rec, isPlainObject(body) ? clone(body) : {});
        rec.id = id;
        rec.updatedAt = now();
        return this.send(res, 204, null);
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, { error: "not_found", message: `${resource} not found` });
        this.store[resource].delete(id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, { error: "method_not_allowed", message: "method not allowed" });
    }

    return this.send(res, 404, { error: "not_found", message: "not found" });
  }

  token(res, body) {
    // Accept any client_credentials / authorization grant.
    const grant = isPlainObject(body) ? body.grant_type : undefined;
    if (!grant) {
      return this.send(res, 400, { error: "invalid_request", message: "grant_type is required" });
    }
    const access = randomBytes(24).toString("hex");
    this.tokens.add(access);
    return this.send(res, 200, {
      token_type: "bearer",
      access_token: access,
      expires_in: 7200,
    });
  }

  create(res, resource, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, { error: "invalid_request", message: "Invalid body" });
    }
    if (resource === "conversations") {
      const missing = [];
      if (!body.subject) missing.push("subject");
      if (!body.mailboxId) missing.push("mailboxId");
      if (missing.length) {
        return this.send(res, 400, {
          error: "Validation error",
          message: "The request was not valid",
          _embedded: { errors: missing.map((p) => ({ path: p, message: "Required", source: "JSON" })) },
        });
      }
    }
    if (resource === "customers" && !body.firstName && !body.lastName && !body.emails) {
      return this.send(res, 400, {
        error: "Validation error",
        message: "The request was not valid",
        _embedded: { errors: [{ path: "firstName", message: "Required", source: "JSON" }] },
      });
    }
    const id = this._nextId(resource);
    const ts = now();
    const rec = {
      id,
      ...clone(body),
      createdAt: ts,
      _links: { self: { href: `${this._base()}/v2/${resource}/${id}` } },
    };
    rec.id = id;
    if (resource === "conversations") {
      if (rec.status === undefined) rec.status = "active";
      rec.number = id;
    }
    this.store[resource].set(id, rec);
    // Help Scout returns 201 with a Resource-ID header and no body.
    res.setHeader("Resource-ID", String(id));
    res.setHeader("Location", `${this._base()}/v2/${resource}/${id}`);
    return this.send(res, 201, null);
  }

  list(res, resource, embeddedKey, url) {
    const all = Array.from(this.store[resource].values());
    const size = Math.max(1, Math.min(Number(url.searchParams.get("size")) || 25, 100));
    const pageNum = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const start = (pageNum - 1) * size;
    const pageItems = all.slice(start, start + size);
    const totalPages = Math.max(1, Math.ceil(all.length / size));
    return this.send(res, 200, {
      _embedded: { [embeddedKey]: pageItems.map(clone) },
      _links: {
        self: { href: `${this._base()}/v2/${resource}` },
        first: { href: `${this._base()}/v2/${resource}?page=1` },
        last: { href: `${this._base()}/v2/${resource}?page=${totalPages}` },
      },
      page: {
        size,
        totalElements: all.length,
        totalPages,
        number: pageNum,
      },
    });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: "not_found", message: "not found" });
  }

  root() {
    return { name: "helpscout", version: "2", protocol: "helpscout-mailbox-v2", documentation: "/docs/helpscout.md" };
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
          this.send(res, 400, { error: "invalid_request", message: "Invalid JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { error: "invalid_request", message: "Invalid JSON" });
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
