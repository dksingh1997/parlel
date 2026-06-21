import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/groq — a tiny, dependency-free fake of the Groq API, which is
// OpenAI-compatible and mounted under /openai/v1. Speaks the wire protocol
// used by the official `groq-sdk` (and the `openai` SDK pointed at Groq).
// Deterministic responses derived from a hash of the input.
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
    "Based", "on", "your", "request", "Groq", "returns", "this", "fast",
    "deterministic", "and", "reproducible", "answer", "for", "testing", "via",
    "parlel", "running", "locally", "at", "zero", "cost", "today", "here", "now",
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
  "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "llama3-70b-8192",
  "mixtral-8x7b-32768", "gemma2-9b-it", "whisper-large-v3",
];

export class GroqServer {
  constructor(port = 4750, options = {}) {
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
    res.setHeader("server", "parlel-groq");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    // Groq mounts the OpenAI-compatible API under /openai/v1
    if (parts[0] !== "openai" || parts[1] !== "v1") {
      return this.send(res, 404, oaiError("Unknown endpoint", "invalid_request_error"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, oaiError(
        "Invalid API Key", "invalid_request_error", null, "invalid_api_key",
      ));
    }

    const route = parts.slice(2);

    if (req.method === "GET" && route[0] === "models") {
      if (route.length === 1) {
        return this.send(res, 200, {
          object: "list",
          data: MODELS.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "Groq", active: true })),
        });
      }
      const id = route.slice(1).join("/");
      return this.send(res, 200, { id, object: "model", created: 1700000000, owned_by: "Groq", active: true });
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && route[0] === "chat" && route[1] === "completions") {
      return this.chatCompletions(res, body);
    }

    return this.send(res, 404, oaiError("Unknown endpoint", "invalid_request_error"));
  }

  chatCompletions(res, body) {
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      return this.send(res, 400, oaiError("you must provide a messages parameter", "invalid_request_error", "messages"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("you must provide a model parameter", "invalid_request_error", "model"));
    }
    this._record("chat", body);

    const model = body.model;
    const prompt = promptFromMessages(body.messages);
    const text = deterministicText(prompt);
    const promptTokens = tokenCount(prompt);
    const completionTokens = tokenCount(text);
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
      write({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        x_groq: { id: `req_${hashOf(id).slice(0, 16)}`, usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } },
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
      choices: [{ index: 0, message: { role: "assistant", content: text }, logprobs: null, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      system_fingerprint: `fp_${hashOf(model).slice(0, 10)}`,
      x_groq: { id: `req_${hashOf(id).slice(0, 16)}` },
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
    return { name: "groq", version: "1", protocol: "openai-compatible", documentation: "/docs/groq.md" };
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
          this.send(res, 400, oaiError("We could not parse the JSON body of your request.", "invalid_request_error"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, oaiError("We could not parse the JSON body of your request.", "invalid_request_error"));
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
