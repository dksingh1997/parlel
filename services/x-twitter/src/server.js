import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/x-twitter — dependency-free fake of the X (Twitter) API v2.
//
// Implements tweet create/get/delete, user lookups, and likes using the real
// v2 { data: ... } wire shapes. State is in-memory and ephemeral.
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

// X API v2 error envelope.
function xError(title, detail, status, type = "about:blank") {
  return { title, detail, status, type };
}

function newId() {
  // 19-digit snowflake-ish numeric id.
  let s = "1";
  for (let i = 0; i < 18; i += 1) s += Math.floor(Math.random() * 10);
  return s;
}

export class XTwitterServer {
  constructor(port = 4800, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.tweets = new Map();
    this.likes = []; // { user_id, tweet_id }
    this._seedDefaults();
  }

  _seedDefaults() {
    this.me = {
      id: "1000000000000000001",
      name: "Parlel User",
      username: "parlel",
    };
    this.usersByUsername = new Map();
    this.usersByUsername.set("parlel", this.me);
    this.usersByUsername.set("jack", { id: "12", name: "jack", username: "jack" });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, xError("Internal Server Error", error.message || "error", 500));
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
    res.setHeader("server", "parlel-x-twitter");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (parts[0] !== "2") {
      return this.send(res, 404, xError("Not Found Error", "The requested resource was not found.", 404));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, {
        title: "Unauthorized",
        type: "about:blank",
        status: 401,
        detail: "Unauthorized",
      });
    }

    const route = parts.slice(1);

    // POST /2/tweets
    if (req.method === "POST" && route[0] === "tweets" && route.length === 1) {
      if (!isPlainObject(body) || typeof body.text !== "string" || body.text.length === 0) {
        return this.send(res, 400, {
          errors: [{
            parameters: { text: [] },
            message: "The `text` field is required and must not be empty.",
          }],
          title: "Invalid Request",
          detail: "One or more parameters to your request was invalid.",
          type: "https://api.twitter.com/2/problems/invalid-request",
        });
      }
      const id = newId();
      const tweet = {
        id,
        text: body.text,
        edit_history_tweet_ids: [id],
        author_id: this.me.id,
        created_at: new Date().toISOString(),
      };
      this.tweets.set(id, tweet);
      return this.send(res, 201, { data: { id, text: tweet.text, edit_history_tweet_ids: [id] } });
    }

    // GET/DELETE /2/tweets/:id
    if (route[0] === "tweets" && route.length === 2) {
      const id = route[1];
      if (req.method === "GET") {
        const tweet = this.tweets.get(id);
        if (!tweet) {
          return this.send(res, 200, {
            errors: [{
              value: id,
              detail: `Could not find tweet with id: [${id}].`,
              title: "Not Found Error",
              resource_type: "tweet",
              parameter: "id",
              resource_id: id,
              type: "https://api.twitter.com/2/problems/resource-not-found",
            }],
          });
        }
        return this.send(res, 200, { data: { id: tweet.id, text: tweet.text, edit_history_tweet_ids: tweet.edit_history_tweet_ids } });
      }
      if (req.method === "DELETE") {
        const existed = this.tweets.delete(id);
        return this.send(res, 200, { data: { deleted: existed } });
      }
      return this.send(res, 405, xError("Method Not Allowed", "method not allowed", 405));
    }

    // GET /2/users/me
    if (req.method === "GET" && route[0] === "users" && route[1] === "me" && route.length === 2) {
      return this.send(res, 200, { data: clone(this.me) });
    }

    // GET /2/users/by/username/:username
    if (req.method === "GET" && route[0] === "users" && route[1] === "by" && route[2] === "username" && route.length === 4) {
      const username = route[3];
      const user = this.usersByUsername.get(username);
      if (!user) {
        return this.send(res, 200, {
          errors: [{
            value: username,
            detail: `Could not find user with username: [${username}].`,
            title: "Not Found Error",
            resource_type: "user",
            parameter: "username",
            resource_id: username,
            type: "https://api.twitter.com/2/problems/resource-not-found",
          }],
        });
      }
      return this.send(res, 200, { data: clone(user) });
    }

    // POST /2/users/:id/likes
    if (req.method === "POST" && route[0] === "users" && route[2] === "likes" && route.length === 3) {
      const userId = route[1];
      const tweetId = isPlainObject(body) ? body.tweet_id : undefined;
      if (typeof tweetId !== "string" || !tweetId) {
        return this.send(res, 400, {
          errors: [{ message: "The `tweet_id` field is required.", parameters: { tweet_id: [] } }],
          title: "Invalid Request",
          detail: "One or more parameters to your request was invalid.",
          type: "https://api.twitter.com/2/problems/invalid-request",
        });
      }
      this.likes.push({ user_id: userId, tweet_id: tweetId });
      return this.send(res, 200, { data: { liked: true } });
    }

    return this.send(res, 404, xError("Not Found Error", "The requested resource was not found.", 404));
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "tweets") {
      return this.send(res, 200, { tweets: Array.from(this.tweets.values()).map(clone), count: this.tweets.size });
    }
    if (req.method === "GET" && parts[1] === "likes") {
      return this.send(res, 200, { likes: clone(this.likes), count: this.likes.length });
    }
    return this.send(res, 404, xError("Not Found Error", "not found", 404));
  }

  root() {
    return {
      name: "x-twitter",
      version: "1",
      protocol: "x-api-v2",
      documentation: "/docs/x-twitter.md",
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
          this.send(res, 400, xError("Invalid Request", "Bad request body", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, xError("Invalid Request", "Bad request body", 400));
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
