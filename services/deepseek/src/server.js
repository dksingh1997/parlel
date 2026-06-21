import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/deepseek — a tiny, dependency-free fake of the DeepSeek API, which is
// OpenAI-compatible. POST /chat/completions and GET /models. Deterministic
// responses derived from a hash of the input.
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

function deterministicText(prompt) {
  const words = [
    "Based", "on", "your", "request", "DeepSeek", "returns", "this",
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
  return messages.map((m) => (typeof m?.content === "string" ? m.content : "")).join("\n");
}

function oaiError(message, type = "invalid_request_error", param = null, code = null) {
  return { error: { message, type, param, code } };
}

const MODELS = ["deepseek-chat", "deepseek-reasoner"];

export class DeepseekServer {
  constructor(port = 4752, options = {}) {
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
    res.setHeader("server", "parlel-deepseek");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, oaiError("Authentication Fails", "authentication_error", null, "invalid_request_error"));
    }

    // GET /models  (and the openai SDK may prefix /v1)
    const route = parts[0] === "v1" ? parts.slice(1) : parts;

    if (req.method === "GET" && route[0] === "models" && route.length === 1) {
      return this.send(res, 200, {
        object: "list",
        data: MODELS.map((id) => ({ id, object: "model", owned_by: "deepseek" })),
      });
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && route[0] === "chat" && route[1] === "completions") {
      return this.chatCompletions(res, body);
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
    const isReasoner = model === "deepseek-reasoner";
    const reasoning = isReasoner ? `Let me think step by step about ${prompt.slice(0, 20)}.` : null;
    const promptTokens = tokenCount(prompt);
    const completionTokens = tokenCount(text) + (reasoning ? tokenCount(reasoning) : 0);
    const id = `chatcmpl-${hashOf(prompt).slice(0, 24)}`;
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
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const message = { role: "assistant", content: text };
    if (reasoning) message.reasoning_content = reasoning;

    return this.send(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: promptTokens,
      },
      system_fingerprint: `fp_${hashOf(model).slice(0, 10)}`,
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
    return { name: "deepseek", version: "1", protocol: "openai-compatible", documentation: "/docs/deepseek.md" };
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
