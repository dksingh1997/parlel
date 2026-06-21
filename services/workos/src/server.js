import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/workos — dependency-free fake of the WorkOS API (User Management, SSO,
// Organizations). In-memory, ephemeral, deterministic. Bearer auth (sk_test).
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function now() {
  return new Date().toISOString();
}

function splitPath(p) {
  return p.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function wid(prefix, seed) {
  return `${prefix}_${createHash("sha256").update(String(seed)).digest("hex").slice(0, 26).toUpperCase()}`;
}

function listEnvelope(items) {
  return {
    object: "list",
    data: items,
    list_metadata: {
      before: null,
      after: items.length ? items[items.length - 1].id : null,
    },
  };
}

export class WorkosServer {
  constructor(port = 4821, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.organizations = new Map();
    this.counter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message });
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
    res.setHeader("server", "parlel-workos");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, { message: "not found" });
    }

    // SSO authorize is a redirect-style GET that doesn't require API key.
    if (req.method === "GET" && parts[0] === "sso" && parts[1] === "authorize") {
      const redirect = url.searchParams.get("redirect_uri") || "http://127.0.0.1/callback";
      const code = wid("code", `${randomBytes(8).toString("hex")}`);
      res.setHeader("Location", `${redirect}?code=${code}`);
      return this.send(res, 302, { location: `${redirect}?code=${code}` });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, {
        message: "Could not authenticate the request. Maybe you used the wrong API key?",
      });
    }

    if (parts[0] === "user_management") return this.handleUserManagement(req, res, parts.slice(1), body);
    if (parts[0] === "organizations") return this.handleOrganizations(req, res, parts.slice(1), body);
    if (parts[0] === "sso" && parts[1] === "token" && req.method === "POST") {
      return this.ssoToken(res, body);
    }

    return this.send(res, 404, { message: "not found" });
  }

  handleUserManagement(req, res, route, body) {
    // POST /user_management/authenticate
    if (route[0] === "authenticate" && req.method === "POST") {
      let user = body.email ? [...this.users.values()].find((u) => u.email === body.email) : null;
      if (!user) {
        user = this._createUser({ email: body.email || "user@parlel.dev" });
      }
      return this.send(res, 200, {
        user: clone(user),
        organization_id: body.organization_id || null,
        access_token: this._jwt(user),
        refresh_token: randomBytes(24).toString("hex"),
        authentication_method: "Password",
      });
    }

    if (route[0] === "users") {
      if (route.length === 1) {
        if (req.method === "GET") {
          return this.send(res, 200, listEnvelope([...this.users.values()].map(clone)));
        }
        if (req.method === "POST") {
          if (!body.email || !EMAIL_RE.test(body.email)) {
            return this.send(res, 422, {
              message: "Validation failed",
              code: "validation_error",
              errors: [{ field: "email", code: "email_invalid" }],
            });
          }
          if ([...this.users.values()].some((u) => u.email === body.email)) {
            return this.send(res, 409, { message: "A user with this email already exists.", code: "email_not_available" });
          }
          const user = this._createUser(body);
          return this.send(res, 201, clone(user));
        }
      }
      const id = route[1];
      const user = this.users.get(id);
      if (req.method === "GET") {
        if (!user) return this.notFound(res, "User");
        return this.send(res, 200, clone(user));
      }
      if (req.method === "PUT") {
        if (!user) return this.notFound(res, "User");
        if (typeof body.first_name === "string") user.first_name = body.first_name;
        if (typeof body.last_name === "string") user.last_name = body.last_name;
        if (typeof body.email_verified === "boolean") user.email_verified = body.email_verified;
        user.updated_at = now();
        return this.send(res, 200, clone(user));
      }
      if (req.method === "DELETE") {
        if (!user) return this.notFound(res, "User");
        this.users.delete(id);
        return this.send(res, 200, {});
      }
    }

    return this.send(res, 404, { message: "not found" });
  }

  handleOrganizations(req, res, route, body) {
    if (route.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, listEnvelope([...this.organizations.values()].map(clone)));
      }
      if (req.method === "POST") {
        if (!body.name) {
          return this.send(res, 422, { message: "Validation failed", code: "validation_error" });
        }
        this.counter += 1;
        const id = wid("org", `${body.name}:${this.counter}`);
        const org = {
          object: "organization",
          id,
          name: body.name,
          allow_profiles_outside_organization: Boolean(body.allow_profiles_outside_organization),
          domains: Array.isArray(body.domains)
            ? body.domains.map((d) => ({
                object: "organization_domain",
                id: wid("org_domain", `${id}:${typeof d === "string" ? d : d.domain}`),
                domain: typeof d === "string" ? d : d.domain,
              }))
            : [],
          created_at: now(),
          updated_at: now(),
        };
        this.organizations.set(id, org);
        return this.send(res, 201, clone(org));
      }
    }
    const id = route[0];
    const org = this.organizations.get(id);
    if (req.method === "GET") {
      if (!org) return this.notFound(res, "Organization");
      return this.send(res, 200, clone(org));
    }
    return this.send(res, 404, { message: "not found" });
  }

  ssoToken(res, body) {
    const user = this._createUser({ email: body.email || "sso@parlel.dev" });
    return this.send(res, 200, {
      access_token: this._jwt(user),
      profile: {
        object: "profile",
        id: wid("prof", user.id),
        connection_id: wid("conn", user.id),
        connection_type: "OktaSAML",
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        idp_id: randomBytes(8).toString("hex"),
        raw_attributes: {},
      },
    });
  }

  _createUser(body) {
    this.counter += 1;
    const id = wid("user", `${body.email}:${this.counter}`);
    const user = {
      object: "user",
      id,
      email: body.email,
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      email_verified: Boolean(body.email_verified),
      profile_picture_url: null,
      created_at: now(),
      updated_at: now(),
    };
    this.users.set(id, user);
    return user;
  }

  _jwt(user) {
    const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const iat = Math.floor(Date.now() / 1000);
    const payload = b64url(JSON.stringify({ sub: user.id, email: user.email, iat, exp: iat + 3600 }));
    const sig = b64url(createHash("sha256").update(`${header}.${payload}.parlel`).digest());
    return `${header}.${payload}.${sig}`;
  }

  notFound(res, what) {
    return this.send(res, 404, { message: `${what} not found`, code: "entity_not_found" });
  }

  root() {
    return { name: "workos", version: "1", protocol: "workos-api", documentation: "/docs/workos.md" };
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
        const ctype = (req.headers["content-type"] || "").toLowerCase();
        if (ctype.includes("application/x-www-form-urlencoded")) {
          const obj = {};
          for (const [k, v] of new URLSearchParams(data)) obj[k] = v;
          return resolve(obj);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { message: "Bad request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Bad request body" });
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
