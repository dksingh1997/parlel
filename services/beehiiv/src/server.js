import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/beehiiv — a tiny, dependency-free fake of the beehiiv API v2.
//
// Speaks the wire protocol the language-agnostic beehiiv v2 REST API uses:
// JSON bodies authenticated via Bearer auth. Responses follow the beehiiv
// shapes { data: {...} } and { data: [], limit, page, total_results,
// total_pages }. State is in-memory and ephemeral; created posts are captured.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENTINEL_BAD_JSON = Symbol("bad-json");

const HTTP_REASONS = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

const ERROR_CODES = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  429: "rate_limit_exceeded",
  500: "internal_server_error",
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// beehiiv error envelope: { status, statusText, errors: [{ message, code }] }
function bhError(status, message) {
  return {
    status,
    statusText: HTTP_REASONS[status] || "Error",
    errors: [{ message, code: ERROR_CODES[status] || "error" }],
  };
}

function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function listEnvelope(data) {
  return {
    data,
    limit: 10,
    page: 1,
    total_results: data.length,
    total_pages: 1,
  };
}

function makeSubscription(body, overrides = {}) {
  const ts = nowSec();
  return {
    id: overrides.id || newId("sub"),
    email: body.email,
    status: overrides.status || "active",
    created: overrides.created || ts,
    subscription_tier: body.tier || "free",
    subscription_premium_tier_names: [],
    utm_source: body.utm_source ?? "",
    utm_medium: body.utm_medium ?? "",
    utm_channel: "api",
    utm_campaign: body.utm_campaign ?? "",
    utm_term: body.utm_term ?? "",
    utm_content: body.utm_content ?? "",
    referring_site: body.referring_site ?? "",
    referral_code: "",
    custom_fields: Array.isArray(body.custom_fields) ? clone(body.custom_fields) : [],
  };
}

function makePost(body, pubId) {
  const ts = nowSec();
  const slug = (body.title || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return {
    id: newId("post"),
    subtitle: body.subtitle ?? "",
    title: body.title,
    authors: Array.isArray(body.authors) ? clone(body.authors) : [],
    created: ts,
    status: body.status || "draft",
    publish_date: ts,
    displayed_date: ts,
    split_tested: false,
    subject_line: body.title,
    preview_text: body.subtitle ?? "",
    slug: body.slug || slug,
    thumbnail_url: "",
    web_url: "",
    audience: "free",
    platform: "both",
    content_tags: Array.isArray(body.content_tags) ? clone(body.content_tags) : [],
    hidden_from_feed: false,
    enforce_gated_content: false,
    email_capture_popup: false,
    _publication_id: pubId,
  };
}

export class BeehiivServer {
  constructor(port = 4835, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = []; // captured posts
    this.publications = new Map();
    // subscriptions keyed by publicationId -> Map(subId -> sub)
    this.subscriptions = new Map();
    this.posts = new Map(); // postId -> post
    this._seedDefaults();
  }

  _seedDefaults() {
    const pubId = "pub_parlel";
    this.publications.set(pubId, {
      id: pubId,
      name: "Parlel Newsletter",
      organization_name: "Parlel",
      referral_program_enabled: false,
      created: nowSec(),
    });
    this.subscriptions.set(pubId, new Map());
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, bhError(500, error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-beehiiv");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v2") {
      return this.send(res, 404, bhError(404, "Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, bhError(401, "Unauthorized: API key is missing or invalid."));
    }

    const route = parts.slice(1);

    // /v2/publications
    if (route[0] === "publications" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, listEnvelope(Array.from(this.publications.values()).map(clone)));
    }

    // /v2/publications/:pubId/...
    if (route[0] === "publications" && route.length >= 2) {
      const pubId = route[1];
      if (!this.publications.has(pubId)) {
        return this.send(res, 404, bhError(404, "Publication not found."));
      }
      // GET /v2/publications/:pubId
      if (route.length === 2 && req.method === "GET") {
        return this.send(res, 200, { data: clone(this.publications.get(pubId)) });
      }
      // .../subscriptions
      if (route[2] === "subscriptions") {
        return this.handleSubscriptions(req, res, route, body, pubId);
      }
      // .../posts
      if (route[2] === "posts") {
        return this.handlePosts(req, res, route, body, pubId);
      }
    }

    return this.send(res, 404, bhError(404, "Not Found"));
  }

  handleSubscriptions(req, res, route, body, pubId) {
    if (!this.subscriptions.has(pubId)) this.subscriptions.set(pubId, new Map());
    const bucket = this.subscriptions.get(pubId);

    // /v2/publications/:pubId/subscriptions
    if (route.length === 3) {
      if (req.method === "GET") {
        return this.send(res, 200, listEnvelope(Array.from(bucket.values()).map(clone)));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
          return this.send(res, 400, bhError(400, "A valid email is required."));
        }
        // Upsert by email.
        for (const existing of bucket.values()) {
          if (existing.email === body.email) {
            return this.send(res, 200, { data: clone(existing) });
          }
        }
        const record = makeSubscription(body);
        bucket.set(record.id, record);
        return this.send(res, 200, { data: clone(record) });
      }
      return this.send(res, 405, bhError(405, "Method Not Allowed"));
    }

    // /v2/publications/:pubId/subscriptions/by_email/:email
    if (route.length === 5 && route[3] === "by_email") {
      const email = route[4];
      let sub = null;
      for (const s of bucket.values()) {
        if (s.email === email) { sub = s; break; }
      }
      if (req.method === "GET") {
        if (!sub) return this.send(res, 404, bhError(404, "Subscription not found."));
        return this.send(res, 200, { data: clone(sub) });
      }
      if (req.method === "PUT") {
        if (!sub) return this.send(res, 404, bhError(404, "Subscription not found."));
        if (isPlainObject(body)) {
          this._applySubscriptionUpdate(sub, body);
        }
        return this.send(res, 200, { data: clone(sub) });
      }
      return this.send(res, 405, bhError(405, "Method Not Allowed"));
    }

    // /v2/publications/:pubId/subscriptions/:subscriptionId
    if (route.length === 4) {
      const subId = route[3];
      let sub = bucket.get(subId) || null;
      if (req.method === "GET") {
        if (!sub) return this.send(res, 404, bhError(404, "Subscription not found."));
        return this.send(res, 200, { data: clone(sub) });
      }
      if (req.method === "PUT") {
        if (!sub) return this.send(res, 404, bhError(404, "Subscription not found."));
        if (isPlainObject(body)) {
          this._applySubscriptionUpdate(sub, body);
        }
        return this.send(res, 200, { data: clone(sub) });
      }
      if (req.method === "DELETE") {
        if (!sub) return this.send(res, 404, bhError(404, "Subscription not found."));
        bucket.delete(sub.id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, bhError(405, "Method Not Allowed"));
    }
    return this.send(res, 404, bhError(404, "Not Found"));
  }

  _applySubscriptionUpdate(sub, body) {
    if (typeof body.email === "string") sub.email = body.email;
    if (typeof body.tier === "string") sub.subscription_tier = body.tier;
    if (body.unsubscribe === true) sub.status = "inactive";
    if (Array.isArray(body.custom_fields)) sub.custom_fields = clone(body.custom_fields);
  }

  handlePosts(req, res, route, body, pubId) {
    // /v2/publications/:pubId/posts
    if (route.length === 3) {
      if (req.method === "GET") {
        const all = Array.from(this.posts.values())
          .filter((p) => p._publication_id === pubId)
          .map(clone);
        return this.send(res, 200, listEnvelope(all));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.title !== "string" || !body.title) {
          return this.send(res, 400, bhError(400, "title is required."));
        }
        const record = makePost(body, pubId);
        this.posts.set(record.id, record);
        this.messages.push({ id: record.id, received_at: nowSec(), kind: "post", body: clone(body) });
        return this.send(res, 201, { data: clone(record) });
      }
      return this.send(res, 405, bhError(405, "Method Not Allowed"));
    }

    // /v2/publications/:pubId/posts/:postId
    if (route.length === 4) {
      const postId = route[3];
      const post = this.posts.get(postId) || null;
      if (req.method === "GET") {
        if (!post || post._publication_id !== pubId) {
          return this.send(res, 404, bhError(404, "Post not found."));
        }
        return this.send(res, 200, { data: clone(post) });
      }
      if (req.method === "PATCH" || req.method === "PUT") {
        if (!post || post._publication_id !== pubId) {
          return this.send(res, 404, bhError(404, "Post not found."));
        }
        if (isPlainObject(body)) {
          if (typeof body.title === "string") post.title = body.title;
          if (typeof body.subtitle === "string") post.subtitle = body.subtitle;
          if (typeof body.status === "string") post.status = body.status;
          if (Array.isArray(body.content_tags)) post.content_tags = clone(body.content_tags);
          if (typeof body.slug === "string") post.slug = body.slug;
          if (Array.isArray(body.authors)) post.authors = clone(body.authors);
        }
        return this.send(res, 200, { data: clone(post) });
      }
      if (req.method === "DELETE") {
        if (!post || post._publication_id !== pubId) {
          return this.send(res, 404, bhError(404, "Post not found."));
        }
        this.posts.delete(postId);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, bhError(405, "Method Not Allowed"));
    }

    return this.send(res, 404, bhError(404, "Not Found"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 2) {
      return this.send(res, 200, { messages: clone(this.messages), count: this.messages.length });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 3) {
      const match = this.messages.find((m) => m.id === parts[2]);
      if (!match) return this.send(res, 404, bhError(404, "message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, bhError(404, "Not Found"));
  }

  root() {
    return {
      name: "beehiiv",
      version: "1.0",
      protocol: "beehiiv-v2",
      documentation: "/docs/beehiiv.md",
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
          this.send(res, 400, bhError(400, "Invalid request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, bhError(400, "Invalid request body."));
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
