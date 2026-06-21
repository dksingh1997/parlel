import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/voyage-ai — a tiny, dependency-free fake of the Voyage AI API.
//
// Speaks the wire protocol used by the `voyageai` SDK (and the REST API) so
// application code and AI agents can run against it at zero cost. Embeddings
// (1024-dim) and rerank scores are DETERMINISTIC: derived from a hash of the
// input. State is in-memory and ephemeral.
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

function hashFloat(input, idx) {
  const n = parseInt(hashOf(`${input}:${idx}`).slice(0, 8), 16);
  return (n / 0xffffffff) * 2 - 1;
}

// Deterministic relevance score in [0, 1) derived from the query+document pair.
function relevanceScore(query, document) {
  const n = parseInt(hashOf(`${query}::${document}`).slice(0, 12), 16);
  return (n % 1000000) / 1000000;
}

function tokenCount(text) {
  if (!text) return 0;
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function vError(message, code = 400) {
  return { detail: message };
}

const EMBED_MODELS = ["voyage-3", "voyage-3-lite", "voyage-large-2", "voyage-code-2", "voyage-multilingual-2"];
const RERANK_MODELS = ["rerank-2", "rerank-2-lite", "rerank-lite-1"];

export class VoyageAiServer {
  constructor(port = 4865, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.requests = [];
    this.idCounter = 0;
  }

  _record(kind) {
    this.idCounter += 1;
    this.requests.push({ n: this.idCounter, kind, at: new Date().toISOString() });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, vError(error.message || "Internal server error", 500));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-voyage");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts);
    }

    if (parts[0] !== "v1") return this.send(res, 404, vError("not found", 404));
    const route = parts.slice(1);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, vError("Provided API key is invalid.", 401));
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && route[0] === "embeddings" && route.length === 1) {
      return this.embeddings(res, body);
    }
    if (req.method === "POST" && route[0] === "rerank" && route.length === 1) {
      return this.rerank(res, body);
    }

    return this.send(res, 404, vError("not found", 404));
  }

  embeddings(res, body) {
    if (!isPlainObject(body) || body.input === undefined) {
      return this.send(res, 400, vError("input is required"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, vError("model is required"));
    }
    this._record("embeddings");

    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const dims = typeof body.output_dimension === "number" && body.output_dimension > 0 ? body.output_dimension : 1024;
    const data = inputs.map((input, index) => ({
      object: "embedding",
      embedding: Array.from({ length: dims }, (_, i) => Number(hashFloat(String(input), i).toFixed(6))),
      index,
    }));
    const totalTokens = inputs.reduce((s, i) => s + tokenCount(String(i)), 0);

    return this.send(res, 200, {
      object: "list",
      data,
      model: body.model,
      usage: { total_tokens: totalTokens },
    });
  }

  rerank(res, body) {
    if (!isPlainObject(body) || typeof body.query !== "string" || !body.query) {
      return this.send(res, 400, vError("query is required"));
    }
    if (!Array.isArray(body.documents) || body.documents.length === 0) {
      return this.send(res, 400, vError("documents is required"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, vError("model is required"));
    }
    this._record("rerank");

    const returnDocs = body.return_documents === true;
    let scored = body.documents.map((doc, index) => ({
      index,
      document: String(doc),
      relevance_score: Number(relevanceScore(body.query, String(doc)).toFixed(6)),
    }));
    // Sort by descending relevance score (rerank output is ranked).
    scored.sort((a, b) => b.relevance_score - a.relevance_score);
    if (typeof body.top_k === "number" && body.top_k > 0) scored = scored.slice(0, body.top_k);

    const data = scored.map((s) => {
      const entry = { index: s.index, relevance_score: s.relevance_score };
      if (returnDocs) entry.document = s.document;
      return entry;
    });

    const totalTokens = tokenCount(body.query) + body.documents.reduce((s, d) => s + tokenCount(String(d)), 0);

    return this.send(res, 200, {
      object: "list",
      data,
      model: body.model,
      usage: { total_tokens: totalTokens },
    });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "requests") {
      return this.send(res, 200, { requests: this.requests, count: this.requests.length });
    }
    return this.send(res, 404, vError("not found", 404));
  }

  root() {
    return { name: "voyage-ai", version: "1", protocol: "voyage-v1", documentation: "/docs/voyage-ai.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch {
          this.send(res, 400, vError("invalid JSON body", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, vError("invalid JSON body", 400));
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
