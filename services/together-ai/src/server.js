import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/together-ai — a tiny, dependency-free fake of the Together AI API.
//
// Together AI is OpenAI-compatible. Speaks the wire protocol used by the
// `together-ai` / `openai` SDKs so application code and AI agents can run
// against it at zero cost. All output is DETERMINISTIC (hash-derived).
// Supports SSE streaming. State is in-memory and ephemeral.
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

function deterministicText(prompt) {
  const words = [
    "Together", "AI", "serves", "open", "models", "and", "returns",
    "deterministic", "output", "for", "parlel", "tests", "fully",
    "reproducible", "from", "the", "input", "hash", "here", "now", "today",
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
  return messages.map((m) => {
    if (typeof m?.content === "string") return m.content;
    if (Array.isArray(m?.content)) return m.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ");
    return "";
  }).join("\n");
}

function oaiError(message, type = "invalid_request_error", code = null) {
  return { error: { message, type, code } };
}

const BASE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const MODELS = [
  "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
  "mistralai/Mixtral-8x7B-Instruct-v0.1",
  "Qwen/Qwen2.5-72B-Instruct-Turbo",
  "togethercomputer/m2-bert-80M-8k-retrieval",
  "black-forest-labs/FLUX.1-schnell",
];

export class TogetherAiServer {
  constructor(port = 4863, options = {}) {
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
    this.requests.push({ n: this.idCounter, kind, at: new Date().toISOString() });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, oaiError(error.message || "Internal server error", "server_error"));
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
    res.setHeader("server", "parlel-together");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts);
    }

    if (parts[0] !== "v1") return this.send(res, 404, oaiError("Unknown endpoint"));
    const route = parts.slice(1);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, oaiError("Invalid API key provided", "authentication_error", "invalid_api_key"));
    }

    // GET /v1/models
    if (req.method === "GET" && route[0] === "models" && route.length === 1) {
      return this.send(res, 200, MODELS.map((id) => ({
        id, object: "model", created: 1700000000, type: id.includes("FLUX") ? "image" : "chat",
        organization: id.split("/")[0],
      })));
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && route[0] === "chat" && route[1] === "completions") {
      return this.chatCompletions(res, body);
    }
    if (req.method === "POST" && route[0] === "completions") {
      return this.completions(res, body);
    }
    if (req.method === "POST" && route[0] === "embeddings") {
      return this.embeddings(res, body);
    }
    if (req.method === "POST" && route[0] === "images" && route[1] === "generations") {
      return this.images(res, body);
    }

    return this.send(res, 404, oaiError("Unknown endpoint"));
  }

  chatCompletions(res, body) {
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      return this.send(res, 400, oaiError("messages is a required property"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("model is a required property"));
    }
    this._record("chat", body);

    const model = body.model;
    const prompt = promptFromMessages(body.messages);
    const text = deterministicText(prompt);
    const promptTokens = tokenCount(prompt);
    const completionTokens = tokenCount(text);
    const id = `${hashOf(prompt).slice(0, 24)}`;
    const created = 1700000000;

    if (body.stream === true) {
      return this.streamChat(res, { id, created, model, text, promptTokens, completionTokens });
    }

    return this.send(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
  }

  streamChat(res, ctx) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const base = { id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model: ctx.model };
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    const words = ctx.text.split(" ");
    for (let i = 0; i < words.length; i++) {
      const piece = i === 0 ? words[i] : " " + words[i];
      write({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
    write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  completions(res, body) {
    if (!isPlainObject(body) || body.prompt === undefined) {
      return this.send(res, 400, oaiError("prompt is a required property"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("model is a required property"));
    }
    this._record("completion", body);
    const prompt = Array.isArray(body.prompt) ? body.prompt.join("\n") : String(body.prompt);
    const text = " " + deterministicText(prompt);
    const promptTokens = tokenCount(prompt);
    const completionTokens = tokenCount(text);
    return this.send(res, 200, {
      id: hashOf(prompt).slice(0, 24),
      object: "text_completion",
      created: 1700000000,
      model: body.model,
      choices: [{ text, index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
  }

  embeddings(res, body) {
    if (!isPlainObject(body) || body.input === undefined) {
      return this.send(res, 400, oaiError("input is a required property"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("model is a required property"));
    }
    this._record("embeddings", body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const dims = 768;
    const data = inputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: dims }, (_, i) => Number(hashFloat(String(input), i).toFixed(6))),
    }));
    const promptTokens = inputs.reduce((s, i) => s + tokenCount(String(i)), 0);
    return this.send(res, 200, {
      object: "list", data, model: body.model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    });
  }

  images(res, body) {
    if (!isPlainObject(body) || typeof body.prompt !== "string" || !body.prompt) {
      return this.send(res, 400, oaiError("prompt is a required property"));
    }
    this._record("images", body);
    const n = typeof body.n === "number" ? body.n : 1;
    const data = Array.from({ length: n }, (_, i) => {
      const seed = `${body.prompt}:${i}`;
      const img = Buffer.concat([BASE_PNG, Buffer.from(hashOf(seed), "hex")]);
      return { index: i, b64_json: img.toString("base64") };
    });
    return this.send(res, 200, {
      id: hashOf(body.prompt).slice(0, 24),
      model: typeof body.model === "string" ? body.model : "black-forest-labs/FLUX.1-schnell",
      object: "list",
      data,
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
    return this.send(res, 404, oaiError("not found"));
  }

  root() {
    return { name: "together-ai", version: "1", protocol: "together-v1", documentation: "/docs/together-ai.md" };
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
          this.send(res, 400, oaiError("We could not parse the JSON body of your request."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, oaiError("We could not parse the JSON body of your request."));
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
