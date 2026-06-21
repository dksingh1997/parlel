import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/frontegg — dependency-free fake of the Frontegg API. In-memory,
// ephemeral, deterministic. Bearer auth (vendor / user tokens).
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

function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHash("sha256").update(`${header}.${body}.parlel`).digest());
  return `${header}.${body}.${sig}`;
}

export class FronteggServer {
  constructor(port = 4824, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.byEmail = new Map();
    this.tenants = new Map();
    this.counter = 0;
    this._seed();
  }

  _seed() {
    const tenantId = uuid("default-tenant");
    this.tenants.set(tenantId, {
      id: uuid(tenantId),
      tenantId,
      name: "Parlel Tenant",
      createdAt: new Date().toISOString(),
    });
    this.defaultTenantId = tenantId;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { errors: [error.message] });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, frontegg-tenant-id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-frontegg");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, { errors: ["not found"] });
    }

    // POST /auth/vendor — vendor token (no bearer required; client_id+secret).
    if (parts[0] === "auth" && parts[1] === "vendor" && req.method === "POST") {
      return this.vendorToken(res, body);
    }

    // POST /identity/resources/auth/v1/user — user login (no bearer required).
    if (parts[0] === "identity" && parts[1] === "resources" && parts[2] === "auth" && parts[3] === "v1" && parts[4] === "user" && req.method === "POST") {
      return this.userLogin(res, body);
    }

    if (parts[0] === "identity" && parts[1] === "resources") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, { errors: ["Unauthorized"], statusCode: 401 });
      }
      // /identity/resources/users/v1
      if (parts[2] === "users" && parts[3] === "v1") {
        return this.handleUsers(req, res, parts.slice(4), body, url);
      }
      // /identity/resources/tenants/v1
      if (parts[2] === "tenants" && parts[3] === "v1") {
        return this.handleTenants(req, res, parts.slice(4), body);
      }
    }

    return this.send(res, 404, { errors: ["not found"] });
  }

  vendorToken(res, body) {
    if (!body.clientId || !body.secret) {
      return this.send(res, 401, { errors: ["Invalid vendor credentials"], statusCode: 401 });
    }
    const iat = Math.floor(Date.now() / 1000);
    return this.send(res, 200, {
      token: makeJwt({ scope: "vendor", clientId: body.clientId, iat, exp: iat + 3600 }),
      expiresIn: 3600,
      tokenType: "Bearer",
    });
  }

  userLogin(res, body) {
    if (!body.email || !EMAIL_RE.test(body.email)) {
      return this.send(res, 400, { errors: ["email must be a valid email"], statusCode: 400 });
    }
    let user = this.users.get(this.byEmail.get(body.email));
    if (!user) user = this._createUser({ email: body.email, name: body.email.split("@")[0] });
    if (body.password !== undefined && user.password !== undefined && user.password !== body.password) {
      return this.send(res, 401, { errors: ["Invalid email or password"], statusCode: 401 });
    }
    const iat = Math.floor(Date.now() / 1000);
    return this.send(res, 200, {
      accessToken: makeJwt({ sub: user.id, email: user.email, tenantId: user.tenantId, type: "userToken", iat, exp: iat + 3600 }),
      refreshToken: randomBytes(24).toString("hex"),
      expiresIn: 3600,
      userId: user.id,
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      mfaRequired: false,
    });
  }

  handleUsers(req, res, route, body, url) {
    if (route.length === 0) {
      if (req.method === "GET") {
        const items = [...this.users.values()].map(this._publicUser);
        return this.send(res, 200, { items, _metadata: { totalItems: items.length, totalPages: 1 } });
      }
      if (req.method === "POST") {
        if (!body.email || !EMAIL_RE.test(body.email)) {
          return this.send(res, 400, { errors: ["email must be a valid email"], statusCode: 400 });
        }
        if (this.byEmail.has(body.email)) {
          return this.send(res, 409, { errors: ["User already exists"], statusCode: 409 });
        }
        const tenantId = body.tenantId || this._tenantFromReq(req) || this.defaultTenantId;
        const user = this._createUser({ ...body, tenantId });
        return this.send(res, 201, this._publicUser(user));
      }
    }

    const id = route[0];
    const user = this.users.get(id);
    if (req.method === "GET") {
      if (!user) return this.send(res, 404, { errors: ["User not found"], statusCode: 404 });
      return this.send(res, 200, this._publicUser(user));
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      if (!user) return this.send(res, 404, { errors: ["User not found"], statusCode: 404 });
      if (typeof body.name === "string") user.name = body.name;
      if (typeof body.phoneNumber === "string") user.phoneNumber = body.phoneNumber;
      if (typeof body.profilePictureUrl === "string") user.profilePictureUrl = body.profilePictureUrl;
      if (isPlainObject(body.metadata)) user.metadata = clone(body.metadata);
      user.updatedAt = new Date().toISOString();
      return this.send(res, 200, this._publicUser(user));
    }
    if (req.method === "DELETE") {
      if (!user) return this.send(res, 404, { errors: ["User not found"], statusCode: 404 });
      if (user.email) this.byEmail.delete(user.email);
      this.users.delete(id);
      return this.send(res, 200, {});
    }
    return this.send(res, 405, { errors: ["method not allowed"], statusCode: 405 });
  }

  handleTenants(req, res, route, body) {
    if (route.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.tenants.values()].map(clone));
      }
      if (req.method === "POST") {
        if (!body.name) {
          return this.send(res, 400, { errors: ["name is required"], statusCode: 400 });
        }
        this.counter += 1;
        const tenantId = body.tenantId || uuid(`${body.name}:${this.counter}`);
        const tenant = {
          id: uuid(`tenant-id:${tenantId}`),
          tenantId,
          name: body.name,
          createdAt: new Date().toISOString(),
        };
        this.tenants.set(tenantId, tenant);
        return this.send(res, 201, clone(tenant));
      }
    }
    return this.send(res, 404, { errors: ["not found"] });
  }

  _createUser(body) {
    this.counter += 1;
    const id = uuid(`${body.email}:${this.counter}`);
    const user = {
      id,
      email: body.email,
      name: body.name || (body.email ? body.email.split("@")[0] : ""),
      profilePictureUrl: body.profilePictureUrl || null,
      phoneNumber: body.phoneNumber || null,
      verified: false,
      tenantId: body.tenantId || this.defaultTenantId,
      password: body.password,
      metadata: clone(body.metadata) || {},
      roles: [],
      permissions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, user);
    if (body.email) this.byEmail.set(body.email, id);
    return user;
  }

  _publicUser(user) {
    const out = clone(user);
    delete out.password;
    return out;
  }

  _tenantFromReq(req) {
    return req.headers["frontegg-tenant-id"] || null;
  }

  root() {
    return { name: "frontegg", version: "1", protocol: "frontegg-api", documentation: "/docs/frontegg.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, { errors: ["Bad request body"], statusCode: 400 });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { errors: ["Bad request body"], statusCode: 400 });
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
