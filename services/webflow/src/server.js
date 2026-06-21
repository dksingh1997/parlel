import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/webflow — a tiny, dependency-free fake of the Webflow API v2.
//
// Speaks the Webflow Data API wire protocol (sites, collections, CMS items)
// so application code using the real `webflow-api` SDK can run against it.
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wfError(status, message, code) {
  return { message, code: code || "validation_error", externalReference: null, details: [] };
}

function newId() {
  return randomBytes(12).toString("hex");
}

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export class WebflowServer {
  constructor(port = 4843, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.sites = new Map();
    this.collections = new Map();
    this.items = new Map(); // collectionId -> Map(itemId -> item)
    this._seed();
  }

  _seed() {
    const siteId = "parlel-site";
    this.sites.set(siteId, {
      id: siteId,
      workspaceId: "parlel-workspace",
      displayName: "Parlel Site",
      shortName: "parlel",
      createdOn: now(),
      lastPublished: null,
      previewUrl: "https://parlel.webflow.io",
      timeZone: "America/Los_Angeles",
      locales: { primary: { id: "en", cmsLocaleId: "en-cms", displayName: "English" }, secondary: [] },
    });
    const collectionId = "blog-posts";
    this.collections.set(collectionId, {
      id: collectionId,
      displayName: "Blog Posts",
      singularName: "Blog Post",
      slug: "blog-posts",
      createdOn: now(),
      lastUpdated: now(),
      fields: [
        { id: "name", isRequired: true, isEditable: true, type: "PlainText", displayName: "Name", slug: "name" },
        { id: "slug", isRequired: true, isEditable: true, type: "PlainText", displayName: "Slug", slug: "slug" },
      ],
    });
    this.items.set(collectionId, new Map());
  }

  makeItem(collectionId, fieldData, isDraft, isArchived) {
    const id = newId();
    return {
      id,
      cmsLocaleId: "en-cms",
      lastPublished: null,
      lastUpdated: now(),
      createdOn: now(),
      isArchived: Boolean(isArchived),
      isDraft: Boolean(isDraft),
      fieldData: fieldData || {},
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, wfError(500, error.message || "error", "server_error"));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-webflow");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, wfError(404, "not found", "not_found"));
    }

    if (parts[0] !== "v2") return this.send(res, 404, wfError(404, "not found", "not_found"));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, wfError(401, "Unauthorized: invalid access token", "unauthorized"));
    }

    let body = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString("utf8")); } catch { body = {}; }
    }
    const route = parts.slice(1);

    if (route[0] === "sites") return this.handleSites(req, res, route);
    if (route[0] === "collections") return this.handleCollections(req, res, route, body, url);

    return this.send(res, 404, wfError(404, "not found", "not_found"));
  }

  handleSites(req, res, route) {
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { sites: Array.from(this.sites.values()) });
    }
    const id = route[1];
    const site = this.sites.get(id);
    if (req.method === "GET") {
      if (!site) return this.send(res, 404, wfError(404, "Site not found", "not_found"));
      return this.send(res, 200, site);
    }
    return this.send(res, 405, wfError(405, "method not allowed", "method_not_allowed"));
  }

  handleCollections(req, res, route, body, url) {
    const collectionId = route[1];
    if (!collectionId) return this.send(res, 404, wfError(404, "not found", "not_found"));

    // /v2/collections/:id/items ...
    if (route[2] === "items") {
      return this.handleItems(req, res, collectionId, route.slice(3), body, url);
    }

    // /v2/collections/:id
    const collection = this.collections.get(collectionId);
    if (req.method === "GET") {
      if (!collection) return this.send(res, 404, wfError(404, "Collection not found", "not_found"));
      return this.send(res, 200, collection);
    }
    return this.send(res, 405, wfError(405, "method not allowed", "method_not_allowed"));
  }

  handleItems(req, res, collectionId, sub, body, url) {
    if (!this.collections.has(collectionId)) {
      return this.send(res, 404, wfError(404, "Collection not found", "not_found"));
    }
    let store = this.items.get(collectionId);
    if (!store) { store = new Map(); this.items.set(collectionId, store); }

    // /items (collection)
    if (sub.length === 0) {
      if (req.method === "GET") {
        const all = Array.from(store.values());
        const offset = Number(url.searchParams.get("offset") || 0);
        const limit = Number(url.searchParams.get("limit") || 100);
        const items = all.slice(offset, offset + limit);
        return this.send(res, 200, {
          items,
          pagination: { limit, offset, total: all.length },
        });
      }
      if (req.method === "POST") {
        const fieldData = isPlainObject(body.fieldData) ? body.fieldData : {};
        const item = this.makeItem(collectionId, fieldData, body.isDraft, body.isArchived);
        store.set(item.id, item);
        return this.send(res, 202, item);
      }
      return this.send(res, 405, wfError(405, "method not allowed", "method_not_allowed"));
    }

    // /items/:itemId
    const itemId = sub[0];
    const item = store.get(itemId);
    if (req.method === "GET") {
      if (!item) return this.send(res, 404, wfError(404, "Item not found", "not_found"));
      return this.send(res, 200, item);
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      if (!item) return this.send(res, 404, wfError(404, "Item not found", "not_found"));
      if (isPlainObject(body.fieldData)) item.fieldData = { ...item.fieldData, ...body.fieldData };
      if (typeof body.isDraft === "boolean") item.isDraft = body.isDraft;
      if (typeof body.isArchived === "boolean") item.isArchived = body.isArchived;
      item.lastUpdated = now();
      return this.send(res, 200, item);
    }
    if (req.method === "DELETE") {
      if (!item) return this.send(res, 404, wfError(404, "Item not found", "not_found"));
      store.delete(itemId);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, wfError(405, "method not allowed", "method_not_allowed"));
  }

  root() {
    return { name: "webflow", version: "2", protocol: "webflow-v2", documentation: "/docs/webflow.md" };
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
    res.setHeader("Content-Type", "application/json");
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
