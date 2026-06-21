import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/perplexity — a tiny, dependency-free fake of the Perplexity API.
// OpenAI-compatible chat completions at POST /chat/completions, plus a
// Perplexity-specific `citations` array. Deterministic responses.
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
    "According", "to", "recent", "sources", "the", "answer", "is",
    "deterministic", "and", "reproducible", "with", "citations", "for",
    "testing", "via", "parlel", "running", "locally", "at", "zero", "cost", "now",
  ];
  const count = 6 + hashInt(prompt, "len", 10);
  const out = [];
  for (let i = 0; i < count; i++) out.push(words[hashInt(prompt, `w${i}`, words.length)]);
  const text = out.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

function deterministicCitations(prompt) {
  const n = 2 + hashInt(prompt, "cites", 3);
  return Array.from({ length: n }, (_, i) => `https://parlel.local/source/${hashOf(`${prompt}:${i}`).slice(0, 16)}`);
}

function tokenCount(text) {
  if (!text) return 0;
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function promptFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => (typeof m?.content === "string" ? m.content : ""))
    .join("\n");
}

function oaiError(message, type = "invalid_request_error", param = null, code = null) {
  return { error: { message, type, param, code } };
}

const MODELS = ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro", "sonar-deep-research"];

export class PerplexityServer {
  constructor(port = 4751, options = {}) {
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
    res.setHeader("server", "parlel-perplexity");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, oaiError("Unauthorized", "invalid_request_error", null, "invalid_api_key"));
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && parts[0] === "chat" && parts[1] === "completions") {
      return this.chatCompletions(res, body);
    }

    return this.send(res, 404, oaiError("Unknown endpoint", "invalid_request_error"));
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
    const citations = deterministicCitations(prompt);
    const promptTokens = tokenCount(prompt);
    const completionTokens = tokenCount(text);
    const id = `${hashOf(prompt).slice(0, 8)}-${hashOf(prompt).slice(8, 12)}-${hashOf(prompt).slice(12, 16)}`;
    const created = 1700000000;

    if (body.stream === true) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      const base = { id, model, object: "chat.completion.chunk", created, citations };
      const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const words = text.split(" ");
      for (let i = 0; i < words.length; i++) {
        write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: i === 0 ? words[i] : " " + words[i] }, finish_reason: null }] });
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
      model,
      object: "chat.completion",
      created,
      citations,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
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
    return { name: "perplexity", version: "1", protocol: "openai-compatible", documentation: "/docs/perplexity.md", models: MODELS };
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
