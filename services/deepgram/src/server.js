import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/deepgram — a tiny, dependency-free fake of the Deepgram HTTP API.
//
// Speaks the wire protocol used by the official `@deepgram/sdk` so application
// code and AI agents can run against it with zero cost. Transcripts and TTS
// audio are DETERMINISTIC: derived from a hash of the input so tests repeat.
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

function dgError(message, status = 400) {
  return { err_code: status === 401 ? "INVALID_AUTH" : "Bad Request", err_msg: message };
}

const TRANSCRIPT_WORDS = [
  "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
  "deepgram", "transcribes", "audio", "into", "text", "with", "parlel",
  "deterministic", "output", "for", "reliable", "automated", "testing", "today",
];

// Deterministic transcript derived from a seed (the audio bytes or url).
function deterministicTranscript(seed) {
  const count = 6 + hashInt(seed, "len", 8);
  const out = [];
  for (let i = 0; i < count; i++) out.push(TRANSCRIPT_WORDS[hashInt(seed, `w${i}`, TRANSCRIPT_WORDS.length)]);
  return out.join(" ");
}

function buildWords(transcript, seed) {
  const tokens = transcript.split(" ");
  let t = 0;
  return tokens.map((word, i) => {
    const dur = 0.2 + (hashInt(seed, `d${i}`, 40) / 100);
    const start = Number(t.toFixed(3));
    t += dur;
    const end = Number(t.toFixed(3));
    return {
      word,
      start,
      end,
      confidence: Number((0.9 + hashInt(seed, `c${i}`, 100) / 1000).toFixed(4)),
      punctuated_word: word,
    };
  });
}

export class DeepgramServer {
  constructor(port = 4857, options = {}) {
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

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, dgError(error.message || "Internal server error", 500));
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
    res.setHeader("server", "parlel-deepgram");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    const raw = await this.readRaw(req);

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v1") return this.send(res, 404, dgError("Not found.", 404));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, dgError("Invalid credentials.", 401));
    }

    const route = parts.slice(1);
    const ct = (req.headers["content-type"] || "").toLowerCase();

    // POST /v1/listen — transcription (audio bytes OR { url })
    if (req.method === "POST" && route[0] === "listen" && route.length === 1) {
      let seed;
      if (ct.includes("application/json")) {
        let body;
        try { body = raw.length ? JSON.parse(raw.toString()) : {}; }
        catch { return this.send(res, 400, dgError("Invalid JSON body.", 400)); }
        if (!isPlainObject(body) || typeof body.url !== "string") {
          return this.send(res, 400, dgError("A url is required for remote audio.", 400));
        }
        seed = body.url;
      } else {
        if (!raw.length) return this.send(res, 400, dgError("Audio payload is required.", 400));
        seed = hashOf(raw);
      }
      this._record("listen", seed);
      return this.send(res, 200, this.transcription(seed, url.searchParams));
    }

    // POST /v1/speak — text-to-speech (returns audio bytes)
    if (req.method === "POST" && route[0] === "speak" && route.length === 1) {
      let body;
      try { body = raw.length ? JSON.parse(raw.toString()) : {}; }
      catch { return this.send(res, 400, dgError("Invalid JSON body.", 400)); }
      if (!isPlainObject(body) || typeof body.text !== "string" || !body.text) {
        return this.send(res, 400, dgError("A text field is required.", 400));
      }
      this._record("speak", body.text);
      // Deterministic audio bytes derived from the text hash.
      const audio = Buffer.from(hashOf(body.text), "hex");
      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("dg-request-id", hashOf(body.text).slice(0, 36));
      return res.end(audio);
    }

    // GET /v1/projects
    if (req.method === "GET" && route[0] === "projects" && route.length === 1) {
      return this.send(res, 200, {
        projects: [
          { project_id: hashOf("parlel-project").slice(0, 36), name: "parlel-default", company: "parlel" },
        ],
      });
    }

    return this.send(res, 404, dgError("Not found.", 404));
  }

  transcription(seed, params) {
    const transcript = deterministicTranscript(seed);
    const words = buildWords(transcript, seed);
    const confidence = Number((0.95 + hashInt(seed, "conf", 50) / 1000).toFixed(4));
    const duration = words.length ? words[words.length - 1].end : 0;
    const reqId = hashOf(seed).slice(0, 36);
    const alternative = {
      transcript,
      confidence,
      words,
    };
    if (params.get("paragraphs") === "true") {
      alternative.paragraphs = {
        transcript,
        paragraphs: [{ sentences: [{ text: transcript, start: 0, end: duration }], start: 0, end: duration, num_words: words.length }],
      };
    }
    return {
      metadata: {
        transaction_key: "deprecated",
        request_id: reqId,
        sha256: hashOf(seed),
        created: new Date().toISOString(),
        duration,
        channels: 1,
        models: [hashOf("model").slice(0, 36)],
        model_info: {},
      },
      results: {
        channels: [
          { alternatives: [alternative] },
        ],
      },
    };
  }

  _record(kind, seed) {
    this.idCounter += 1;
    this.requests.push({ n: this.idCounter, kind, seed: String(seed).slice(0, 64), at: new Date().toISOString() });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "requests") {
      return this.send(res, 200, { requests: this.requests, count: this.requests.length });
    }
    return this.send(res, 404, dgError("not found", 404));
  }

  root() {
    return { name: "deepgram", version: "1", protocol: "deepgram-v1", documentation: "/docs/deepgram.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // Deepgram uses "Authorization: Token <key>" (also accept Bearer).
    return /^Token\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
