import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/wordpress — a tiny, dependency-free fake of the WordPress REST API v2.
//
// Speaks the wp-json/wp/v2 wire protocol (posts, pages, categories, users) so
// application code using the real WordPress REST API can run against it.
// Writes require Basic auth (an application password). State is in-memory and
// ephemeral.
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wpError(code, message, status) {
  return { code, message, data: { status } };
}

function rendered(value) {
  return { rendered: value || "", protected: false };
}

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}

function slugify(text) {
  return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export class WordpressServer {
  constructor(port = 4844, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.posts = new Map();
    this.pages = new Map();
    this.categories = new Map();
    this.idCounter = 1;
    // Seed an "Uncategorized" category (id 1).
    this.categories.set(1, {
      id: 1, count: 0, description: "", link: "http://parlel.dev/?cat=1",
      name: "Uncategorized", slug: "uncategorized", taxonomy: "category", parent: 0,
    });
  }

  nextId() {
    this.idCounter += 1;
    return this.idCounter;
  }

  makePost(type, body) {
    const id = this.nextId();
    const title = body.title || "";
    return {
      id,
      date: now(),
      date_gmt: now(),
      guid: rendered(`http://parlel.dev/?p=${id}`),
      modified: now(),
      modified_gmt: now(),
      slug: body.slug || slugify(title) || `${type}-${id}`,
      status: body.status || "publish",
      type,
      link: `http://parlel.dev/?p=${id}`,
      title: rendered(title),
      content: rendered(body.content || ""),
      excerpt: rendered(body.excerpt || ""),
      author: 1,
      featured_media: body.featured_media || 0,
      comment_status: "open",
      ping_status: "open",
      sticky: false,
      template: "",
      format: "standard",
      categories: Array.isArray(body.categories) ? body.categories : [1],
      tags: Array.isArray(body.tags) ? body.tags : [],
      meta: isPlainObject(body.meta) ? body.meta : {},
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, wpError("internal_server_error", error.message || "error", 500));
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
    res.setHeader("server", "parlel-wordpress");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, wpError("rest_no_route", "not found", 404));
    }

    // /wp-json/wp/v2/...
    if (parts[0] !== "wp-json" || parts[1] !== "wp" || parts[2] !== "v2") {
      return this.send(res, 404, wpError("rest_no_route", "No route was found matching the URL and request method.", 404));
    }

    let body = {};
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    if (raw.length) {
      if (ctype.includes("application/json")) {
        try { body = JSON.parse(raw.toString("utf8")); } catch { body = {}; }
      } else if (ctype.includes("urlencoded")) {
        for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) body[k] = v;
      }
    }

    const route = parts.slice(3);

    if (route[0] === "users" && route[1] === "me") {
      return this.usersMe(req, res);
    }
    if (route[0] === "posts") return this.handleContent(req, res, this.posts, "post", route, body, url);
    if (route[0] === "pages") return this.handleContent(req, res, this.pages, "page", route, body, url);
    if (route[0] === "categories") return this.handleCategories(req, res, route, body, url);

    return this.send(res, 404, wpError("rest_no_route", "No route was found matching the URL and request method.", 404));
  }

  handleContent(req, res, store, type, route, body, url) {
    const writeMethod = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
    if (writeMethod && !this.isAuthorized(req)) {
      return this.send(res, 401, wpError("rest_cannot_create", "Sorry, you are not allowed to do that.", 401));
    }

    // Collection
    if (route.length === 1) {
      if (req.method === "GET") {
        let items = Array.from(store.values());
        const status = url.searchParams.get("status");
        if (status) items = items.filter((p) => p.status === status);
        const search = url.searchParams.get("search");
        if (search) items = items.filter((p) => p.title.rendered.toLowerCase().includes(search.toLowerCase()));
        return this.sendList(res, items);
      }
      if (req.method === "POST") {
        const post = this.makePost(type, body);
        store.set(post.id, post);
        return this.send(res, 201, post);
      }
      return this.send(res, 405, wpError("rest_no_route", "method not allowed", 405));
    }

    // Single
    const id = Number(route[1]);
    const post = store.get(id);

    if (req.method === "GET") {
      if (!post) return this.send(res, 404, wpError("rest_post_invalid_id", "Invalid post ID.", 404));
      return this.send(res, 200, post);
    }
    if (req.method === "POST" || req.method === "PUT") {
      if (!post) return this.send(res, 404, wpError("rest_post_invalid_id", "Invalid post ID.", 404));
      if (typeof body.title === "string") post.title = rendered(body.title);
      if (typeof body.content === "string") post.content = rendered(body.content);
      if (typeof body.excerpt === "string") post.excerpt = rendered(body.excerpt);
      if (typeof body.status === "string") post.status = body.status;
      if (typeof body.slug === "string") post.slug = body.slug;
      if (Array.isArray(body.categories)) post.categories = body.categories;
      post.modified = now();
      post.modified_gmt = now();
      return this.send(res, 200, post);
    }
    if (req.method === "DELETE") {
      if (!post) return this.send(res, 404, wpError("rest_post_invalid_id", "Invalid post ID.", 404));
      const force = url.searchParams.get("force") === "true";
      store.delete(id);
      if (force) {
        return this.send(res, 200, { deleted: true, previous: post });
      }
      post.status = "trash";
      return this.send(res, 200, post);
    }
    return this.send(res, 405, wpError("rest_no_route", "method not allowed", 405));
  }

  handleCategories(req, res, route, body, url) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.sendList(res, Array.from(this.categories.values()));
      }
      if (req.method === "POST") {
        if (!this.isAuthorized(req)) {
          return this.send(res, 401, wpError("rest_cannot_create", "Sorry, you are not allowed to do that.", 401));
        }
        if (typeof body.name !== "string" || !body.name) {
          return this.send(res, 400, wpError("rest_missing_callback_param", "Missing parameter(s): name", 400));
        }
        const id = this.nextId();
        const cat = {
          id, count: 0, description: body.description || "",
          link: `http://parlel.dev/?cat=${id}`, name: body.name,
          slug: body.slug || slugify(body.name), taxonomy: "category", parent: body.parent || 0,
        };
        this.categories.set(id, cat);
        return this.send(res, 201, cat);
      }
      return this.send(res, 405, wpError("rest_no_route", "method not allowed", 405));
    }
    const id = Number(route[1]);
    const cat = this.categories.get(id);
    if (req.method === "GET") {
      if (!cat) return this.send(res, 404, wpError("rest_term_invalid", "Term does not exist.", 404));
      return this.send(res, 200, cat);
    }
    return this.send(res, 405, wpError("rest_no_route", "method not allowed", 405));
  }

  usersMe(req, res) {
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, wpError("rest_not_logged_in", "You are not currently logged in.", 401));
    }
    return this.send(res, 200, {
      id: 1,
      name: "parlel",
      url: "",
      description: "",
      link: "http://parlel.dev/author/parlel",
      slug: "parlel",
      roles: ["administrator"],
      capabilities: { administrator: true },
      username: "parlel",
      email: "tester@parlel.dev",
    });
  }

  sendList(res, items) {
    res.setHeader("X-WP-Total", String(items.length));
    res.setHeader("X-WP-TotalPages", "1");
    return this.send(res, 200, items);
  }

  root() {
    return { name: "wordpress", version: "2", protocol: "wp-rest-v2", documentation: "/docs/wordpress.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Basic\s+\S+/i.test(req.headers.authorization || "");
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
