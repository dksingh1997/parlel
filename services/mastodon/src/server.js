import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mastodon — dependency-free fake of the Mastodon API.
//
// Implements status create/get/delete, credential verification, and the home
// timeline using the real Status/Account wire shapes. Bearer auth. State is
// in-memory and ephemeral.
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

// Mastodon error envelope: { error: "..." } (sometimes with error_description)
function mastoError(error, description) {
  const out = { error };
  if (description) out.error_description = description;
  return out;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export class MastodonServer {
  constructor(port = 4806, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.statuses = new Map();
    // Mastodon snowflake-style ids are large; keep a numeric counter in the
    // safe-integer range and render with a fixed high prefix so ids stay
    // monotonic and unique.
    this.statusCounter = 0;
    this._seedDefaults();
  }

  _seedDefaults() {
    this.account = {
      id: "1",
      username: "parlel",
      acct: "parlel",
      display_name: "Parlel User",
      locked: false,
      bot: false,
      created_at: "2020-01-01T00:00:00.000Z",
      note: "<p>The parlel test account.</p>",
      url: "https://mastodon.parlel.dev/@parlel",
      avatar: "https://mastodon.parlel.dev/avatars/parlel.png",
      avatar_static: "https://mastodon.parlel.dev/avatars/parlel.png",
      header: "https://mastodon.parlel.dev/headers/parlel.png",
      header_static: "https://mastodon.parlel.dev/headers/parlel.png",
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      last_status_at: null,
      emojis: [],
      fields: [],
      source: {
        privacy: "public",
        sensitive: false,
        language: "en",
        note: "The parlel test account.",
        fields: [],
        follow_requests_count: 0,
      },
    };
  }

  _nextStatusId() {
    this.statusCounter += 1;
    return `1090${String(this.statusCounter).padStart(14, "0")}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, mastoError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-mastodon");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (parts[0] !== "api" || parts[1] !== "v1") {
      return this.send(res, 404, mastoError("Record not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, mastoError("The access token is invalid"));
    }

    const route = parts.slice(2); // after api/v1

    // POST /api/v1/statuses
    if (req.method === "POST" && route[0] === "statuses" && route.length === 1) {
      const data = isPlainObject(body) ? body : {};
      if (typeof data.status !== "string" || data.status.length === 0) {
        // status can be empty only if media is attached; we don't support media.
        if (!data.media_ids || (Array.isArray(data.media_ids) && data.media_ids.length === 0)) {
          return this.send(res, 422, mastoError("Validation failed: Text can't be blank"));
        }
      }
      const status = this._createStatus(data);
      return this.send(res, 200, this._publicStatus(status));
    }

    // GET /api/v1/timelines/home
    if (req.method === "GET" && route[0] === "timelines" && route[1] === "home" && route.length === 2) {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 40);
      const items = Array.from(this.statuses.values())
        .sort((a, b) => b._seq - a._seq)
        .slice(0, limit)
        .map((s) => this._publicStatus(s));
      return this.send(res, 200, items);
    }

    // GET/DELETE /api/v1/statuses/:id
    if (route[0] === "statuses" && route.length === 2) {
      const id = route[1];
      const status = this.statuses.get(id);
      if (!status) return this.send(res, 404, mastoError("Record not found"));
      if (req.method === "GET") return this.send(res, 200, this._publicStatus(status));
      if (req.method === "DELETE") {
        this.statuses.delete(id);
        this.account.statuses_count = Math.max(0, this.account.statuses_count - 1);
        // Mastodon returns the deleted status (with source text) on DELETE.
        return this.send(res, 200, this._publicStatus(status));
      }
      return this.send(res, 405, mastoError("Method not allowed"));
    }

    // GET /api/v1/accounts/verify_credentials
    if (req.method === "GET" && route[0] === "accounts" && route[1] === "verify_credentials" && route.length === 2) {
      return this.send(res, 200, clone(this.account));
    }

    return this.send(res, 404, mastoError("Record not found"));
  }

  _publicStatus(status) {
    const { _seq, ...rest } = status;
    return clone(rest);
  }

  _createStatus(data) {
    const id = this._nextStatusId();
    const text = typeof data.status === "string" ? data.status : "";
    const visibility = data.visibility || "public";
    const status = {
      _seq: this.statusCounter,
      id,
      created_at: new Date().toISOString(),
      in_reply_to_id: data.in_reply_to_id || null,
      in_reply_to_account_id: null,
      sensitive: Boolean(data.sensitive),
      spoiler_text: data.spoiler_text || "",
      visibility,
      language: data.language || "en",
      uri: `https://mastodon.parlel.dev/users/parlel/statuses/${id}`,
      url: `https://mastodon.parlel.dev/@parlel/${id}`,
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      favourited: false,
      reblogged: false,
      muted: false,
      bookmarked: false,
      pinned: false,
      content: `<p>${escapeHtml(text)}</p>`,
      reblog: null,
      application: { name: "parlel", website: null },
      account: clone(this.account),
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
      card: null,
      poll: null,
    };
    this.statuses.set(id, status);
    this.account.statuses_count += 1;
    this.account.last_status_at = status.created_at.slice(0, 10);
    return status;
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "statuses") {
      return this.send(res, 200, {
        statuses: Array.from(this.statuses.values()).map((s) => this._publicStatus(s)),
        count: this.statuses.size,
      });
    }
    return this.send(res, 404, mastoError("Record not found"));
  }

  root() {
    return {
      name: "mastodon",
      version: "1",
      protocol: "mastodon-api",
      documentation: "/docs/mastodon.md",
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
          this.send(res, 400, mastoError("Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, mastoError("Bad request body"));
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
