import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mailerlite — a tiny, dependency-free fake of the MailerLite API.
//
// Speaks the wire protocol the official `@mailerlite/mailerlite-nodejs` SDK
// uses: JSON bodies authenticated via Bearer auth. Responses follow the
// MailerLite shapes { data: {...} } and { data: [], meta, links }. State is
// in-memory and ephemeral.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENTINEL_BAD_JSON = Symbol("bad-json");

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

function mlError(message, errors = {}) {
  return { message, errors };
}

function newId() {
  // MailerLite ids are large numeric strings.
  return String(Math.floor(Math.random() * 9e17) + 1e17);
}

function listEnvelope(data) {
  return {
    data,
    links: { first: null, last: null, prev: null, next: null },
    meta: { current_page: 1, from: data.length ? 1 : null, last_page: 1, per_page: 25, to: data.length || null, total: data.length },
  };
}

export class MailerliteServer {
  constructor(port = 4831, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.subscribers = new Map(); // id -> subscriber
    this.subscribersByEmail = new Map();
    this.groups = new Map();
    this.campaigns = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, mlError(error.message || "Internal server error"));
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
      if (!this.server) {
        resolve();
        return;
      }
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-mailerlite");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api") {
      return this.send(res, 404, mlError("Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { message: "Unauthenticated." });
    }

    const route = parts.slice(1);

    if (route[0] === "subscribers") return this.handleSubscribers(req, res, route, body);
    if (route[0] === "groups") return this.handleGroups(req, res, route, body);
    if (route[0] === "campaigns") return this.handleCampaigns(req, res, route, body);
    if (req.method === "GET" && route[0] === "account" && route.length === 1) {
      return this.send(res, 200, {
        data: {
          account: { id: "1", name: "Parlel", company: "Parlel", subdomain: "parlel" },
          plan: { name: "free", price: 0 },
        },
      });
    }

    return this.send(res, 404, mlError("Not Found"));
  }

  handleSubscribers(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, listEnvelope(Array.from(this.subscribers.values()).map(clone)));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
          return this.send(res, 422, mlError("The given data was invalid.", { email: ["The email field is required."] }));
        }
        // Upsert behaviour: existing email updates fields.
        let record = this.subscribersByEmail.get(body.email);
        if (record) {
          if (isPlainObject(body.fields)) record.fields = { ...record.fields, ...clone(body.fields) };
          record.updated_at = now();
          return this.send(res, 200, { data: clone(record) });
        }
        const id = newId();
        record = {
          id,
          email: body.email,
          status: body.status || "active",
          source: "api",
          fields: isPlainObject(body.fields) ? clone(body.fields) : {},
          groups: Array.isArray(body.groups) ? clone(body.groups) : [],
          created_at: now(),
          updated_at: now(),
        };
        this.subscribers.set(id, record);
        this.subscribersByEmail.set(body.email, record);
        return this.send(res, 201, { data: clone(record) });
      }
      return this.send(res, 405, mlError("Method Not Allowed"));
    }

    if (route.length === 2) {
      const sub = this._findSubscriber(route[1]);
      if (req.method === "GET") {
        if (!sub) return this.send(res, 404, mlError("Resource not found."));
        return this.send(res, 200, { data: clone(sub) });
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        if (!sub) return this.send(res, 404, mlError("Resource not found."));
        if (isPlainObject(body)) {
          if (isPlainObject(body.fields)) sub.fields = { ...sub.fields, ...clone(body.fields) };
          if (typeof body.status === "string") sub.status = body.status;
          sub.updated_at = now();
        }
        return this.send(res, 200, { data: clone(sub) });
      }
      if (req.method === "DELETE") {
        if (!sub) return this.send(res, 404, mlError("Resource not found."));
        this.subscribers.delete(sub.id);
        this.subscribersByEmail.delete(sub.email);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, mlError("Method Not Allowed"));
    }
    return this.send(res, 404, mlError("Not Found"));
  }

  _findSubscriber(key) {
    if (this.subscribers.has(key)) return this.subscribers.get(key);
    if (this.subscribersByEmail.has(key)) return this.subscribersByEmail.get(key);
    return null;
  }

  handleGroups(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, listEnvelope(Array.from(this.groups.values()).map(clone)));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 422, mlError("The given data was invalid.", { name: ["The name field is required."] }));
        }
        const id = newId();
        const record = {
          id,
          name: body.name,
          active_count: 0,
          sent_count: 0,
          opens_count: 0,
          created_at: now(),
        };
        this.groups.set(id, record);
        return this.send(res, 201, { data: clone(record) });
      }
      return this.send(res, 405, mlError("Method Not Allowed"));
    }
    return this.send(res, 404, mlError("Not Found"));
  }

  handleCampaigns(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name || typeof body.type !== "string") {
          return this.send(res, 422, mlError("The given data was invalid.", { name: ["The name field is required."] }));
        }
        const id = newId();
        const record = {
          id,
          name: body.name,
          type: body.type,
          status: "draft",
          emails: Array.isArray(body.emails) ? clone(body.emails) : [],
          created_at: now(),
        };
        this.campaigns.set(id, record);
        // Sending a campaign is a marketing email; capture it.
        this.messages.push({ id, received_at: now(), kind: "campaign", body: clone(body) });
        return this.send(res, 201, { data: clone(record) });
      }
      if (req.method === "GET") {
        return this.send(res, 200, listEnvelope(Array.from(this.campaigns.values()).map(clone)));
      }
      return this.send(res, 405, mlError("Method Not Allowed"));
    }
    return this.send(res, 404, mlError("Not Found"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 2) {
      return this.send(res, 200, { messages: clone(this.messages), count: this.messages.length });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 3) {
      const match = this.messages.find((m) => m.id === parts[2]);
      if (!match) return this.send(res, 404, mlError("message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, mlError("Not Found"));
  }

  root() {
    return {
      name: "mailerlite",
      version: "1.0",
      protocol: "mailerlite-rest",
      documentation: "/docs/mailerlite.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 422, mlError("The given data was invalid."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 422, mlError("The given data was invalid."));
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
