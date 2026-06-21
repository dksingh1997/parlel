import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// GoTrue-style JWT (header.payload.signature), deterministic, not verifiable.
function gotrueJwt(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHash("sha256").update(`${header}.${body}.parlel`).digest());
  return `${header}.${body}.${sig}`;
}

export class SupabaseServer {
  constructor(port = 54321) {
    this.port = port;
    this.tables = new Map();
    this.users = new Map();
    // Auth (GoTrue) state — additive, keyed alongside the existing users map.
    this.authUsersByEmail = new Map();   // email -> auth user id
    this.authPasswords = new Map();       // auth user id -> password
    this.authSessions = new Map();        // access_token -> auth user id
    this.authRefreshTokens = new Map();   // refresh_token -> auth user id
    this.server = null;
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const path = url.pathname;

        let body = "";
        if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
          for await (const chunk of req) body += chunk;
        }

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");

        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }

        try {
          // REST API
          if (path.startsWith("/rest/v1/")) {
            this.handleRest(req, res, path.replace("/rest/v1/", ""), body);
          }
          // Auth API
          else if (path.startsWith("/auth/v1/")) {
            this.handleAuth(req, res, path.replace("/auth/v1/", ""), body);
          }
          // Health
          else if (path === "/rest/v1/") {
            res.writeHead(200);
            res.end(JSON.stringify({ info: { version: "1.0.0" } }));
          }
          else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "not_found" }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      this.server.listen(this.port, () => {
        console.log(`Supabase server running on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve);
      else resolve();
    });
  }

  handleRest(req, res, path, body) {
    const table = path.split("?")[0];

    if (req.method === "GET") {
      const rows = this.tables.get(table) || [];
      res.writeHead(200, { "Content-Range": `0-${rows.length - 1}/${rows.length}` });
      res.end(JSON.stringify(rows));
    } else if (req.method === "POST") {
      const data = JSON.parse(body);
      const id = data.id || randomBytes(8).toString("hex");
      const row = { id, ...data, created_at: new Date().toISOString() };
      if (!this.tables.has(table)) this.tables.set(table, []);
      this.tables.get(table).push(row);
      res.writeHead(201);
      res.end(JSON.stringify(row));
    } else if (req.method === "PATCH") {
      const data = JSON.parse(body);
      const rows = this.tables.get(table) || [];
      const idx = rows.findIndex((r) => r.id === data.id);
      if (idx !== -1) {
        rows[idx] = { ...rows[idx], ...data };
        res.writeHead(200);
        res.end(JSON.stringify(rows[idx]));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      }
    } else if (req.method === "DELETE") {
      const rows = this.tables.get(table) || [];
      const url = new URL(req.url, `http://localhost:${this.port}`);
      const id = url.searchParams.get("id");
      this.tables.set(table, rows.filter((r) => r.id !== id));
      res.writeHead(200);
      res.end(JSON.stringify({}));
    }
  }

  handleAuth(req, res, path, body) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const route = path.split("?")[0];
    const data = body ? JSON.parse(body) : {};

    // POST /auth/v1/signup
    if (route === "signup" && req.method === "POST") {
      if (!data.email) {
        res.writeHead(422);
        res.end(JSON.stringify({ code: 422, error_code: "validation_failed", msg: "Unable to validate email address" }));
        return;
      }
      const user = this._authCreateUser(data.email, data.password);
      const session = this._authIssueSession(user);
      res.writeHead(200);
      res.end(JSON.stringify({ ...session, user }));
      return;
    }

    // POST /auth/v1/token?grant_type=password|refresh_token
    if (route === "token" && req.method === "POST") {
      const grant = url.searchParams.get("grant_type") || data.grant_type || "password";

      if (grant === "refresh_token") {
        const rt = data.refresh_token;
        const uid = rt && this.authRefreshTokens.get(rt);
        const user = uid && this.users.get(uid);
        if (!user) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid Refresh Token" }));
          return;
        }
        const session = this._authIssueSession(user);
        res.writeHead(200);
        res.end(JSON.stringify({ ...session, user }));
        return;
      }

      // password grant
      const email = data.email;
      const uid = email && this.authUsersByEmail.get(email);
      const user = uid && this.users.get(uid);
      if (!user || (data.password !== undefined && this.authPasswords.get(uid) !== undefined && this.authPasswords.get(uid) !== data.password)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }));
        return;
      }
      const session = this._authIssueSession(user);
      res.writeHead(200);
      res.end(JSON.stringify({ ...session, user }));
      return;
    }

    // GET /auth/v1/user — Bearer access token resolves the user.
    if (route === "user" && req.method === "GET") {
      const auth = req.headers.authorization || "";
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const token = m ? m[1] : null;
      const uid = token && this.authSessions.get(token);
      const user = uid && this.users.get(uid);
      if (!user) {
        res.writeHead(401);
        res.end(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid claim: missing sub claim" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(user));
      return;
    }

    // POST /auth/v1/logout — revoke the bearer session.
    if (route === "logout" && req.method === "POST") {
      const auth = req.headers.authorization || "";
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const token = m ? m[1] : null;
      if (token) this.authSessions.delete(token);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not_found" }));
  }

  _authCreateUser(email, password) {
    let id = this.authUsersByEmail.get(email);
    let user = id && this.users.get(id);
    if (!user) {
      id = randomBytes(8).toString("hex");
      const ts = new Date().toISOString();
      user = {
        id,
        aud: "authenticated",
        role: "authenticated",
        email,
        email_confirmed_at: ts,
        phone: "",
        confirmed_at: ts,
        last_sign_in_at: ts,
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {},
        identities: [],
        created_at: ts,
        updated_at: ts,
      };
      this.users.set(id, user);
      this.authUsersByEmail.set(email, id);
    }
    if (password !== undefined) this.authPasswords.set(id, password);
    return user;
  }

  _authIssueSession(user) {
    const iat = Math.floor(Date.now() / 1000);
    const access_token = gotrueJwt({
      aud: "authenticated",
      exp: iat + 3600,
      iat,
      sub: user.id,
      email: user.email,
      role: "authenticated",
      session_id: randomBytes(8).toString("hex"),
    });
    const refresh_token = randomBytes(16).toString("hex");
    this.authSessions.set(access_token, user.id);
    this.authRefreshTokens.set(refresh_token, user.id);
    return {
      access_token,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: iat + 3600,
      refresh_token,
    };
  }
}
