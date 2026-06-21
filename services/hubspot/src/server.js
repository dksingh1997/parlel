import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/hubspot — a tiny, dependency-free fake of the HubSpot CRM API v3.
//
// Speaks the wire protocol used by @hubspot/api-client (and direct REST):
//   * Base path /crm/v3/objects/{objectType}
//   * Bearer (private app token / OAuth) auth.
//   * Object shape: { id, properties: {}, createdAt, updatedAt, archived }
//   * List shape:   { results: [...], paging: { next: { after } } }
//   * Error envelope: { status:"error", message, correlationId, category }
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");
const OBJECT_TYPES = ["contacts", "companies", "deals"];

// Unique identifier property per object type — used to mirror HubSpot's
// duplicate-create 409 CONFLICT behaviour (contacts dedupe on email, companies
// on domain; deals have no unique identifier so never conflict).
const UNIQUE_PROPERTY = { contacts: "email", companies: "domain" };
const BATCH_OPS = ["create", "read", "update", "archive"];

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

function hsError(message, category = "VALIDATION_ERROR") {
  return {
    status: "error",
    message,
    correlationId: randomBytes(16).toString("hex"),
    category,
  };
}

export class HubspotServer {
  constructor(port = 4777, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.store = {};
    this.counters = {};
    for (const type of OBJECT_TYPES) {
      this.store[type] = new Map();
      this.counters[type] = 0;
    }
  }

  _nextId(type) {
    this.counters[type] += 1;
    return String(this.counters[type]);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, hsError(error.message || "Internal server error", "INTERNAL_ERROR"));
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
    res.setHeader("server", "parlel-hubspot");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Everything under /crm requires auth.
    if (parts[0] !== "crm") return this.send(res, 404, hsError("not found", "OBJECT_NOT_FOUND"));
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, {
        status: "error",
        message: "Authentication credentials not found. This API supports OAuth 2.0 authentication...",
        correlationId: randomBytes(16).toString("hex"),
        category: "INVALID_AUTHENTICATION",
      });
    }

    // /crm/v3/objects/{type}...
    const route = parts.slice(1); // v3, objects, type, ...
    if (route[0] !== "v3" || route[1] !== "objects") {
      return this.send(res, 404, hsError("not found", "OBJECT_NOT_FOUND"));
    }
    const type = route[2];
    if (!OBJECT_TYPES.includes(type)) {
      return this.send(res, 404, hsError(`Unknown object type ${type}`, "OBJECT_NOT_FOUND"));
    }

    // POST /crm/v3/objects/{type}/search
    if (route[3] === "search" && route.length === 4) {
      if (req.method !== "POST") return this.send(res, 405, hsError("method not allowed", "METHOD_NOT_ALLOWED"));
      return this.search(res, type, body);
    }

    // POST /crm/v3/objects/{type}/batch/{create|read|update|archive}
    if (route[3] === "batch" && route.length === 5) {
      const op = route[4];
      if (!BATCH_OPS.includes(op)) {
        return this.send(res, 404, hsError("not found", "OBJECT_NOT_FOUND"));
      }
      if (req.method !== "POST") return this.send(res, 405, hsError("method not allowed", "METHOD_NOT_ALLOWED"));
      return this.batch(res, type, op, body);
    }

    // Collection: /crm/v3/objects/{type}
    if (route.length === 3) {
      if (req.method === "GET") return this.list(res, type, url);
      if (req.method === "POST") return this.create(res, type, body);
      return this.send(res, 405, hsError("method not allowed", "METHOD_NOT_ALLOWED"));
    }

    // Single: /crm/v3/objects/{type}/{id}
    if (route.length === 4) {
      const id = route[3];
      const obj = this.store[type].get(id);
      if (req.method === "GET") {
        if (!obj) return this.send(res, 404, hsError(`resource not found`, "OBJECT_NOT_FOUND"));
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "PATCH") {
        if (!obj) return this.send(res, 404, hsError(`resource not found`, "OBJECT_NOT_FOUND"));
        const props = isPlainObject(body) && isPlainObject(body.properties) ? body.properties : {};
        obj.properties = { ...obj.properties, ...props, lastmodifieddate: now() };
        obj.updatedAt = now();
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "DELETE") {
        if (!obj) return this.send(res, 404, hsError(`resource not found`, "OBJECT_NOT_FOUND"));
        this.store[type].delete(id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, hsError("method not allowed", "METHOD_NOT_ALLOWED"));
    }

    return this.send(res, 404, hsError("not found", "OBJECT_NOT_FOUND"));
  }

  create(res, type, body) {
    if (!isPlainObject(body) || !isPlainObject(body.properties)) {
      return this.send(res, 400, hsError("Property values were not valid. The properties field is required."));
    }
    const existingId = this._findDuplicate(type, body.properties);
    if (existingId) {
      const name = type === "companies" ? "Company" : type === "deals" ? "Deal" : "Contact";
      return this.send(res, 409, hsError(`${name} already exists. Existing ID: ${existingId}`, "CONFLICT"));
    }
    const obj = this._materialize(type, body.properties);
    return this.send(res, 201, clone(obj));
  }

  // Build and persist a new object record, mirroring HubSpot's generated fields.
  _materialize(type, properties) {
    const id = this._nextId(type);
    const ts = now();
    const obj = {
      id,
      properties: { ...clone(properties), hs_object_id: id, createdate: ts, lastmodifieddate: ts },
      createdAt: ts,
      updatedAt: ts,
      archived: false,
    };
    this.store[type].set(id, obj);
    return obj;
  }

  // Returns the id of an existing record sharing the type's unique identifier
  // (email for contacts, domain for companies), or null when none / not deduped.
  _findDuplicate(type, properties) {
    const key = UNIQUE_PROPERTY[type];
    if (!key || properties[key] === undefined || properties[key] === null) return null;
    const target = String(properties[key]);
    for (const obj of this.store[type].values()) {
      if (String(obj.properties[key]) === target) return obj.id;
    }
    return null;
  }

  // POST /crm/v3/objects/{type}/batch/{create|read|update|archive}
  // Real HubSpot returns { status:"COMPLETE", results:[...], startedAt, completedAt }
  // (200) for create/read/update, and 204 (no body) for archive.
  batch(res, type, op, body) {
    const inputs = isPlainObject(body) && Array.isArray(body.inputs) ? body.inputs : null;
    if (!inputs) {
      return this.send(res, 400, hsError("Property values were not valid. The inputs field is required."));
    }
    const startedAt = now();

    if (op === "create") {
      const results = [];
      for (const input of inputs) {
        const props = isPlainObject(input) && isPlainObject(input.properties) ? input.properties : {};
        results.push(clone(this._materialize(type, props)));
      }
      return this.send(res, 201, { status: "COMPLETE", results, startedAt, completedAt: now() });
    }

    if (op === "read") {
      const results = [];
      for (const input of inputs) {
        const id = isPlainObject(input) ? String(input.id) : String(input);
        const obj = this.store[type].get(id);
        if (obj) results.push(clone(obj));
      }
      return this.send(res, 200, { status: "COMPLETE", results, startedAt, completedAt: now() });
    }

    if (op === "update") {
      const results = [];
      for (const input of inputs) {
        if (!isPlainObject(input)) continue;
        const obj = this.store[type].get(String(input.id));
        if (!obj) continue;
        const props = isPlainObject(input.properties) ? input.properties : {};
        obj.properties = { ...obj.properties, ...props, lastmodifieddate: now() };
        obj.updatedAt = now();
        results.push(clone(obj));
      }
      return this.send(res, 200, { status: "COMPLETE", results, startedAt, completedAt: now() });
    }

    // archive
    for (const input of inputs) {
      const id = isPlainObject(input) ? String(input.id) : String(input);
      this.store[type].delete(id);
    }
    return this.send(res, 204, null);
  }

  list(res, type, url) {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 10, 100));
    const after = Number(url.searchParams.get("after")) || 0;
    const all = Array.from(this.store[type].values());
    const page = all.slice(after, after + limit);
    const result = { results: page.map(clone) };
    const nextOffset = after + limit;
    if (nextOffset < all.length) {
      result.paging = { next: { after: String(nextOffset), link: "" } };
    }
    return this.send(res, 200, result);
  }

  search(res, type, body) {
    const all = Array.from(this.store[type].values());
    let matched = all;
    const groups = isPlainObject(body) && Array.isArray(body.filterGroups) ? body.filterGroups : [];
    if (groups.length > 0) {
      // OR across groups, AND within a group's filters.
      matched = all.filter((obj) =>
        groups.some((g) => {
          const filters = Array.isArray(g.filters) ? g.filters : [];
          return filters.every((f) => {
            const val = obj.properties[f.propertyName];
            switch (f.operator) {
              case "EQ":
                return String(val) === String(f.value);
              case "NEQ":
                return String(val) !== String(f.value);
              case "HAS_PROPERTY":
                return val !== undefined;
              case "CONTAINS_TOKEN":
                return typeof val === "string" && val.includes(String(f.value));
              default:
                return String(val) === String(f.value);
            }
          });
        })
      );
    }
    const limit = Math.max(1, Math.min(Number(body?.limit) || 10, 100));
    const after = Number(body?.after) || 0;
    const page = matched.slice(after, after + limit);
    const result = { total: matched.length, results: page.map(clone) };
    if (after + limit < matched.length) {
      result.paging = { next: { after: String(after + limit) } };
    }
    return this.send(res, 200, result);
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, hsError("not found", "OBJECT_NOT_FOUND"));
  }

  root() {
    return { name: "hubspot", version: "3", protocol: "hubspot-crm-v3", documentation: "/docs/hubspot.md" };
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
          this.send(res, 400, hsError("Invalid input JSON"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, hsError("Invalid input JSON"));
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
