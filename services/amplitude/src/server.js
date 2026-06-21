import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/amplitude — a tiny, dependency-free fake of the Amplitude HTTP API v2.
//
// Speaks the wire protocol of @amplitude/analytics-node and the HTTP V2 API:
// POST /2/httpapi (event ingest), POST /batch, /identify, and the user-search
// dashboard endpoint. api_key is supplied in the request body.
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

export class AmplitudeServer {
  constructor(port = 4809, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.events = [];
    this.users = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { code: 500, error: error.message || "Internal server error" });
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
    res.setHeader("server", "parlel-amplitude");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // POST /2/httpapi — HTTP API v2 event ingest.
    if (req.method === "POST" && parts[0] === "2" && parts[1] === "httpapi") {
      return this.httpapi(res, body);
    }
    // POST /batch — Batch Event Upload API.
    if (req.method === "POST" && parts[0] === "batch") {
      return this.httpapi(res, body);
    }
    // POST /identify — Identify API.
    if (req.method === "POST" && parts[0] === "identify") {
      return this.identify(res, body);
    }
    // POST /api/2/usersearch — dashboard user search.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "2" && parts[2] === "usersearch") {
      return this.userSearch(res, body, url);
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "2" && parts[2] === "usersearch") {
      return this.userSearch(res, body, url);
    }

    return this.send(res, 404, { code: 404, error: "not found" });
  }

  httpapi(res, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, { code: 400, error: "Invalid request body" });
    }
    if (typeof body.api_key !== "string" || body.api_key.length === 0) {
      return this.send(res, 400, { code: 400, error: "Missing api_key" });
    }
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length === 0) {
      return this.send(res, 400, { code: 400, error: "Missing events", events_ingested: 0 });
    }
    let ingested = 0;
    for (const ev of events) {
      if (!isPlainObject(ev) || typeof ev.event_type !== "string") continue;
      this.events.push({
        id: newId(),
        event_type: ev.event_type,
        user_id: ev.user_id || null,
        device_id: ev.device_id || null,
        event_properties: clone(ev.event_properties) || {},
        user_properties: clone(ev.user_properties) || {},
        time: ev.time || Date.now(),
      });
      if (ev.user_id || ev.device_id) {
        const key = ev.user_id || ev.device_id;
        const u = this.users.get(key) || { user_id: ev.user_id || null, device_id: ev.device_id || null, user_properties: {} };
        if (ev.user_properties && ev.user_properties.$set) Object.assign(u.user_properties, ev.user_properties.$set);
        this.users.set(key, u);
      }
      ingested += 1;
    }
    const payloadSize = Buffer.byteLength(JSON.stringify(body), "utf8");
    return this.send(res, 200, {
      code: 200,
      events_ingested: ingested,
      payload_size_bytes: payloadSize,
      server_upload_time: Date.now(),
    });
  }

  identify(res, body) {
    // Identify API: api_key + identification (JSON-encoded array or object).
    let api_key = null;
    let identification = null;
    if (isPlainObject(body)) {
      api_key = body.api_key;
      identification = body.identification;
    }
    if (typeof api_key !== "string") {
      return this.send(res, 400, { code: 400, error: "Missing api_key" });
    }
    let list = identification;
    if (typeof list === "string") {
      try { list = JSON.parse(list); } catch { list = null; }
    }
    if (!Array.isArray(list)) list = list ? [list] : [];
    let count = 0;
    for (const ident of list) {
      if (!isPlainObject(ident)) continue;
      const key = ident.user_id || ident.device_id;
      if (!key) continue;
      const u = this.users.get(key) || { user_id: ident.user_id || null, device_id: ident.device_id || null, user_properties: {} };
      if (ident.user_properties && ident.user_properties.$set) Object.assign(u.user_properties, ident.user_properties.$set);
      else if (ident.user_properties) Object.assign(u.user_properties, ident.user_properties);
      this.users.set(key, u);
      count += 1;
    }
    return this.send(res, 200, { code: 200, identifies_ingested: count, server_upload_time: Date.now() });
  }

  userSearch(res, body, url) {
    const term = url.searchParams.get("user") || (isPlainObject(body) ? body.user : null);
    const matches = Array.from(this.users.values()).filter((u) => {
      if (!term) return true;
      return u.user_id === term || u.device_id === term;
    });
    return this.send(res, 200, {
      matches: matches.map((u) => ({
        user_id: u.user_id,
        amplitude_id: newId(),
        device_id: u.device_id,
      })),
      type: "match_user_or_device_id",
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
    if (req.method === "GET" && parts[1] === "users") {
      return this.send(res, 200, { users: Array.from(this.users.values()).map(clone), count: this.users.size });
    }
    if (req.method === "DELETE" && parts[1] === "events") {
      this.events = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, { code: 404, error: "not found" });
  }

  root() {
    return { name: "amplitude", version: "1.0", protocol: "amplitude-http-v2", documentation: "/docs/amplitude.md" };
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
          this.send(res, 400, { code: 400, error: "Malformed JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { code: 400, error: "Bad request body" });
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
