import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/zendesk — a tiny, dependency-free fake of the Zendesk Support API v2.
//
// Wire conventions replicated:
//   * Base path /api/v2/{resource}.json (the .json suffix is optional).
//   * Basic auth (email/token or email:password) or Bearer (OAuth) auth.
//   * Single resource wrapped: { ticket: {...} } / { user: {...} }.
//   * Collections wrapped:     { tickets: [...], count, next_page, previous_page }.
//   * Numeric auto-increment ids.
//   * Error envelope: { error, description } or { error: { title, message } }.
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

// resource -> { singular }
const RESOURCES = {
  tickets: "ticket",
  users: "user",
  organizations: "organization",
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

function stripJson(part) {
  return part.endsWith(".json") ? part.slice(0, -5) : part;
}

function zdError(description, error = "RecordInvalid") {
  return { error, description };
}

export class ZendeskServer {
  constructor(port = 4781, options = {}) {
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
          this.send(res, 500, zdError(error.message || "Internal server error", "Error"));
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
    res.setHeader("server", "parlel-zendesk");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api" || parts[1] !== "v2") {
      return this.send(res, 404, zdError("Not found", "RecordNotFound"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { error: "Couldn't authenticate you" });
    }

    const resource = stripJson(parts[2] || "");
    if (!RESOURCES[resource]) {
      return this.send(res, 404, zdError("Not found", "RecordNotFound"));
    }
    const singular = RESOURCES[resource];

    // /api/v2/{resource}.json  (collection)
    if (parts.length === 3) {
      if (req.method === "GET") return this.list(res, resource, singular);
      if (req.method === "POST") return this.create(res, resource, singular, body);
      return this.send(res, 405, zdError("Method not allowed", "MethodNotAllowed"));
    }

    // /api/v2/{resource}/{id}.json  (single)
    if (parts.length === 4) {
      const id = Number(stripJson(parts[3]));
      const rec = this.store[resource].get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, zdError("Not found", "RecordNotFound"));
        return this.send(res, 200, { [singular]: clone(rec) });
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        if (!rec) return this.send(res, 404, zdError("Not found", "RecordNotFound"));
        const payload = isPlainObject(body) && isPlainObject(body[singular]) ? body[singular] : {};
        Object.assign(rec, clone(payload));
        rec.id = id;
        rec.updated_at = now();
        return this.send(res, 200, { [singular]: clone(rec) });
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, zdError("Not found", "RecordNotFound"));
        this.store[resource].delete(id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, zdError("Method not allowed", "MethodNotAllowed"));
    }

    return this.send(res, 404, zdError("Not found", "RecordNotFound"));
  }

  create(res, resource, singular, body) {
    const payload = isPlainObject(body) ? body[singular] : undefined;
    if (!isPlainObject(payload)) {
      return this.send(res, 422, zdError(`Missing ${singular} object`, "RecordInvalid"));
    }
    if (resource === "tickets" && !payload.subject && !payload.comment) {
      return this.send(res, 422, zdError("Subject or comment: cannot be blank", "RecordInvalid"));
    }
    if (resource === "users" && !payload.name) {
      return this.send(res, 422, zdError("Name: cannot be blank", "RecordInvalid"));
    }
    if (resource === "organizations" && !payload.name) {
      return this.send(res, 422, zdError("Name: cannot be blank", "RecordInvalid"));
    }
    const id = this._nextId(resource);
    const ts = now();
    const rec = { id, url: `/api/v2/${resource}/${id}.json`, ...clone(payload), created_at: ts, updated_at: ts };
    if (resource === "tickets" && rec.status === undefined) rec.status = "open";
    this.store[resource].set(id, rec);
    return this.send(res, 201, { [singular]: clone(rec) });
  }

  list(res, resource, singular) {
    const all = Array.from(this.store[resource].values()).map(clone);
    return this.send(res, 200, {
      [resource]: all,
      count: all.length,
      next_page: null,
      previous_page: null,
    });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, zdError("Not found", "RecordNotFound"));
  }

  root() {
    return { name: "zendesk", version: "2", protocol: "zendesk-support-v2", documentation: "/docs/zendesk.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Basic\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, zdError("Invalid JSON", "InvalidJson"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, zdError("Invalid JSON", "InvalidJson"));
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
