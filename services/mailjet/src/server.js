import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mailjet — a tiny, dependency-free fake of the Mailjet API v3.1 / v3.
//
// Speaks the wire protocol the official `node-mailjet` SDK uses: JSON bodies
// authenticated via HTTP Basic auth (api key:secret). State is in-memory and
// ephemeral; sent mail is captured for inspection via /__parlel/* endpoints.
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

// Mailjet error envelope (v3.1): { ErrorIdentifier, ErrorCode, StatusCode, ErrorMessage }
function mjError(statusCode, message, code = "mj-0001") {
  return {
    ErrorIdentifier: randomUUID(),
    ErrorCode: code,
    StatusCode: statusCode,
    ErrorMessage: message,
  };
}

function newMessageId() {
  // Mailjet message ids are large integers.
  return String(Math.floor(Math.random() * 9e17) + 1e17);
}

function newMessageUuid() {
  return randomUUID();
}

export class MailjetServer {
  constructor(port = 4829, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.contacts = new Map(); // id -> contact
    this.contactsByEmail = new Map();
    this.contactsLists = new Map();
    this.contactIdCounter = 0;
    this.listIdCounter = 0;
    this._seedDefaults();
  }

  _seedDefaults() {
    this.listIdCounter += 1;
    const id = this.listIdCounter;
    this.contactsLists.set(id, {
      ID: id,
      Name: "parlel-default",
      Address: "parlel-default",
      SubscriberCount: 0,
      CreatedAt: now(),
      IsDeleted: false,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, mjError(500, error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-mailjet");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, {
        ErrorMessage: "API key authentication/authorization failure. You are not authorized to access this resource.",
        ErrorCode: "ps-0001",
        StatusCode: 401,
      });
    }

    // POST /v3.1/send
    if (req.method === "POST" && parts[0] === "v3.1" && parts[1] === "send" && parts.length === 2) {
      return this.sendEmail(res, body);
    }

    // /v3/REST/contact
    if (parts[0] === "v3" && parts[1] === "REST" && parts[2] === "contact") {
      return this.handleContacts(req, res, parts, body);
    }

    // GET /v3/REST/contactslist
    if (req.method === "GET" && parts[0] === "v3" && parts[1] === "REST" && parts[2] === "contactslist") {
      const Data = Array.from(this.contactsLists.values()).map(clone);
      return this.send(res, 200, { Count: Data.length, Data, Total: Data.length });
    }

    return this.send(res, 404, mjError(404, "Object not found"));
  }

  sendEmail(res, body) {
    if (!isPlainObject(body) || !Array.isArray(body.Messages)) {
      return this.send(res, 400, mjError(400, '"Messages" array is required.'));
    }
    const responseMessages = [];
    for (const msg of body.Messages) {
      if (!isPlainObject(msg) || !isPlainObject(msg.From) || !msg.From.Email) {
        responseMessages.push({
          Status: "error",
          Errors: [{ ErrorIdentifier: randomUUID(), ErrorCode: "mj-0004", StatusCode: 400, ErrorMessage: '"From" is mandatory.' }],
        });
        continue;
      }
      const to = Array.isArray(msg.To) ? msg.To : [];
      if (to.length === 0 || !to.every((r) => isPlainObject(r) && EMAIL_RE.test(r.Email || ""))) {
        responseMessages.push({
          Status: "error",
          Errors: [{ ErrorIdentifier: randomUUID(), ErrorCode: "mj-0004", StatusCode: 400, ErrorMessage: '"To" must contain valid recipients.' }],
        });
        continue;
      }
      const captured = {
        messageId: newMessageId(),
        received_at: now(),
        body: clone(msg),
      };
      this.messages.push(captured);
      responseMessages.push({
        Status: "success",
        CustomID: msg.CustomID || "",
        To: to.map((r) => ({
          Email: r.Email,
          MessageUUID: newMessageUuid(),
          MessageID: Number(captured.messageId),
          MessageHref: `https://api.mailjet.com/v3/REST/message/${captured.messageId}`,
        })),
        Cc: [],
        Bcc: [],
      });
    }
    const hasError = responseMessages.some((m) => m.Status === "error");
    return this.send(res, hasError ? 400 : 200, { Messages: responseMessages });
  }

  handleContacts(req, res, parts, body) {
    // /v3/REST/contact
    if (parts.length === 3) {
      if (req.method === "GET") {
        const Data = Array.from(this.contacts.values()).map(clone);
        return this.send(res, 200, { Count: Data.length, Data, Total: Data.length });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.Email !== "string" || !EMAIL_RE.test(body.Email)) {
          return this.send(res, 400, mjError(400, '"Email" is mandatory and must be valid.'));
        }
        if (this.contactsByEmail.has(body.Email)) {
          return this.send(res, 400, mjError(400, "A contact with the same Email already exists.", "mj-0002"));
        }
        this.contactIdCounter += 1;
        const id = this.contactIdCounter;
        const record = {
          ID: id,
          Email: body.Email,
          Name: body.Name || "",
          IsExcludedFromCampaigns: Boolean(body.IsExcludedFromCampaigns),
          CreatedAt: now(),
          DeliveredCount: 0,
          IsOptInPending: false,
        };
        this.contacts.set(id, record);
        this.contactsByEmail.set(body.Email, record);
        return this.send(res, 201, { Count: 1, Data: [clone(record)], Total: 1 });
      }
      return this.send(res, 405, mjError(405, "Method not allowed"));
    }

    // /v3/REST/contact/:id
    if (parts.length === 4) {
      const key = parts[3];
      const contact = this._findContact(key);
      if (req.method === "GET") {
        if (!contact) return this.send(res, 404, mjError(404, "Object not found"));
        return this.send(res, 200, { Count: 1, Data: [clone(contact)], Total: 1 });
      }
      if (req.method === "PUT") {
        if (!contact) return this.send(res, 404, mjError(404, "Object not found"));
        if (isPlainObject(body)) {
          if (typeof body.Name === "string") contact.Name = body.Name;
          if (typeof body.IsExcludedFromCampaigns === "boolean") contact.IsExcludedFromCampaigns = body.IsExcludedFromCampaigns;
        }
        return this.send(res, 200, { Count: 1, Data: [clone(contact)], Total: 1 });
      }
      return this.send(res, 405, mjError(405, "Method not allowed"));
    }
    return this.send(res, 404, mjError(404, "Object not found"));
  }

  _findContact(key) {
    const asId = Number(key);
    if (!Number.isNaN(asId) && this.contacts.has(asId)) return this.contacts.get(asId);
    if (this.contactsByEmail.has(key)) return this.contactsByEmail.get(key);
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
      const match = this.messages.find((m) => m.messageId === parts[2]);
      if (!match) return this.send(res, 404, mjError(404, "message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, mjError(404, "Object not found"));
  }

  root() {
    return {
      name: "mailjet",
      version: "1.0",
      protocol: "mailjet-v3",
      documentation: "/docs/mailjet.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Basic\s+\S+/i.test(auth);
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
          this.send(res, 400, mjError(400, "Malformed JSON request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, mjError(400, "Malformed JSON request body."));
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
