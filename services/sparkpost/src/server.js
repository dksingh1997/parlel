import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/sparkpost — a tiny, dependency-free fake of the SparkPost API v1.
//
// Speaks the wire protocol the official `sparkpost` Node SDK uses: JSON bodies
// authenticated via a raw `Authorization: <api-key>` header (no Bearer prefix).
// State is in-memory and ephemeral; sent mail is captured for inspection via
// /__parlel/* endpoints.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// SparkPost error envelope: { errors: [{ message, code, description }] }
function spError(message, code = "1300", description = "") {
  return { errors: [{ message, code, description }] };
}

function newTransmissionId() {
  return String(Math.floor(Math.random() * 9e16) + 1e16);
}

export class SparkpostServer {
  constructor(port = 4830, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.transmissions = new Map();
    this.templates = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, spError(error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-sparkpost");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // All API routes live under /api/v1.
    if (parts[0] !== "api" || parts[1] !== "v1") {
      return this.send(res, 404, spError("Not Found", "1600"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, spError("Unauthorized", "1300", "Unauthorized."));
    }

    const route = parts.slice(2);

    // /api/v1/transmissions
    if (route[0] === "transmissions") {
      return this.handleTransmissions(req, res, route, body);
    }
    // /api/v1/templates
    if (route[0] === "templates") {
      return this.handleTemplates(req, res, route, body);
    }
    // GET /api/v1/account
    if (req.method === "GET" && route[0] === "account" && route.length === 1) {
      return this.send(res, 200, {
        results: {
          company_name: "Parlel",
          country_code: "US",
          anniversary_date: now(),
          usage: { recipients: { this_month: { used: 0, limit: 50000 } } },
          options: { smtp_tracking_default: true },
        },
      });
    }

    return this.send(res, 404, spError("Not Found", "1600"));
  }

  handleTransmissions(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") return this.createTransmission(res, body);
      if (req.method === "GET") {
        const results = Array.from(this.transmissions.values()).map((t) => ({
          id: t.id,
          state: t.state,
          campaign_id: t.campaign_id || "",
          num_recipients: t.num_recipients,
        }));
        return this.send(res, 200, { results });
      }
      return this.send(res, 405, spError("Method Not Allowed", "1600"));
    }
    if (route.length === 2 && req.method === "GET") {
      const t = this.transmissions.get(route[1]);
      if (!t) return this.send(res, 404, spError("resource not found", "1600"));
      return this.send(res, 200, { results: clone(t) });
    }
    return this.send(res, 404, spError("Not Found", "1600"));
  }

  createTransmission(res, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, spError("Invalid request body", "1300"));
    }
    const content = body.content;
    if (!isPlainObject(content) || !content.from) {
      return this.send(res, 422, spError("content.from is required", "1400", "Missing required field"));
    }
    const recipients = body.recipients;
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return this.send(res, 422, spError("recipients are required", "1400", "Missing required field"));
    }
    let accepted = 0;
    let rejected = 0;
    for (const r of recipients) {
      const email = isPlainObject(r) && isPlainObject(r.address) ? r.address.email : (isPlainObject(r) ? r.address : null);
      if (typeof email === "string" && EMAIL_RE.test(email)) accepted += 1;
      else rejected += 1;
    }
    const id = newTransmissionId();
    const record = {
      id,
      state: "success",
      campaign_id: body.campaign_id || "",
      num_recipients: accepted,
      content: clone(content),
      recipients: clone(recipients),
      received_at: now(),
    };
    this.transmissions.set(id, record);
    this.messages.push({ id, received_at: record.received_at, body: clone(body) });

    return this.send(res, 200, {
      results: {
        total_rejected_recipients: rejected,
        total_accepted_recipients: accepted,
        id,
      },
    });
  }

  handleTemplates(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        const results = Array.from(this.templates.values()).map((t) => ({
          id: t.id,
          name: t.name,
          published: t.published,
          description: t.description,
        }));
        return this.send(res, 200, { results });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || !body.id || !isPlainObject(body.content)) {
          return this.send(res, 422, spError("id and content are required", "1400", "Missing required field"));
        }
        const record = {
          id: body.id,
          name: body.name || body.id,
          description: body.description || "",
          published: Boolean(body.published),
          content: clone(body.content),
          created_at: now(),
        };
        this.templates.set(record.id, record);
        return this.send(res, 200, { results: { id: record.id } });
      }
      return this.send(res, 405, spError("Method Not Allowed", "1600"));
    }
    return this.send(res, 404, spError("Not Found", "1600"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 2) {
      return this.send(res, 200, { messages: clone(this.messages), count: this.messages.length });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 3) {
      const match = this.messages.find((m) => m.id === parts[2]);
      if (!match) return this.send(res, 404, spError("message not found", "1600"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, spError("Not Found", "1600"));
  }

  root() {
    return {
      name: "sparkpost",
      version: "1.0",
      protocol: "sparkpost-v1",
      documentation: "/docs/sparkpost.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    // SparkPost uses a raw Authorization header (no Bearer prefix).
    const auth = req.headers.authorization || "";
    return auth.length > 0;
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
          this.send(res, 400, spError("Invalid request body", "1300"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, spError("Invalid request body", "1300"));
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
