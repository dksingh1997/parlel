import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/okta — dependency-free fake of the Okta Management API + Auth API.
// In-memory, ephemeral, deterministic. Header auth: Authorization: SSWS <token>.
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

function oktaId(seed) {
  return `00u${createHash("sha256").update(String(seed)).digest("hex").slice(0, 17)}`;
}

function groupId(seed) {
  return `00g${createHash("sha256").update(String(seed)).digest("hex").slice(0, 17)}`;
}

function oktaError(status, code, summary) {
  return {
    status,
    body: {
      errorCode: code,
      errorSummary: summary,
      errorLink: code,
      errorId: `oae${randomBytes(8).toString("hex")}`,
      errorCauses: [],
    },
  };
}

export class OktaServer {
  constructor(port = 4819, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.groups = new Map();
    this.counter = 0;
    this._seed();
  }

  _seed() {
    const id = groupId("Everyone");
    this.groups.set(id, {
      id,
      created: now(),
      lastUpdated: now(),
      type: "BUILT_IN",
      profile: { name: "Everyone", description: "All users in your organization" },
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          const e = oktaError(500, "E0000009", error.message);
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
    res.setHeader("server", "parlel-okta");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, oktaError(404, "E0000007", "not found").body);
    }

    if (parts[0] !== "api" || parts[1] !== "v1") {
      return this.send(res, 404, oktaError(404, "E0000007", "Not found").body);
    }

    if (!this.isAuthorized(req)) {
      const e = oktaError(401, "E0000011", "Invalid token provided");
      return this.send(res, e.status, e.body);
    }

    const route = parts.slice(2);
    if (route[0] === "users") return this.handleUsers(req, res, route, body);
    if (route[0] === "groups") return this.handleGroups(req, res, route, body);
    if (route[0] === "authn") return this.handleAuthn(req, res, route, body);

    const e = oktaError(404, "E0000007", "Not found");
    return this.send(res, e.status, e.body);
  }

  handleUsers(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.users.values()].map(clone));
      }
      if (req.method === "POST") {
        const profile = body.profile || {};
        if (!profile.login || !profile.email || !EMAIL_RE.test(profile.email)) {
          const e = oktaError(400, "E0000001", "Api validation failed: login/email");
          return this.send(res, e.status, e.body);
        }
        const user = this._createUser(body);
        return this.send(res, 200, clone(user));
      }
      const e = oktaError(405, "E0000022", "The endpoint does not support the provided HTTP method");
      return this.send(res, e.status, e.body);
    }

    // /api/v1/users/:id/lifecycle/activate
    if (route.length === 4 && route[2] === "lifecycle" && req.method === "POST") {
      const user = this.users.get(route[1]);
      if (!user) return this.notFound(res);
      const action = route[3];
      if (action === "activate") {
        user.status = "ACTIVE";
        user.activated = now();
        user.lastUpdated = now();
        return this.send(res, 200, {});
      }
      if (action === "deactivate") {
        user.status = "DEPROVISIONED";
        user.lastUpdated = now();
        return this.send(res, 200, {});
      }
      if (action === "suspend") {
        user.status = "SUSPENDED";
        return this.send(res, 200, {});
      }
      return this.send(res, 200, {});
    }

    const id = route[1];
    const user = this.users.get(id);
    if (req.method === "GET") {
      if (!user) return this.notFound(res);
      return this.send(res, 200, clone(user));
    }
    if (req.method === "POST" || req.method === "PUT") {
      // Okta uses POST (partial) / PUT (full) for user updates.
      if (!user) return this.notFound(res);
      if (isPlainObject(body.profile)) {
        user.profile = req.method === "PUT" ? clone(body.profile) : { ...user.profile, ...clone(body.profile) };
      }
      user.lastUpdated = now();
      return this.send(res, 200, clone(user));
    }
    if (req.method === "DELETE") {
      if (!user) return this.notFound(res);
      if (user.status !== "DEPROVISIONED") {
        // Okta requires deactivation before deletion; first DELETE deactivates.
        user.status = "DEPROVISIONED";
        return this.send(res, 200, {});
      }
      this.users.delete(id);
      return this.send(res, 204, null);
    }
    const e = oktaError(405, "E0000022", "The endpoint does not support the provided HTTP method");
    return this.send(res, e.status, e.body);
  }

  handleGroups(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.groups.values()].map(clone));
      }
      if (req.method === "POST") {
        const profile = body.profile || {};
        if (!profile.name) {
          const e = oktaError(400, "E0000001", "Api validation failed: name");
          return this.send(res, e.status, e.body);
        }
        this.counter += 1;
        const id = groupId(`${profile.name}:${this.counter}`);
        const group = {
          id,
          created: now(),
          lastUpdated: now(),
          type: "OKTA_GROUP",
          profile: { name: profile.name, description: profile.description || null },
        };
        this.groups.set(id, group);
        return this.send(res, 200, clone(group));
      }
    }
    const id = route[1];
    const group = this.groups.get(id);
    if (!group) return this.notFound(res);
    if (req.method === "GET") return this.send(res, 200, clone(group));
    if (req.method === "DELETE") {
      this.groups.delete(id);
      return this.send(res, 204, null);
    }
    const e = oktaError(405, "E0000022", "The endpoint does not support the provided HTTP method");
    return this.send(res, e.status, e.body);
  }

  handleAuthn(req, res, route, body) {
    // POST /api/v1/authn — primary authentication.
    if (route.length === 1 && req.method === "POST") {
      if (!body.username || !body.password) {
        const e = oktaError(401, "E0000004", "Authentication failed");
        return this.send(res, e.status, e.body);
      }
      let user = [...this.users.values()].find((u) => u.profile.login === body.username || u.profile.email === body.username);
      if (!user) {
        user = this._createUser({
          profile: { login: body.username, email: body.username, firstName: "Parlel", lastName: "User" },
        });
        user.status = "ACTIVE";
      }
      return this.send(res, 200, {
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        status: "SUCCESS",
        sessionToken: randomBytes(20).toString("hex"),
        _embedded: {
          user: {
            id: user.id,
            passwordChanged: now(),
            profile: {
              login: user.profile.login,
              firstName: user.profile.firstName,
              lastName: user.profile.lastName,
              locale: "en",
              timeZone: "America/Los_Angeles",
            },
          },
        },
      });
    }
    const e = oktaError(405, "E0000022", "The endpoint does not support the provided HTTP method");
    return this.send(res, e.status, e.body);
  }

  _createUser(body) {
    this.counter += 1;
    const profile = body.profile || {};
    const id = oktaId(`${profile.login || profile.email}:${this.counter}`);
    const user = {
      id,
      status: body.credentials ? "STAGED" : (body.profile?.login ? "PROVISIONED" : "STAGED"),
      created: now(),
      activated: null,
      statusChanged: now(),
      lastLogin: null,
      lastUpdated: now(),
      passwordChanged: body.credentials ? now() : null,
      type: { id: "otyparlel" },
      profile: {
        login: profile.login,
        email: profile.email,
        firstName: profile.firstName || null,
        lastName: profile.lastName || null,
        ...clone(profile),
      },
      credentials: {
        provider: { type: "OKTA", name: "OKTA" },
      },
    };
    this.users.set(id, user);
    return user;
  }

  notFound(res) {
    const e = oktaError(404, "E0000007", "Not found: Resource not found");
    return this.send(res, e.status, e.body);
  }

  root() {
    return { name: "okta", version: "1", protocol: "okta-api", documentation: "/docs/okta.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^SSWS\s+\S+/i.test(auth);
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
          const e = oktaError(400, "E0000003", "The request body was not well-formed.");
          this.send(res, e.status, e.body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        const e = oktaError(400, "E0000003", "The request body was not well-formed.");
        this.send(res, e.status, e.body);
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
