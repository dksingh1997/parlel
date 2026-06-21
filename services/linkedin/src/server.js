import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/linkedin — dependency-free fake of the LinkedIn API.
//
// Implements post creation (the legacy /v2/ugcPosts and the newer /rest/posts),
// profile lookup (/v2/me) and OpenID userinfo (/v2/userinfo). State is in-memory
// and ephemeral; created posts are captured for inspection.
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

// LinkedIn error envelope: { message, serviceErrorCode, status }
function linkedinError(status, message, serviceErrorCode = 0) {
  return { message, serviceErrorCode, status };
}

function newPostId() {
  // urn:li:share:<numeric> style id fragment
  return Date.now().toString() + randomBytes(2).readUInt16BE(0);
}

export class LinkedinServer {
  constructor(port = 4799, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.posts = [];
    this._seedDefaults();
  }

  _seedDefaults() {
    this.profile = {
      id: "parlelMember001",
      localizedFirstName: "Parlel",
      localizedLastName: "User",
      firstName: { localized: { en_US: "Parlel" }, preferredLocale: { country: "US", language: "en" } },
      lastName: { localized: { en_US: "User" }, preferredLocale: { country: "US", language: "en" } },
    };
    this.userinfo = {
      sub: "parlelMember001",
      email_verified: true,
      name: "Parlel User",
      locale: { country: "US", language: "en" },
      given_name: "Parlel",
      family_name: "User",
      email: "user@parlel.dev",
      picture: "https://media.licdn.com/parlel/avatar.png",
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, linkedinError(500, error.message || "Internal server error"));
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
      if (!this.server) {
        resolve();
        return;
      }
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Restli-Protocol-Version, LinkedIn-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-linkedin");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    const known = parts[0] === "v2" || parts[0] === "rest";
    if (!known) {
      return this.send(res, 404, linkedinError(404, "Not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, linkedinError(401, "Invalid access token", 65600));
    }

    // POST /v2/ugcPosts
    if (req.method === "POST" && parts[0] === "v2" && parts[1] === "ugcPosts" && parts.length === 2) {
      const id = `urn:li:ugcPost:${newPostId()}`;
      this.posts.push({ id, api: "ugcPosts", body: clone(body) });
      res.setHeader("x-restli-id", id);
      return this.send(res, 201, { id });
    }

    // POST /rest/posts
    if (req.method === "POST" && parts[0] === "rest" && parts[1] === "posts" && parts.length === 2) {
      const id = `urn:li:share:${newPostId()}`;
      this.posts.push({ id, api: "posts", body: clone(body) });
      res.setHeader("x-restli-id", id);
      // The /rest/posts endpoint returns 201 with the id in the header and empty body.
      return this.send(res, 201, null);
    }

    // GET /v2/me
    if (req.method === "GET" && parts[0] === "v2" && parts[1] === "me" && parts.length === 2) {
      return this.send(res, 200, clone(this.profile));
    }

    // GET /v2/userinfo (OpenID Connect)
    if (req.method === "GET" && parts[0] === "v2" && parts[1] === "userinfo" && parts.length === 2) {
      return this.send(res, 200, clone(this.userinfo));
    }

    return this.send(res, 404, linkedinError(404, "Not found"));
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "posts") {
      return this.send(res, 200, { posts: clone(this.posts), count: this.posts.length });
    }
    return this.send(res, 404, linkedinError(404, "not found"));
  }

  root() {
    return {
      name: "linkedin",
      version: "1",
      protocol: "linkedin-v2",
      documentation: "/docs/linkedin.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, linkedinError(400, "Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, linkedinError(400, "Bad request body"));
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
