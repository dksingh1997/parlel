import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/brevo — a tiny, dependency-free fake of the Brevo (Sendinblue) API v3.
//
// Speaks the wire protocol the official `@getbrevo/brevo` SDK uses: JSON bodies
// authenticated via the `api-key` header. State is in-memory and ephemeral;
// sent mail is captured for inspection via /__parlel/* endpoints.
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

// Brevo error envelope: { code, message }
function brevoError(code, message) {
  return { code, message };
}

function newMessageId() {
  return `<${randomBytes(12).toString("hex")}@parlel.brevo>`;
}

export class BrevoServer {
  constructor(port = 4828, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.contacts = new Map(); // email -> contact
    this.templates = new Map();
    this.contactIdCounter = 0;
    this.templateIdCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, brevoError("internal_error", error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "api-key, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-brevo");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v3") {
      return this.send(res, 404, brevoError("not_found", "Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, brevoError("unauthorized", "Key not found"));
    }

    const route = parts.slice(1);

    // POST /v3/smtp/email
    if (req.method === "POST" && route[0] === "smtp" && route[1] === "email" && route.length === 2) {
      return this.sendEmail(res, body);
    }
    // POST /v3/smtp/templates
    if (req.method === "POST" && route[0] === "smtp" && route[1] === "templates" && route.length === 2) {
      return this.createTemplate(res, body);
    }
    // /v3/contacts (+ /:identifier)
    if (route[0] === "contacts") {
      return this.handleContacts(req, res, route, body);
    }
    // GET /v3/account
    if (req.method === "GET" && route[0] === "account" && route.length === 1) {
      return this.send(res, 200, {
        email: "owner@parlel.dev",
        firstName: "Parlel",
        lastName: "Owner",
        companyName: "Parlel",
        plan: [{ type: "free", credits: 9000, creditsType: "sendLimit" }],
      });
    }

    return this.send(res, 404, brevoError("not_found", "Not Found"));
  }

  sendEmail(res, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, brevoError("missing_parameter", "Invalid request body."));
    }
    const hasTemplate = body.templateId !== undefined;
    if (!hasTemplate) {
      if (!isPlainObject(body.sender) || !body.sender.email) {
        return this.send(res, 400, brevoError("missing_parameter", "sender is mandatory."));
      }
    }
    if (!Array.isArray(body.to) || body.to.length === 0) {
      return this.send(res, 400, brevoError("missing_parameter", "to is mandatory."));
    }
    for (const r of body.to) {
      if (!isPlainObject(r) || typeof r.email !== "string" || !EMAIL_RE.test(r.email)) {
        return this.send(res, 400, brevoError("invalid_parameter", "Invalid recipient email."));
      }
    }
    const messageId = newMessageId();
    this.messages.push({
      messageId,
      received_at: now(),
      body: clone(body),
    });
    return this.send(res, 201, { messageId });
  }

  createTemplate(res, body) {
    if (!isPlainObject(body) || !body.templateName || !body.subject) {
      return this.send(res, 400, brevoError("missing_parameter", "templateName and subject are mandatory."));
    }
    this.templateIdCounter += 1;
    const id = this.templateIdCounter;
    this.templates.set(id, {
      id,
      name: body.templateName,
      subject: body.subject,
      htmlContent: body.htmlContent || "",
      isActive: body.isActive !== false,
      createdAt: now(),
    });
    return this.send(res, 201, { id });
  }

  handleContacts(req, res, route, body) {
    // /v3/contacts
    if (route.length === 1) {
      if (req.method === "GET") {
        const contacts = Array.from(this.contacts.values()).map(clone);
        return this.send(res, 200, { contacts, count: contacts.length });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
          return this.send(res, 400, brevoError("invalid_parameter", "Invalid email address."));
        }
        if (this.contacts.has(body.email)) {
          return this.send(res, 400, brevoError("duplicate_parameter", "Contact already exist"));
        }
        this.contactIdCounter += 1;
        const id = this.contactIdCounter;
        this.contacts.set(body.email, {
          id,
          email: body.email,
          attributes: isPlainObject(body.attributes) ? clone(body.attributes) : {},
          listIds: Array.isArray(body.listIds) ? clone(body.listIds) : [],
          emailBlacklisted: Boolean(body.emailBlacklisted),
          smsBlacklisted: Boolean(body.smsBlacklisted),
          createdAt: now(),
          modifiedAt: now(),
        });
        return this.send(res, 201, { id });
      }
      return this.send(res, 405, brevoError("method_not_allowed", "Method Not Allowed"));
    }

    // /v3/contacts/:identifier
    if (route.length === 2) {
      const identifier = route[1];
      const contact = this._findContact(identifier);
      if (req.method === "GET") {
        if (!contact) return this.send(res, 404, brevoError("document_not_found", "Contact does not exist"));
        return this.send(res, 200, clone(contact));
      }
      if (req.method === "PUT") {
        if (!contact) return this.send(res, 404, brevoError("document_not_found", "Contact does not exist"));
        if (isPlainObject(body)) {
          if (isPlainObject(body.attributes)) contact.attributes = { ...contact.attributes, ...clone(body.attributes) };
          if (Array.isArray(body.listIds)) contact.listIds = clone(body.listIds);
          if (typeof body.emailBlacklisted === "boolean") contact.emailBlacklisted = body.emailBlacklisted;
          contact.modifiedAt = now();
        }
        return this.send(res, 204, null);
      }
      if (req.method === "DELETE") {
        if (!contact) return this.send(res, 404, brevoError("document_not_found", "Contact does not exist"));
        this.contacts.delete(contact.email);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, brevoError("method_not_allowed", "Method Not Allowed"));
    }
    return this.send(res, 404, brevoError("not_found", "Not Found"));
  }

  _findContact(identifier) {
    if (this.contacts.has(identifier)) return this.contacts.get(identifier);
    const asId = Number(identifier);
    if (!Number.isNaN(asId)) {
      for (const c of this.contacts.values()) {
        if (c.id === asId) return c;
      }
    }
    return null;
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
      const match = this.messages.find((m) => m.messageId === parts[2] || m.messageId.replace(/[<>]/g, "") === parts[2]);
      if (!match) return this.send(res, 404, brevoError("not_found", "message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, brevoError("not_found", "Not Found"));
  }

  root() {
    return {
      name: "brevo",
      version: "1.0",
      protocol: "brevo-v3",
      documentation: "/docs/brevo.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const key = req.headers["api-key"];
    return typeof key === "string" && key.length > 0;
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
          this.send(res, 400, brevoError("invalid_parameter", "Invalid request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, brevoError("invalid_parameter", "Invalid request body."));
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
