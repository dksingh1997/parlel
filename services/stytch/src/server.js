import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/stytch — dependency-free fake of the Stytch API. In-memory, ephemeral,
// deterministic. Basic auth: project_id:secret.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function splitPath(p) {
  return p.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function uuid(seed) {
  const h = createHash("sha256").update(String(seed)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function requestId() {
  return `request-id-test-${uuid(randomBytes(8).toString("hex"))}`;
}

function stytchError(status, error_type, error_message) {
  return {
    status,
    body: {
      status_code: status,
      request_id: requestId(),
      error_type,
      error_message,
      error_url: `https://stytch.com/docs/api/errors/${status}`,
    },
  };
}

export class StytchServer {
  constructor(port = 4823, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.byEmail = new Map();
    this.sessions = new Map();
    this.counter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          const e = stytchError(500, "internal_server_error", error.message);
          this.send(res, e.status, e.body);
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
    res.setHeader("server", "parlel-stytch");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, stytchError(404, "not_found", "not found").body);
    }

    if (parts[0] !== "v1") {
      return this.send(res, 404, stytchError(404, "route_not_found", "not found").body);
    }

    if (!this.isAuthorized(req)) {
      const e = stytchError(401, "unauthorized_credentials", "Unauthorized credentials.");
      return this.send(res, e.status, e.body);
    }

    const route = parts.slice(1);

    // POST /v1/magic_links/email/login_or_create
    if (route[0] === "magic_links" && route[1] === "email" && route[2] === "login_or_create" && req.method === "POST") {
      return this.magicLinkLoginOrCreate(res, body);
    }

    if (route[0] === "passwords") {
      // POST /v1/passwords  (create)
      if (route.length === 1 && req.method === "POST") return this.passwordCreate(res, body);
      // POST /v1/passwords/authenticate
      if (route[1] === "authenticate" && req.method === "POST") return this.passwordAuthenticate(res, body);
    }

    if (route[0] === "users") return this.handleUsers(req, res, route, body);

    // POST /v1/sessions/authenticate
    if (route[0] === "sessions" && route[1] === "authenticate" && req.method === "POST") {
      return this.sessionAuthenticate(res, body);
    }

    return this.send(res, 404, stytchError(404, "route_not_found", "not found").body);
  }

  magicLinkLoginOrCreate(res, body) {
    if (!body.email || !EMAIL_RE.test(body.email)) {
      const e = stytchError(400, "invalid_email", "The email provided is invalid.");
      return this.send(res, e.status, e.body);
    }
    let user = this.users.get(this.byEmail.get(body.email));
    const user_created = !user;
    if (!user) user = this._createUser({ email: body.email });
    return this.send(res, 200, {
      status_code: 200,
      request_id: requestId(),
      user_id: user.user_id,
      email_id: user.emails[0].email_id,
      user_created,
    });
  }

  passwordCreate(res, body) {
    if (!body.email || !EMAIL_RE.test(body.email)) {
      const e = stytchError(400, "invalid_email", "The email provided is invalid.");
      return this.send(res, e.status, e.body);
    }
    if (!body.password) {
      const e = stytchError(400, "weak_password", "The password provided does not meet our requirements.");
      return this.send(res, e.status, e.body);
    }
    if (this.byEmail.has(body.email)) {
      const e = stytchError(400, "duplicate_email", "A user with the specified email already exists for this project.");
      return this.send(res, e.status, e.body);
    }
    const user = this._createUser({ email: body.email, password: body.password });
    const session = this._createSession(user, body.session_duration_minutes);
    return this.send(res, 200, {
      status_code: 200,
      request_id: requestId(),
      user_id: user.user_id,
      email_id: user.emails[0].email_id,
      user: clone(user),
      session_token: session.session_token,
      session_jwt: session.session_jwt,
    });
  }

  passwordAuthenticate(res, body) {
    const user = body.email ? this.users.get(this.byEmail.get(body.email)) : null;
    if (!user) {
      const e = stytchError(404, "user_not_found", "User could not be found.");
      return this.send(res, e.status, e.body);
    }
    if (body.password !== undefined && user.password !== undefined && user.password !== body.password) {
      const e = stytchError(401, "unauthorized_credentials", "Unauthorized credentials.");
      return this.send(res, e.status, e.body);
    }
    const session = this._createSession(user, body.session_duration_minutes);
    return this.send(res, 200, {
      status_code: 200,
      request_id: requestId(),
      user_id: user.user_id,
      user: clone(user),
      session_token: session.session_token,
      session_jwt: session.session_jwt,
    });
  }

  sessionAuthenticate(res, body) {
    const session = body.session_token ? this.sessions.get(body.session_token) : null;
    if (!session) {
      const e = stytchError(404, "session_not_found", "Session was not found.");
      return this.send(res, e.status, e.body);
    }
    const user = this.users.get(session.user_id);
    return this.send(res, 200, {
      status_code: 200,
      request_id: requestId(),
      session: {
        session_id: session.session_id,
        user_id: session.user_id,
        started_at: session.started_at,
        expires_at: session.expires_at,
        authentication_factors: session.authentication_factors,
      },
      session_token: session.session_token,
      session_jwt: session.session_jwt,
      user: clone(user),
    });
  }

  handleUsers(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, {
          status_code: 200,
          request_id: requestId(),
          results: [...this.users.values()].map(clone),
          results_metadata: { total: this.users.size, next_cursor: null },
        });
      }
      if (req.method === "POST") {
        if (!body.email || !EMAIL_RE.test(body.email)) {
          const e = stytchError(400, "invalid_email", "The email provided is invalid.");
          return this.send(res, e.status, e.body);
        }
        if (this.byEmail.has(body.email)) {
          const e = stytchError(400, "duplicate_email", "A user with the specified email already exists for this project.");
          return this.send(res, e.status, e.body);
        }
        const user = this._createUser(body);
        return this.send(res, 200, {
          status_code: 200,
          request_id: requestId(),
          user_id: user.user_id,
          email_id: user.emails[0].email_id,
          status: "active",
          user: clone(user),
        });
      }
    }

    const userId = route[1];
    const user = this.users.get(userId);
    if (req.method === "GET") {
      if (!user) {
        const e = stytchError(404, "user_not_found", "User could not be found.");
        return this.send(res, e.status, e.body);
      }
      return this.send(res, 200, { status_code: 200, request_id: requestId(), ...clone(user) });
    }
    if (req.method === "DELETE") {
      if (!user) {
        const e = stytchError(404, "user_not_found", "User could not be found.");
        return this.send(res, e.status, e.body);
      }
      if (user.emails[0]?.email) this.byEmail.delete(user.emails[0].email);
      this.users.delete(userId);
      return this.send(res, 200, { status_code: 200, request_id: requestId(), user_id: userId });
    }
    return this.send(res, 405, stytchError(405, "method_not_allowed", "method not allowed").body);
  }

  _createUser(body) {
    this.counter += 1;
    const user_id = `user-test-${uuid(`${body.email}:${this.counter}`)}`;
    const email = body.email;
    const user = {
      user_id,
      name: {
        first_name: body.name?.first_name || "",
        middle_name: body.name?.middle_name || "",
        last_name: body.name?.last_name || "",
      },
      emails: email
        ? [{ email_id: `email-test-${uuid(`${user_id}:email`)}`, email, verified: false }]
        : [],
      phone_numbers: [],
      status: "active",
      password: body.password,
      created_at: new Date().toISOString(),
      providers: [],
      webauthn_registrations: [],
      totps: [],
    };
    this.users.set(user_id, user);
    if (email) this.byEmail.set(email, user_id);
    return user;
  }

  _createSession(user, durationMinutes) {
    const minutes = durationMinutes || 60;
    const session_id = `session-test-${uuid(`${user.user_id}:${this.counter}:${randomBytes(4).toString("hex")}`)}`;
    const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const session_token = randomBytes(24).toString("base64").replace(/[+/=]/g, "");
    const iat = Math.floor(Date.now() / 1000);
    const session_jwt = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ sub: user.user_id, iat, exp: iat + minutes * 60 }))}.${b64url(createHash("sha256").update(session_token).digest())}`;
    const session = {
      session_id,
      user_id: user.user_id,
      session_token,
      session_jwt,
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
      authentication_factors: [{ type: "password", delivery_method: "knowledge" }],
    };
    this.sessions.set(session_token, session);
    return session;
  }

  root() {
    return { name: "stytch", version: "1", protocol: "stytch-api", documentation: "/docs/stytch.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Basic\s+\S+/i.test(auth);
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
          this.send(res, 400, stytchError(400, "invalid_json", "Could not parse the request body as JSON.").body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, stytchError(400, "invalid_json", "Could not parse the request body as JSON.").body);
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
