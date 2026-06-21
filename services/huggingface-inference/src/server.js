import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/huggingface-inference — a tiny, dependency-free fake of the Hugging
// Face Inference API. POST /models/{model} (pipeline tasks: text-generation
// returns [{ generated_text }], feature-extraction returns an embeddings
// array) and POST /v1/chat/completions (the OpenAI-compatible router). Speaks
// the wire protocol used by the official `@huggingface/inference` SDK.
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

function hashFloat(input, idx) {
  const n = parseInt(hashOf(`${input}:${idx}`).slice(0, 8), 16);
  return (n / 0xffffffff) * 2 - 1;
}

function deterministicText(prompt) {
  const words = [
    "Based", "on", "your", "input", "the", "model", "generates", "this",
    "deterministic", "and", "reproducible", "text", "for", "testing", "via",
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

// HF error envelope: { error }
function hfError(message) {
  return { error: message };
}

// Decide the pipeline task for a model id. Real HF fixes the task per-model;
// we use a name heuristic (overridable via ?task= or the request body).
function inferTask(model, body, url) {
  const explicit = url.searchParams.get("task") || (isPlainObject(body) ? body.task : undefined);
  if (typeof explicit === "string" && explicit) return explicit;
  const m = String(model).toLowerCase();
  if (m.includes("sentence-transformers") || m.includes("embed") || m.includes("feature") || m.includes("bge") || m.includes("e5")) {
    return "feature-extraction";
  }
  return "text-generation";
}

export class HuggingfaceInferenceServer {
  constructor(port = 4756, options = {}) {
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
          this.send(res, 500, hfError(error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-huggingface-inference");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, hfError("Authorization header is correct, but the token seems invalid"));
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    // POST /v1/chat/completions  (router, OpenAI-compatible)
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "chat" && parts[2] === "completions") {
      return this.chatCompletions(res, body);
    }

    // POST /models/{model}  (model id may contain slashes, e.g. org/name)
    if (req.method === "POST" && parts[0] === "models" && parts.length >= 2) {
      const model = parts.slice(1).join("/");
      const task = inferTask(model, body, url);
      this._record(task, { model, body });
      if (task === "feature-extraction") return this.featureExtraction(res, model, body);
      return this.textGeneration(res, model, body);
    }

    return this.send(res, 404, hfError("Not Found"));
  }

  textGeneration(res, model, body) {
    if (!isPlainObject(body) || body.inputs === undefined) {
      return this.send(res, 400, hfError("inputs is required"));
    }
    const input = Array.isArray(body.inputs) ? body.inputs.join("\n") : String(body.inputs);
    const generated = deterministicText(input);
    const returnFull = !isPlainObject(body.parameters) || body.parameters.return_full_text !== false;
    const generated_text = returnFull ? `${input} ${generated}` : generated;
    return this.send(res, 200, [{ generated_text }]);
  }

  featureExtraction(res, model, body) {
    if (!isPlainObject(body) || body.inputs === undefined) {
      return this.send(res, 400, hfError("inputs is required"));
    }
    const dims = 384;
    const inputs = Array.isArray(body.inputs) ? body.inputs : [body.inputs];
    const vectors = inputs.map((t) =>
      Array.from({ length: dims }, (_, i) => Number(hashFloat(String(t), i).toFixed(6)))
    );
    // Single string => single vector; array => array of vectors (HF behavior).
    return this.send(res, 200, Array.isArray(body.inputs) ? vectors : vectors[0]);
  }

  chatCompletions(res, body) {
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      return this.send(res, 400, hfError("messages is required"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, hfError("model is required"));
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
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
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
    return this.send(res, 404, hfError("not found"));
  }

  root() {
    return { name: "huggingface-inference", version: "1", protocol: "hf-inference", documentation: "/docs/huggingface-inference.md" };
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
          this.send(res, 400, hfError("Could not parse JSON body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, hfError("Could not parse JSON body"));
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
