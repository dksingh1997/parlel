import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/openrouter — a tiny, dependency-free fake of the OpenRouter API.
//
// OpenRouter is OpenAI-compatible and adds a routing/model marketplace on top.
// Speaks the wire protocol used by the `openai` SDK (pointed at OpenRouter) so
// application code and AI agents can run against it with zero cost. All output
// is DETERMINISTIC: derived from a hash of the input. Supports SSE streaming.
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
    "OpenRouter", "routes", "your", "request", "to", "the", "best", "model",
    "and", "returns", "deterministic", "output", "for", "parlel", "tests",
    "fully", "reproducible", "from", "the", "input", "hash", "today", "now",
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

const MODELS = [
  "openai/gpt-4o", "openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet",
  "google/gemini-pro-1.5", "meta-llama/llama-3.1-70b-instruct",
  "mistralai/mistral-large", "openai/text-embedding-3-small",
];

export class OpenrouterServer {
  constructor(port = 4861, options = {}) {
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, HTTP-Referer, X-Title");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-openrouter");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts);
    }

    // OpenRouter routes are under /api/v1
    if (!(parts[0] === "api" && parts[1] === "v1")) {
      return this.send(res, 404, oaiError("Unknown endpoint"));
    }
    const route = parts.slice(2);

    // GET /api/v1/models is public on OpenRouter.
    if (req.method === "GET" && route[0] === "models" && route.length === 1) {
      return this.send(res, 200, {
        data: MODELS.map((id) => ({
          id,
          name: id,
          context_length: 128000,
          pricing: { prompt: "0", completion: "0" },
          architecture: { modality: "text", tokenizer: "parlel" },
        })),
      });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, oaiError("No auth credentials found", "authentication_error", 401));
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && route[0] === "chat" && route[1] === "completions") {
      return this.chatCompletions(res, body);
    }
    if (req.method === "POST" && route[0] === "embeddings") {
      return this.embeddings(res, body);
    }

    return this.send(res, 404, oaiError("Unknown endpoint"));
  }

  chatCompletions(res, body) {
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      return this.send(res, 400, oaiError("messages is a required field"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("model is a required field"));
    }
    this._record("chat", body);

    const model = body.model;
    const prompt = promptFromMessages(body.messages);
    const text = deterministicText(prompt);
    const promptTokens = tokenCount(prompt);
    const completionTokens = tokenCount(text);
    const id = `gen-${hashOf(prompt).slice(0, 24)}`;
    const created = 1700000000;

    if (body.stream === true) {
      return this.streamChat(res, { id, created, model, text, promptTokens, completionTokens });
    }

    return this.send(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      // OpenRouter-specific routing field.
      provider: model.split("/")[0] || "parlel",
      choices: [
        { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  }

  streamChat(res, ctx) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const base = {
      id: ctx.id,
      object: "chat.completion.chunk",
      created: ctx.created,
      model: ctx.model,
      provider: ctx.model.split("/")[0] || "parlel",
    };
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

  embeddings(res, body) {
    if (!isPlainObject(body) || body.input === undefined) {
      return this.send(res, 400, oaiError("input is a required field"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("model is a required field"));
    }
    this._record("embeddings", body);

    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const dims = typeof body.dimensions === "number" && body.dimensions > 0 ? body.dimensions : 1536;
    const data = inputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: dims }, (_, i) => Number(hashFloat(String(input), i).toFixed(6))),
    }));
    const promptTokens = inputs.reduce((s, i) => s + tokenCount(String(i)), 0);

    return this.send(res, 200, {
      object: "list",
      data,
      model: body.model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
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
    return { name: "openrouter", version: "1", protocol: "openrouter-v1", documentation: "/docs/openrouter.md" };
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
