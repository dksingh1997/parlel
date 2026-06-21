import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/openai — a tiny, dependency-free fake of the OpenAI REST API.
//
// Speaks the wire protocol used by the official `openai` SDK so application
// code and AI agents can run against it with zero cost and zero side effects.
// All "generated" content is DETERMINISTIC: text and vectors are derived from
// a hash of the input so tests are repeatable. State is in-memory.
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

// Deterministic integer in [0, max) derived from a hash + salt.
function hashInt(input, salt, max) {
  const h = hashOf(`${salt}:${input}`);
  const n = parseInt(h.slice(0, 12), 16);
  return n % max;
}

// Deterministic float in [-1, 1) for embeddings.
function hashFloat(input, idx) {
  const h = hashOf(`${input}:${idx}`);
  const n = parseInt(h.slice(0, 8), 16);
  return (n / 0xffffffff) * 2 - 1;
}

// A deterministic "completion" derived from the prompt. Realistic-looking but
// 100% reproducible for a given prompt.
function deterministicText(prompt) {
  const words = [
    "Based", "on", "your", "request", "the", "answer", "is", "deterministic",
    "and", "fully", "reproducible", "for", "testing", "purposes", "here", "now",
    "with", "parlel", "running", "locally", "at", "zero", "cost", "today",
  ];
  const count = 6 + hashInt(prompt, "len", 10);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(words[hashInt(prompt, `w${i}`, words.length)]);
  }
  let text = out.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

// Approx token count (deterministic, word-based) used for usage fields.
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

function oaiError(message, type = "invalid_request_error", param = null, code = null) {
  return { error: { message, type, param, code } };
}

// Real API always returns these detail sub-objects on completion usage. We zero
// them out (deterministic stub: no caching/audio/reasoning accounting).
function usageWithDetails(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}

const MODELS = [
  "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo",
  "text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002",
  "dall-e-3", "dall-e-2", "omni-moderation-latest", "text-moderation-latest",
];

export class OpenaiServer {
  constructor(port = 4747, options = {}) {
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, OpenAI-Organization, OpenAI-Beta");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("server", "parlel-openai");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (parts[0] !== "v1") {
      return this.send(res, 404, oaiError(
        `Invalid URL (${req.method} ${url.pathname})`,
        "invalid_request_error", null, "unknown_url",
      ));
    }

    const authError = this.authError(req);
    if (authError) return this.send(res, 401, authError);

    const route = parts.slice(1);

    // GET /v1/models  and GET /v1/models/{id}
    if (req.method === "GET" && route[0] === "models") {
      if (route.length === 1) {
        return this.send(res, 200, {
          object: "list",
          data: MODELS.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "openai" })),
        });
      }
      const id = route.slice(1).join("/");
      if (!MODELS.includes(id)) {
        return this.send(res, 404, oaiError(
          `The model '${id}' does not exist`,
          "invalid_request_error", null, "model_not_found",
        ));
      }
      return this.send(res, 200, { id, object: "model", created: 1700000000, owned_by: "openai" });
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    if (req.method === "POST" && route[0] === "chat" && route[1] === "completions") {
      return this.chatCompletions(req, res, body);
    }
    if (req.method === "POST" && route[0] === "completions") {
      return this.completions(res, body);
    }
    if (req.method === "POST" && route[0] === "embeddings") {
      return this.embeddings(res, body);
    }
    if (req.method === "POST" && route[0] === "images" && route[1] === "generations") {
      return this.imagesGenerations(res, body);
    }
    if (req.method === "POST" && route[0] === "moderations") {
      return this.moderations(res, body);
    }

    return this.send(res, 404, oaiError(
      `Invalid URL (${req.method} ${url.pathname})`,
      "invalid_request_error", null, "unknown_url",
    ));
  }

  // -------------------------------------------------------------------------
  // POST /v1/chat/completions
  // -------------------------------------------------------------------------
  chatCompletions(req, res, body) {
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
      return this.streamChat(res, { id, created, model, text, promptTokens, completionTokens });
    }

    return this.send(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text, refusal: null },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: usageWithDetails(promptTokens, completionTokens),
      system_fingerprint: `fp_${hashOf(model).slice(0, 10)}`,
    });
  }

  streamChat(res, ctx) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const base = { id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model: ctx.model };
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // role chunk
    write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    // content chunks, one per word (deterministic)
    const words = ctx.text.split(" ");
    for (let i = 0; i < words.length; i++) {
      const piece = i === 0 ? words[i] : " " + words[i];
      write({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
    // final chunk
    write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  // -------------------------------------------------------------------------
  // POST /v1/completions  (legacy)
  // -------------------------------------------------------------------------
  completions(res, body) {
    if (!isPlainObject(body) || body.prompt === undefined) {
      return this.send(res, 400, oaiError("you must provide a prompt parameter", "invalid_request_error", "prompt"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("you must provide a model parameter", "invalid_request_error", "model"));
    }
    this._record("completion", body);

    const prompt = Array.isArray(body.prompt) ? body.prompt.join("\n") : String(body.prompt);
    const text = " " + deterministicText(prompt);
    const promptTokens = tokenCount(prompt);
    const completionTokens = tokenCount(text);

    return this.send(res, 200, {
      id: `cmpl-${hashOf(prompt).slice(0, 24)}`,
      object: "text_completion",
      created: 1700000000,
      model: body.model,
      choices: [{ text, index: 0, logprobs: null, finish_reason: "stop" }],
      usage: usageWithDetails(promptTokens, completionTokens),
    });
  }

  // -------------------------------------------------------------------------
  // POST /v1/embeddings
  // -------------------------------------------------------------------------
  embeddings(res, body) {
    if (!isPlainObject(body) || body.input === undefined) {
      return this.send(res, 400, oaiError("you must provide an input parameter", "invalid_request_error", "input"));
    }
    if (typeof body.model !== "string" || !body.model) {
      return this.send(res, 400, oaiError("you must provide a model parameter", "invalid_request_error", "model"));
    }
    this._record("embeddings", body);

    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const dims = typeof body.dimensions === "number" && body.dimensions > 0 ? body.dimensions : 1536;
    const data = inputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: dims }, (_, i) => Number(hashFloat(String(input), i).toFixed(6))),
    }));
    const promptTokens = inputs.reduce((sum, i) => sum + tokenCount(String(i)), 0);

    return this.send(res, 200, {
      object: "list",
      data,
      model: body.model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    });
  }

  // -------------------------------------------------------------------------
  // POST /v1/images/generations
  // -------------------------------------------------------------------------
  imagesGenerations(res, body) {
    if (!isPlainObject(body) || typeof body.prompt !== "string" || !body.prompt) {
      return this.send(res, 400, oaiError("you must provide a prompt parameter", "invalid_request_error", "prompt"));
    }
    this._record("images", body);

    const n = typeof body.n === "number" ? body.n : 1;
    const isB64 = body.response_format === "b64_json";
    const data = Array.from({ length: n }, (_, i) => {
      const seed = hashOf(`${body.prompt}:${i}`);
      if (isB64) {
        return { b64_json: Buffer.from(seed).toString("base64"), revised_prompt: body.prompt };
      }
      return { url: `https://parlel.local/images/${seed.slice(0, 32)}.png`, revised_prompt: body.prompt };
    });

    return this.send(res, 200, { created: 1700000000, data });
  }

  // -------------------------------------------------------------------------
  // POST /v1/moderations
  // -------------------------------------------------------------------------
  moderations(res, body) {
    if (!isPlainObject(body) || body.input === undefined) {
      return this.send(res, 400, oaiError("you must provide an input parameter", "invalid_request_error", "input"));
    }
    this._record("moderations", body);

    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    // Full omni-moderation-latest category set (13 categories).
    const categoryNames = [
      "sexual", "sexual/minors", "harassment", "harassment/threatening",
      "hate", "hate/threatening", "illicit", "illicit/violent",
      "self-harm", "self-harm/intent", "self-harm/instructions",
      "violence", "violence/graphic",
    ];
    const results = inputs.map((input) => {
      // Deterministic flag: flag if the input hash indicates "harmful" content.
      const flagged = hashInt(String(input), "flag", 100) < 5;
      const categories = {};
      const scores = {};
      const appliedInputTypes = {};
      for (const c of categoryNames) {
        const score = (hashInt(String(input), c, 10000) / 10000);
        categories[c] = flagged && c === "violence" ? true : false;
        scores[c] = Number((score * (flagged ? 0.9 : 0.01)).toFixed(8));
        appliedInputTypes[c] = ["text"];
      }
      return {
        flagged,
        categories,
        category_scores: scores,
        category_applied_input_types: appliedInputTypes,
      };
    });

    return this.send(res, 200, {
      id: `modr-${hashOf(JSON.stringify(inputs)).slice(0, 24)}`,
      model: typeof body.model === "string" ? body.model : "omni-moderation-latest",
      results,
    });
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection endpoints
  // -------------------------------------------------------------------------
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
    return { name: "openai", version: "1", protocol: "openai-v1", documentation: "/docs/openai.md" };
  }

  // Returns null when the request is authorized, otherwise the OpenAI error
  // body to send with a 401. Real API distinguishes two cases:
  //   * no Authorization header      -> code: null, "You didn't provide an API key…"
  //   * malformed / invalid bearer   -> code: "invalid_api_key"
  // We accept ANY non-empty bearer token by design (no real secret validation).
  authError(req) {
    if (!this.requireAuth) return null;
    const auth = req.headers.authorization || "";
    if (!auth.trim()) {
      return oaiError(
        "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY). You can obtain an API key from https://platform.openai.com/account/api-keys.",
        "invalid_request_error", null, null,
      );
    }
    if (!/^Bearer\s+\S+/i.test(auth)) {
      return oaiError(
        "Incorrect API key provided. You can find your API key at https://platform.openai.com/account/api-keys.",
        "invalid_request_error", null, "invalid_api_key",
      );
    }
    return null;
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
