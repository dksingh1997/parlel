import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/stability-ai — a tiny, dependency-free fake of the Stability AI API.
//
// Speaks the wire protocol used by the Stability REST API (v1 generation and
// v2beta stable-image) so application code and AI agents can run against it at
// zero cost. Images are DETERMINISTIC tiny PNGs derived from the prompt hash.
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

// A minimal 1x1 transparent PNG (valid file) used as the deterministic base.
const BASE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

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

// Deterministic tiny PNG: base PNG bytes with hash-derived trailing bytes so
// different prompts yield distinct (but reproducible) base64 payloads.
function deterministicImage(seed) {
  const tail = Buffer.from(hashOf(seed), "hex");
  return Buffer.concat([BASE_PNG, tail]);
}

function stError(name, message, status = 400) {
  return { id: hashOf(message).slice(0, 32), name, errors: [message] };
}

const ENGINES = [
  { id: "stable-diffusion-xl-1024-v1-0", name: "Stable Diffusion XL", type: "PICTURE" },
  { id: "stable-diffusion-v1-6", name: "Stable Diffusion 1.6", type: "PICTURE" },
  { id: "esrgan-v1-x2plus", name: "Real-ESRGAN x2", type: "PICTURE" },
];

export class StabilityAiServer {
  constructor(port = 4862, options = {}) {
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
    this.requests.push({ n: this.idCounter, kind, at: new Date().toISOString() });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, stError("internal_error", error.message || "Internal server error", 500));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-stability");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    const raw = await this.readRaw(req);

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, stError("unauthorized", "missing authorization header", 401));
    }

    // v1: POST /v1/generation/:engine_id/text-to-image
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "generation"
        && parts[3] === "text-to-image" && parts.length === 4) {
      let body;
      try { body = raw.length ? JSON.parse(raw.toString()) : {}; }
      catch { return this.send(res, 400, stError("invalid_body", "invalid JSON body", 400)); }
      return this.v1TextToImage(res, parts[2], body);
    }

    // v1: GET /v1/engines/list
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "engines" && parts[2] === "list") {
      return this.send(res, 200, ENGINES);
    }

    // v1: GET /v1/user/account
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "user" && parts[2] === "account") {
      return this.send(res, 200, {
        id: hashOf("parlel-account").slice(0, 24),
        email: "parlel@parlel.dev",
        organizations: [{ id: "org-parlel", name: "parlel", role: "MEMBER", is_default: true }],
      });
    }

    // v2beta: POST /v2beta/stable-image/generate/core
    if (req.method === "POST" && parts[0] === "v2beta" && parts[1] === "stable-image"
        && parts[2] === "generate" && (parts[3] === "core" || parts[3] === "sd3" || parts[3] === "ultra")) {
      // Body may be multipart; extract a prompt heuristically, else hash the raw bytes.
      const seed = this.extractPrompt(req, raw);
      this._record("v2-core");
      const accept = (req.headers["accept"] || "").toLowerCase();
      const img = deterministicImage(seed);
      const seedNum = hashInt(seed, "seed", 4294967295);
      if (accept.includes("application/json")) {
        return this.send(res, 200, {
          image: img.toString("base64"),
          seed: seedNum,
          finish_reason: "SUCCESS",
        });
      }
      // Default: raw image bytes.
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/png");
      res.setHeader("seed", String(seedNum));
      res.setHeader("finish-reason", "SUCCESS");
      return res.end(img);
    }

    return this.send(res, 404, stError("not_found", "not found", 404));
  }

  v1TextToImage(res, engineId, body) {
    if (!isPlainObject(body) || !Array.isArray(body.text_prompts) || body.text_prompts.length === 0) {
      return this.send(res, 400, stError("invalid_prompts", "text_prompts is required", 400));
    }
    this._record("v1-t2i");
    const promptText = body.text_prompts.map((p) => (isPlainObject(p) ? p.text || "" : String(p))).join(" ");
    const samples = typeof body.samples === "number" ? body.samples : 1;
    const artifacts = Array.from({ length: samples }, (_, i) => {
      const seed = `${engineId}:${promptText}:${i}`;
      return {
        base64: deterministicImage(seed).toString("base64"),
        seed: hashInt(seed, "seed", 4294967295),
        finishReason: "SUCCESS",
      };
    });
    return this.send(res, 200, { artifacts });
  }

  extractPrompt(req, raw) {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    if (ct.includes("application/json")) {
      try {
        const body = JSON.parse(raw.toString());
        if (isPlainObject(body) && typeof body.prompt === "string") return body.prompt;
      } catch { /* ignore */ }
    }
    if (ct.includes("multipart/form-data")) {
      const text = raw.toString("latin1");
      const m = text.match(/name="prompt"\r?\n\r?\n([\s\S]*?)\r?\n--/);
      if (m) return m[1].trim();
    }
    return hashOf(raw.length ? raw : Buffer.from("empty"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "requests") {
      return this.send(res, 200, { requests: this.requests, count: this.requests.length });
    }
    return this.send(res, 404, stError("not_found", "not found", 404));
  }

  root() {
    return { name: "stability-ai", version: "1", protocol: "stability-v1", documentation: "/docs/stability-ai.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
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
