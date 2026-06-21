import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/notion — a tiny, dependency-free fake of the Notion API.
//
// Speaks the /v1 wire protocol used by the official @notionhq/client. Bearer
// auth plus a required Notion-Version header (missing -> 400 missing_version).
// Page objects carry the documented { object, id, created_by, last_edited_by,
// in_trash, icon, cover, parent.type, public_url, ... } shape and lists carry
// { object: "list", results, next_cursor, has_more }. State is in-memory and
// ephemeral.
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

// Notion error envelope: { object: "error", status, code, message }
function notionError(status, code, message) {
  return { object: "error", status, code, message };
}

export class NotionServer {
  constructor(port = 4794, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.pages = new Map();
    this.databases = new Map();
    this._seedDefaults();
  }

  _now() {
    return new Date().toISOString();
  }

  _seedDefaults() {
    const dbId = randomUUID();
    this.databases.set(dbId, {
      object: "database",
      id: dbId,
      created_time: this._now(),
      last_edited_time: this._now(),
      title: [{ type: "text", text: { content: "Parlel DB" }, plain_text: "Parlel DB" }],
      properties: {
        Name: { id: "title", name: "Name", type: "title", title: {} },
        Status: { id: "status", name: "Status", type: "select", select: { options: [] } },
      },
      parent: { type: "workspace", workspace: true },
      url: `https://notion.so/${dbId.replace(/-/g, "")}`,
    });
    this.defaultDatabase = dbId;

    this.botUser = {
      object: "user",
      id: randomUUID(),
      type: "bot",
      name: "Parlel Integration",
      avatar_url: null,
      bot: {
        owner: { type: "workspace", workspace: true },
        workspace_id: randomUUID(),
        workspace_limits: { max_file_upload_size_in_bytes: 5242880 },
        workspace_name: "Parlel",
      },
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, notionError(500, "internal_server_error", error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Notion-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-notion");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v1") {
      return this.send(res, 404, notionError(404, "object_not_found", "Not found"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, notionError(401, "unauthorized", "API token is invalid."));
    }
    // Real Notion requires a Notion-Version header on every request; a missing
    // header returns 400 missing_version. We accept any version value.
    if (!req.headers["notion-version"]) {
      return this.send(res, 400, notionError(400, "missing_version",
        "Notion-Version header failed validation: Notion-Version header should be defined, instead was `undefined`."));
    }

    const route = parts.slice(1);

    if (route[0] === "pages") return this.handlePages(req, res, route, body);
    if (route[0] === "databases") return this.handleDatabases(req, res, route, body);
    if (route[0] === "search" && route.length === 1 && req.method === "POST") {
      return this.handleSearch(res, body);
    }
    if (route[0] === "users" && route[1] === "me" && route.length === 2 && req.method === "GET") {
      return this.send(res, 200, clone(this.botUser));
    }

    return this.send(res, 404, notionError(404, "object_not_found", "Not found"));
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------
  handlePages(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        if (!isPlainObject(body) || !isPlainObject(body.parent)) {
          return this.send(res, 400, notionError(400, "validation_error", "body.parent is required"));
        }
        // When the parent is a database, real Notion validates: the database
        // must exist, every property must be in its schema with a matching
        // type, and a title property must be present.
        if (body.parent.database_id !== undefined) {
          const db = this.databases.get(body.parent.database_id);
          if (!db) {
            return this.send(res, 404, notionError(404, "object_not_found",
              `Could not find database with ID: ${body.parent.database_id}.`));
          }
          const validationError = this._validatePageProperties(db, body.properties);
          if (validationError) {
            return this.send(res, 400, notionError(400, "validation_error", validationError));
          }
        }
        const id = randomUUID();
        const userRef = { object: "user", id: this.botUser.id };
        const page = {
          object: "page",
          id,
          created_time: this._now(),
          last_edited_time: this._now(),
          created_by: userRef,
          last_edited_by: userRef,
          cover: null,
          icon: null,
          archived: false,
          in_trash: false,
          parent: this._normalizeParent(body.parent),
          properties: isPlainObject(body.properties) ? clone(body.properties) : {},
          url: `https://notion.so/${id.replace(/-/g, "")}`,
          public_url: null,
        };
        this.pages.set(id, page);
        return this.send(res, 200, clone(page));
      }
      return this.send(res, 405, notionError(405, "invalid_request", "Method not allowed"));
    }

    const id = route[1];
    const page = this.pages.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!page) return this.send(res, 404, notionError(404, "object_not_found", "Could not find page."));
        return this.send(res, 200, clone(page));
      }
      if (req.method === "PATCH") {
        if (!page) return this.send(res, 404, notionError(404, "object_not_found", "Could not find page."));
        if (isPlainObject(body)) {
          if (isPlainObject(body.properties)) {
            page.properties = { ...page.properties, ...clone(body.properties) };
          }
          // `in_trash` is the current field; `archived` is a deprecated alias
          // that always returns the same value. Accept either as input.
          if (typeof body.in_trash === "boolean") {
            page.in_trash = body.in_trash;
            page.archived = body.in_trash;
          }
          if (typeof body.archived === "boolean") {
            page.archived = body.archived;
            page.in_trash = body.archived;
          }
          page.last_edited_time = this._now();
          page.last_edited_by = { object: "user", id: this.botUser.id };
        }
        return this.send(res, 200, clone(page));
      }
      return this.send(res, 405, notionError(405, "invalid_request", "Method not allowed"));
    }
    return this.send(res, 404, notionError(404, "object_not_found", "Not found"));
  }

  // Real Notion echoes the parent with an explicit `type` discriminator, e.g.
  // { type: "database_id", database_id: "..." }. Infer it from the supplied key.
  _normalizeParent(parent) {
    const out = clone(parent);
    if (!isPlainObject(out)) return out;
    if (out.type === undefined) {
      if (out.database_id !== undefined) out.type = "database_id";
      else if (out.data_source_id !== undefined) out.type = "data_source_id";
      else if (out.page_id !== undefined) out.type = "page_id";
      else if (out.workspace !== undefined) out.type = "workspace";
      else if (out.block_id !== undefined) out.type = "block_id";
    }
    return out;
  }

  // Validate page properties against a database's schema, the way real Notion
  // does. Returns an error message string, or null if valid.
  _validatePageProperties(db, properties) {
    const schema = db.properties || {};
    const props = isPlainObject(properties) ? properties : {};

    // Every supplied property must exist in the schema and carry the value
    // shape matching its configured type (e.g. a `select` prop needs `select`).
    for (const [name, value] of Object.entries(props)) {
      const def = schema[name];
      if (!def) {
        return `${name} is not a property that exists.`;
      }
      if (isPlainObject(value) && value[def.type] === undefined) {
        return `${name} is expected to be ${def.type}.`;
      }
    }

    // A db-parented page must set its title property.
    const titleProp = Object.entries(schema).find(([, d]) => d.type === "title");
    if (titleProp) {
      const [titleName] = titleProp;
      const supplied = props[titleName];
      const hasTitle =
        isPlainObject(supplied) && Array.isArray(supplied.title) && supplied.title.length > 0;
      if (!hasTitle) {
        return `${titleName} is expected to be title.`;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Databases
  // -------------------------------------------------------------------------
  handleDatabases(req, res, route, body) {
    if (route.length === 2) {
      const id = route[1];
      const database = this.databases.get(id);
      if (req.method === "GET") {
        if (!database) return this.send(res, 404, notionError(404, "object_not_found", "Could not find database."));
        return this.send(res, 200, clone(database));
      }
      return this.send(res, 405, notionError(405, "invalid_request", "Method not allowed"));
    }

    // POST /v1/databases/:id/query
    if (route.length === 3 && route[2] === "query" && req.method === "POST") {
      const id = route[1];
      if (!this.databases.has(id)) {
        return this.send(res, 404, notionError(404, "object_not_found", "Could not find database."));
      }
      const results = [...this.pages.values()].filter(
        (p) => isPlainObject(p.parent) && p.parent.database_id === id
      ).map(clone);
      return this.send(res, 200, {
        object: "list",
        results,
        next_cursor: null,
        has_more: false,
        type: "page_or_database",
        page_or_database: {},
      });
    }

    return this.send(res, 404, notionError(404, "object_not_found", "Not found"));
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  handleSearch(res, body) {
    const query = isPlainObject(body) && typeof body.query === "string" ? body.query.toLowerCase() : "";
    const filterType = isPlainObject(body) && isPlainObject(body.filter) ? body.filter.value : null;

    let results = [];
    if (filterType !== "database") {
      results = results.concat([...this.pages.values()].map(clone));
    }
    if (filterType !== "page") {
      results = results.concat([...this.databases.values()].map(clone));
    }
    if (query) {
      results = results.filter((obj) => JSON.stringify(obj).toLowerCase().includes(query));
    }
    return this.send(res, 200, {
      object: "list",
      results,
      next_cursor: null,
      has_more: false,
      type: "page_or_database",
      page_or_database: {},
    });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, notionError(404, "object_not_found", "Not found"));
  }

  root() {
    return {
      name: "notion",
      version: "1",
      protocol: "notion-v1",
      documentation: "/docs/notion.md",
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
          this.send(res, 400, notionError(400, "invalid_json", "Error parsing JSON body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, notionError(400, "invalid_json", "Error parsing JSON body."));
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
