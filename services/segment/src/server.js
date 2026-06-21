import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/segment — a tiny, dependency-free fake of the Segment Tracking API.
//
// Speaks the wire protocol of @segment/analytics-node / analytics.js HTTP
// tracking: /v1/track, /v1/identify, /v1/page, /v1/group, /v1/batch.
// Basic auth (write key as username). All calls return 200 {}.
// Captured events are inspectable. State is in-memory and ephemeral.
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

function newMessageId() {
  return `ajs-${randomBytes(16).toString("hex")}`;
}

const TYPES = new Set(["track", "identify", "page", "screen", "group", "alias"]);

export class SegmentServer {
  constructor(port = 4815, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.events = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: error.message || "Internal server error" });
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
    res.setHeader("server", "parlel-segment");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (parts[0] === "v1" && req.method === "POST") {
      const kind = parts[1];
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, { error: "Invalid write key" });
      }
      if (kind === "batch") {
        return this.batch(res, body);
      }
      if (TYPES.has(kind)) {
        return this.ingest(res, kind, body);
      }
    }

    return this.send(res, 404, { error: "not found" });
  }

  _capture(type, payload) {
    if (!isPlainObject(payload)) return;
    this.events.push({
      messageId: payload.messageId || newMessageId(),
      type,
      userId: payload.userId || null,
      anonymousId: payload.anonymousId || null,
      event: payload.event || null,
      name: payload.name || null,
      groupId: payload.groupId || null,
      properties: clone(payload.properties) || {},
      traits: clone(payload.traits) || {},
      context: clone(payload.context) || {},
      timestamp: payload.timestamp || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    });
  }

  ingest(res, type, body) {
    this._capture(type, body);
    // Segment returns 200 with an empty object body.
    return this.send(res, 200, {});
  }

  batch(res, body) {
    const list = isPlainObject(body) && Array.isArray(body.batch) ? body.batch : [];
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      const type = typeof item.type === "string" && TYPES.has(item.type) ? item.type : "track";
      this._capture(type, item);
    }
    return this.send(res, 200, {});
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
    return this.send(res, 404, { error: "not found" });
  }

  root() {
    return { name: "segment", version: "1.0", protocol: "segment-tracking", documentation: "/docs/segment.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // Segment uses HTTP Basic with the write key as the username.
    return /^Basic\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, { error: "Malformed JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { error: "Bad request body" });
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
