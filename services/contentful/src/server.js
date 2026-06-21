import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/contentful — a tiny, dependency-free fake of the Contentful Content
// Delivery API (CDA) and Content Management API (CMA).
//
// Speaks the Contentful wire protocol (sys/fields envelopes, Array collections)
// so application code using the real `contentful` / `contentful-management`
// SDKs can run against it. State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cfError(status, id, message) {
  return {
    sys: { type: "Error", id },
    message,
    requestId: randomBytes(8).toString("hex"),
  };
}

function newId() {
  return randomBytes(8).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
}

function now() {
  return new Date().toISOString();
}

export class ContentfulServer {
  constructor(port = 4841, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.entries = new Map(); // id -> entry
    this.contentTypes = new Map(); // id -> content type
    this.assets = new Map();
    this._seed();
  }

  _seed() {
    const ctId = "blogPost";
    this.contentTypes.set(ctId, {
      sys: { id: ctId, type: "ContentType", version: 1, createdAt: now(), updatedAt: now() },
      name: "Blog Post",
      displayField: "title",
      fields: [
        { id: "title", name: "Title", type: "Symbol", required: true, localized: false },
        { id: "body", name: "Body", type: "Text", required: false, localized: false },
      ],
    });
  }

  makeEntry(contentTypeId, fields, id) {
    const entryId = id || newId();
    return {
      sys: {
        id: entryId,
        type: "Entry",
        version: 1,
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
        contentType: { sys: { type: "Link", linkType: "ContentType", id: contentTypeId } },
        space: { sys: { type: "Link", linkType: "Space", id: "parlel" } },
        environment: { sys: { type: "Link", linkType: "Environment", id: "master" } },
      },
      fields: fields || {},
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, cfError(500, "ServerError", error.message || "error"));
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
    const raw = await this.readRaw(req);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Contentful-Version, X-Contentful-Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-contentful");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, cfError(404, "NotFound", "not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, cfError(401, "AccessTokenInvalid", "The access token you sent could not be found or is invalid."));
    }

    let body = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString("utf8")); } catch { body = {}; }
    }

    // /spaces/:spaceId/environments/:env/...
    if (parts[0] === "spaces" && parts[2] === "environments") {
      const route = parts.slice(4);
      return this.handleEnv(req, res, route, body, url);
    }
    // /spaces/:spaceId/... (no environment, default master) — entries/content_types
    if (parts[0] === "spaces" && (parts[2] === "entries" || parts[2] === "content_types")) {
      const route = parts.slice(2);
      return this.handleEnv(req, res, route, body, url);
    }

    return this.send(res, 404, cfError(404, "NotFound", "not found"));
  }

  handleEnv(req, res, route, body, url) {
    if (route[0] === "entries") return this.handleEntries(req, res, route, body, url);
    if (route[0] === "content_types") return this.handleContentTypes(req, res, route, url);
    return this.send(res, 404, cfError(404, "NotFound", "not found"));
  }

  handleEntries(req, res, route, body, url) {
    // Collection: /entries
    if (route.length === 1) {
      if (req.method === "GET") {
        let items = Array.from(this.entries.values());
        const ctFilter = url.searchParams.get("content_type");
        if (ctFilter) {
          items = items.filter((e) => e.sys.contentType.sys.id === ctFilter);
        }
        const skip = Number(url.searchParams.get("skip") || 0);
        const limit = Number(url.searchParams.get("limit") || 100);
        const total = items.length;
        const page = items.slice(skip, skip + limit);
        return this.send(res, 200, {
          sys: { type: "Array" },
          total,
          skip,
          limit,
          items: page,
        });
      }
      // POST /entries  (CMA create with generated id)
      if (req.method === "POST") {
        const ctId = req.headers["x-contentful-content-type"] || body?.sys?.contentType?.sys?.id || "blogPost";
        const entry = this.makeEntry(ctId, body.fields || {});
        this.entries.set(entry.sys.id, entry);
        return this.send(res, 201, entry);
      }
      return this.send(res, 405, cfError(405, "MethodNotAllowed", "method not allowed"));
    }

    // Single: /entries/:id
    const id = route[1];
    if (req.method === "GET") {
      const entry = this.entries.get(id);
      if (!entry) return this.send(res, 404, cfError(404, "NotFound", "The resource could not be found."));
      return this.send(res, 200, entry);
    }
    if (req.method === "PUT") {
      // CMA create-or-update with explicit id.
      const existing = this.entries.get(id);
      const ctId = req.headers["x-contentful-content-type"]
        || body?.sys?.contentType?.sys?.id
        || existing?.sys?.contentType?.sys?.id
        || "blogPost";
      if (existing) {
        existing.fields = body.fields || existing.fields;
        existing.sys.version += 1;
        existing.sys.updatedAt = now();
        return this.send(res, 200, existing);
      }
      const entry = this.makeEntry(ctId, body.fields || {}, id);
      this.entries.set(id, entry);
      return this.send(res, 201, entry);
    }
    if (req.method === "DELETE") {
      if (!this.entries.has(id)) return this.send(res, 404, cfError(404, "NotFound", "The resource could not be found."));
      this.entries.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, cfError(405, "MethodNotAllowed", "method not allowed"));
  }

  handleContentTypes(req, res, route, url) {
    if (route.length === 1 && req.method === "GET") {
      const items = Array.from(this.contentTypes.values());
      return this.send(res, 200, {
        sys: { type: "Array" },
        total: items.length,
        skip: 0,
        limit: 100,
        items,
      });
    }
    const id = route[1];
    if (req.method === "GET") {
      const ct = this.contentTypes.get(id);
      if (!ct) return this.send(res, 404, cfError(404, "NotFound", "The resource could not be found."));
      return this.send(res, 200, ct);
    }
    return this.send(res, 405, cfError(405, "MethodNotAllowed", "method not allowed"));
  }

  root() {
    return { name: "contentful", version: "1", protocol: "contentful-cda-cma", documentation: "/docs/contentful.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
  }

  readRaw(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(Buffer.alloc(0)));
    });
  }

  send(res, status, body) {
    res.setHeader("Content-Type", "application/vnd.contentful.delivery.v1+json");
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
