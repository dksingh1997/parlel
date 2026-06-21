import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/reddit — dependency-free fake of the Reddit API.
//
// Implements OAuth token issuance, identity, subreddit listings, submission,
// and subreddit about using the real Reddit Listing/Thing wire shapes.
// Bearer auth + a User-Agent header are required (matching Reddit's rules).
// State is in-memory and ephemeral.
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

function base36(n) {
  return n.toString(36);
}

function listing(children, after = null, before = null) {
  return {
    kind: "Listing",
    data: {
      after,
      dist: children.length,
      modhash: "",
      geo_filter: "",
      children,
      before,
    },
  };
}

export class RedditServer {
  constructor(port = 4804, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.posts = new Map(); // id36 -> t3 data
    this.postCounter = 1000;
    this._seedDefaults();
  }

  _seedDefaults() {
    this.me = {
      kind: "t2",
      id: "parlel01",
      name: "parlel",
      created: 1577836800,
      created_utc: 1577836800,
      link_karma: 1,
      comment_karma: 0,
      is_gold: false,
      is_mod: false,
      has_verified_email: true,
    };
    this.subreddits = new Map();
    this.subreddits.set("test", {
      kind: "t5",
      id: "2qh23",
      display_name: "test",
      title: "Testing Ground",
      public_description: "A subreddit for testing.",
      subscribers: 12345,
      url: "/r/test/",
      over18: false,
      created_utc: 1201233135,
    });
    // Seed a couple of hot posts for r/test.
    for (let i = 0; i < 2; i += 1) {
      this.postCounter += 1;
      const id = base36(this.postCounter);
      this.posts.set(id, {
        id,
        name: `t3_${id}`,
        subreddit: "test",
        title: `Seeded hot post ${i + 1}`,
        author: "parlel",
        selftext: "",
        url: `https://reddit.com/r/test/comments/${id}/`,
        permalink: `/r/test/comments/${id}/seeded_hot_post/`,
        score: 100 - i,
        ups: 100 - i,
        num_comments: i,
        created_utc: 1577836800 + i,
        over_18: false,
        stickied: false,
      });
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message || "Internal Server Error", error: 500 });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, User-Agent");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-reddit");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // POST /api/v1/access_token — OAuth token (client credentials / password / refresh).
    // Authenticated with HTTP Basic (client id:secret); we accept any Basic/Bearer or none here.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "access_token") {
      return this.send(res, 200, {
        access_token: `parlel.${randomBytes(16).toString("hex")}`,
        token_type: "bearer",
        expires_in: 3600,
        scope: "*",
      });
    }

    // All other endpoints require a bearer token AND a User-Agent.
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { message: "Unauthorized", error: 401 });
    }
    // Reddit requires a unique, descriptive User-Agent and rejects missing or
    // generic library defaults (e.g. "node", "python-requests").
    const ua = (req.headers["user-agent"] || "").trim();
    if (!ua || /^(node|python-requests|okhttp|axios|go-http-client|java)\b/i.test(ua)) {
      return this.send(res, 429, {
        message: "Too Many Requests",
        error: 429,
        reason: "A unique, descriptive User-Agent header is required.",
      });
    }

    // GET /api/v1/me
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "me" && parts.length === 3) {
      return this.send(res, 200, clone(this.me));
    }

    // POST /api/submit
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "submit" && parts.length === 2) {
      const data = isPlainObject(body) ? body : {};
      const sr = data.sr || data.subreddit;
      if (typeof sr !== "string" || !sr || typeof data.title !== "string" || !data.title) {
        return this.send(res, 200, {
          json: {
            errors: [["NO_TEXT", "we need something here", "title"]],
          },
        });
      }
      this.postCounter += 1;
      const id = base36(this.postCounter);
      const kind = data.kind === "link" ? "link" : "self";
      const post = {
        id,
        name: `t3_${id}`,
        subreddit: sr,
        title: data.title,
        author: this.me.name,
        selftext: kind === "self" ? (data.text || "") : "",
        url: kind === "link" ? (data.url || "") : `https://www.reddit.com/r/${sr}/comments/${id}/`,
        permalink: `/r/${sr}/comments/${id}/${encodeURIComponent(String(data.title).toLowerCase().replace(/\s+/g, "_"))}/`,
        score: 1,
        ups: 1,
        num_comments: 0,
        created_utc: Math.floor(Date.now() / 1000),
        over_18: Boolean(data.nsfw),
        stickied: false,
      };
      this.posts.set(id, post);
      return this.send(res, 200, {
        json: {
          errors: [],
          data: {
            url: post.url,
            drafts_count: 0,
            id,
            name: post.name,
          },
        },
      });
    }

    // GET /r/:subreddit/hot.json
    if (req.method === "GET" && parts[0] === "r" && parts.length === 3 && parts[2] === "hot.json") {
      const sub = parts[1];
      const children = Array.from(this.posts.values())
        .filter((p) => p.subreddit === sub)
        .sort((a, b) => b.score - a.score)
        .map((p) => ({ kind: "t3", data: clone(p) }));
      const after = children.length ? children[children.length - 1].data.name : null;
      return this.send(res, 200, listing(children, after));
    }

    // GET /r/:subreddit/about.json
    if (req.method === "GET" && parts[0] === "r" && parts.length === 3 && parts[2] === "about.json") {
      const sub = parts[1];
      const sr = this.subreddits.get(sub) || {
        kind: "t5",
        id: base36(2000 + sub.length),
        display_name: sub,
        title: sub,
        public_description: "",
        subscribers: 0,
        url: `/r/${sub}/`,
        over18: false,
        created_utc: 1201233135,
      };
      return this.send(res, 200, { kind: "t5", data: clone(sr) });
    }

    return this.send(res, 404, { message: "Not Found", error: 404 });
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
    return this.send(res, 404, { message: "Not Found", error: 404 });
  }

  root() {
    return {
      name: "reddit",
      version: "1",
      protocol: "reddit-api",
      documentation: "/docs/reddit.md",
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
          // Reddit form posts often aren't JSON; fall back to urlencoded parse.
          try {
            const params = new URLSearchParams(data);
            const obj = {};
            for (const [k, v] of params.entries()) obj[k] = v;
            if (Object.keys(obj).length > 0) {
              resolve(obj);
              return;
            }
          } catch {
            // ignore
          }
          this.send(res, 400, { message: "Bad Request", error: 400 });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Bad Request", error: 400 });
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
