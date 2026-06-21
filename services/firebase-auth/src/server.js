import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/firebase-auth — dependency-free fake of the Firebase Auth REST API
// (Identity Toolkit). In-memory, ephemeral, deterministic.
//   Client endpoints (?key=): :signUp, :signInWithPassword, :lookup, :update, :delete
//   Admin endpoints (Bearer): POST /v1/projects/:projectId/accounts
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
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

// Identity Toolkit error envelope: { error: { code, message, errors: [...] } }
function itError(status, message) {
  return {
    status,
    body: {
      error: {
        code: status,
        message,
        errors: [{ message, domain: "global", reason: "invalid" }],
      },
    },
  };
}

export class FirebaseAuthServer {
  constructor(port = 4820, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();       // localId -> user
    this.byEmail = new Map();     // email -> localId
    this.refreshTokens = new Map();
    this.counter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          const e = itError(500, error.message);
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
    res.setHeader("server", "parlel-firebase-auth");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, itError(404, "NOT_FOUND").body);
    }

    if (parts[0] !== "v1") {
      return this.send(res, 404, itError(404, "NOT_FOUND").body);
    }

    // Admin: POST /v1/projects/:projectId/accounts (Bearer auth).
    if (parts[1] === "projects" && parts[3] === "accounts" && req.method === "POST") {
      if (!this.bearer(req)) {
        return this.send(res, 401, itError(401, "MISSING_OR_INVALID_CREDENTIAL").body);
      }
      const user = this._upsertUser(body, true);
      return this.send(res, 200, { kind: "identitytoolkit#SignupNewUserResponse", localId: user.localId, email: user.email });
    }

    // Client endpoints: /v1/accounts:<action>?key=...
    if (parts.length === 2 && parts[1].startsWith("accounts:")) {
      const key = url.searchParams.get("key");
      if (this.requireAuth && !key) {
        return this.send(res, 401, itError(401, "API key not valid. Please pass a valid API key.").body);
      }
      if (req.method !== "POST") {
        return this.send(res, 405, itError(405, "METHOD_NOT_ALLOWED").body);
      }
      const action = parts[1].slice("accounts:".length);
      return this.handleAccountAction(res, action, body);
    }

    return this.send(res, 404, itError(404, "NOT_FOUND").body);
  }

  handleAccountAction(res, action, body) {
    switch (action) {
      case "signUp":
        return this.signUp(res, body);
      case "signInWithPassword":
        return this.signInWithPassword(res, body);
      case "lookup":
        return this.lookup(res, body);
      case "update":
        return this.update(res, body);
      case "delete":
        return this.deleteAccount(res, body);
      case "sendOobCode":
        return this.send(res, 200, { kind: "identitytoolkit#GetOobConfirmationCodeResponse", email: body.email });
      default:
        return this.send(res, 404, itError(404, "NOT_FOUND").body);
    }
  }

  signUp(res, body) {
    if (body.email && !EMAIL_RE.test(body.email)) {
      return this.send(res, 400, itError(400, "INVALID_EMAIL").body);
    }
    if (body.email && this.byEmail.has(body.email)) {
      return this.send(res, 400, itError(400, "EMAIL_EXISTS").body);
    }
    const user = this._upsertUser(body, false);
    const tokens = this._issueTokens(user);
    return this.send(res, 200, {
      kind: "identitytoolkit#SignupNewUserResponse",
      idToken: tokens.idToken,
      email: user.email || "",
      refreshToken: tokens.refreshToken,
      expiresIn: "3600",
      localId: user.localId,
    });
  }

  signInWithPassword(res, body) {
    if (!body.email || !this.byEmail.has(body.email)) {
      return this.send(res, 400, itError(400, "EMAIL_NOT_FOUND").body);
    }
    const user = this.users.get(this.byEmail.get(body.email));
    if (body.password !== undefined && user.password !== undefined && user.password !== body.password) {
      return this.send(res, 400, itError(400, "INVALID_PASSWORD").body);
    }
    const tokens = this._issueTokens(user);
    return this.send(res, 200, {
      kind: "identitytoolkit#VerifyPasswordResponse",
      localId: user.localId,
      email: user.email,
      displayName: user.displayName || "",
      idToken: tokens.idToken,
      registered: true,
      refreshToken: tokens.refreshToken,
      expiresIn: "3600",
    });
  }

  lookup(res, body) {
    let matches = [];
    if (Array.isArray(body.localId)) {
      matches = body.localId.map((id) => this.users.get(id)).filter(Boolean);
    } else if (body.idToken) {
      const localId = this._localIdFromToken(body.idToken);
      const user = localId && this.users.get(localId);
      if (user) matches = [user];
    } else if (Array.isArray(body.email)) {
      matches = body.email.map((e) => this.users.get(this.byEmail.get(e))).filter(Boolean);
    }
    if (matches.length === 0) {
      return this.send(res, 400, itError(400, "USER_NOT_FOUND").body);
    }
    return this.send(res, 200, {
      kind: "identitytoolkit#GetAccountInfoResponse",
      users: matches.map((u) => this._accountInfo(u)),
    });
  }

  update(res, body) {
    let user = null;
    if (body.idToken) user = this.users.get(this._localIdFromToken(body.idToken));
    else if (body.localId) user = this.users.get(body.localId);
    if (!user) {
      return this.send(res, 400, itError(400, "USER_NOT_FOUND").body);
    }
    if (typeof body.email === "string" && EMAIL_RE.test(body.email)) {
      if (user.email) this.byEmail.delete(user.email);
      user.email = body.email;
      this.byEmail.set(body.email, user.localId);
    }
    if (typeof body.displayName === "string") user.displayName = body.displayName;
    if (typeof body.photoUrl === "string") user.photoUrl = body.photoUrl;
    if (typeof body.password === "string") user.password = body.password;
    if (typeof body.emailVerified === "boolean") user.emailVerified = body.emailVerified;
    if (typeof body.disabled === "boolean") user.disabled = body.disabled;
    return this.send(res, 200, {
      kind: "identitytoolkit#SetAccountInfoResponse",
      localId: user.localId,
      email: user.email,
      displayName: user.displayName || "",
      emailVerified: Boolean(user.emailVerified),
    });
  }

  deleteAccount(res, body) {
    let user = null;
    if (body.idToken) user = this.users.get(this._localIdFromToken(body.idToken));
    else if (body.localId) user = this.users.get(body.localId);
    if (!user) {
      return this.send(res, 400, itError(400, "USER_NOT_FOUND").body);
    }
    if (user.email) this.byEmail.delete(user.email);
    this.users.delete(user.localId);
    return this.send(res, 200, { kind: "identitytoolkit#DeleteAccountResponse" });
  }

  _upsertUser(body, admin) {
    if (body.localId && this.users.has(body.localId)) {
      return this.users.get(body.localId);
    }
    this.counter += 1;
    const localId = body.localId || createHash("sha256").update(`${body.email || "anon"}:${this.counter}`).digest("hex").slice(0, 28);
    const user = {
      localId,
      email: body.email || "",
      emailVerified: Boolean(body.emailVerified),
      displayName: body.displayName || "",
      photoUrl: body.photoUrl || "",
      password: body.password,
      disabled: Boolean(body.disabled),
      createdAt: String(Date.now()),
      lastLoginAt: String(Date.now()),
      providerUserInfo: body.email
        ? [{ providerId: "password", federatedId: body.email, email: body.email, rawId: body.email }]
        : [],
    };
    this.users.set(localId, user);
    if (user.email) this.byEmail.set(user.email, localId);
    return user;
  }

  _issueTokens(user) {
    const iat = Math.floor(Date.now() / 1000);
    const idToken = makeJwt({
      iss: `https://securetoken.google.com/parlel`,
      aud: "parlel",
      auth_time: iat,
      user_id: user.localId,
      sub: user.localId,
      iat,
      exp: iat + 3600,
      email: user.email,
      email_verified: Boolean(user.emailVerified),
      firebase: { identities: { email: [user.email] }, sign_in_provider: "password" },
    });
    const refreshToken = `${user.localId}:${randomBytes(16).toString("hex")}`;
    this.refreshTokens.set(refreshToken, user.localId);
    return { idToken, refreshToken };
  }

  _localIdFromToken(idToken) {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
      return payload.user_id || payload.sub;
    } catch {
      return null;
    }
  }

  _accountInfo(u) {
    return {
      localId: u.localId,
      email: u.email,
      emailVerified: Boolean(u.emailVerified),
      displayName: u.displayName || "",
      photoUrl: u.photoUrl || "",
      passwordHash: u.password ? b64url(createHash("sha256").update(u.password).digest()) : undefined,
      disabled: Boolean(u.disabled),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      providerUserInfo: u.providerUserInfo,
    };
  }

  root() {
    return { name: "firebase-auth", version: "1", protocol: "identitytoolkit-v1", documentation: "/docs/firebase-auth.md" };
  }

  bearer(req) {
    const auth = req.headers.authorization || "";
    const m = /^Bearer\s+(\S+)/i.exec(auth);
    return m ? m[1] : null;
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
          this.send(res, 400, itError(400, "Invalid JSON payload received.").body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, itError(400, "Invalid JSON payload received.").body);
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
