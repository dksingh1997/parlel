import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/cohere — a tiny, dependency-free fake of the Cohere v2 API.
// POST /v2/chat, POST /v2/embed, POST /v2/rerank. Speaks the wire protocol
// used by the official `cohere-ai` SDK. Deterministic responses derived from
// a hash of the input.
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

function hashInt(input, salt, max) {
  return parseInt(hashOf(`${salt}:${input}`).slice(0, 12), 16) % max;
}

function hashFloat(input, idx) {
  const n = parseInt(hashOf(`${input}:${idx}`).slice(0, 8), 16);
  return (n / 0xffffffff) * 2 - 1;
}

// Deterministic relevance score in [0, 1).
function hashScore(input) {
  const n = parseInt(hashOf(input).slice(0, 8), 16);
  return n / 0xffffffff;
}

function deterministicText(prompt) {
  const words = [
    "Based", "on", "your", "message", "Cohere", "Command", "returns", "this",
    "deterministic", "and", "reproducible", "answer", "for", "testing", "via",
    "parlel", "running", "locally", "at", "zero", "cost", "today", "now", "here",
  ];
  const count = 6 + hashInt(prompt, "len", 10);
  const out = [];
  for (let i = 0; i < count; i++) out.push(words[hashInt(prompt, `w${i}`, words.length)]);
  const text = out.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

function tokenCount(text) {
  if (!text) return 0;
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function promptFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      if (typeof m?.content === "string") return m.content;
      if (Array.isArray(m?.content)) return m.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ");
      return "";
    })
    .join("\n");
}

// Cohere error envelope: { message }
function coError(message) {
  return { message };
}

export class CohereServer {
  constructor(port = 4754, options = {}) {
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

  _record(kind, body) {
    this.idCounter += 1;
    this.requests.push({ n: this.idCounter, kind, body, at: new Date().toISOString() });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, coError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Client-Name");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-cohere");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (parts[0] !== "v2" && parts[0] !== "v1") return this.send(res, 404, coError("Not Found"));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, coError("invalid api token"));
    }

    const route = parts.slice(1);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && route[0] === "chat") return this.chat(res, body);
    if (req.method === "POST" && route[0] === "embed") return this.embed(res, body);
    if (req.method === "POST" && route[0] === "rerank") return this.rerank(res, body);

    return this.send(res, 404, coError("Not Found"));
  }

  // POST /v2/chat
  chat(res, body) {
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      return this.send(res, 400, coError("messages is required"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, coError("model is required"));
    }
    this._record("chat", body);

    const prompt = promptFromMessages(body.messages);
    const text = deterministicText(prompt);
    const inputTokens = tokenCount(prompt);
    const outputTokens = tokenCount(text);
    const id = hashOf(prompt).slice(0, 36);

    if (body.stream === true) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      write({ type: "message-start", id, delta: { message: { role: "assistant" } } });
      write({ type: "content-start", index: 0, delta: { message: { content: { type: "text", text: "" } } } });
      const words = text.split(" ");
      for (let i = 0; i < words.length; i++) {
        write({ type: "content-delta", index: 0, delta: { message: { content: { text: i === 0 ? words[i] : " " + words[i] } } } });
      }
      write({ type: "content-end", index: 0 });
      write({ type: "message-end", delta: { finish_reason: "COMPLETE", usage: { tokens: { input_tokens: inputTokens, output_tokens: outputTokens } } } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    return this.send(res, 200, {
      id,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
      finish_reason: "COMPLETE",
      usage: {
        billed_units: { input_tokens: inputTokens, output_tokens: outputTokens },
        tokens: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    });
  }

  // POST /v2/embed
  embed(res, body) {
    if (!isPlainObject(body)) return this.send(res, 400, coError("invalid body"));
    const texts = Array.isArray(body.texts) ? body.texts : [];
    if (texts.length === 0) {
      return this.send(res, 400, coError("texts is required"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, coError("model is required"));
    }
    if (!Array.isArray(body.input_type) && typeof body.input_type !== "string") {
      return this.send(res, 400, coError("input_type is required"));
    }
    this._record("embed", body);

    const dims = 1024;
    const embeddingTypes = Array.isArray(body.embedding_types) && body.embedding_types.length
      ? body.embedding_types
      : ["float"];
    const floatVectors = texts.map((t) =>
      Array.from({ length: dims }, (_, i) => Number(hashFloat(String(t), i).toFixed(6)))
    );
    const embeddings = {};
    if (embeddingTypes.includes("float")) embeddings.float = floatVectors;

    return this.send(res, 200, {
      id: hashOf(JSON.stringify(texts)).slice(0, 36),
      embeddings,
      texts,
      meta: { api_version: { version: "2" }, billed_units: { input_tokens: texts.reduce((s, t) => s + tokenCount(t), 0) } },
    });
  }

  // POST /v2/rerank
  rerank(res, body) {
    if (!isPlainObject(body) || typeof body.query !== "string" || !body.query) {
      return this.send(res, 400, coError("query is required"));
    }
    if (!Array.isArray(body.documents) || body.documents.length === 0) {
      return this.send(res, 400, coError("documents is required"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, coError("model is required"));
    }
    this._record("rerank", body);

    const docs = body.documents.map((d) => (typeof d === "string" ? d : d?.text || JSON.stringify(d)));
    let results = docs.map((doc, index) => ({
      index,
      relevance_score: Number(hashScore(`${body.query}:${doc}`).toFixed(6)),
    }));
    results.sort((a, b) => b.relevance_score - a.relevance_score);
    if (typeof body.top_n === "number") results = results.slice(0, body.top_n);

    return this.send(res, 200, {
      id: hashOf(`${body.query}:${docs.join("|")}`).slice(0, 36),
      results,
      meta: { api_version: { version: "2" }, billed_units: { search_units: 1 } },
    });
  }

  handleControl(req, res, parts, _body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "requests") {
      return this.send(res, 200, { requests: this.requests, count: this.requests.length });
    }
    if (req.method === "DELETE" && parts[1] === "requests") {
      this.requests = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, coError("not found"));
  }

  root() {
    return { name: "cohere", version: "1", protocol: "cohere-v2", documentation: "/docs/cohere.md" };
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
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, coError("Could not parse JSON body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, coError("Could not parse JSON body"));
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
