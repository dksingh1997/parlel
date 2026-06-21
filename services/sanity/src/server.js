import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/sanity — a tiny, dependency-free fake of the Sanity content API.
//
// Speaks the Sanity HTTP wire protocol so application code using the real
// `@sanity/client` can run against it:
//   GET  /v2021-10-21/data/query/:dataset?query=<GROQ>
//   POST /v2021-10-21/data/mutate/:dataset
//   GET  /v2021-10-21/data/doc/:dataset/:id
// State is in-memory and ephemeral. A minimal GROQ subset is supported:
//   *                          -> all documents
//   *[_type == "x"]            -> documents whose _type matches
//   *[_id == "x"]             -> document by id
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanityError(status, description) {
  return { error: { description, type: status === 401 ? "unauthorized" : "queryParseError", statusCode: status } };
}

function newId() {
  return randomBytes(12).toString("hex");
}

export class SanityServer {
  constructor(port = 4842, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.docs = new Map(); // _id -> document
    this.txCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, sanityError(500, error.message || "error"));
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
    res.setHeader("server", "parlel-sanity");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, sanityError(404, "not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, sanityError(401, "Unauthorized - invalid token"));
    }

    let body = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString("utf8")); } catch { body = {}; }
    }

    // /vX/data/query/:dataset
    if (parts[1] === "data" && parts[2] === "query") {
      if (req.method === "GET") return this.query(res, url.searchParams.get("query") || "");
    }
    // /vX/data/mutate/:dataset
    if (parts[1] === "data" && parts[2] === "mutate") {
      if (req.method === "POST") return this.mutate(res, body, url);
    }
    // /vX/data/doc/:dataset/:id
    if (parts[1] === "data" && parts[2] === "doc" && parts[4]) {
      if (req.method === "GET") return this.getDoc(res, parts[4]);
    }

    return this.send(res, 404, sanityError(404, "not found"));
  }

  query(res, groq) {
    const start = Date.now();
    let result;
    try {
      result = this.runGroq(groq);
    } catch (error) {
      return this.send(res, 400, sanityError(400, error.message));
    }
    return this.send(res, 200, { ms: Date.now() - start, query: groq, result });
  }

  // Minimal GROQ: supports `*`, `*[_type == "x"]`, `*[_id == "x"]`, and a
  // trailing `[0]` to pick the first element.
  runGroq(groq) {
    const q = String(groq).trim();
    const all = Array.from(this.docs.values());
    let pickFirst = false;
    let expr = q;
    const firstMatch = expr.match(/\[0\]\s*$/);
    if (firstMatch) {
      pickFirst = true;
      expr = expr.slice(0, firstMatch.index).trim();
    }

    let results = all;
    if (expr === "*") {
      results = all;
    } else {
      const m = expr.match(/^\*\s*\[\s*(.+?)\s*\]$/s);
      if (!m) throw new Error("Unsupported GROQ query");
      const filter = m[1];
      const eq = filter.match(/^(\w+)\s*==\s*["'](.+?)["']$/);
      if (eq) {
        const [, field, value] = eq;
        results = all.filter((d) => d[field] === value);
      } else {
        throw new Error("Unsupported GROQ filter");
      }
    }
    return pickFirst ? (results[0] ?? null) : results;
  }

  mutate(res, body, url) {
    const mutations = Array.isArray(body?.mutations) ? body.mutations : [];
    const returnIds = url.searchParams.get("returnIds") === "true";
    const returnDocs = url.searchParams.get("returnDocuments") === "true";
    const results = [];
    const documents = [];

    for (const mutation of mutations) {
      if (mutation.create || mutation.createIfNotExists || mutation.createOrReplace) {
        const doc = mutation.create || mutation.createIfNotExists || mutation.createOrReplace;
        const id = doc._id || `${doc._type || "doc"}.${newId()}`;
        if (mutation.createIfNotExists && this.docs.has(id)) {
          results.push({ id, operation: "none" });
          documents.push(this.docs.get(id));
          continue;
        }
        const stored = {
          ...doc,
          _id: id,
          _type: doc._type || "document",
          _createdAt: new Date().toISOString(),
          _updatedAt: new Date().toISOString(),
          _rev: newId(),
        };
        this.docs.set(id, stored);
        results.push({ id, operation: mutation.createOrReplace ? "createOrReplace" : "create" });
        documents.push(stored);
      } else if (mutation.patch) {
        const { id, set, unset, inc } = mutation.patch;
        const doc = this.docs.get(id);
        if (doc) {
          if (isPlainObject(set)) Object.assign(doc, set);
          if (Array.isArray(unset)) for (const key of unset) delete doc[key];
          if (isPlainObject(inc)) for (const [k, v] of Object.entries(inc)) doc[k] = (doc[k] || 0) + v;
          doc._updatedAt = new Date().toISOString();
          doc._rev = newId();
          documents.push(doc);
        }
        results.push({ id, operation: "update" });
      } else if (mutation.delete) {
        const id = mutation.delete.id;
        if (this.docs.has(id)) {
          documents.push(this.docs.get(id));
          this.docs.delete(id);
        }
        results.push({ id, operation: "delete" });
      }
    }

    this.txCounter += 1;
    const response = {
      transactionId: newId(),
      results,
    };
    if (returnIds) response.documentIds = results.map((r) => r.id);
    if (returnDocs) response.documents = documents;
    return this.send(res, 200, response);
  }

  getDoc(res, id) {
    const doc = this.docs.get(id);
    return this.send(res, 200, { documents: doc ? [doc] : [] });
  }

  root() {
    return { name: "sanity", version: "1", protocol: "sanity-http", documentation: "/docs/sanity.md" };
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
