import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mixpanel — a tiny, dependency-free fake of the Mixpanel ingestion
// and query API. Supports /track (base64 `data` param or JSON), /import,
// /engage (people), and the /api/2.0/events query endpoint.
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

function newId() {
  return randomBytes(12).toString("hex");
}

// Decode a base64-encoded JSON `data` param (Mixpanel's classic encoding).
function decodeData(raw) {
  if (typeof raw !== "string") return raw;
  // Try JSON first.
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to base64
  }
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export class MixpanelServer {
  constructor(port = 4808, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.events = [];
    this.people = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { status: 0, error: error.message || "Internal server error" });
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
    res.setHeader("server", "parlel-mixpanel");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // /track — ingest events (data param or JSON body).
    if (req.method === "POST" && parts[0] === "track") {
      return this.track(res, body, url);
    }
    // /import — historical ingest (Basic auth project token); accept any.
    if (req.method === "POST" && parts[0] === "import") {
      return this.import(res, body, url);
    }
    // /engage — people updates.
    if (req.method === "POST" && parts[0] === "engage") {
      return this.engage(res, body, url);
    }
    // GET /api/2.0/events — query.
    if (parts[0] === "api" && parts[1] === "2.0" && parts[2] === "events") {
      return this.queryEvents(res, url);
    }

    return this.send(res, 404, { status: 0, error: "not found" });
  }

  _extractPayload(body, url) {
    // Mixpanel can send `data` as a query param, a form field, or a JSON body.
    let raw = url.searchParams.get("data");
    if (raw == null && isPlainObject(body) && body.data !== undefined) raw = body.data;
    if (raw != null) {
      const decoded = typeof raw === "string" ? decodeData(raw) : raw;
      return decoded;
    }
    // Otherwise the body itself is the payload (array or object).
    if (Array.isArray(body)) return body;
    if (isPlainObject(body) && (body.event || body.$distinct_id || body.$token)) return body;
    return null;
  }

  track(res, body, url) {
    const payload = this._extractPayload(body, url);
    const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
    if (list.length === 0) {
      return this.send(res, 200, 0);
    }
    for (const ev of list) {
      if (!isPlainObject(ev) || typeof ev.event !== "string") continue;
      this.events.push({
        id: newId(),
        event: ev.event,
        properties: clone(ev.properties) || {},
        distinct_id: ev.properties?.distinct_id || ev.distinct_id || null,
        time: ev.properties?.time || Date.now(),
      });
    }
    // Mixpanel /track returns 1 for success, 0 for failure.
    return this.send(res, 200, 1);
  }

  import(res, body, url) {
    const payload = this._extractPayload(body, url);
    const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
    let imported = 0;
    for (const ev of list) {
      if (!isPlainObject(ev) || typeof ev.event !== "string") continue;
      this.events.push({
        id: newId(),
        event: ev.event,
        properties: clone(ev.properties) || {},
        distinct_id: ev.properties?.distinct_id || ev.distinct_id || null,
        time: ev.properties?.time || Date.now(),
        imported: true,
      });
      imported += 1;
    }
    return this.send(res, 200, { code: 200, num_records_imported: imported, status: "OK" });
  }

  engage(res, body, url) {
    const payload = this._extractPayload(body, url);
    const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
    for (const op of list) {
      if (!isPlainObject(op)) continue;
      const id = op.$distinct_id || op.distinct_id;
      if (!id) continue;
      const existing = this.people.get(id) || { $distinct_id: id, $properties: {} };
      if (op.$set) Object.assign(existing.$properties, op.$set);
      if (op.$set_once) {
        for (const [k, v] of Object.entries(op.$set_once)) {
          if (!(k in existing.$properties)) existing.$properties[k] = v;
        }
      }
      if (op.$unset && Array.isArray(op.$unset)) {
        for (const k of op.$unset) delete existing.$properties[k];
      }
      this.people.set(id, existing);
    }
    return this.send(res, 200, 1);
  }

  queryEvents(res, url) {
    const eventFilter = url.searchParams.get("event");
    let results = this.events;
    if (eventFilter) {
      let names;
      try { names = JSON.parse(eventFilter); } catch { names = [eventFilter]; }
      if (!Array.isArray(names)) names = [names];
      results = results.filter((e) => names.includes(e.event));
    }
    return this.send(res, 200, {
      legend_size: 1,
      data: {
        series: ["all"],
        values: { all: results.length },
      },
      events: results.map(clone),
    });
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "events") {
      return this.send(res, 200, { events: clone(this.events), count: this.events.length });
    }
    if (req.method === "GET" && parts[1] === "people") {
      return this.send(res, 200, { people: Array.from(this.people.values()).map(clone), count: this.people.size });
    }
    if (req.method === "DELETE" && parts[1] === "events") {
      this.events = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, { status: 0, error: "not found" });
  }

  root() {
    return { name: "mixpanel", version: "1.0", protocol: "mixpanel", documentation: "/docs/mixpanel.md" };
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
          for (const [k, v] of params.entries()) obj[k] = v;
          return resolve(obj);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          // Non-JSON bodies (e.g. raw base64 data) are passed through as { _raw }.
          resolve({ _raw: data });
        }
      });
      req.on("error", () => {
        this.send(res, 400, { status: 0, error: "Bad request body" });
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
