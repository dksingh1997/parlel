import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/drip — a tiny, dependency-free fake of the Drip API v2.
//
// Speaks the wire protocol the language-agnostic Drip REST API uses: JSON
// bodies wrapped in resource arrays (e.g. { subscribers: [{...}] }),
// authenticated via HTTP Basic auth (api token as the username). State is
// in-memory and ephemeral; recorded events are captured for inspection.
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

// Drip error envelope: { errors: [{ code, message, attribute }] }
function dripError(code, message, attribute = null) {
  return { errors: [{ code, message, attribute }] };
}

function newId() {
  return randomBytes(12).toString("hex");
}

export class DripServer {
  constructor(port = 4833, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = []; // captured events
    this.subscribers = new Map(); // id -> subscriber
    this.subscribersByEmail = new Map();
    this.campaigns = new Map();
    this._seedDefaults();
  }

  _seedDefaults() {
    const id = newId();
    this.campaigns.set(id, {
      id,
      name: "parlel-welcome",
      status: "active",
      from_name: "Parlel",
      from_email: "owner@parlel.dev",
      subject: "Welcome",
      created_at: now(),
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, dripError("internal_error", error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-drip");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v2") {
      return this.send(res, 404, dripError("not_found", "Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, dripError("unauthorized", "Please provide a valid API token."));
    }

    // /v2/:accountId/...
    const accountId = parts[1];
    const resource = parts[2];
    const sub = parts[3];

    if (resource === "subscribers") {
      return this.handleSubscribers(req, res, body, sub);
    }
    if (resource === "events") {
      return this.handleEvents(req, res, body);
    }
    if (resource === "campaigns") {
      if (req.method === "GET" && !sub) {
        const campaigns = Array.from(this.campaigns.values()).map(clone);
        return this.send(res, 200, { campaigns, meta: { count: campaigns.length, total_count: campaigns.length } });
      }
      if (req.method === "GET" && sub) {
        const c = this.campaigns.get(sub);
        if (!c) return this.send(res, 404, dripError("not_found", "Campaign not found."));
        return this.send(res, 200, { campaigns: [clone(c)] });
      }
      return this.send(res, 405, dripError("method_not_allowed", "Method Not Allowed"));
    }

    return this.send(res, 404, dripError("not_found", "Not Found"));
  }

  handleSubscribers(req, res, body, sub) {
    if (!sub) {
      if (req.method === "GET") {
        const subscribers = Array.from(this.subscribers.values()).map(clone);
        return this.send(res, 200, { subscribers, meta: { count: subscribers.length, total_count: subscribers.length } });
      }
      if (req.method === "POST") {
        const arr = isPlainObject(body) && Array.isArray(body.subscribers) ? body.subscribers : null;
        if (!arr || arr.length === 0) {
          return this.send(res, 422, dripError("invalid", "subscribers array is required.", "subscribers"));
        }
        const input = arr[0];
        if (!isPlainObject(input) || typeof input.email !== "string" || !EMAIL_RE.test(input.email)) {
          return this.send(res, 422, dripError("email_invalid", "Email is not valid.", "email"));
        }
        // Upsert by email.
        let record = this.subscribersByEmail.get(input.email);
        if (record) {
          if (isPlainObject(input.custom_fields)) record.custom_fields = { ...record.custom_fields, ...clone(input.custom_fields) };
          if (Array.isArray(input.tags)) record.tags = Array.from(new Set([...(record.tags || []), ...input.tags]));
          if (typeof input.status === "string") record.status = input.status;
          record.updated_at = now();
          return this.send(res, 200, { subscribers: [clone(record)] });
        }
        const id = newId();
        record = {
          id,
          email: input.email,
          status: input.status || "active",
          custom_fields: isPlainObject(input.custom_fields) ? clone(input.custom_fields) : {},
          tags: Array.isArray(input.tags) ? clone(input.tags) : [],
          created_at: now(),
          updated_at: now(),
        };
        this.subscribers.set(id, record);
        this.subscribersByEmail.set(input.email, record);
        return this.send(res, 201, { subscribers: [clone(record)] });
      }
      return this.send(res, 405, dripError("method_not_allowed", "Method Not Allowed"));
    }

    // /v2/:accountId/subscribers/:idOrEmail
    const record = this._findSubscriber(sub);
    if (req.method === "GET") {
      if (!record) return this.send(res, 404, dripError("not_found", "Subscriber not found."));
      return this.send(res, 200, { subscribers: [clone(record)] });
    }
    if (req.method === "DELETE") {
      if (!record) return this.send(res, 404, dripError("not_found", "Subscriber not found."));
      this.subscribers.delete(record.id);
      this.subscribersByEmail.delete(record.email);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, dripError("method_not_allowed", "Method Not Allowed"));
  }

  _findSubscriber(key) {
    if (this.subscribers.has(key)) return this.subscribers.get(key);
    if (this.subscribersByEmail.has(key)) return this.subscribersByEmail.get(key);
    const decoded = decodeURIComponent(key);
    if (this.subscribersByEmail.has(decoded)) return this.subscribersByEmail.get(decoded);
    return null;
  }

  handleEvents(req, res, body) {
    if (req.method !== "POST") {
      return this.send(res, 405, dripError("method_not_allowed", "Method Not Allowed"));
    }
    const arr = isPlainObject(body) && Array.isArray(body.events) ? body.events : null;
    if (!arr || arr.length === 0) {
      return this.send(res, 422, dripError("invalid", "events array is required.", "events"));
    }
    const ev = arr[0];
    if (!isPlainObject(ev) || typeof ev.email !== "string" || typeof ev.action !== "string") {
      return this.send(res, 422, dripError("invalid", "email and action are required.", "action"));
    }
    this.messages.push({ id: newId(), received_at: now(), kind: "event", body: clone(body) });
    return this.send(res, 204, null);
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
      if (!match) return this.send(res, 404, dripError("not_found", "message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, dripError("not_found", "Not Found"));
  }

  root() {
    return {
      name: "drip",
      version: "1.0",
      protocol: "drip-v2",
      documentation: "/docs/drip.md",
    };
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
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 422, dripError("invalid", "Invalid request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 422, dripError("invalid", "Invalid request body."));
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
