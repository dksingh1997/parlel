import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/algolia — a tiny, dependency-free fake of the Algolia Search &
// Indexing API. Implements a *real* substring/token search over indexed
// objects so queries return matching hits. State is in-memory and ephemeral.
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

function newObjectId() {
  return randomBytes(12).toString("hex");
}

function newTaskId() {
  return Math.floor(Math.random() * 1e12) + 1;
}

// Flatten an object's string/number values into a single searchable string.
function searchableText(obj) {
  const parts = [];
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      parts.push(String(v));
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === "object") {
      for (const key of Object.keys(v)) walk(v[key]);
    }
  };
  walk(obj);
  return parts.join(" ").toLowerCase();
}

function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export class AlgoliaServer {
  constructor(port = 4884, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // indexName -> Map(objectID -> object)
    this.indexes = new Map();
  }

  getIndex(name, create = false) {
    if (!this.indexes.has(name) && create) {
      this.indexes.set(name, new Map());
    }
    return this.indexes.get(name);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message || "Internal server error" });
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
    res.setHeader("Access-Control-Allow-Headers", "X-Algolia-API-Key, X-Algolia-Application-Id, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-algolia");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "1") {
      return this.send(res, 404, { message: "Not found" });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 403, { message: "Invalid Application-ID or API key" });
    }

    // /1/indexes/...
    if (parts[1] === "indexes") {
      const indexName = parts[2];
      const sub = parts[3];

      if (!indexName) {
        return this.send(res, 404, { message: "Not found" });
      }

      // POST /1/indexes/:indexName  -> add object (auto objectID)
      if (parts.length === 3 && req.method === "POST") {
        return this.addObject(res, indexName, body);
      }

      // DELETE /1/indexes/:indexName  -> delete index
      if (parts.length === 3 && req.method === "DELETE") {
        return this.deleteIndex(res, indexName);
      }

      // POST /1/indexes/:indexName/query  -> search
      if (sub === "query" && parts.length === 4 && req.method === "POST") {
        return this.query(res, indexName, body);
      }

      // POST /1/indexes/:indexName/batch
      if (sub === "batch" && parts.length === 4 && req.method === "POST") {
        return this.batch(res, indexName, body);
      }

      // /1/indexes/:indexName/:objectID
      if (parts.length === 4 && sub !== "query" && sub !== "batch") {
        const objectID = sub;
        const index = this.getIndex(indexName);
        if (req.method === "GET") {
          const obj = index && index.get(objectID);
          if (!obj) return this.send(res, 404, { message: "ObjectID does not exist" });
          return this.send(res, 200, clone(obj));
        }
        if (req.method === "PUT") {
          return this.putObject(res, indexName, objectID, body);
        }
        if (req.method === "DELETE") {
          if (index) index.delete(objectID);
          return this.send(res, 200, { taskID: newTaskId(), deletedAt: new Date().toISOString() });
        }
      }
    }

    return this.send(res, 404, { message: "Not found" });
  }

  addObject(res, indexName, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, { message: "Invalid JSON body" });
    }
    const index = this.getIndex(indexName, true);
    const objectID = body.objectID ? String(body.objectID) : newObjectId();
    const obj = { ...clone(body), objectID };
    index.set(objectID, obj);
    return this.send(res, 201, {
      objectID,
      taskID: newTaskId(),
      createdAt: new Date().toISOString(),
    });
  }

  putObject(res, indexName, objectID, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, { message: "Invalid JSON body" });
    }
    if (body.objectID !== undefined && String(body.objectID) !== objectID) {
      return this.send(res, 400, { message: "Invalid objectID: body and URL mismatch" });
    }
    const index = this.getIndex(indexName, true);
    const obj = { ...clone(body), objectID };
    index.set(objectID, obj);
    return this.send(res, 200, {
      objectID,
      taskID: newTaskId(),
      updatedAt: new Date().toISOString(),
    });
  }

  deleteIndex(res, indexName) {
    this.indexes.delete(indexName);
    return this.send(res, 200, {
      taskID: newTaskId(),
      deletedAt: new Date().toISOString(),
    });
  }

  batch(res, indexName, body) {
    if (!isPlainObject(body) || !Array.isArray(body.requests)) {
      return this.send(res, 400, { message: "Invalid JSON body" });
    }
    const index = this.getIndex(indexName, true);
    const requests = body.requests;
    const objectIDs = [];
    for (const r of requests) {
      const action = r.action;
      const obj = r.body || {};
      if (action === "addObject") {
        const objectID = obj.objectID ? String(obj.objectID) : newObjectId();
        index.set(objectID, { ...clone(obj), objectID });
        objectIDs.push(objectID);
      } else if (action === "updateObject") {
        const objectID = String(obj.objectID);
        index.set(objectID, { ...clone(obj), objectID });
        objectIDs.push(objectID);
      } else if (action === "partialUpdateObject") {
        const objectID = String(obj.objectID);
        const existing = index.get(objectID) || { objectID };
        index.set(objectID, { ...existing, ...clone(obj), objectID });
        objectIDs.push(objectID);
      } else if (action === "partialUpdateObjectNoCreate") {
        const objectID = String(obj.objectID);
        if (index.has(objectID)) {
          const existing = index.get(objectID);
          index.set(objectID, { ...existing, ...clone(obj), objectID });
        }
        objectIDs.push(objectID);
      } else if (action === "deleteObject") {
        const objectID = String(obj.objectID);
        index.delete(objectID);
        objectIDs.push(objectID);
      } else if (action === "delete") {
        this.indexes.delete(indexName);
      } else if (action === "clear") {
        index.clear();
      }
    }
    return this.send(res, 200, { taskID: newTaskId(), objectIDs });
  }

  // Real substring/token search.
  query(res, indexName, body) {
    const index = this.getIndex(indexName) || new Map();
    const queryStr = (isPlainObject(body) && typeof body.query === "string") ? body.query : "";
    const hitsPerPage = (isPlainObject(body) && Number(body.hitsPerPage)) || 20;
    const page = (isPlainObject(body) && Number(body.page)) || 0;

    const all = Array.from(index.values());
    const qTokens = tokenize(queryStr);

    let matched;
    if (qTokens.length === 0) {
      matched = all.slice();
    } else {
      matched = all.filter((obj) => {
        const text = searchableText(obj);
        // A record matches if every query token is a substring of the record text.
        return qTokens.every((tok) => text.includes(tok));
      });
    }

    // Rank: more token occurrences / earlier position scores higher (stable-ish).
    matched.sort((a, b) => {
      const ta = searchableText(a);
      const tb = searchableText(b);
      const sa = qTokens.reduce((acc, t) => acc + (ta.indexOf(t) >= 0 ? 1 : 0), 0);
      const sb = qTokens.reduce((acc, t) => acc + (tb.indexOf(t) >= 0 ? 1 : 0), 0);
      return sb - sa;
    });

    const nbHits = matched.length;
    const nbPages = Math.max(1, Math.ceil(nbHits / hitsPerPage));
    const start = page * hitsPerPage;
    const pageHits = matched.slice(start, start + hitsPerPage).map((obj) => {
      const hit = clone(obj);
      // Minimal _highlightResult so SDK consumers don't choke.
      hit._highlightResult = this.buildHighlight(obj, qTokens);
      return hit;
    });

    return this.send(res, 200, {
      hits: pageHits,
      nbHits,
      page,
      nbPages,
      hitsPerPage,
      query: queryStr,
      params: `query=${encodeURIComponent(queryStr)}&hitsPerPage=${hitsPerPage}&page=${page}`,
      processingTimeMS: 1,
      exhaustiveNbHits: true,
    });
  }

  buildHighlight(obj, qTokens) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "objectID") continue;
      if (typeof v === "string") {
        const lower = v.toLowerCase();
        const matchLevel = qTokens.some((t) => lower.includes(t)) ? "full" : "none";
        out[k] = { value: v, matchLevel, matchedWords: qTokens.filter((t) => lower.includes(t)) };
      }
    }
    return out;
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { message: "Not found" });
  }

  root() {
    return {
      name: "algolia",
      version: "1",
      protocol: "algolia-search",
      documentation: "/docs/algolia.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const key = req.headers["x-algolia-api-key"];
    const appId = req.headers["x-algolia-application-id"];
    return typeof key === "string" && key.length > 0 && typeof appId === "string" && appId.length > 0;
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
          this.send(res, 400, { message: "Invalid JSON body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Invalid JSON body" });
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
