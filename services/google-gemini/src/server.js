import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/google-gemini — a tiny, dependency-free fake of the Google Gemini
// (Generative Language) API. Speaks the wire protocol used by the official
// `@google/generative-ai` / `@google/genai` SDKs. Deterministic responses.
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
    "Based", "on", "your", "prompt", "Gemini", "responds", "with", "this",
    "deterministic", "and", "reproducible", "text", "for", "testing", "via",
    "parlel", "running", "locally", "at", "zero", "cost", "right", "now", "here",
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

function promptFromContents(contents) {
  if (!Array.isArray(contents)) {
    if (isPlainObject(contents) && Array.isArray(contents.parts)) {
      return contents.parts.map((p) => p?.text || "").join(" ");
    }
    return "";
  }
  return contents
    .map((c) => (Array.isArray(c?.parts) ? c.parts.map((p) => p?.text || "").join(" ") : ""))
    .join("\n");
}

function geminiError(code, message, status) {
  return { error: { code, message, status } };
}

export class GoogleGeminiServer {
  constructor(port = 4749, options = {}) {
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
          this.send(res, 500, geminiError(500, error.message || "Internal error", "INTERNAL"));
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
    res.setHeader("Access-Control-Allow-Headers", "x-goog-api-key, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-google-gemini");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (parts[0] !== "v1beta" && parts[0] !== "v1") {
      return this.send(res, 404, geminiError(404, "Not found", "NOT_FOUND"));
    }

    if (!this.isAuthorized(req, url)) {
      return this.send(res, 401, geminiError(
        401,
        "API key not valid. Please pass a valid API key.",
        "UNAUTHENTICATED",
      ));
    }

    const route = parts.slice(1);

    // GET /v1beta/models
    if (req.method === "GET" && route[0] === "models" && route.length === 1) {
      return this.send(res, 200, {
        models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash", "gemini-pro"].map((m) => ({
          name: `models/${m}`,
          version: "001",
          displayName: m,
          supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
        })),
      });
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    // POST /v1beta/models/{model}:generateContent  (or :streamGenerateContent)
    if (req.method === "POST" && route[0] === "models" && route.length === 2) {
      const last = route[1];
      const colon = last.indexOf(":");
      if (colon > -1) {
        const model = last.slice(0, colon);
        const method = last.slice(colon + 1);
        if (method === "generateContent") return this.generateContent(res, model, body);
        if (method === "streamGenerateContent") return this.streamGenerateContent(res, model, body, url);
        if (method === "countTokens") {
          const prompt = promptFromContents(body?.contents);
          return this.send(res, 200, { totalTokens: tokenCount(prompt) });
        }
      }
    }

    return this.send(res, 404, geminiError(404, "Not found", "NOT_FOUND"));
  }

  _buildResponse(model, body) {
    const prompt = promptFromContents(body?.contents);
    const text = deterministicText(prompt);
    const promptTokens = tokenCount(prompt);
    const candTokens = tokenCount(text);
    return {
      text,
      payload: {
        candidates: [
          {
            content: { parts: [{ text }], role: "model" },
            finishReason: "STOP",
            index: 0,
            safetyRatings: [
              { category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "NEGLIGIBLE" },
            ],
          },
        ],
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: candTokens,
          totalTokenCount: promptTokens + candTokens,
        },
        modelVersion: model,
      },
    };
  }

  generateContent(res, model, body) {
    if (!isPlainObject(body) || body.contents === undefined) {
      return this.send(res, 400, geminiError(400, "contents is required", "INVALID_ARGUMENT"));
    }
    this._record("generateContent", { model, body });
    const { payload } = this._buildResponse(model, body);
    return this.send(res, 200, payload);
  }

  streamGenerateContent(res, model, body, url) {
    if (!isPlainObject(body) || body.contents === undefined) {
      return this.send(res, 400, geminiError(400, "contents is required", "INVALID_ARGUMENT"));
    }
    this._record("streamGenerateContent", { model, body });
    const { text, payload } = this._buildResponse(model, body);
    const isSSE = (url.searchParams.get("alt") || "") === "sse";

    res.statusCode = 200;
    const words = text.split(" ");

    if (isSSE) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      for (let i = 0; i < words.length; i++) {
        const piece = i === 0 ? words[i] : " " + words[i];
        const chunk = {
          candidates: [{ content: { parts: [{ text: piece }], role: "model" }, index: 0 }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
      return;
    }

    // Default streaming format: a JSON array streamed incrementally.
    res.setHeader("Content-Type", "application/json");
    const chunks = words.map((w, i) => ({
      candidates: [{ content: { parts: [{ text: i === 0 ? w : " " + w }], role: "model" }, index: 0 }],
    }));
    chunks.push(payload);
    res.end(JSON.stringify(chunks));
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
    return this.send(res, 404, geminiError(404, "not found", "NOT_FOUND"));
  }

  root() {
    return { name: "google-gemini", version: "1", protocol: "gemini-v1beta", documentation: "/docs/google-gemini.md" };
  }

  isAuthorized(req, url) {
    if (!this.requireAuth) return true;
    const queryKey = url.searchParams.get("key");
    const headerKey = req.headers["x-goog-api-key"];
    return (typeof queryKey === "string" && queryKey.length > 0) ||
      (typeof headerKey === "string" && headerKey.length > 0);
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
          this.send(res, 400, geminiError(400, "Invalid JSON payload", "INVALID_ARGUMENT"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, geminiError(400, "Invalid JSON payload", "INVALID_ARGUMENT"));
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
