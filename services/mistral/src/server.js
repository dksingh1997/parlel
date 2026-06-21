import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mistral — a tiny, dependency-free fake of the Mistral AI API, which
// is OpenAI-compatible under /v1. Chat completions (+stream), embeddings, and
// models. Speaks the wire protocol used by the official `@mistralai/mistralai`
// SDK. Deterministic responses derived from a hash of the input.
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
    "Based", "on", "your", "request", "Mistral", "returns", "this",
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

function oaiError(message, type = "invalid_request_error", param = null, code = null) {
  return { error: { message, type, param, code } };
}

const MODELS = [
  "mistral-large-latest", "mistral-small-latest", "mistral-medium-latest",
  "open-mistral-nemo", "codestral-latest", "mistral-embed",
];

export class MistralServer {
  constructor(port = 4755, options = {}) {
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
          this.send(res, 500, oaiError(error.message || "Internal server error", "internal_server_error"));
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
    res.setHeader("server", "parlel-mistral");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (parts[0] !== "v1") return this.send(res, 404, oaiError("Not Found", "invalid_request_error"));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, oaiError("Unauthorized", "invalid_request_error", null, "401"));
    }

    const route = parts.slice(1);

    if (req.method === "GET" && route[0] === "models" && route.length === 1) {
      return this.send(res, 200, {
        object: "list",
        data: MODELS.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "mistralai" })),
      });
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && route[0] === "chat" && route[1] === "completions") {
      return this.chatCompletions(res, body);
    }
    if (req.method === "POST" && route[0] === "embeddings") {
      return this.embeddings(res, body);
    }

    return this.send(res, 404, oaiError("Not Found", "invalid_request_error"));
  }

  chatCompletions(res, body) {
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      return this.send(res, 400, oaiError("messages is required", "invalid_request_error", "messages"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("model is required", "invalid_request_error", "model"));
    }
    this._record("chat", body);

    const model = body.model;
    const prompt = promptFromMessages(body.messages);
    const text = deterministicText(prompt);
    const promptTokens = tokenCount(prompt);
    const completionTokens = tokenCount(text);
    const id = `cmpl-${hashOf(prompt).slice(0, 24)}`;
    const created = 1700000000;

    if (body.stream === true) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      const base = { id, object: "chat.completion.chunk", created, model };
      const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      const words = text.split(" ");
      for (let i = 0; i < words.length; i++) {
        write({ ...base, choices: [{ index: 0, delta: { content: i === 0 ? words[i] : " " + words[i] }, finish_reason: null }] });
      }
      write({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    return this.send(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text, tool_calls: null }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  }

  embeddings(res, body) {
    if (!isPlainObject(body) || body.input === undefined) {
      return this.send(res, 400, oaiError("input is required", "invalid_request_error", "input"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("model is required", "invalid_request_error", "model"));
    }
    this._record("embeddings", body);

    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const dims = 1024;
    const data = inputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: dims }, (_, i) => Number(hashFloat(String(input), i).toFixed(6))),
    }));
    const promptTokens = inputs.reduce((sum, i) => sum + tokenCount(String(i)), 0);

    return this.send(res, 200, {
      id: `embd-${hashOf(JSON.stringify(inputs)).slice(0, 24)}`,
      object: "list",
      data,
      model: body.model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens, completion_tokens: 0 },
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
    return this.send(res, 404, oaiError("not found", "invalid_request_error"));
  }

  root() {
    return { name: "mistral", version: "1", protocol: "openai-compatible", documentation: "/docs/mistral.md" };
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
          this.send(res, 400, oaiError("Could not parse JSON body", "invalid_request_error"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, oaiError("Could not parse JSON body", "invalid_request_error"));
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
