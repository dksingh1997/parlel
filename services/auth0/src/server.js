import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/auth0 — a tiny, dependency-free fake of the Auth0 Authentication API
// and Management API v2. In-memory, ephemeral, deterministic.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Build a realistic JWT-looking token (header.payload.signature), deterministic.
function makeJwt(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHash("sha256").update(`${header}.${body}.parlel`).digest());
  return `${header}.${body}.${sig}`;
}

function authError(error, error_description, status = 400) {
  return { status, body: { error, error_description } };
}

export class Auth0Server {
  constructor(port = 4817, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.domain = options.domain || `127.0.0.1:${port}`;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.clients = new Map();
    this.tokens = new Map();
    this.userCounter = 0;
    this._seed();
  }

  _seed() {
    this.clients.set("parlel", {
      client_id: "parlel",
      name: "Parlel Default App",
      app_type: "regular_web",
      callbacks: ["http://127.0.0.1/callback"],
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: "server_error", error_description: error.message });
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
    res.setHeader("server", "parlel-auth0");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, { error: "not_found" });
    }

    // Authentication API: POST /oauth/token
    if (req.method === "POST" && parts[0] === "oauth" && parts[1] === "token" && parts.length === 2) {
      return this.oauthToken(res, body);
    }

    // GET /userinfo (Bearer)
    if (req.method === "GET" && parts[0] === "userinfo" && parts.length === 1) {
      return this.userinfo(req, res);
    }

    // Management API v2 — Bearer required.
    if (parts[0] === "api" && parts[1] === "v2") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, {
          statusCode: 401,
          error: "Unauthorized",
          message: "Invalid token",
        });
      }
      const route = parts.slice(2);
      if (route[0] === "users") return this.handleUsers(req, res, route, body);
      if (route[0] === "clients") return this.handleClients(req, res, route, body);
      return this.send(res, 404, { statusCode: 404, error: "Not Found", message: "not found" });
    }

    return this.send(res, 404, { error: "not_found" });
  }

  oauthToken(res, body) {
    const grant = body.grant_type;
    if (!grant) {
      const e = authError("invalid_request", "Missing grant_type parameter");
      return this.send(res, e.status, e.body);
    }
    if (grant === "client_credentials") {
      if (!body.client_id || !body.client_secret) {
        const e = authError("invalid_request", "Missing client credentials", 401);
        return this.send(res, e.status, e.body);
      }
      return this.send(res, 200, this.issueToken({ sub: `${body.client_id}@clients`, gty: "client-credentials" }));
    }
    if (grant === "password" || grant === "http://auth0.com/oauth/grant-type/password-realm") {
      if (!body.username || !body.password) {
        const e = authError("invalid_grant", "Wrong email or password.", 403);
        return this.send(res, e.status, e.body);
      }
      let user = [...this.users.values()].find((u) => u.email === body.username);
      if (!user) {
        user = this._createUser({ email: body.username, password: body.password, connection: body.realm });
      }
      return this.send(res, 200, this.issueToken({ sub: user.user_id, email: user.email }, true));
    }
    if (grant === "authorization_code" || grant === "refresh_token") {
      return this.send(res, 200, this.issueToken({ sub: "auth0|code-exchange" }, true));
    }
    const e = authError("unsupported_grant_type", `Grant type '${grant}' not allowed`);
    return this.send(res, e.status, e.body);
  }

  issueToken(claims, includeId = false) {
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
      iss: `https://${this.domain}/`,
      aud: "https://parlel/api/v2/",
      iat,
      exp: iat + 86400,
      ...claims,
    };
    const access_token = makeJwt(payload);
    this.tokens.set(access_token, payload);
    const out = {
      access_token,
      token_type: "Bearer",
      expires_in: 86400,
      scope: "openid profile email",
    };
    if (includeId) out.id_token = makeJwt({ ...payload, name: claims.email });
    return out;
  }

  userinfo(req, res) {
    const token = this.bearer(req);
    if (!token) {
      return this.send(res, 401, { error: "invalid_token", error_description: "missing bearer token" });
    }
    const payload = this.tokens.get(token);
    let user = null;
    if (payload && payload.sub) user = this.users.get(payload.sub);
    if (!user && payload && payload.email) {
      user = [...this.users.values()].find((u) => u.email === payload.email);
    }
    const sub = user ? user.user_id : (payload?.sub || "auth0|anonymous");
    return this.send(res, 200, {
      sub,
      email: user?.email || payload?.email || "user@parlel.dev",
      email_verified: user?.email_verified ?? true,
      name: user?.name || user?.email || "Parlel User",
      updated_at: now(),
    });
  }

  handleUsers(req, res, route, body) {
    // /api/v2/users
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.users.values()].map(this._publicUser));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
          return this.send(res, 400, {
            statusCode: 400,
            error: "Bad Request",
            message: "Payload validation error: 'email' is required and must be valid.",
          });
        }
        if ([...this.users.values()].some((u) => u.email === body.email)) {
          return this.send(res, 409, {
            statusCode: 409,
            error: "Conflict",
            message: "The user already exists.",
          });
        }
        const user = this._createUser(body);
        return this.send(res, 201, this._publicUser(user));
      }
      return this.send(res, 405, { statusCode: 405, error: "Method Not Allowed", message: "method not allowed" });
    }

    // /api/v2/users/:id
    const id = route[1];
    const user = this.users.get(id);
    if (req.method === "GET") {
      if (!user) return this.notFoundUser(res);
      return this.send(res, 200, this._publicUser(user));
    }
    if (req.method === "PATCH") {
      if (!user) return this.notFoundUser(res);
      if (isPlainObject(body)) {
        if (typeof body.email === "string") user.email = body.email;
        if (typeof body.email_verified === "boolean") user.email_verified = body.email_verified;
        if (typeof body.name === "string") user.name = body.name;
        if (typeof body.password === "string") user.password = body.password;
        if (isPlainObject(body.user_metadata)) user.user_metadata = clone(body.user_metadata);
        if (isPlainObject(body.app_metadata)) user.app_metadata = clone(body.app_metadata);
        if (typeof body.blocked === "boolean") user.blocked = body.blocked;
        user.updated_at = now();
      }
      return this.send(res, 200, this._publicUser(user));
    }
    if (req.method === "DELETE") {
      this.users.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, { statusCode: 405, error: "Method Not Allowed", message: "method not allowed" });
  }

  handleClients(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.clients.values()].map(clone));
      }
      if (req.method === "POST") {
        const id = randomBytes(16).toString("hex");
        const client = {
          client_id: id,
          client_secret: randomBytes(24).toString("hex"),
          name: body.name || "New App",
          app_type: body.app_type || "regular_web",
          callbacks: Array.isArray(body.callbacks) ? clone(body.callbacks) : [],
        };
        this.clients.set(id, client);
        return this.send(res, 201, clone(client));
      }
      return this.send(res, 405, { statusCode: 405, error: "Method Not Allowed", message: "method not allowed" });
    }
    const id = route[1];
    const client = this.clients.get(id);
    if (!client) return this.send(res, 404, { statusCode: 404, error: "Not Found", message: "client not found" });
    if (req.method === "GET") return this.send(res, 200, clone(client));
    if (req.method === "DELETE") {
      this.clients.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, { statusCode: 405, error: "Method Not Allowed", message: "method not allowed" });
  }

  _createUser(body) {
    this.userCounter += 1;
    const connection = body.connection || "Username-Password-Authentication";
    const hex = createHash("sha256")
      .update(`${body.email}:${this.userCounter}`)
      .digest("hex")
      .slice(0, 24);
    const user_id = `auth0|${hex}`;
    const user = {
      user_id,
      email: body.email,
      email_verified: body.email_verified ?? false,
      name: body.name || body.email,
      nickname: body.nickname || (body.email ? body.email.split("@")[0] : "user"),
      password: body.password,
      connection,
      user_metadata: clone(body.user_metadata) || {},
      app_metadata: clone(body.app_metadata) || {},
      blocked: false,
      created_at: now(),
      updated_at: now(),
    };
    this.users.set(user_id, user);
    return user;
  }

  _publicUser(user) {
    const out = clone(user);
    delete out.password;
    return out;
  }

  notFoundUser(res) {
    return this.send(res, 404, {
      statusCode: 404,
      error: "Not Found",
      message: "The user does not exist.",
      errorCode: "inexistent_user",
    });
  }

  root() {
    return { name: "auth0", version: "1", protocol: "auth0-api", documentation: "/docs/auth0.md" };
  }

  bearer(req) {
    const auth = req.headers.authorization || "";
    const m = /^Bearer\s+(\S+)/i.exec(auth);
    return m ? m[1] : null;
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return Boolean(this.bearer(req));
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        const ctype = (req.headers["content-type"] || "").toLowerCase();
        if (ctype.includes("application/x-www-form-urlencoded")) {
          const obj = {};
          for (const [k, v] of new URLSearchParams(data)) obj[k] = v;
          return resolve(obj);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { error: "invalid_request", error_description: "Bad request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { error: "invalid_request", error_description: "Bad request body" });
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
