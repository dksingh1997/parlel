import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/elevenlabs — a tiny, dependency-free fake of the ElevenLabs API.
// Text-to-speech returns DETERMINISTIC audio/mpeg bytes derived from a hash of
// the text + voice id. Also serves /v1/voices, /v1/models, /v1/user. Speaks
// the wire protocol used by the official `elevenlabs` SDK.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashBuf(input) {
  return createHash("sha256").update(String(input)).digest();
}

// Deterministic pseudo-MP3 payload: an ID3v2 header + a run of MPEG frame-sync
// bytes seeded from the hash. Not playable audio, but a stable, inspectable
// audio/mpeg byte stream that depends only on the text + voice.
function deterministicAudio(text, voiceId, bytesWanted = 2048) {
  const seed = hashBuf(`${voiceId}:${text}`);
  const out = Buffer.alloc(bytesWanted);
  // ID3v2 tag header "ID3"
  out[0] = 0x49; out[1] = 0x44; out[2] = 0x33; out[3] = 0x03; out[4] = 0x00;
  let pos = 10;
  let h = 0;
  while (pos < bytesWanted) {
    // MPEG audio frame sync (0xFFE...) followed by deterministic bytes.
    out[pos] = 0xff;
    if (pos + 1 < bytesWanted) out[pos + 1] = 0xfb;
    for (let k = 2; k < 4 && pos + k < bytesWanted; k++) {
      out[pos + k] = seed[(h + pos + k) % seed.length];
    }
    pos += 4;
    h = (h + 1) % 256;
  }
  return out;
}

function elError(status, message, detail) {
  // ElevenLabs error envelope: { detail: { status, message } }
  return { detail: detail !== undefined ? detail : { status, message } };
}

const VOICES = [
  { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "premade" },
  { voice_id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", category: "premade" },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", category: "premade" },
];

const TTS_MODELS = [
  { model_id: "eleven_multilingual_v2", name: "Eleven Multilingual v2", can_do_text_to_speech: true },
  { model_id: "eleven_turbo_v2_5", name: "Eleven Turbo v2.5", can_do_text_to_speech: true },
  { model_id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", can_do_text_to_speech: true },
];

export class ElevenlabsServer {
  constructor(port = 4753, options = {}) {
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
          this.send(res, 500, elError(500, error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "xi-api-key, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-elevenlabs");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (parts[0] !== "v1") return this.send(res, 404, elError(404, "Not Found"));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, elError(401, "Invalid API key", {
        status: "invalid_api_key",
        message: "Invalid API key",
      }));
    }

    const route = parts.slice(1);

    // GET /v1/voices
    if (req.method === "GET" && route[0] === "voices" && route.length === 1) {
      return this.send(res, 200, { voices: VOICES });
    }
    // GET /v1/voices/{voice_id}
    if (req.method === "GET" && route[0] === "voices" && route.length === 2) {
      const v = VOICES.find((x) => x.voice_id === route[1]) || { ...VOICES[0], voice_id: route[1] };
      return this.send(res, 200, v);
    }
    // GET /v1/models
    if (req.method === "GET" && route[0] === "models" && route.length === 1) {
      return this.send(res, 200, TTS_MODELS);
    }
    // GET /v1/user  and  GET /v1/user/subscription
    if (req.method === "GET" && route[0] === "user" && route.length === 1) {
      return this.send(res, 200, {
        user_id: "parlel-user",
        is_new_user: false,
        xi_api_key: "parlel",
        subscription: {
          tier: "creator",
          character_count: 0,
          character_limit: 100000,
          can_extend_character_limit: true,
          status: "active",
        },
      });
    }
    if (req.method === "GET" && route[0] === "user" && route[1] === "subscription") {
      return this.send(res, 200, {
        tier: "creator",
        character_count: 0,
        character_limit: 100000,
        status: "active",
      });
    }

    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    // POST /v1/text-to-speech/{voice_id}   (and optional /stream suffix)
    if (req.method === "POST" && route[0] === "text-to-speech" && route.length >= 2) {
      const voiceId = route[1];
      return this.textToSpeech(res, voiceId, body);
    }

    return this.send(res, 404, elError(404, "Not Found"));
  }

  textToSpeech(res, voiceId, body) {
    if (!isPlainObject(body) || typeof body.text !== "string" || body.text.length === 0) {
      return this.send(res, 422, elError(422, "text is required", {
        status: "validation_error",
        message: "text is required",
      }));
    }
    this._record("tts", { voiceId, body });

    const audio = deterministicAudio(body.text, voiceId);
    res.statusCode = 200;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(audio.length));
    res.end(audio);
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
    return this.send(res, 404, elError(404, "not found"));
  }

  root() {
    return { name: "elevenlabs", version: "1", protocol: "elevenlabs-v1", documentation: "/docs/elevenlabs.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const key = req.headers["xi-api-key"];
    return typeof key === "string" && key.length > 0;
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
          this.send(res, 422, elError(422, "Could not parse JSON body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 422, elError(422, "Could not parse JSON body"));
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
