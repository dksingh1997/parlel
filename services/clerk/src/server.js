import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/clerk — dependency-free fake of the Clerk Backend API (v1).
// In-memory, ephemeral, deterministic. Bearer auth with sk_test_ keys.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function splitPath(p) {
  return p.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function suffix(prefix, seed) {
  return `${prefix}_${createHash("sha256").update(String(seed)).digest("hex").slice(0, 27)}`;
}

function clerkError(status, code, message, longMessage) {
  return {
    status,
    body: {
      errors: [{ code, message, long_message: longMessage || message }],
      clerk_trace_id: randomBytes(8).toString("hex"),
    },
  };
}

export class ClerkServer {
  constructor(port = 4818, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.sessions = new Map();
    this.organizations = new Map();
    this.counter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { errors: [{ code: "internal_error", message: error.message }] });
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
    res.setHeader("server", "parlel-clerk");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, { errors: [{ code: "not_found", message: "not found" }] });
    }

    if (parts[0] !== "v1") {
      return this.send(res, 404, { errors: [{ code: "not_found", message: "not found" }] });
    }

    if (!this.isAuthorized(req)) {
      const e = clerkError(401, "authentication_invalid", "Invalid authentication", "The bearer token is missing or invalid.");
      return this.send(res, e.status, e.body);
    }

    const route = parts.slice(1);
    if (route[0] === "users") return this.handleUsers(req, res, route, body, url);
    if (route[0] === "sessions") return this.handleSessions(req, res, route, body);
    if (route[0] === "organizations") return this.handleOrganizations(req, res, route, body);

    return this.send(res, 404, { errors: [{ code: "not_found", message: "not found" }] });
  }

  handleUsers(req, res, route, body, url) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.users.values()].map(clone));
      }
      if (req.method === "POST") {
        const emails = Array.isArray(body.email_address) ? body.email_address : [];
        const primary = emails[0];
        if (primary && !EMAIL_RE.test(primary)) {
          const e = clerkError(422, "form_param_format_invalid", "is invalid", "email_address is invalid.");
          return this.send(res, e.status, e.body);
        }
        const user = this._createUser(body);
        return this.send(res, 200, clone(user));
      }
      const e = clerkError(405, "method_not_allowed", "method not allowed");
      return this.send(res, e.status, e.body);
    }

    const id = route[1];
    const user = this.users.get(id);
    if (req.method === "GET") {
      if (!user) return this.notFound(res);
      return this.send(res, 200, clone(user));
    }
    if (req.method === "PATCH") {
      if (!user) return this.notFound(res);
      if (typeof body.first_name === "string") user.first_name = body.first_name;
      if (typeof body.last_name === "string") user.last_name = body.last_name;
      if (isPlainObject(body.public_metadata)) user.public_metadata = clone(body.public_metadata);
      if (isPlainObject(body.private_metadata)) user.private_metadata = clone(body.private_metadata);
      user.updated_at = Date.now();
      return this.send(res, 200, clone(user));
    }
    if (req.method === "DELETE") {
      if (!user) return this.notFound(res);
      this.users.delete(id);
      return this.send(res, 200, { object: "user", id, deleted: true });
    }
    const e = clerkError(405, "method_not_allowed", "method not allowed");
    return this.send(res, e.status, e.body);
  }

  handleSessions(req, res, route, body) {
    // POST /v1/sessions/:id/verify
    if (route.length === 3 && route[2] === "verify" && req.method === "POST") {
      let session = this.sessions.get(route[1]);
      if (!session) {
        session = this._createSession(route[1]);
      }
      return this.send(res, 200, clone(session));
    }
    // GET /v1/sessions
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, [...this.sessions.values()].map(clone));
    }
    // GET /v1/sessions/:id
    if (route.length === 2 && req.method === "GET") {
      const session = this.sessions.get(route[1]);
      if (!session) return this.notFound(res);
      return this.send(res, 200, clone(session));
    }
    const e = clerkError(405, "method_not_allowed", "method not allowed");
    return this.send(res, e.status, e.body);
  }

  handleOrganizations(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        const data = [...this.organizations.values()].map(clone);
        return this.send(res, 200, { data, total_count: data.length });
      }
      if (req.method === "POST") {
        if (!body.name) {
          const e = clerkError(422, "form_param_missing", "is required", "name is required.");
          return this.send(res, e.status, e.body);
        }
        this.counter += 1;
        const id = suffix("org", `${body.name}:${this.counter}`);
        const org = {
          object: "organization",
          id,
          name: body.name,
          slug: body.slug || body.name.toLowerCase().replace(/\s+/g, "-"),
          members_count: 0,
          max_allowed_memberships: 0,
          public_metadata: clone(body.public_metadata) || {},
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        this.organizations.set(id, org);
        return this.send(res, 200, clone(org));
      }
    }
    const e = clerkError(405, "method_not_allowed", "method not allowed");
    return this.send(res, e.status, e.body);
  }

  _createUser(body) {
    this.counter += 1;
    const emails = Array.isArray(body.email_address) ? body.email_address : [];
    const id = suffix("user", `${emails[0] || "user"}:${this.counter}`);
    const email_addresses = emails.map((email, i) => ({
      id: suffix("idn", `${id}:${i}`),
      object: "email_address",
      email_address: email,
      verification: { status: "verified", strategy: "admin" },
      linked_to: [],
    }));
    const user = {
      id,
      object: "user",
      username: body.username || null,
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      email_addresses,
      primary_email_address_id: email_addresses[0]?.id || null,
      phone_numbers: [],
      password_enabled: Boolean(body.password),
      two_factor_enabled: false,
      public_metadata: clone(body.public_metadata) || {},
      private_metadata: clone(body.private_metadata) || {},
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.users.set(id, user);
    return user;
  }

  _createSession(id) {
    const userId = [...this.users.keys()][0] || suffix("user", id);
    const session = {
      object: "session",
      id,
      user_id: userId,
      status: "active",
      last_active_at: Date.now(),
      expire_at: Date.now() + 86400000,
      abandon_at: Date.now() + 604800000,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  notFound(res) {
    const e = clerkError(404, "resource_not_found", "Resource not found", "The requested resource was not found.");
    return this.send(res, e.status, e.body);
  }

  root() {
    return { name: "clerk", version: "1", protocol: "clerk-backend-v1", documentation: "/docs/clerk.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+sk_/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => { data += c.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { errors: [{ code: "bad_request", message: "Bad request body" }] });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { errors: [{ code: "bad_request", message: "Bad request body" }] });
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

const SENTINEL_BAD_JSON = Symbol("bad-json");
