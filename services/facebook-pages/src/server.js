import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/facebook-pages — dependency-free fake of the Facebook Graph API
// (Pages). Implements me, page lookup, feed publishing, post listing and
// page accounts using the real Graph wire shapes. access_token is accepted
// via ?access_token= query OR an Authorization: Bearer header.
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

// Graph API error envelope.
function fbError(message, type, code, subcode) {
  const error = {
    message,
    type,
    code,
    fbtrace_id: randomBytes(8).toString("base64").replace(/[+/=]/g, "").slice(0, 11),
  };
  if (subcode !== undefined) error.error_subcode = subcode;
  return { error };
}

function newPostId(pageId) {
  let s = "";
  for (let i = 0; i < 15; i += 1) s += Math.floor(Math.random() * 10);
  return `${pageId}_${s}`;
}

export class FacebookPagesServer {
  constructor(port = 4801, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.posts = new Map(); // postId -> post (with _pageId)
    this._seedDefaults();
  }

  _seedDefaults() {
    this.me = { id: "1000000000000001", name: "Parlel User" };
    this.pages = new Map();
    const page = {
      id: "2000000000000002",
      name: "Parlel Page",
      access_token: `parlel.${randomBytes(12).toString("hex")}`,
      category: "Software",
      category_list: [{ id: "2700", name: "Software" }],
      tasks: ["ANALYZE", "ADVERTISE", "MESSAGING", "MODERATE", "CREATE_CONTENT", "MANAGE"],
    };
    this.pages.set(page.id, page);
    this._defaultPageId = page.id;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, fbError(error.message || "Internal server error", "OAuthException", 1));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-facebook-pages");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // Graph versioned path, e.g. /v18.0/...
    if (!/^v\d+\.\d+$/.test(parts[0] || "")) {
      return this.send(res, 404, fbError("Unknown path", "GraphMethodException", 100));
    }

    if (!this.isAuthorized(req, url, body)) {
      return this.send(res, 401, fbError(
        "An active access token must be used to query information about the current user.",
        "OAuthException",
        2500,
      ));
    }

    const route = parts.slice(1); // after version

    // GET /v18.0/me
    if (req.method === "GET" && route[0] === "me" && route.length === 1) {
      return this.send(res, 200, clone(this.me));
    }

    // GET /v18.0/me/accounts
    if (req.method === "GET" && route[0] === "me" && route[1] === "accounts" && route.length === 2) {
      return this.send(res, 200, {
        data: Array.from(this.pages.values()).map(clone),
        paging: { cursors: { before: "MA", after: "MA" } },
      });
    }

    // Node-level operations: /v18.0/:nodeId[/edge]
    const nodeId = route[0];

    // GET /v18.0/:pageId/posts  or  POST /v18.0/:pageId/feed
    if (route.length === 2) {
      const edge = route[1];
      if (req.method === "GET" && edge === "posts") {
        const data = Array.from(this.posts.values())
          .filter((p) => p._pageId === nodeId)
          .map((p) => ({ id: p.id, message: p.message, created_time: p.created_time, story: p.story }));
        return this.send(res, 200, {
          data,
          paging: { cursors: { before: "MA", after: "MA" } },
        });
      }
      if (req.method === "POST" && edge === "feed") {
        const message = isPlainObject(body) ? body.message : undefined;
        if ((typeof message !== "string" || !message) && !(isPlainObject(body) && body.link)) {
          return this.send(res, 400, fbError(
            "(#100) Param message or link is required",
            "OAuthException",
            100,
          ));
        }
        const id = newPostId(nodeId);
        const post = {
          id,
          _pageId: nodeId,
          message: typeof message === "string" ? message : "",
          link: isPlainObject(body) ? body.link : undefined,
          story: typeof message === "string" ? message : "",
          created_time: new Date().toISOString(),
        };
        this.posts.set(id, post);
        return this.send(res, 200, { id });
      }
      return this.send(res, 404, fbError("Unsupported get request.", "GraphMethodException", 100));
    }

    // GET /v18.0/:pageId  (or a post id)
    if (req.method === "GET" && route.length === 1) {
      const page = this.pages.get(nodeId);
      if (page) {
        return this.send(res, 200, { id: page.id, name: page.name, category: page.category });
      }
      const post = this.posts.get(nodeId);
      if (post) {
        return this.send(res, 200, { id: post.id, message: post.message, created_time: post.created_time });
      }
      // Unknown nodes still 200 with a basic id echo in Graph; but emit a not-found error here.
      return this.send(res, 404, fbError(
        `(#803) Some of the aliases you requested do not exist: ${nodeId}`,
        "OAuthException",
        803,
      ));
    }

    return this.send(res, 404, fbError("Unknown path", "GraphMethodException", 100));
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "posts") {
      return this.send(res, 200, {
        posts: Array.from(this.posts.values()).map(clone),
        count: this.posts.size,
      });
    }
    return this.send(res, 404, fbError("not found", "GraphMethodException", 100));
  }

  root() {
    return {
      name: "facebook-pages",
      version: "1",
      protocol: "facebook-graph",
      documentation: "/docs/facebook-pages.md",
    };
  }

  isAuthorized(req, url, body) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    const qToken = url.searchParams.get("access_token");
    if (qToken && qToken.length > 0) return true;
    if (isPlainObject(body) && typeof body.access_token === "string" && body.access_token.length > 0) return true;
    return false;
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
        const ct = (req.headers["content-type"] || "").toLowerCase();
        if (ct.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params.entries()) obj[k] = v;
          resolve(obj);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, fbError("Bad request body", "OAuthException", 100));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, fbError("Bad request body", "OAuthException", 100));
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
