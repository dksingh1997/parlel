import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/chroma — a tiny, dependency-free fake of the Chroma API (v1).
//
// Speaks the wire protocol used by the official `chromadb` JS client so
// application code can run against it with zero cost. Collections store
// embeddings in memory and a REAL nearest-neighbor query is implemented
// (L2 squared distance, matching Chroma's default). State is in-memory.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashOf(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

function uuid(seed) {
  const h = hashOf(`${seed}:${Date.now()}:${Math.random()}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Squared L2 distance (Chroma's default space).
function l2sq(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function chError(message, status = 400) {
  return { error: message };
}

// Faithful Chroma `where` metadata filter: supports direct equality,
// the operators $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin, and $and/$or composition.
function matchWhere(metadata, where) {
  if (where == null) return true;
  if (!isPlainObject(where)) return true;
  const md = isPlainObject(metadata) ? metadata : {};
  for (const [key, cond] of Object.entries(where)) {
    if (key === "$and") {
      if (!Array.isArray(cond) || !cond.every((c) => matchWhere(md, c))) return false;
      continue;
    }
    if (key === "$or") {
      if (!Array.isArray(cond) || !cond.some((c) => matchWhere(md, c))) return false;
      continue;
    }
    const actual = md[key];
    if (isPlainObject(cond)) {
      for (const [op, val] of Object.entries(cond)) {
        if (!matchOp(actual, op, val)) return false;
      }
    } else if (actual !== cond) {
      return false;
    }
  }
  return true;
}

function matchOp(actual, op, val) {
  switch (op) {
    case "$eq": return actual === val;
    case "$ne": return actual !== val;
    case "$gt": return actual > val;
    case "$gte": return actual >= val;
    case "$lt": return actual < val;
    case "$lte": return actual <= val;
    case "$in": return Array.isArray(val) && val.includes(actual);
    case "$nin": return Array.isArray(val) && !val.includes(actual);
    default: return true;
  }
}

// Faithful `where_document` filter: { $contains } / { $not_contains },
// composable with $and/$or.
function matchWhereDocument(document, where) {
  if (where == null) return true;
  if (!isPlainObject(where)) return true;
  const doc = typeof document === "string" ? document : "";
  for (const [op, val] of Object.entries(where)) {
    if (op === "$and") {
      if (!Array.isArray(val) || !val.every((c) => matchWhereDocument(doc, c))) return false;
    } else if (op === "$or") {
      if (!Array.isArray(val) || !val.some((c) => matchWhereDocument(doc, c))) return false;
    } else if (op === "$contains") {
      if (!doc.includes(String(val))) return false;
    } else if (op === "$not_contains") {
      if (doc.includes(String(val))) return false;
    }
  }
  return true;
}

export class ChromaServer {
  constructor(port = 4860, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.collections = new Map(); // id -> { id, name, metadata, records: Map(id -> {embedding, document, metadata}) }
    this.byName = new Map(); // name -> id
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, chError(error.message || "Internal server error", 500));
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

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-chroma");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts);
    }

    // Chroma routes are under /api/v1
    if (!(parts[0] === "api" && parts[1] === "v1")) {
      return this.send(res, 404, chError("not found", 404));
    }

    const route = parts.slice(2); // strip api/v1

    // GET /api/v1/heartbeat
    if (req.method === "GET" && route[0] === "heartbeat" && route.length === 1) {
      return this.send(res, 200, { "nanosecond heartbeat": Date.now() * 1e6 });
    }
    // GET /api/v1/version
    if (req.method === "GET" && route[0] === "version" && route.length === 1) {
      return this.send(res, 200, "0.4.24-parlel");
    }
    // GET /api/v1/  (root identity)
    if (req.method === "GET" && route.length === 0) {
      return this.send(res, 200, { "nanosecond heartbeat": Date.now() * 1e6 });
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    // Collections
    if (route[0] === "collections") return this.handleCollections(req, res, route, body, url);

    return this.send(res, 404, chError("not found", 404));
  }

  handleCollections(req, res, route, body, url) {
    // /api/v1/collections
    if (route.length === 1) {
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 400, chError("name is required"));
        }
        let id = this.byName.get(body.name);
        if (id) {
          // get_or_create semantics
          if (body.get_or_create) return this.send(res, 200, this.viewCollection(this.collections.get(id)));
          return this.send(res, 409, chError(`Collection ${body.name} already exists`, 409));
        }
        id = uuid(body.name);
        const col = {
          id,
          name: body.name,
          metadata: isPlainObject(body.metadata) ? body.metadata : null,
          records: new Map(),
        };
        this.collections.set(id, col);
        this.byName.set(body.name, id);
        return this.send(res, 200, this.viewCollection(col));
      }
      if (req.method === "GET") {
        return this.send(res, 200, Array.from(this.collections.values()).map((c) => this.viewCollection(c)));
      }
      return this.send(res, 405, chError("method not allowed", 405));
    }

    // /api/v1/collections/:idOrName  (GET retrieve by name, DELETE by name)
    if (route.length === 2) {
      const key = route[1];
      const col = this.resolveCollection(key);
      if (req.method === "GET") {
        if (!col) return this.send(res, 404, chError(`Collection ${key} does not exist`, 404));
        return this.send(res, 200, this.viewCollection(col));
      }
      if (req.method === "DELETE") {
        if (!col) return this.send(res, 404, chError(`Collection ${key} does not exist`, 404));
        this.collections.delete(col.id);
        this.byName.delete(col.name);
        return this.send(res, 200, null);
      }
      return this.send(res, 405, chError("method not allowed", 405));
    }

    // /api/v1/collections/:id/{add|query|get|count|delete|upsert}
    if (route.length === 3) {
      const key = route[1];
      const action = route[2];
      const col = this.resolveCollection(key);
      if (!col) return this.send(res, 404, chError(`Collection ${key} does not exist`, 404));

      if (req.method === "POST" && (action === "add" || action === "upsert")) {
        return this.add(res, col, body);
      }
      if (req.method === "POST" && action === "query") {
        return this.query(res, col, body);
      }
      if (req.method === "POST" && action === "get") {
        return this.getRecords(res, col, body);
      }
      if (req.method === "GET" && action === "count") {
        return this.send(res, 200, col.records.size);
      }
      if (req.method === "POST" && action === "delete") {
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        for (const id of ids) col.records.delete(id);
        return this.send(res, 200, ids);
      }
      return this.send(res, 405, chError("method not allowed", 405));
    }

    return this.send(res, 404, chError("not found", 404));
  }

  add(res, col, body) {
    if (!isPlainObject(body) || !Array.isArray(body.embeddings)) {
      return this.send(res, 400, chError("embeddings are required"));
    }
    const n = body.embeddings.length;
    const ids = Array.isArray(body.ids) ? body.ids : body.embeddings.map((_, i) => uuid(`auto${i}`));
    const documents = Array.isArray(body.documents) ? body.documents : new Array(n).fill(null);
    const metadatas = Array.isArray(body.metadatas) ? body.metadatas : new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      col.records.set(ids[i], {
        id: ids[i],
        embedding: body.embeddings[i].map(Number),
        document: documents[i] ?? null,
        metadata: metadatas[i] ?? null,
      });
    }
    return this.send(res, 201, true);
  }

  query(res, col, body) {
    if (!isPlainObject(body)) return this.send(res, 400, chError("invalid body"));
    const queryEmbeddings = body.query_embeddings;
    if (!Array.isArray(queryEmbeddings) || !Array.isArray(queryEmbeddings[0])) {
      return this.send(res, 400, chError("query_embeddings are required"));
    }
    const nResults = typeof body.n_results === "number" ? body.n_results : 10;
    const records = Array.from(col.records.values()).filter(
      (r) => matchWhere(r.metadata, body.where) && matchWhereDocument(r.document, body.where_document),
    );

    const ids = [];
    const distances = [];
    const documents = [];
    const metadatas = [];
    const embeddings = [];
    const includeEmb = Array.isArray(body.include) && body.include.includes("embeddings");

    for (const q of queryEmbeddings) {
      const scored = records
        .map((r) => ({ r, dist: l2sq(q, r.embedding) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, nResults);
      ids.push(scored.map((s) => s.r.id));
      distances.push(scored.map((s) => Number(s.dist.toFixed(6))));
      documents.push(scored.map((s) => s.r.document));
      metadatas.push(scored.map((s) => s.r.metadata));
      if (includeEmb) embeddings.push(scored.map((s) => s.r.embedding));
    }

    const out = { ids, distances, documents, metadatas };
    if (includeEmb) out.embeddings = embeddings;
    return this.send(res, 200, out);
  }

  getRecords(res, col, body) {
    const want = Array.isArray(body?.ids) ? new Set(body.ids) : null;
    let recs = Array.from(col.records.values()).filter((r) => (want ? want.has(r.id) : true));
    recs = recs.filter(
      (r) => matchWhere(r.metadata, body?.where) && matchWhereDocument(r.document, body?.where_document),
    );
    const limit = typeof body?.limit === "number" ? body.limit : null;
    const offset = typeof body?.offset === "number" ? body.offset : 0;
    if (offset) recs = recs.slice(offset);
    if (limit !== null) recs = recs.slice(0, limit);
    return this.send(res, 200, {
      ids: recs.map((r) => r.id),
      documents: recs.map((r) => r.document),
      metadatas: recs.map((r) => r.metadata),
      embeddings: recs.map((r) => r.embedding),
    });
  }

  resolveCollection(key) {
    if (this.collections.has(key)) return this.collections.get(key);
    const id = this.byName.get(key);
    return id ? this.collections.get(id) : null;
  }

  viewCollection(col) {
    return { id: col.id, name: col.name, metadata: col.metadata };
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "collections") {
      return this.send(res, 200, {
        collections: Array.from(this.collections.values()).map((c) => ({
          ...this.viewCollection(c),
          count: c.records.size,
        })),
        count: this.collections.size,
      });
    }
    return this.send(res, 404, chError("not found", 404));
  }

  root() {
    return { name: "chroma", version: "1", protocol: "chroma-v1", documentation: "/docs/chroma.md" };
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, chError("invalid JSON body", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, chError("invalid JSON body", 400));
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
