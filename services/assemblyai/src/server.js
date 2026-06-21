import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/assemblyai — a tiny, dependency-free fake of the AssemblyAI API.
//
// Speaks the wire protocol used by the official `assemblyai` SDK so application
// code and AI agents can run against it with zero cost. Transcripts and LeMUR
// responses are DETERMINISTIC: derived from a hash of the input. Transcripts
// complete on the first GET. State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashOf(input) {
  return createHash("sha256").update(input).digest("hex");
}

function hashInt(input, salt, max) {
  return parseInt(hashOf(`${salt}:${input}`).slice(0, 12), 16) % max;
}

function uuid(seed) {
  const h = hashOf(`${seed}:${Date.now()}:${Math.random()}`);
  // RFC 4122 v4: set version nibble to 4 and variant bits to 10xx
  const v4 = h.slice(0, 12) + "4" + h.slice(13, 16) + "8" + h.slice(17, 32);
  return `${v4.slice(0, 8)}-${v4.slice(8, 12)}-${v4.slice(12, 16)}-${v4.slice(16, 20)}-${v4.slice(20, 32)}`;
}

const WORDS = [
  "assembly", "ai", "transcribes", "your", "audio", "into", "accurate", "text",
  "with", "parlel", "deterministic", "output", "for", "reliable", "testing",
  "speech", "to", "structured", "results", "every", "single", "time",
];

function deterministicTranscript(seed) {
  const count = 6 + hashInt(seed, "len", 8);
  const out = [];
  for (let i = 0; i < count; i++) out.push(WORDS[hashInt(seed, `w${i}`, WORDS.length)]);
  return out.join(" ");
}

function buildWords(text, seed) {
  const tokens = text.split(" ");
  let t = 0;
  return tokens.map((word, i) => {
    const dur = 200 + hashInt(seed, `d${i}`, 400);
    const start = t;
    t += dur;
    return { text: word, start, end: t, confidence: Number((0.9 + hashInt(seed, `c${i}`, 100) / 1000).toFixed(4)), speaker: null };
  });
}

function aaiError(error) {
  return { error };
}

export class AssemblyaiServer {
  constructor(port = 4858, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.transcripts = new Map();
    this.idCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, aaiError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("server", "parlel-assemblyai");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    const raw = await this.readRaw(req);

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, aaiError("Authentication error, API token missing/invalid"));
    }

    const ct = (req.headers["content-type"] || "").toLowerCase();

    // POST /v2/upload — accepts raw bytes, returns { upload_url }
    if (req.method === "POST" && parts[0] === "v2" && parts[1] === "upload" && parts.length === 2) {
      const token = hashOf(raw.length ? raw : Buffer.from(String(Date.now()))).slice(0, 32);
      return this.send(res, 200, { upload_url: `https://cdn.assemblyai.com/upload/${token}` });
    }

    // POST /v2/transcript — create
    if (req.method === "POST" && parts[0] === "v2" && parts[1] === "transcript" && parts.length === 2) {
      let body;
      try { body = raw.length ? JSON.parse(raw.toString()) : {}; }
      catch { return this.send(res, 400, aaiError("Invalid JSON body.")); }
      if (!isPlainObject(body) || typeof body.audio_url !== "string" || !body.audio_url) {
        return this.send(res, 400, aaiError("\"audio_url\" is a required field"));
      }
      return this.createTranscript(res, body);
    }

    // GET /v2/transcript — list transcripts (paginated)
    if (req.method === "GET" && parts[0] === "v2" && parts[1] === "transcript" && parts.length === 2) {
      return this.listTranscripts(res, url);
    }

    // GET /v2/transcript/:id
    if (req.method === "GET" && parts[0] === "v2" && parts[1] === "transcript" && parts.length === 3) {
      return this.getTranscript(res, parts[2]);
    }

    // DELETE /v2/transcript/:id
    if (req.method === "DELETE" && parts[0] === "v2" && parts[1] === "transcript" && parts.length === 3) {
      return this.deleteTranscript(res, parts[2]);
    }

    // POST /lemur/v3/generate/task
    if (req.method === "POST" && parts[0] === "lemur" && parts[1] === "v3" && parts[2] === "generate" && parts[3] === "task") {
      let body;
      try { body = raw.length ? JSON.parse(raw.toString()) : {}; }
      catch { return this.send(res, 400, aaiError("Invalid JSON body.")); }
      if (!isPlainObject(body) || typeof body.prompt !== "string" || !body.prompt) {
        return this.send(res, 400, aaiError("\"prompt\" is a required field"));
      }
      const seed = body.prompt + JSON.stringify(body.transcript_ids || body.input_text || "");
      return this.send(res, 200, {
        request_id: uuid(seed),
        response: deterministicTranscript(seed),
        usage: { input_tokens: hashInt(seed, "in", 500) + 10, output_tokens: hashInt(seed, "out", 200) + 10 },
      });
    }

    return this.send(res, 404, aaiError("not found"));
  }

  createTranscript(res, body) {
    const id = uuid(body.audio_url);
    const record = {
      id,
      audio_url: body.audio_url,
      status: "queued",
      text: null,
      words: null,
      language_code: body.language_code || "en_us",
      confidence: null,
      audio_duration: null,
      created_at: new Date().toISOString(),
      // Required fields matching OpenAPI Transcript schema
      speech_model: null,
      language_model: "assemblyai_default",
      acoustic_model: "assemblyai_default",
      webhook_auth: false,
      auto_highlights: false,
      redact_pii: false,
      summarization: false,
      language_confidence_threshold: 0,
      language_confidence: null,
      punctuate: true,
      format_text: true,
      multichannel: false,
      _request: body,
    };
    this.transcripts.set(id, record);
    this.idCounter += 1;
    return this.send(res, 200, this.view(record));
  }

  getTranscript(res, id) {
    const record = this.transcripts.get(id);
    if (!record) return this.send(res, 404, aaiError("Not found"));
    // Complete on first GET (deterministic).
    if (record.status === "queued" || record.status === "processing") {
      const seed = record.audio_url;
      const text = deterministicTranscript(seed);
      const words = buildWords(text, seed);
      record.status = "completed";
      record.text = text;
      record.words = words;
      record.confidence = Number((0.94 + hashInt(seed, "conf", 50) / 1000).toFixed(4));
      record.audio_duration = words.length ? Math.ceil(words[words.length - 1].end / 1000) : 0;
    }
    return this.send(res, 200, this.view(record));
  }

  view(r) {
    return {
      id: r.id,
      audio_url: r.audio_url,
      status: r.status,
      text: r.text,
      words: r.words,
      language_code: r.language_code,
      confidence: r.confidence,
      audio_duration: r.audio_duration,
      created_at: r.created_at,
      speech_model: r.speech_model,
      language_model: r.language_model,
      acoustic_model: r.acoustic_model,
      webhook_auth: r.webhook_auth,
      auto_highlights: r.auto_highlights,
      redact_pii: r.redact_pii,
      summarization: r.summarization,
      language_confidence_threshold: r.language_confidence_threshold,
      language_confidence: r.language_confidence,
      punctuate: r.punctuate,
      format_text: r.format_text,
      multichannel: r.multichannel,
    };
  }

  listTranscripts(res, url) {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "10", 10), 1), 200);
    const statusFilter = url.searchParams.get("status");
    let items = Array.from(this.transcripts.values());
    if (statusFilter) items = items.filter((r) => r.status === statusFilter);
    // Newest first
    items.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const result_count = Math.min(items.length, limit);
    const page = items.slice(0, limit);
    return this.send(res, 200, {
      transcripts: page.map((r) => this.view(r)),
      page_details: {
        limit,
        result_count,
        current_url: url.toString(),
        prev_url: null,
        next_url: null,
      },
    });
  }

  deleteTranscript(res, id) {
    const record = this.transcripts.get(id);
    if (!record) return this.send(res, 404, aaiError("Not found"));
    this.transcripts.delete(id);
    return this.send(res, 200, this.view(record));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "transcripts") {
      return this.send(res, 200, {
        transcripts: Array.from(this.transcripts.values()).map((r) => this.view(r)),
        count: this.transcripts.size,
      });
    }
    return this.send(res, 404, aaiError("not found"));
  }

  root() {
    return { name: "assemblyai", version: "1", protocol: "assemblyai-v2", documentation: "/docs/assemblyai.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // AssemblyAI uses a raw API key in the Authorization header (no scheme).
    return auth.trim().length > 0;
  }

  readRaw(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(Buffer.alloc(0)));
    });
  }

  send(res, status, body) {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
