import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/coda — a tiny, dependency-free fake of the Coda API v1.
//
// Speaks the /v1 wire protocol used by the official coda-js client. Bearer
// auth. Collections carry { items, href }. State is in-memory and ephemeral.
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

// Coda error envelope: { statusCode, statusMessage, message }
function codaError(statusCode, statusMessage, message) {
  return { statusCode, statusMessage, message: message || statusMessage };
}

function shortId(prefix) {
  return prefix + randomBytes(7).toString("base64").replace(/[+/=]/g, "").slice(0, 10);
}

export class CodaServer {
  constructor(port = 4796, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.docs = new Map();
    // tables keyed by docId -> Map(tableId -> table)
    this.tables = new Map();
    // rows keyed by `${docId}:${tableId}` -> Map(rowId -> row)
    this.rows = new Map();
    this._seedDefaults();
  }

  _seedDefaults() {
    const docId = shortId("");
    this.docs.set(docId, {
      id: docId,
      type: "doc",
      href: this._href(`/docs/${docId}`),
      browserLink: `https://coda.io/d/${docId}`,
      name: "Parlel Doc",
      owner: "parlel@example.com",
      ownerName: "Parlel User",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.defaultDoc = docId;

    const tableId = shortId("grid-");
    const tables = new Map();
    tables.set(tableId, {
      id: tableId,
      type: "table",
      tableType: "table",
      href: this._href(`/docs/${docId}/tables/${tableId}`),
      browserLink: `https://coda.io/d/${docId}#${tableId}`,
      name: "Tasks",
      rowCount: 0,
    });
    this.tables.set(docId, tables);
    this.defaultTable = tableId;
    this.rows.set(`${docId}:${tableId}`, new Map());

    this.whoami = {
      name: "Parlel User",
      loginId: "parlel@example.com",
      type: "user",
      scoped: false,
      tokenName: "parlel-token",
      href: this._href("/whoami"),
    };
  }

  _href(path) {
    return `https://coda.io/apis/v1${path}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, codaError(500, "Internal Server Error", error.message));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-coda");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v1") {
      return this.send(res, 404, codaError(404, "Not Found", "Not found"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, codaError(401, "Unauthorized", "Bearer token is invalid or missing"));
    }

    const route = parts.slice(1);

    // GET /v1/whoami
    if (route[0] === "whoami" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, clone(this.whoami));
    }

    if (route[0] === "docs") return this.handleDocs(req, res, route, body);

    return this.send(res, 404, codaError(404, "Not Found", "Not found"));
  }

  handleDocs(req, res, route, body) {
    // /v1/docs
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, {
          items: [...this.docs.values()].map(clone),
          href: this._href("/docs"),
        });
      }
      if (req.method === "POST") {
        const id = shortId("");
        const doc = {
          id,
          type: "doc",
          href: this._href(`/docs/${id}`),
          browserLink: `https://coda.io/d/${id}`,
          name: typeof body.title === "string" && body.title ? body.title : "Untitled",
          owner: "parlel@example.com",
          ownerName: "Parlel User",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.docs.set(id, doc);
        this.tables.set(id, new Map());
        return this.send(res, 201, clone(doc));
      }
      return this.send(res, 405, codaError(405, "Method Not Allowed", "Method not allowed"));
    }

    const docId = route[1];
    if (!this.docs.has(docId)) {
      return this.send(res, 404, codaError(404, "Not Found", "Doc not found"));
    }

    // GET /v1/docs/:docId
    if (route.length === 2 && req.method === "GET") {
      return this.send(res, 200, clone(this.docs.get(docId)));
    }

    // /v1/docs/:docId/tables
    if (route[2] === "tables") {
      const tables = this.tables.get(docId) || new Map();
      if (route.length === 3 && req.method === "GET") {
        return this.send(res, 200, {
          items: [...tables.values()].map(clone),
          href: this._href(`/docs/${docId}/tables`),
        });
      }
      const tableId = route[3];
      if (route.length === 4 && req.method === "GET") {
        const table = tables.get(tableId);
        if (!table) return this.send(res, 404, codaError(404, "Not Found", "Table not found"));
        return this.send(res, 200, clone(table));
      }

      // /v1/docs/:docId/tables/:tableId/rows
      if (route.length === 5 && route[4] === "rows") {
        const table = tables.get(tableId);
        if (!table) return this.send(res, 404, codaError(404, "Not Found", "Table not found"));
        const key = `${docId}:${tableId}`;
        if (!this.rows.has(key)) this.rows.set(key, new Map());
        const rows = this.rows.get(key);

        if (req.method === "GET") {
          return this.send(res, 200, {
            items: [...rows.values()].map(clone),
            href: this._href(`/docs/${docId}/tables/${tableId}/rows`),
          });
        }
        if (req.method === "POST") {
          const incoming = Array.isArray(body.rows) ? body.rows : [];
          const addedRowIds = [];
          for (const r of incoming) {
            const rowId = shortId("i-");
            const cells = Array.isArray(r.cells) ? r.cells : [];
            const values = {};
            for (const cell of cells) {
              if (cell && cell.column !== undefined) values[cell.column] = cell.value;
            }
            const row = {
              id: rowId,
              type: "row",
              href: this._href(`/docs/${docId}/tables/${tableId}/rows/${rowId}`),
              name: values.Name || values.name || rowId,
              index: rows.size,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              values,
            };
            rows.set(rowId, row);
            addedRowIds.push(rowId);
          }
          table.rowCount = rows.size;
          // Coda returns 202 Accepted with a mutation token + addedRowIds.
          return this.send(res, 202, {
            requestId: shortId("req-"),
            addedRowIds,
          });
        }
        return this.send(res, 405, codaError(405, "Method Not Allowed", "Method not allowed"));
      }
    }

    return this.send(res, 404, codaError(404, "Not Found", "Not found"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, codaError(404, "Not Found", "Not found"));
  }

  root() {
    return {
      name: "coda",
      version: "1",
      protocol: "coda-v1",
      documentation: "/docs/coda.md",
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
          this.send(res, 400, codaError(400, "Bad Request", "Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, codaError(400, "Bad Request", "Bad request body"));
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
