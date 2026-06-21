import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/loops — a tiny, dependency-free fake of the Loops API.
//
// Speaks the wire protocol the official `@loops/loops` SDK uses: JSON bodies
// authenticated via Bearer auth. State is in-memory and ephemeral; sent
// transactional emails are captured for inspection via /__parlel/* endpoints.
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

// Loops error envelope: { success: false, message }
function loopsError(message) {
  return { success: false, message };
}

export class LoopsServer {
  constructor(port = 4834, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = []; // captured transactional emails
    this.contacts = new Map(); // email -> contact
    this.events = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, loopsError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-loops");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v1") {
      return this.send(res, 404, loopsError("Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, loopsError("Invalid API key"));
    }

    const route = parts.slice(1);

    // POST /v1/transactional
    if (req.method === "POST" && route[0] === "transactional" && route.length === 1) {
      return this.sendTransactional(res, body);
    }
    // POST /v1/contacts/create
    if (req.method === "POST" && route[0] === "contacts" && route[1] === "create" && route.length === 2) {
      return this.createContact(res, body);
    }
    // PUT /v1/contacts/update
    if (req.method === "PUT" && route[0] === "contacts" && route[1] === "update" && route.length === 2) {
      return this.updateContact(res, body);
    }
    // GET /v1/contacts/find?email=
    if (req.method === "GET" && route[0] === "contacts" && route[1] === "find" && route.length === 2) {
      const email = url.searchParams.get("email");
      if (!email) return this.send(res, 400, loopsError("email query parameter is required."));
      const contact = this.contacts.get(email);
      return this.send(res, 200, contact ? [clone(contact)] : []);
    }
    // POST /v1/events/send
    if (req.method === "POST" && route[0] === "events" && route[1] === "send" && route.length === 2) {
      return this.sendEvent(res, body);
    }
    // GET /v1/api-key
    if (req.method === "GET" && route[0] === "api-key" && route.length === 1) {
      return this.send(res, 200, { success: true, teamName: "Parlel" });
    }

    return this.send(res, 404, loopsError("Not Found"));
  }

  sendTransactional(res, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, loopsError("Invalid request body."));
    }
    if (typeof body.transactionalId !== "string" || !body.transactionalId) {
      return this.send(res, 400, loopsError("transactionalId is required."));
    }
    if (typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
      return this.send(res, 400, loopsError("A valid email is required."));
    }
    this.messages.push({ id: randomUUID(), received_at: now(), body: clone(body) });
    return this.send(res, 200, { success: true });
  }

  createContact(res, body) {
    if (!isPlainObject(body) || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
      return this.send(res, 400, loopsError("A valid email is required."));
    }
    if (this.contacts.has(body.email)) {
      return this.send(res, 409, loopsError("An existing contact with this email was found."));
    }
    const id = randomUUID();
    const record = {
      id,
      email: body.email,
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      source: body.source ?? "API",
      subscribed: body.subscribed !== false,
      userGroup: body.userGroup ?? "",
      userId: body.userId ?? null,
      ...this._customProps(body),
    };
    this.contacts.set(body.email, record);
    return this.send(res, 200, { success: true, id });
  }

  updateContact(res, body) {
    if (!isPlainObject(body) || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
      return this.send(res, 400, loopsError("A valid email is required."));
    }
    let record = this.contacts.get(body.email);
    if (!record) {
      // Loops update upserts when contact does not exist.
      const id = randomUUID();
      record = { id, email: body.email, source: "API", subscribed: true };
      this.contacts.set(body.email, record);
    }
    for (const key of Object.keys(body)) {
      if (key === "email") continue;
      record[key] = body[key];
    }
    return this.send(res, 200, { success: true, id: record.id });
  }

  sendEvent(res, body) {
    if (!isPlainObject(body) || typeof body.eventName !== "string" || !body.eventName) {
      return this.send(res, 400, loopsError("eventName is required."));
    }
    if ((typeof body.email !== "string" || !EMAIL_RE.test(body.email)) && !body.userId) {
      return this.send(res, 400, loopsError("Either email or userId is required."));
    }
    this.events.push({ id: randomUUID(), received_at: now(), body: clone(body) });
    return this.send(res, 200, { success: true });
  }

  _customProps(body) {
    const reserved = new Set(["email", "firstName", "lastName", "source", "subscribed", "userGroup", "userId"]);
    const out = {};
    for (const key of Object.keys(body)) {
      if (!reserved.has(key)) out[key] = body[key];
    }
    return out;
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
      if (!match) return this.send(res, 404, loopsError("message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, loopsError("Not Found"));
  }

  root() {
    return {
      name: "loops",
      version: "1.0",
      protocol: "loops-rest",
      documentation: "/docs/loops.md",
    };
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
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, loopsError("Invalid request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, loopsError("Invalid request body."));
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
