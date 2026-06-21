import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/pipedrive — a tiny, dependency-free fake of the Pipedrive API v1.
//
// Wire conventions replicated:
//   * Base path /v1/{resource}  (persons, deals, organizations, leads)
//   * Auth via ?api_token=<token> query param OR Authorization: Bearer <token>.
//   * Response envelope:
//       single: { success:true, data:{...} }
//       list:   { success:true, data:[...], additional_data:{ pagination:{...} } }
//   * Numeric ids (leads use UUID-ish string ids).
//   * Error envelope: { success:false, error, error_info, data:null, additional_data:null }
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

const SENTINEL_BAD_JSON = Symbol("bad-json");
const RESOURCES = ["persons", "deals", "organizations", "leads"];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pdError(error, code = 400) {
  return { success: false, error, error_info: "Please check developers.pipedrive.com", data: null, additional_data: null };
}

export class PipedriveServer {
  constructor(port = 4779, options = {}) {
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
    if (resource === "leads") return randomUUID();
    this.counters[resource] += 1;
    return this.counters[resource];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, pdError(error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-pipedrive");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v1") return this.send(res, 404, pdError("Endpoint not found"));
    if (!this.isAuthorized(req, url)) {
      return this.send(res, 401, { success: false, error: "You need to be authorized to make this request.", errorCode: 401, error_info: "Please check developers.pipedrive.com" });
    }

    const resource = parts[1];
    if (!RESOURCES.includes(resource)) {
      return this.send(res, 404, pdError("Endpoint not found", 404));
    }

    // /v1/{resource}
    if (parts.length === 2) {
      if (req.method === "GET") return this.list(res, resource, url);
      if (req.method === "POST") return this.create(res, resource, body);
      return this.send(res, 405, pdError("Method not allowed", 405));
    }

    // /v1/{resource}/{id}
    if (parts.length === 3) {
      const id = this._parseId(resource, parts[2]);
      const rec = this.store[resource].get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, pdError("Item not found", 404));
        return this.send(res, 200, { success: true, data: clone(rec) });
      }
      if (req.method === "PUT") {
        if (!rec) return this.send(res, 404, pdError("Item not found", 404));
        Object.assign(rec, isPlainObject(body) ? clone(body) : {});
        rec.id = id;
        rec.update_time = now();
        return this.send(res, 200, { success: true, data: clone(rec) });
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, pdError("Item not found", 404));
        this.store[resource].delete(id);
        return this.send(res, 200, { success: true, data: { id } });
      }
      return this.send(res, 405, pdError("Method not allowed", 405));
    }

    return this.send(res, 404, pdError("Endpoint not found", 404));
  }

  _parseId(resource, raw) {
    return resource === "leads" ? raw : Number(raw);
  }

  create(res, resource, body) {
    if (!isPlainObject(body)) return this.send(res, 400, pdError("Invalid request body"));
    if (resource === "persons" && !body.name) {
      return this.send(res, 400, pdError("name must be given"));
    }
    if (resource === "organizations" && !body.name) {
      return this.send(res, 400, pdError("name must be given"));
    }
    if (resource === "deals" && !body.title) {
      return this.send(res, 400, pdError("title must be given"));
    }
    if (resource === "leads" && !body.title) {
      return this.send(res, 400, pdError("title must be given"));
    }
    const id = this._nextId(resource);
    const ts = now();
    const rec = { id, ...clone(body), add_time: ts, update_time: ts };
    this.store[resource].set(id, rec);
    return this.send(res, 201, { success: true, data: clone(rec) });
  }

  list(res, resource, url) {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 100, 500));
    const start = Number(url.searchParams.get("start")) || 0;
    const all = Array.from(this.store[resource].values());
    const page = all.slice(start, start + limit);
    const moreItems = start + limit < all.length;
    return this.send(res, 200, {
      success: true,
      data: page.length ? page.map(clone) : null,
      additional_data: {
        pagination: {
          start,
          limit,
          more_items_in_collection: moreItems,
          next_start: moreItems ? start + limit : null,
        },
      },
    });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, pdError("not found", 404));
  }

  root() {
    return { name: "pipedrive", version: "1", protocol: "pipedrive-v1", documentation: "/docs/pipedrive.md" };
  }

  isAuthorized(req, url) {
    if (!this.requireAuth) return true;
    if (/^Bearer\s+\S+/i.test(req.headers.authorization || "")) return true;
    const token = url.searchParams.get("api_token");
    return typeof token === "string" && token.length > 0;
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
          this.send(res, 400, pdError("Invalid JSON in request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, pdError("Invalid JSON in request body"));
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
