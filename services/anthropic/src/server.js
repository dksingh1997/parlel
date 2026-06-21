import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/anthropic — a tiny, dependency-free fake of the Anthropic Messages
// API. Speaks the wire protocol used by the official `@anthropic-ai/sdk` so
// application code and AI agents can run against it with zero cost. All
// generated content is DETERMINISTIC (derived from a hash of the input).
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
    "Based", "on", "your", "message", "I", "can", "help", "with", "that",
    "the", "response", "is", "deterministic", "and", "reproducible", "for",
    "testing", "with", "parlel", "running", "locally", "at", "zero", "cost",
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
      if (Array.isArray(m?.content)) {
        return m.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ");
      }
      return "";
    })
    .join("\n");
}

function requestId() {
  return `req_${hashOf(String(Date.now() + Math.random())).slice(0, 24)}`;
}

function antError(type, message, reqId) {
  const body = { type: "error", error: { type, message } };
  if (reqId) body.request_id = reqId;
  return body;
}

export class AnthropicServer {
  constructor(port = 4748, options = {}) {
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
          const reqId = res.getHeader("request-id") || requestId();
          this.send(res, 500, antError("api_error", error.message || "Internal server error", reqId));
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
    const reqId = requestId();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "x-api-key, anthropic-version, anthropic-beta, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-anthropic");
    res.setHeader("request-id", reqId);

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (parts[0] !== "v1") return this.send(res, 404, antError("not_found_error", "Not Found", reqId));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, antError("authentication_error", "Invalid API key", reqId));
    }

    const route = parts.slice(1);
    const body = await this.readBody(req, res, reqId);
    if (body === SENTINEL_BAD_JSON) return;

    // POST /v1/messages
    if (req.method === "POST" && route[0] === "messages" && route.length === 1) {
      return this.messages(req, res, body, reqId);
    }
    // POST /v1/messages/count_tokens
    if (req.method === "POST" && route[0] === "messages" && route[1] === "count_tokens") {
      return this.countTokens(req, res, body, reqId);
    }

    return this.send(res, 404, antError("not_found_error", "Not Found", reqId));
  }

  messages(req, res, body, reqId) {
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      return this.send(res, 400, antError("invalid_request_error", "messages: Field required", reqId));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, antError("invalid_request_error", "model: Field required", reqId));
    }
    if (typeof body.max_tokens !== "number") {
      return this.send(res, 400, antError("invalid_request_error", "max_tokens: Field required", reqId));
    }
    this._record("messages", body);

    const system = typeof body.system === "string" ? body.system : "";
    const prompt = `${system}\n${promptFromMessages(body.messages)}`;
    const text = deterministicText(prompt);
    const id = `msg_${hashOf(prompt).slice(0, 24)}`;
    const inputTokens = tokenCount(prompt);
    const outputTokens = tokenCount(text);

    if (body.stream === true) {
      return this.streamMessages(res, { id, model: body.model, text, inputTokens, outputTokens, reqId });
    }

    return this.send(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      request_id: reqId,
    });
  }

  countTokens(req, res, body, reqId) {
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      return this.send(res, 400, antError("invalid_request_error", "messages: Field required", reqId));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, antError("invalid_request_error", "model: Field required", reqId));
    }
    const prompt = promptFromMessages(body.messages);
    const count = tokenCount(prompt);
    return this.send(res, 200, {
      input_tokens: count,
      input_tokens_details: { cache_read: 0, cache_creation: 0 },
      request_id: reqId,
    });
  }

  streamMessages(res, ctx) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

    event("message_start", {
      type: "message_start",
      message: {
        id: ctx.id,
        type: "message",
        role: "assistant",
        model: ctx.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: ctx.inputTokens, output_tokens: 0 },
        request_id: ctx.reqId,
      },
    });
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    event("ping", { type: "ping" });

    const words = ctx.text.split(" ");
    for (let i = 0; i < words.length; i++) {
      const piece = i === 0 ? words[i] : " " + words[i];
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      });
    }

    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: ctx.outputTokens },
    });
    event("message_stop", { type: "message_stop" });
    res.end();
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
    return this.send(res, 404, antError("not_found_error", "not found"));
  }

  root() {
    return { name: "anthropic", version: "1", protocol: "anthropic-messages", documentation: "/docs/anthropic.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const key = req.headers["x-api-key"];
    return typeof key === "string" && key.length > 0;
  }

  readBody(req, res, reqId) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, antError("invalid_request_error", "Could not parse request body", reqId));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, antError("invalid_request_error", "Could not parse request body", reqId));
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
