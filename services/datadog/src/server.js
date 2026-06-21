import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/datadog — a tiny, dependency-free fake of the Datadog API (v1/v2).
//
// Speaks the wire protocol of @datadog/datadog-api-client and the public
// REST API: metric series submit, log intake, events CRUD, dashboards, and
// service-check runs. Auth via DD-API-KEY (+ DD-APPLICATION-KEY) headers.
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newNumericId() {
  // Datadog event/dashboard ids are large numbers / short strings.
  return Math.floor(Math.random() * 9e15) + 1e15;
}

function newDashId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const part = (n) => Array.from(randomBytes(n)).map((b) => chars[b % chars.length]).join("");
  return `${part(3)}-${part(3)}-${part(3)}`;
}

export class DatadogServer {
  constructor(port = 4810, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.metrics = [];
    this.logs = [];
    this.events = new Map();
    this.dashboards = new Map();
    this.checkRuns = [];
    this._seedDefaults();
  }

  _seedDefaults() {
    const id = newDashId();
    this.dashboards.set(id, {
      id,
      title: "Parlel Default Dashboard",
      description: "Seeded dashboard",
      widgets: [],
      layout_type: "ordered",
      created_at: new Date().toISOString(),
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { errors: [error.message || "Internal server error"] });
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
    res.setHeader("Access-Control-Allow-Headers", "DD-API-KEY, DD-APPLICATION-KEY, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-datadog");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (parts[0] !== "api") return this.send(res, 404, { errors: ["not found"] });

    if (!this.isAuthorized(req)) {
      return this.send(res, 403, { errors: ["Forbidden"] });
    }

    const v = parts[1]; // v1 or v2
    const route = parts.slice(2);

    // POST /api/v1/series
    if (v === "v1" && route[0] === "series" && req.method === "POST") {
      return this.submitSeries(res, body);
    }
    // POST /api/v2/logs
    if (v === "v2" && route[0] === "logs" && req.method === "POST") {
      return this.submitLogs(res, body);
    }
    // /api/v1/events
    if (v === "v1" && route[0] === "events") {
      return this.handleEvents(req, res, route, body);
    }
    // /api/v1/dashboard
    if (v === "v1" && route[0] === "dashboard") {
      return this.handleDashboards(req, res, route, body);
    }
    // POST /api/v1/check_run
    if (v === "v1" && route[0] === "check_run" && req.method === "POST") {
      return this.submitCheckRun(res, body);
    }
    // POST /api/v1/validate — credential validation
    if (v === "v1" && route[0] === "validate" && req.method === "GET") {
      return this.send(res, 200, { valid: true });
    }

    return this.send(res, 404, { errors: ["not found"] });
  }

  submitSeries(res, body) {
    const series = isPlainObject(body) && Array.isArray(body.series) ? body.series : [];
    for (const s of series) {
      if (!isPlainObject(s)) continue;
      this.metrics.push({
        metric: s.metric,
        points: clone(s.points) || [],
        type: s.type || "gauge",
        host: s.host || null,
        tags: clone(s.tags) || [],
        received_at: new Date().toISOString(),
      });
    }
    return this.send(res, 202, { status: "ok" });
  }

  submitLogs(res, body) {
    const list = Array.isArray(body) ? body : isPlainObject(body) ? [body] : [];
    for (const log of list) {
      if (!isPlainObject(log)) continue;
      this.logs.push({
        message: log.message || "",
        ddsource: log.ddsource || null,
        service: log.service || null,
        hostname: log.hostname || null,
        ddtags: log.ddtags || null,
        received_at: new Date().toISOString(),
      });
    }
    return this.send(res, 202, {});
  }

  handleEvents(req, res, route, body) {
    // POST /api/v1/events
    if (route.length === 1 && req.method === "POST") {
      const id = newNumericId();
      const event = {
        id,
        title: isPlainObject(body) ? body.title : undefined,
        text: isPlainObject(body) ? body.text : undefined,
        tags: isPlainObject(body) && Array.isArray(body.tags) ? clone(body.tags) : [],
        alert_type: isPlainObject(body) ? body.alert_type || "info" : "info",
        priority: isPlainObject(body) ? body.priority || "normal" : "normal",
        date_happened: isPlainObject(body) && body.date_happened ? body.date_happened : Math.floor(Date.now() / 1000),
        url: `/event/event?id=${id}`,
      };
      this.events.set(String(id), event);
      return this.send(res, 202, { status: "ok", event: clone(event) });
    }
    // GET /api/v1/events
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { events: Array.from(this.events.values()).map(clone) });
    }
    // GET /api/v1/events/:id
    if (route.length === 2 && req.method === "GET") {
      const event = this.events.get(route[1]);
      if (!event) return this.send(res, 404, { errors: ["event not found"] });
      return this.send(res, 200, { event: clone(event) });
    }
    return this.send(res, 405, { errors: ["method not allowed"] });
  }

  handleDashboards(req, res, route, body) {
    // /api/v1/dashboard
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, {
          dashboards: Array.from(this.dashboards.values()).map((d) => ({
            id: d.id,
            title: d.title,
            description: d.description,
            layout_type: d.layout_type,
          })),
        });
      }
      if (req.method === "POST") {
        const id = newDashId();
        const dash = {
          id,
          title: isPlainObject(body) ? body.title || "Untitled" : "Untitled",
          description: isPlainObject(body) ? body.description || "" : "",
          widgets: isPlainObject(body) && Array.isArray(body.widgets) ? clone(body.widgets) : [],
          layout_type: isPlainObject(body) ? body.layout_type || "ordered" : "ordered",
          created_at: new Date().toISOString(),
        };
        this.dashboards.set(id, dash);
        return this.send(res, 200, clone(dash));
      }
      return this.send(res, 405, { errors: ["method not allowed"] });
    }
    // /api/v1/dashboard/:id
    const id = route[1];
    const dash = this.dashboards.get(id);
    if (!dash) return this.send(res, 404, { errors: ["dashboard not found"] });
    if (req.method === "GET") return this.send(res, 200, clone(dash));
    if (req.method === "PUT") {
      if (isPlainObject(body)) {
        if (typeof body.title === "string") dash.title = body.title;
        if (typeof body.description === "string") dash.description = body.description;
        if (Array.isArray(body.widgets)) dash.widgets = clone(body.widgets);
      }
      return this.send(res, 200, clone(dash));
    }
    if (req.method === "DELETE") {
      this.dashboards.delete(id);
      return this.send(res, 200, { deleted_dashboard_id: id });
    }
    return this.send(res, 405, { errors: ["method not allowed"] });
  }

  submitCheckRun(res, body) {
    const checks = Array.isArray(body) ? body : isPlainObject(body) ? [body] : [];
    for (const c of checks) {
      if (!isPlainObject(c)) continue;
      this.checkRuns.push({
        check: c.check,
        host_name: c.host_name || null,
        status: typeof c.status === "number" ? c.status : 0,
        tags: clone(c.tags) || [],
        message: c.message || null,
        received_at: new Date().toISOString(),
      });
    }
    return this.send(res, 202, { status: "ok" });
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "metrics") {
      return this.send(res, 200, { metrics: clone(this.metrics), count: this.metrics.length });
    }
    if (req.method === "GET" && parts[1] === "logs") {
      return this.send(res, 200, { logs: clone(this.logs), count: this.logs.length });
    }
    if (req.method === "GET" && parts[1] === "check_runs") {
      return this.send(res, 200, { check_runs: clone(this.checkRuns), count: this.checkRuns.length });
    }
    return this.send(res, 404, { errors: ["not found"] });
  }

  root() {
    return { name: "datadog", version: "1.0", protocol: "datadog", documentation: "/docs/datadog.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const apiKey = req.headers["dd-api-key"];
    return typeof apiKey === "string" && apiKey.length > 0;
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
          this.send(res, 400, { errors: ["Malformed JSON"] });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { errors: ["Bad request body"] });
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
