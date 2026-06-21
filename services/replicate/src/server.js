import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/replicate — a tiny, dependency-free fake of the Replicate HTTP API.
//
// Speaks the wire protocol used by the official `replicate` SDK so application
// code and AI agents can run against it with zero cost and zero side effects.
// All "generated" content is DETERMINISTIC: outputs are derived from a hash of
// the input so tests are repeatable. Predictions resolve to "succeeded" on the
// first GET. State is in-memory and ephemeral.
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
  const h = hashOf(`${salt}:${input}`);
  return parseInt(h.slice(0, 12), 16) % max;
}

function newId(seed) {
  // Replicate prediction ids are 26-char base32-ish opaque tokens.
  return hashOf(`${seed}:${Date.now()}:${Math.random()}`).slice(0, 26);
}

function now() {
  return new Date().toISOString();
}

function rpError(detail, status = 400) {
  return { detail, status };
}

// Deterministic text output derived from the input prompt.
function deterministicText(prompt) {
  const words = [
    "Replicate", "runs", "this", "model", "deterministically", "for", "parlel",
    "tests", "locally", "at", "zero", "cost", "and", "fully", "reproducible",
    "output", "derived", "from", "the", "input", "hash", "today", "now", "here",
  ];
  const count = 6 + hashInt(prompt, "len", 8);
  const out = [];
  for (let i = 0; i < count; i++) out.push(words[hashInt(prompt, `w${i}`, words.length)]);
  return out.join(" ");
}

export class ReplicateServer {
  constructor(port = 4856, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.predictions = new Map();
    this.idCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, rpError(error.message || "Internal server error", 500));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Prefer");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("server", "parlel-replicate");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts, body);
    }

    if (parts[0] !== "v1") return this.send(res, 404, rpError("Not found.", 404));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, rpError("Invalid token.", 401));
    }

    const route = parts.slice(1);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    // POST /v1/predictions
    if (req.method === "POST" && route[0] === "predictions" && route.length === 1) {
      return this.createPrediction(res, body);
    }
    // GET /v1/predictions/:id
    if (req.method === "GET" && route[0] === "predictions" && route.length === 2) {
      return this.getPrediction(res, route[1]);
    }
    // POST /v1/predictions/:id/cancel
    if (req.method === "POST" && route[0] === "predictions" && route[2] === "cancel" && route.length === 3) {
      return this.cancelPrediction(res, route[1]);
    }
    // GET /v1/models/:owner/:name
    if (req.method === "GET" && route[0] === "models" && route.length === 3) {
      return this.getModel(res, route[1], route[2]);
    }
    // GET /v1/models/:owner/:name/predictions style isn't required; keep minimal.

    return this.send(res, 404, rpError("Not found.", 404));
  }

  createPrediction(res, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 422, rpError("Request body must be a JSON object.", 422));
    }
    if (typeof body.version !== "string" && !body.input) {
      return this.send(res, 422, rpError("A version or input is required.", 422));
    }
    const id = newId(JSON.stringify(body.input || {}));
    const input = isPlainObject(body.input) ? body.input : {};
    const prediction = {
      id,
      version: typeof body.version === "string" ? body.version : "parlel-version",
      input,
      status: "starting",
      output: null,
      error: null,
      logs: "",
      created_at: now(),
      started_at: null,
      completed_at: null,
      urls: {
        get: `http://${this.host}:${this.port}/v1/predictions/${id}`,
        cancel: `http://${this.host}:${this.port}/v1/predictions/${id}/cancel`,
      },
      metrics: {},
      _polled: false,
    };
    this.predictions.set(id, prediction);
    return this.send(res, 201, this.view(prediction));
  }

  getPrediction(res, id) {
    const prediction = this.predictions.get(id);
    if (!prediction) return this.send(res, 404, rpError("Not found.", 404));
    // Resolve to "succeeded" on the first GET (deterministic).
    if (prediction.status === "starting" || prediction.status === "processing") {
      const seed = JSON.stringify(prediction.input);
      prediction.status = "succeeded";
      prediction.output = [deterministicText(seed)];
      prediction.logs = "Using seed: parlel\nGenerating...\nDone.";
      prediction.started_at = now();
      prediction.completed_at = now();
      prediction.metrics = { predict_time: 0.123 };
    }
    return this.send(res, 200, this.view(prediction));
  }

  cancelPrediction(res, id) {
    const prediction = this.predictions.get(id);
    if (!prediction) return this.send(res, 404, rpError("Not found.", 404));
    if (prediction.status === "starting" || prediction.status === "processing") {
      prediction.status = "canceled";
      prediction.completed_at = now();
    }
    return this.send(res, 200, this.view(prediction));
  }

  getModel(res, owner, name) {
    const id = `${owner}/${name}`;
    const latestVersion = hashOf(id).slice(0, 64);
    return this.send(res, 200, {
      url: `https://replicate.com/${id}`,
      owner,
      name,
      description: `Deterministic parlel fake for ${id}.`,
      visibility: "public",
      github_url: null,
      paper_url: null,
      license_url: null,
      run_count: hashInt(id, "runs", 1000000),
      cover_image_url: null,
      default_example: null,
      latest_version: {
        id: latestVersion,
        created_at: "2023-01-01T00:00:00.000Z",
        cog_version: "0.8.0",
        openapi_schema: { openapi: "3.0.2", info: { title: name, version: "1.0.0" } },
      },
    });
  }

  view(p) {
    return {
      id: p.id,
      version: p.version,
      input: p.input,
      status: p.status,
      output: p.output,
      error: p.error,
      logs: p.logs,
      created_at: p.created_at,
      started_at: p.started_at,
      completed_at: p.completed_at,
      urls: p.urls,
      metrics: p.metrics,
    };
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "predictions") {
      return this.send(res, 200, {
        predictions: Array.from(this.predictions.values()).map((p) => this.view(p)),
        count: this.predictions.size,
      });
    }
    return this.send(res, 404, rpError("not found", 404));
  }

  root() {
    return { name: "replicate", version: "1", protocol: "replicate-v1", documentation: "/docs/replicate.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // Replicate uses "Authorization: Token r8_..." (also accepts Bearer).
    return /^Token\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, rpError("Invalid JSON body.", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, rpError("Invalid JSON body.", 400));
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
