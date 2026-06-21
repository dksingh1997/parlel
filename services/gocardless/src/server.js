import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/gocardless — a tiny, dependency-free fake of the GoCardless API.
//
// Bearer-authenticated, also expects a `GoCardless-Version` header. Resources
// are wrapped under a top-level key: a single resource is { customers: {...} }
// and a collection is { customers: [...], meta: { cursors: {...}, limit } }.
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function token(len = 12) {
  return randomBytes(Math.ceil(len * 0.8)).toString("base64").replace(/[+/=]/g, "").slice(0, len).toUpperCase();
}

function now() {
  return new Date().toISOString();
}

function gcError(type, message, status = 422) {
  return {
    status,
    body: {
      error: {
        type,
        code: status,
        message,
        errors: [{ reason: type, message }],
        documentation_url: "https://developer.gocardless.com/api-reference",
      },
    },
  };
}

const PREFIX = { customers: "CU", mandates: "MD", payments: "PM", creditors: "CR" };

export class GocardlessServer {
  constructor(port = 4871, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.customers = new Map();
    this.mandates = new Map();
    this.payments = new Map();
    this.creditors = new Map();
    this._seed();
  }

  newId(resource) {
    return `${PREFIX[resource]}${token(16)}`;
  }

  _seed() {
    const id = this.newId("creditors");
    this.creditors.set(id, {
      id,
      created_at: now(),
      name: "Parlel Ltd",
      country_code: "GB",
      scheme_identifiers: [{ scheme: "bacs", reference: "123456" }],
    });
  }

  store(resource) {
    return this[resource];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, gcError("internal", error.message || "error", 500).body);
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
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-gocardless");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, gcError("not_found", "not found", 404).body);
    }

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, gcError("authentication_failed", "Bearer access token required", 401).body);
    }

    const resource = parts[0];
    if (resource === "creditors") {
      if (parts.length === 1 && req.method === "GET") {
        return this.send(res, 200, this.collection("creditors"));
      }
      if (parts.length === 2 && req.method === "GET") {
        const item = this.creditors.get(parts[1]);
        if (!item) return this.send(res, 404, gcError("not_found", "creditor not found", 404).body);
        return this.send(res, 200, { creditors: clone(item) });
      }
      return this.send(res, 404, gcError("not_found", "not found", 404).body);
    }

    if (resource === "customers" || resource === "mandates" || resource === "payments") {
      return this.handleResource(req, res, resource, parts, body);
    }

    return this.send(res, 404, gcError("not_found", "not found", 404).body);
  }

  collection(resource) {
    const data = Array.from(this.store(resource).values()).map(clone);
    return {
      [resource]: data,
      meta: { cursors: { before: null, after: null }, limit: 50 },
    };
  }

  handleResource(req, res, resource, parts, body) {
    const store = this.store(resource);
    if (parts.length === 1) {
      if (req.method === "GET") return this.send(res, 200, this.collection(resource));
      if (req.method === "POST") return this.create(res, resource, body);
      return this.send(res, 405, gcError("method_not_allowed", "method not allowed", 405).body);
    }
    if (parts.length === 2) {
      const item = store.get(parts[1]);
      if (!item) return this.send(res, 404, gcError("not_found", `${resource} not found`, 404).body);
      if (req.method === "GET") return this.send(res, 200, { [resource]: clone(item) });
      if (req.method === "PUT" || req.method === "PATCH") {
        const payload = (body && body[resource]) || {};
        if (isPlainObject(payload.metadata)) item.metadata = { ...item.metadata, ...payload.metadata };
        for (const k of ["email", "given_name", "family_name", "company_name"]) {
          if (typeof payload[k] === "string") item[k] = payload[k];
        }
        return this.send(res, 200, { [resource]: clone(item) });
      }
      return this.send(res, 405, gcError("method_not_allowed", "method not allowed", 405).body);
    }
    return this.send(res, 404, gcError("not_found", "not found", 404).body);
  }

  create(res, resource, body) {
    const payload = (isPlainObject(body) && body[resource]) || {};
    const id = this.newId(resource);
    let item;
    if (resource === "customers") {
      item = {
        id,
        created_at: now(),
        email: payload.email || null,
        given_name: payload.given_name || null,
        family_name: payload.family_name || null,
        company_name: payload.company_name || null,
        country_code: payload.country_code || "GB",
        metadata: payload.metadata || {},
      };
    } else if (resource === "mandates") {
      item = {
        id,
        created_at: now(),
        reference: payload.reference || token(8),
        status: "pending_submission",
        scheme: payload.scheme || "bacs",
        links: payload.links || {},
        metadata: payload.metadata || {},
      };
    } else {
      // payments
      if (!payload.amount || !payload.currency) {
        return this.send(res, 422, gcError("validation_failed", "amount and currency are required", 422).body);
      }
      item = {
        id,
        created_at: now(),
        amount: payload.amount,
        currency: payload.currency,
        status: "pending_submission",
        description: payload.description || null,
        links: payload.links || {},
        metadata: payload.metadata || {},
      };
    }
    this.store(resource).set(id, item);
    return this.send(res, 201, { [resource]: clone(item) });
  }

  root() {
    return { name: "gocardless", version: "1", protocol: "gocardless-http", documentation: "/docs/gocardless.md" };
  }

  isAuthorized(req) {
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
          this.send(res, 400, gcError("invalid_request", "malformed JSON body", 400).body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, gcError("invalid_request", "malformed body", 400).body);
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
