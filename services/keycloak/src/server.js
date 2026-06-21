import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/keycloak — dependency-free fake of the Keycloak Admin REST API and the
// OpenID Connect token endpoint. In-memory, ephemeral, deterministic.
//   Token:  POST /realms/:realm/protocol/openid-connect/token
//   Admin:  /admin/realms/:realm/users (+/:id), /admin/realms/:realm/clients
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "parlel" }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHash("sha256").update(`${header}.${body}.parlel`).digest());
  return `${header}.${body}.${sig}`;
}

function splitPath(p) {
  return p.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export class KeycloakServer {
  constructor(port = 4822, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // realm -> { users: Map, clients: Map }
    this.realms = new Map();
    this._realm("parlel");
    this._realm("master");
  }

  _realm(name) {
    if (!this.realms.has(name)) {
      const realm = { users: new Map(), clients: new Map() };
      const id = randomUUID();
      realm.clients.set(id, {
        id,
        clientId: "admin-cli",
        enabled: true,
        publicClient: true,
        protocol: "openid-connect",
      });
      this.realms.set(name, realm);
    }
    return this.realms.get(name);
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
    res.setHeader("server", "parlel-keycloak");

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

    // Token endpoint: /realms/:realm/protocol/openid-connect/token
    if (parts[0] === "realms" && parts[2] === "protocol" && parts[3] === "openid-connect" && parts[4] === "token") {
      if (req.method !== "POST") return this.send(res, 405, { error: "method_not_allowed" });
      return this.tokenEndpoint(res, parts[1], body);
    }

    // Admin REST: /admin/realms/:realm/...
    if (parts[0] === "admin" && parts[1] === "realms") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, { error: "HTTP 401 Unauthorized" });
      }
      const realmName = parts[2];
      const realm = this._realm(realmName);
      const route = parts.slice(3);
      if (route[0] === "users") return this.handleUsers(req, res, realm, route, body, realmName);
      if (route[0] === "clients") return this.handleClients(req, res, realm, route, body);
      return this.send(res, 404, { error: "not_found" });
    }

    return this.send(res, 404, { error: "not_found" });
  }

  tokenEndpoint(res, realmName, body) {
    const grant = body.grant_type;
    if (!grant) {
      return this.send(res, 400, { error: "invalid_request", error_description: "Missing form parameter: grant_type" });
    }
    const realm = this._realm(realmName);
    let sub = "service-account";
    let preferred_username = body.client_id || "admin-cli";

    if (grant === "password") {
      if (!body.username || !body.password) {
        return this.send(res, 401, { error: "invalid_grant", error_description: "Invalid user credentials" });
      }
      let user = [...realm.users.values()].find((u) => u.username === body.username || u.email === body.username);
      if (!user) {
        user = this._createUser(realm, { username: body.username, email: body.username, enabled: true });
      }
      sub = user.id;
      preferred_username = user.username;
    } else if (grant === "client_credentials") {
      if (!body.client_id) {
        return this.send(res, 401, { error: "invalid_client", error_description: "Invalid client credentials" });
      }
    } else if (grant !== "refresh_token") {
      return this.send(res, 400, { error: "unsupported_grant_type", error_description: `Unsupported grant_type: ${grant}` });
    }

    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      exp: iat + 300,
      iat,
      jti: randomUUID(),
      iss: `http://${this.host}:${this.port}/realms/${realmName}`,
      sub,
      typ: "Bearer",
      azp: body.client_id || "admin-cli",
      preferred_username,
      realm_access: { roles: ["offline_access", "uma_authorization"] },
    };
    return this.send(res, 200, {
      access_token: makeJwt(claims),
      expires_in: 300,
      refresh_expires_in: 1800,
      refresh_token: makeJwt({ ...claims, exp: iat + 1800, typ: "Refresh" }),
      token_type: "Bearer",
      "not-before-policy": 0,
      session_state: randomUUID(),
      scope: "profile email",
    });
  }

  handleUsers(req, res, realm, route, body, realmName) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...realm.users.values()].map(clone));
      }
      if (req.method === "POST") {
        if (!body.username) {
          return this.send(res, 400, { errorMessage: "User name is missing" });
        }
        if (body.email && !EMAIL_RE.test(body.email)) {
          return this.send(res, 400, { errorMessage: "Invalid email" });
        }
        if ([...realm.users.values()].some((u) => u.username === body.username)) {
          return this.send(res, 409, { errorMessage: "User exists with same username" });
        }
        const user = this._createUser(realm, body);
        // Keycloak returns 201 with a Location header and empty body.
        res.setHeader("Location", `http://${this.host}:${this.port}/admin/realms/${realmName}/users/${user.id}`);
        return this.send(res, 201, null);
      }
      return this.send(res, 405, { error: "method_not_allowed" });
    }

    const id = route[1];
    const user = realm.users.get(id);
    if (req.method === "GET") {
      if (!user) return this.send(res, 404, { error: "User not found" });
      return this.send(res, 200, clone(user));
    }
    if (req.method === "PUT") {
      if (!user) return this.send(res, 404, { error: "User not found" });
      if (typeof body.email === "string") user.email = body.email;
      if (typeof body.firstName === "string") user.firstName = body.firstName;
      if (typeof body.lastName === "string") user.lastName = body.lastName;
      if (typeof body.enabled === "boolean") user.enabled = body.enabled;
      if (typeof body.emailVerified === "boolean") user.emailVerified = body.emailVerified;
      if (isPlainObject(body.attributes)) user.attributes = clone(body.attributes);
      return this.send(res, 204, null);
    }
    if (req.method === "DELETE") {
      if (!user) return this.send(res, 404, { error: "User not found" });
      realm.users.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, { error: "method_not_allowed" });
  }

  handleClients(req, res, realm, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...realm.clients.values()].map(clone));
      }
      if (req.method === "POST") {
        if (!body.clientId) {
          return this.send(res, 400, { errorMessage: "Client identifier missing" });
        }
        const id = randomUUID();
        const client = {
          id,
          clientId: body.clientId,
          enabled: body.enabled !== false,
          publicClient: Boolean(body.publicClient),
          protocol: body.protocol || "openid-connect",
          redirectUris: Array.isArray(body.redirectUris) ? clone(body.redirectUris) : [],
        };
        realm.clients.set(id, client);
        return this.send(res, 201, null);
      }
    }
    const id = route[1];
    const client = realm.clients.get(id);
    if (!client) return this.send(res, 404, { error: "Client not found" });
    if (req.method === "GET") return this.send(res, 200, clone(client));
    if (req.method === "DELETE") {
      realm.clients.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, { error: "method_not_allowed" });
  }

  _createUser(realm, body) {
    const id = randomUUID();
    const user = {
      id,
      username: body.username,
      email: body.email || "",
      emailVerified: Boolean(body.emailVerified),
      firstName: body.firstName || "",
      lastName: body.lastName || "",
      enabled: body.enabled !== false,
      createdTimestamp: Date.now(),
      attributes: clone(body.attributes) || {},
      requiredActions: [],
      disableableCredentialTypes: [],
      totp: false,
    };
    realm.users.set(id, user);
    return user;
  }

  root() {
    return { name: "keycloak", version: "1", protocol: "keycloak-admin-rest", documentation: "/docs/keycloak.md" };
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
