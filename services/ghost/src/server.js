import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/ghost — a tiny, dependency-free fake of the Ghost Content + Admin APIs.
//
// Speaks the Ghost wire protocol so application code using the real
// `@tryghost/content-api` / `@tryghost/admin-api` SDKs can run against it:
//   Content API: GET /ghost/api/content/posts/?key=<key>      ({ posts, meta })
//   Admin API:   POST/PUT /ghost/api/admin/posts/  (Bearer Ghost JWT)
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ghostError(status, message, type) {
  return {
    errors: [{
      message,
      context: null,
      type: type || "NotFoundError",
      details: null,
      property: null,
      help: null,
      code: null,
      id: randomUUID(),
      ghostErrorCode: null,
    }],
  };
}

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
}

function slugify(text) {
  return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export class GhostServer {
  constructor(port = 4845, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.posts = new Map(); // id -> post
    this.idCounter = 0;
  }

  newPostId() {
    this.idCounter += 1;
    return randomBytes(12).toString("hex");
  }

  makePost(body) {
    const id = this.newPostId();
    const title = body.title || "(Untitled)";
    const status = body.status || "draft";
    const html = body.html || (body.mobiledoc ? "" : "");
    return {
      id,
      uuid: randomUUID(),
      title,
      slug: body.slug || slugify(title) || id,
      html,
      comment_id: id,
      feature_image: body.feature_image || null,
      featured: Boolean(body.featured),
      status,
      visibility: body.visibility || "public",
      created_at: now(),
      updated_at: now(),
      published_at: status === "published" ? now() : null,
      custom_excerpt: body.custom_excerpt || null,
      excerpt: body.custom_excerpt || (html ? html.replace(/<[^>]+>/g, "").slice(0, 100) : ""),
      url: `http://127.0.0.1:${this.port}/${body.slug || slugify(title) || id}/`,
      reading_time: 1,
      access: true,
      tags: Array.isArray(body.tags) ? body.tags : [],
      authors: [{ id: "1", name: "Parlel", slug: "parlel", email: "tester@parlel.dev" }],
      primary_author: { id: "1", name: "Parlel", slug: "parlel" },
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, ghostError(500, error.message || "error", "InternalServerError"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-ghost");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, ghostError(404, "not found"));
    }

    // /ghost/api/(content|admin)/...
    if (parts[0] !== "ghost" || parts[1] !== "api") {
      return this.send(res, 404, ghostError(404, "Resource not found"));
    }

    let body = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString("utf8")); } catch { body = {}; }
    }

    const api = parts[2]; // "content" | "admin"
    const route = parts.slice(3);

    if (api === "content") return this.handleContent(req, res, route, url);
    if (api === "admin") return this.handleAdmin(req, res, route, body);

    return this.send(res, 404, ghostError(404, "Resource not found"));
  }

  // -------------------------------------------------------------------------
  // Content API — auth via ?key=
  // -------------------------------------------------------------------------
  handleContent(req, res, route, url) {
    const key = url.searchParams.get("key");
    if (this.requireAuth && !key) {
      return this.send(res, 401, ghostError(401, "Authorization failed", "UnauthorizedError"));
    }

    if (route[0] === "posts") {
      // GET /ghost/api/content/posts/
      if (route.length === 1 && req.method === "GET") {
        const posts = Array.from(this.posts.values()).filter((p) => p.status === "published");
        return this.send(res, 200, {
          posts,
          meta: { pagination: { page: 1, limit: 15, pages: 1, total: posts.length, next: null, prev: null } },
        });
      }
      // GET /ghost/api/content/posts/:id
      if (route.length === 2 && req.method === "GET") {
        const post = this.posts.get(route[1]) || this.findBySlug(route[1]);
        if (!post || post.status !== "published") {
          return this.send(res, 404, ghostError(404, "Post not found", "NotFoundError"));
        }
        return this.send(res, 200, { posts: [post] });
      }
    }

    if (route[0] === "settings" && req.method === "GET") {
      return this.send(res, 200, { settings: this.siteSettings() });
    }

    return this.send(res, 404, ghostError(404, "Resource not found"));
  }

  // -------------------------------------------------------------------------
  // Admin API — auth via Bearer (Ghost JWT)
  // -------------------------------------------------------------------------
  handleAdmin(req, res, route, body) {
    if (!this.isAdminAuthorized(req)) {
      return this.send(res, 401, ghostError(401, "Authorization failed", "UnauthorizedError"));
    }

    if (route[0] === "site" && req.method === "GET") {
      return this.send(res, 200, {
        site: { title: "Parlel", description: "parlel ghost fake", url: `http://127.0.0.1:${this.port}/`, version: "5.0" },
      });
    }

    if (route[0] === "posts") {
      // GET /ghost/api/admin/posts/
      if (route.length === 1 && req.method === "GET") {
        const posts = Array.from(this.posts.values());
        return this.send(res, 200, {
          posts,
          meta: { pagination: { page: 1, limit: 15, pages: 1, total: posts.length, next: null, prev: null } },
        });
      }
      // POST /ghost/api/admin/posts/
      if (route.length === 1 && req.method === "POST") {
        const input = Array.isArray(body.posts) ? body.posts[0] : body;
        if (!isPlainObject(input) || typeof input.title !== "string" || !input.title) {
          return this.send(res, 422, ghostError(422, "Title is required.", "ValidationError"));
        }
        const post = this.makePost(input);
        this.posts.set(post.id, post);
        return this.send(res, 201, { posts: [post] });
      }
      // GET /ghost/api/admin/posts/:id
      if (route.length === 2 && req.method === "GET") {
        const post = this.posts.get(route[1]);
        if (!post) return this.send(res, 404, ghostError(404, "Post not found", "NotFoundError"));
        return this.send(res, 200, { posts: [post] });
      }
      // PUT /ghost/api/admin/posts/:id
      if (route.length === 2 && req.method === "PUT") {
        const post = this.posts.get(route[1]);
        if (!post) return this.send(res, 404, ghostError(404, "Post not found", "NotFoundError"));
        const input = Array.isArray(body.posts) ? body.posts[0] : body;
        if (typeof input.title === "string") post.title = input.title;
        if (typeof input.html === "string") post.html = input.html;
        if (typeof input.slug === "string") post.slug = input.slug;
        if (typeof input.status === "string") {
          post.status = input.status;
          if (input.status === "published" && !post.published_at) post.published_at = now();
        }
        if (typeof input.feature_image === "string") post.feature_image = input.feature_image;
        post.updated_at = now();
        return this.send(res, 200, { posts: [post] });
      }
      // DELETE /ghost/api/admin/posts/:id
      if (route.length === 2 && req.method === "DELETE") {
        if (!this.posts.has(route[1])) return this.send(res, 404, ghostError(404, "Post not found", "NotFoundError"));
        this.posts.delete(route[1]);
        return this.send(res, 204, null);
      }
    }

    return this.send(res, 404, ghostError(404, "Resource not found"));
  }

  findBySlug(slug) {
    for (const p of this.posts.values()) if (p.slug === slug) return p;
    return null;
  }

  siteSettings() {
    return {
      title: "Parlel",
      description: "parlel ghost fake",
      url: `http://127.0.0.1:${this.port}/`,
      navigation: [],
    };
  }

  root() {
    return { name: "ghost", version: "1", protocol: "ghost-api", documentation: "/docs/ghost.md" };
  }

  isAdminAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Ghost\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
    res.setHeader("Content-Type", "application/json");
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
