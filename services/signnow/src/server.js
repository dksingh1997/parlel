import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/signnow — dependency-free in-memory fake of the SignNow API.
// POST /oauth2/token issues a bearer access token (Basic-authed). All other
// document/user routes accept Bearer. Document shape: { id, document_name, ... }.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hexId(len = 40) {
  return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

export class SignnowServer {
  constructor(port = 4852, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.documents = new Map();
    this.user = {
      id: hexId(40),
      first_name: "Parlel",
      last_name: "User",
      active: "1",
      type: 1,
      primary_email: "user@parlel.dev",
      emails: ["user@parlel.dev"],
      organization: { id: hexId(40), name: "Parlel" },
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: "internal_error", error_description: error.message });
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-signnow");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // POST /oauth2/token — issue an access token. Authed via Basic (client creds).
    if (req.method === "POST" && parts[0] === "oauth2" && parts[1] === "token" && parts.length === 2) {
      const auth = req.headers.authorization || "";
      if (this.requireAuth && !/^Basic\s+\S+/i.test(auth) && !isPlainObject(body)) {
        return this.send(res, 401, { error: "invalid_client" });
      }
      const token = hexId(40);
      return this.send(res, 200, {
        access_token: token,
        token_type: "bearer",
        expires_in: 2592000,
        refresh_token: hexId(40),
        scope: "*",
        last_login: 0,
      });
    }

    // GET /oauth2/token — token verification
    if (req.method === "GET" && parts[0] === "oauth2" && parts[1] === "token" && parts.length === 2) {
      if (!this.isBearer(req)) return this.unauthorized(res);
      return this.send(res, 200, { token_type: "bearer", scope: "*", expires_in: 2592000 });
    }

    // All remaining endpoints require a Bearer token.
    if (!this.isBearer(req)) {
      return this.unauthorized(res);
    }

    // GET /user
    if (req.method === "GET" && parts[0] === "user" && parts.length === 1) {
      return this.send(res, 200, clone(this.user));
    }

    // /document ...
    if (parts[0] === "document") {
      // POST /document  (upload)
      if (parts.length === 1) {
        if (req.method === "POST") {
          return this.createDocument(res, body);
        }
        if (req.method === "GET") {
          // GET /document — list user documents
          return this.send(res, 200, Array.from(this.documents.values()).map(clone));
        }
      }

      const docId = parts[1];
      const doc = this.documents.get(docId);

      // GET /document/:id
      if (parts.length === 2 && req.method === "GET") {
        if (!doc) return this.notFound(res);
        return this.send(res, 200, clone(doc));
      }
      // DELETE /document/:id
      if (parts.length === 2 && req.method === "DELETE") {
        if (!doc) return this.notFound(res);
        this.documents.delete(docId);
        return this.send(res, 200, { status: "success" });
      }
      // POST /document/:id/invite
      if (parts.length === 3 && parts[2] === "invite" && req.method === "POST") {
        if (!doc) return this.notFound(res);
        const invites = isPlainObject(body) && Array.isArray(body.to) ? body.to : [];
        doc.invites = invites.map((to, i) => ({
          id: hexId(40),
          email: to.email || `signer${i}@parlel.dev`,
          role: to.role || "Signer 1",
          status: "pending",
        }));
        doc.status = "pending";
        return this.send(res, 200, { status: "success" });
      }
      // POST /document/:id/download — fieldextract or download link
      if (parts.length === 3 && parts[2] === "download" && req.method === "GET") {
        if (!doc) return this.notFound(res);
        return this.send(res, 200, { url: `http://${this.host}:${this.port}/document/${docId}/file` });
      }
    }

    return this.notFound(res);
  }

  createDocument(res, body) {
    const data = isPlainObject(body) ? body : {};
    const id = hexId(40);
    const doc = {
      id,
      document_name: data.document_name || data.name || "document.pdf",
      page_count: data.page_count || 1,
      created: "1704067200",
      updated: "1704067200",
      original_filename: data.document_name || "document.pdf",
      owner: this.user.primary_email,
      thumbnail: { small: "", medium: "", large: "" },
      roles: [],
      signatures: [],
      fields: [],
      invites: [],
      status: "uploaded",
    };
    this.documents.set(id, doc);
    return this.send(res, 200, { id });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.notFound(res);
  }

  unauthorized(res) {
    return this.send(res, 401, { error: "access_denied", error_description: "The access token provided is invalid." });
  }

  notFound(res) {
    return this.send(res, 404, { error: "not_found", "404": "Unable to find a route to match the URI" });
  }

  root() {
    return {
      name: "signnow",
      version: "1",
      protocol: "signnow-api",
      documentation: "/docs/signnow.md",
    };
  }

  isBearer(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        const ct = String(req.headers["content-type"] || "");
        if (ct.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          return resolve(obj);
        }
        if (ct.includes("multipart/form-data")) {
          return resolve({});
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
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
