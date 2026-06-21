import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/posthog — a tiny, dependency-free fake of the PostHog API.
//
// Speaks the wire protocol used by posthog-node / posthog-js and the public
// REST API: event capture (/capture, /batch), insights/events query under
// /api/projects/:id, and feature flag evaluation via /decide.
// State is in-memory and ephemeral; captured events are inspectable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newId() {
  return randomBytes(16).toString("hex");
}

export class PosthogServer {
  constructor(port = 4807, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.events = [];
    this.insights = new Map();
    this.featureFlags = new Map();
    this.idCounter = 0;
    this._seedDefaults();
  }

  _seedDefaults() {
    this.idCounter += 1;
    const insightId = this.idCounter;
    this.insights.set(insightId, {
      id: insightId,
      short_id: newId().slice(0, 8),
      name: "Parlel Default Insight",
      filters: { events: [{ id: "$pageview" }] },
      result: [],
      created_at: now(),
    });
    this.featureFlags.set("parlel-flag", {
      key: "parlel-flag",
      enabled: true,
      value: true,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { type: "server_error", detail: error.message || "Internal server error" });
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
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-posthog");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // Event capture — auth via api_key in body (project key), no bearer required.
    if (req.method === "POST" && parts[0] === "capture" && parts.length <= 2) {
      return this.capture(res, body);
    }
    if (req.method === "POST" && parts[0] === "batch" && parts.length <= 2) {
      return this.batch(res, body);
    }
    if (req.method === "POST" && parts[0] === "decide") {
      return this.decide(res, body);
    }
    // posthog-js sometimes posts to /e/ as well.
    if (req.method === "POST" && (parts[0] === "e" || parts[0] === "i")) {
      return this.capture(res, body);
    }

    // /api/projects/:id/... — requires bearer (personal API key).
    if (parts[0] === "api") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, {
          type: "authentication_error",
          code: "not_authenticated",
          detail: "Authentication credentials were not provided.",
        });
      }
      return this.handleApi(req, res, parts.slice(1), body, url);
    }

    return this.send(res, 404, { type: "invalid_request", detail: "not found" });
  }

  capture(res, body) {
    if (!isPlainObject(body) || (typeof body.event !== "string" && !Array.isArray(body.batch))) {
      return this.send(res, 400, { status: 0, error: "event required" });
    }
    if (Array.isArray(body.batch)) {
      return this.batch(res, body);
    }
    const captured = {
      uuid: newId(),
      event: body.event,
      distinct_id: body.distinct_id || body.properties?.distinct_id || null,
      properties: clone(body.properties) || {},
      timestamp: body.timestamp || now(),
      api_key: body.api_key || null,
      received_at: now(),
    };
    this.events.push(captured);
    return this.send(res, 200, { status: 1 });
  }

  batch(res, body) {
    const list = Array.isArray(body?.batch) ? body.batch : [];
    for (const ev of list) {
      if (!isPlainObject(ev) || typeof ev.event !== "string") continue;
      this.events.push({
        uuid: newId(),
        event: ev.event,
        distinct_id: ev.distinct_id || ev.properties?.distinct_id || null,
        properties: clone(ev.properties) || {},
        timestamp: ev.timestamp || now(),
        api_key: body.api_key || null,
        received_at: now(),
      });
    }
    return this.send(res, 200, { status: 1 });
  }

  decide(res, body) {
    const flags = {};
    for (const [key, flag] of this.featureFlags.entries()) {
      flags[key] = flag.value !== undefined ? flag.value : flag.enabled;
    }
    return this.send(res, 200, {
      config: { enable_collect_everything: true },
      featureFlags: flags,
      featureFlagPayloads: {},
      errorsWhileComputingFlags: false,
      distinctID: body?.distinct_id || "anonymous",
    });
  }

  handleApi(req, res, route, body, url) {
    // /api/projects/:id/insights | events
    if (route[0] === "projects" && route.length >= 3) {
      const resource = route[2];
      if (resource === "insights") return this.handleInsights(req, res, route, body);
      if (resource === "events") return this.handleEvents(req, res, route, body, url);
    }
    // /api/feature_flag or /api/projects/:id/feature_flags
    if (route[0] === "projects" && route[2] === "feature_flags") {
      if (req.method === "GET") {
        return this.send(res, 200, {
          count: this.featureFlags.size,
          results: Array.from(this.featureFlags.values()).map((f) => ({
            key: f.key,
            active: f.enabled,
            filters: {},
          })),
        });
      }
    }
    return this.send(res, 404, { type: "invalid_request", detail: "not found" });
  }

  handleInsights(req, res, route, body) {
    // route: projects, :id, insights, [:insightId]
    if (route.length === 3) {
      if (req.method === "GET") {
        return this.send(res, 200, {
          count: this.insights.size,
          next: null,
          previous: null,
          results: Array.from(this.insights.values()).map(clone),
        });
      }
      if (req.method === "POST") {
        this.idCounter += 1;
        const insight = {
          id: this.idCounter,
          short_id: newId().slice(0, 8),
          name: isPlainObject(body) && typeof body.name === "string" ? body.name : "Untitled",
          filters: isPlainObject(body) && body.filters ? clone(body.filters) : {},
          result: [],
          created_at: now(),
        };
        this.insights.set(insight.id, insight);
        return this.send(res, 201, clone(insight));
      }
    }
    if (route.length === 4) {
      const id = Number(route[3]);
      const insight = this.insights.get(id);
      if (!insight) return this.send(res, 404, { type: "invalid_request", detail: "not found" });
      if (req.method === "GET") return this.send(res, 200, clone(insight));
      if (req.method === "PATCH" || req.method === "PUT") {
        if (isPlainObject(body)) {
          if (typeof body.name === "string") insight.name = body.name;
          if (body.filters) insight.filters = clone(body.filters);
        }
        return this.send(res, 200, clone(insight));
      }
      if (req.method === "DELETE") {
        this.insights.delete(id);
        return this.send(res, 204, null);
      }
    }
    return this.send(res, 405, { type: "invalid_request", detail: "method not allowed" });
  }

  handleEvents(req, res, route, body, url) {
    if (req.method === "GET" || req.method === "POST") {
      const eventFilter = url.searchParams.get("event");
      let results = this.events;
      if (eventFilter) results = results.filter((e) => e.event === eventFilter);
      return this.send(res, 200, {
        next: null,
        results: results.map((e) => ({
          id: e.uuid,
          distinct_id: e.distinct_id,
          event: e.event,
          properties: clone(e.properties),
          timestamp: e.timestamp,
        })),
      });
    }
    return this.send(res, 405, { type: "invalid_request", detail: "method not allowed" });
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "events") {
      return this.send(res, 200, { events: clone(this.events), count: this.events.length });
    }
    if (req.method === "DELETE" && parts[1] === "events") {
      this.events = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    if (req.method === "POST" && parts[1] === "feature_flags") {
      // Allow tests to set flag values: { key, value }
      if (isPlainObject(body) && typeof body.key === "string") {
        this.featureFlags.set(body.key, { key: body.key, enabled: body.value !== false, value: body.value });
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 400, { error: "key required" });
    }
    return this.send(res, 404, { type: "invalid_request", detail: "not found" });
  }

  root() {
    return { name: "posthog", version: "1.0", protocol: "posthog", documentation: "/docs/posthog.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        const ctype = (req.headers["content-type"] || "").toLowerCase();
        if (ctype.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params.entries()) {
            try { obj[k] = JSON.parse(v); } catch { obj[k] = v; }
          }
          return resolve(obj);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { type: "invalid_request", detail: "Malformed JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { type: "invalid_request", detail: "Bad request body" });
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
