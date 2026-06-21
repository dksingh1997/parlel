import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/freshdesk — a tiny, dependency-free fake of the Freshdesk API v2.
//
// Wire conventions replicated:
//   * Base path /api/v2/{resource}  (tickets, contacts, companies).
//   * Basic auth with the API key as username (key:X), or Bearer.
//   * Plain JSON resources (no wrapping). Collections are bare arrays.
//   * Numeric auto-increment ids.
//   * Error envelope: { description, errors: [{ field, message, code }] }.
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");
const RESOURCES = ["tickets", "contacts", "companies"];

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

function fdError(description, errors = []) {
  return { description, errors };
}

function fieldError(field, message, code = "missing_field") {
  return { field, message, code };
}

export class FreshdeskServer {
  constructor(port = 4782, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.store = {};
    this.counters = {};
    for (const r of RESOURCES) {
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
          this.send(res, 500, fdError(error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-freshdesk");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api" || parts[1] !== "v2") {
      return this.send(res, 404, fdError("Not found"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { code: "invalid_credentials", message: "You have to be logged in to perform this action." });
    }

    const resource = parts[2];
    if (!RESOURCES.includes(resource)) {
      return this.send(res, 404, fdError("Not found"));
    }

    // /api/v2/{resource}
    if (parts.length === 3) {
      if (req.method === "GET") return this.list(res, resource);
      if (req.method === "POST") return this.create(res, resource, body);
      return this.send(res, 405, fdError("Method not allowed"));
    }

    // /api/v2/{resource}/{id}
    if (parts.length === 4) {
      const id = Number(parts[3]);
      const rec = this.store[resource].get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, fdError("Not found"));
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "PUT") {
        if (!rec) return this.send(res, 404, fdError("Not found"));
        Object.assign(rec, isPlainObject(body) ? clone(body) : {});
        rec.id = id;
        rec.updated_at = now();
        return this.send(res, 200, clone(rec));
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, fdError("Not found"));
        this.store[resource].delete(id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, fdError("Method not allowed"));
    }

    return this.send(res, 404, fdError("Not found"));
  }

  create(res, resource, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, fdError("Invalid JSON"));
    }
    const errors = [];
    if (resource === "tickets") {
      if (!body.subject) errors.push(fieldError("subject", "Mandatory attribute missing"));
      if (!body.description) errors.push(fieldError("description", "Mandatory attribute missing"));
      if (body.email === undefined && body.requester_id === undefined) {
        errors.push(fieldError("email", "Mandatory attribute missing"));
      }
    }
    if (resource === "contacts" && !body.name) {
      errors.push(fieldError("name", "Mandatory attribute missing"));
    }
    if (resource === "companies" && !body.name) {
      errors.push(fieldError("name", "Mandatory attribute missing"));
    }
    if (errors.length) {
      return this.send(res, 400, fdError("Validation failed", errors));
    }
    const id = this._nextId(resource);
    const ts = now();
    const rec = { id, ...clone(body), created_at: ts, updated_at: ts };
    if (resource === "tickets") {
      if (rec.status === undefined) rec.status = 2; // open
      if (rec.priority === undefined) rec.priority = 1; // low
    }
    this.store[resource].set(id, rec);
    return this.send(res, 201, clone(rec));
  }

  list(res, resource) {
    const all = Array.from(this.store[resource].values()).map(clone);
    return this.send(res, 200, all);
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, fdError("Not found"));
  }

  root() {
    return { name: "freshdesk", version: "2", protocol: "freshdesk-v2", documentation: "/docs/freshdesk.md" };
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
          this.send(res, 400, fdError("Invalid JSON"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, fdError("Invalid JSON"));
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
