import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/opsgenie — a tiny, dependency-free fake of the Opsgenie Alert API v2.
//
// Speaks the Opsgenie Alert API v2 surface (alerts CRUD + acknowledge/close,
// heartbeats). State is in-memory and ephemeral. List responses use the
// { data, paging, took, requestId } envelope.
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

function took() {
  return Math.round((Math.random() * 0.1 + 0.001) * 1000) / 1000;
}

export class OpsgenieServer {
  constructor(port = 4880, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.alerts = new Map(); // id -> alert
    this.alertOrder = [];
    this.tinyCounter = 0;
    this.heartbeats = new Map();
    this.heartbeats.set("parlel-default", {
      name: "parlel-default",
      description: "Default parlel heartbeat",
      interval: 10,
      intervalUnit: "minutes",
      enabled: true,
      expired: false,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message || "Internal server error" });
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
      if (!this.server) {
        resolve();
        return;
      }
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
    res.setHeader("server", "parlel-opsgenie");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v2") {
      return this.send(res, 404, { message: "Not found", took: took(), requestId: randomUUID() });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, {
        message: "No API key provided. You can use the API key associated with the integration.",
        took: took(),
        requestId: randomUUID(),
      });
    }

    const route = parts.slice(1);

    // Heartbeats: GET /v2/heartbeats
    if (route[0] === "heartbeats" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, {
        data: Array.from(this.heartbeats.values()).map(clone),
        took: took(),
        requestId: randomUUID(),
      });
    }

    // Alerts
    if (route[0] === "alerts") {
      // POST /v2/alerts
      if (route.length === 1 && req.method === "POST") return this.createAlert(res, body);
      // GET /v2/alerts
      if (route.length === 1 && req.method === "GET") {
        const data = this.alertOrder.map((id) => clone(this.alerts.get(id))).filter(Boolean);
        return this.send(res, 200, {
          data,
          paging: { first: "", last: "" },
          took: took(),
          requestId: randomUUID(),
        });
      }
      // /v2/alerts/:id (+ actions)
      if (route.length >= 2) {
        const id = route[1];
        const action = route[2];
        const alert = this.findAlert(id);
        if (!alert) {
          return this.send(res, 404, {
            message: "Alert not found",
            took: took(),
            requestId: randomUUID(),
          });
        }
        if (!action && req.method === "GET") {
          return this.send(res, 200, { data: clone(alert), took: took(), requestId: randomUUID() });
        }
        if (action === "acknowledge" && req.method === "POST") {
          alert.acknowledged = true;
          alert.status = "open";
          alert.updatedAt = now();
          return this.send(res, 202, {
            result: "Request will be processed",
            took: took(),
            requestId: randomUUID(),
          });
        }
        if (action === "close" && req.method === "POST") {
          alert.status = "closed";
          alert.updatedAt = now();
          return this.send(res, 202, {
            result: "Request will be processed",
            took: took(),
            requestId: randomUUID(),
          });
        }
      }
    }

    return this.send(res, 404, { message: "Not found", took: took(), requestId: randomUUID() });
  }

  createAlert(res, body) {
    if (!isPlainObject(body) || typeof body.message !== "string" || !body.message) {
      return this.send(res, 422, {
        message: "Error occurred while validating the request.",
        errors: { message: "must not be blank" },
        took: took(),
        requestId: randomUUID(),
      });
    }
    const id = randomUUID();
    this.tinyCounter += 1;
    const tinyId = String(this.tinyCounter);
    const createdAt = now();
    const alert = {
      id,
      tinyId,
      alias: body.alias || createHash("sha1").update(id).digest("hex"),
      message: body.message,
      status: "open",
      acknowledged: false,
      isSeen: false,
      priority: body.priority || "P3",
      source: body.source || "parlel",
      tags: Array.isArray(body.tags) ? clone(body.tags) : [],
      createdAt,
      updatedAt: createdAt,
      count: 1,
      description: body.description || "",
    };
    this.alerts.set(id, alert);
    this.alertOrder.unshift(id);
    return this.send(res, 202, {
      result: "Request will be processed",
      took: took(),
      requestId: randomUUID(),
    });
  }

  findAlert(idOrAlias) {
    if (this.alerts.has(idOrAlias)) return this.alerts.get(idOrAlias);
    for (const a of this.alerts.values()) {
      if (a.tinyId === idOrAlias || a.alias === idOrAlias) return a;
    }
    return null;
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { message: "not found" });
  }

  root() {
    return {
      name: "opsgenie",
      version: "2",
      protocol: "opsgenie-alert-v2",
      documentation: "/docs/opsgenie.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // Opsgenie uses "Authorization: GenieKey <key>".
    return /^GenieKey\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { message: "Invalid JSON body", took: took(), requestId: randomUUID() });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Invalid JSON body", took: took(), requestId: randomUUID() });
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
