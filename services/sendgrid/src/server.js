import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/sendgrid — a tiny, dependency-free fake of the SendGrid v3 Web API.
//
// It speaks the exact wire protocol used by the official `@sendgrid/mail`
// (and `@sendgrid/client`) packages so application code and AI agents can run
// against it with zero cost and zero side effects. State is in-memory and
// ephemeral; sent mail is captured for inspection and assertions.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// SendGrid error envelope: { errors: [{ message, field, help }] }
function sgError(message, field = null, help = null) {
  const entry = { message };
  if (field !== null) entry.field = field;
  if (help !== null) entry.help = help;
  return { errors: [entry] };
}

function sgErrors(entries) {
  return { errors: entries };
}

// Generate a SendGrid-style X-Message-Id (base64-ish opaque token).
function newMessageId() {
  return randomBytes(16).toString("base64").replace(/[+/=]/g, "").slice(0, 22);
}

function newBatchId() {
  return randomBytes(18).toString("hex").slice(0, 36);
}

function newApiKeyId() {
  return randomBytes(11).toString("base64").replace(/[+/=]/g, "").slice(0, 22);
}

function isValidEmailObject(value) {
  if (typeof value === "string") return EMAIL_RE.test(value);
  if (isPlainObject(value)) return typeof value.email === "string" && EMAIL_RE.test(value.email);
  return false;
}

function normalizeEmail(value) {
  if (typeof value === "string") return { email: value };
  return value;
}

// Validate a /v3/mail/send body the same way the real API would (the most
// common, load-bearing validations). Returns an array of error entries.
function validateMailSend(body) {
  const errors = [];

  if (!isPlainObject(body)) {
    errors.push({
      message: "Bad request body",
      field: null,
      help: null,
    });
    return errors;
  }

  // personalizations
  const personalizations = body.personalizations;
  if (!Array.isArray(personalizations) || personalizations.length === 0) {
    errors.push({
      message: "The personalizations field is required and must have at least one personalization.",
      field: "personalizations",
      help: "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.personalizations",
    });
  } else {
    personalizations.forEach((p, i) => {
      if (!isPlainObject(p) || !Array.isArray(p.to) || p.to.length === 0) {
        errors.push({
          message: "The to array is required for each personalization and must have at least one email object.",
          field: `personalizations.${i}.to`,
          help: "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.personalizations.to",
        });
        return;
      }
      p.to.forEach((addr, j) => {
        if (!isValidEmailObject(addr)) {
          errors.push({
            message: "Does not contain a valid address.",
            field: `personalizations.${i}.to.${j}.email`,
            help: "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#-Email-Address",
          });
        }
      });
    });
  }

  // from
  if (!isValidEmailObject(body.from)) {
    errors.push({
      message: "The from object must be provided for every email send. It is an object that requires the email parameter, but may also contain a name parameter.  e.g. {\"email\" : \"example@example.com\"}  or {\"email\" : \"example@example.com\", \"name\" : \"Example Recipient\"}.",
      field: "from",
      help: "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.from",
    });
  }

  // subject — required unless provided per-personalization or via template
  const hasTemplate = typeof body.template_id === "string" && body.template_id.length > 0;
  const hasGlobalSubject = typeof body.subject === "string" && body.subject.length > 0;
  const hasPerSubject =
    Array.isArray(personalizations) &&
    personalizations.every((p) => isPlainObject(p) && typeof p.subject === "string" && p.subject.length > 0);
  if (!hasTemplate && !hasGlobalSubject && !hasPerSubject) {
    errors.push({
      message: "The subject is required. You can get around this requirement if you use a template with a subject defined or if every personalization has a subject defined.",
      field: "subject",
      help: "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.subject",
    });
  }

  // content — required unless a template is used
  if (!hasTemplate) {
    const content = body.content;
    if (!Array.isArray(content) || content.length === 0) {
      errors.push({
        message: "Unless a valid template_id is provided, the content parameter is required. There must be at least one defined content block. We typically suggest both text/plain and text/html blocks are included, but only one block is required.",
        field: "content",
        help: "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.content",
      });
    } else {
      content.forEach((c, i) => {
        if (!isPlainObject(c) || typeof c.type !== "string" || !c.type) {
          errors.push({
            message: "The type parameter is required for every entry in the content array.",
            field: `content.${i}.type`,
            help: "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.content.type",
          });
        }
        if (!isPlainObject(c) || typeof c.value !== "string" || c.value.length === 0) {
          errors.push({
            message: "The value parameter is required for every entry in the content array.",
            field: `content.${i}.value`,
            help: "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.content.value",
          });
        }
      });
    }
  }

  return errors;
}

export class SendgridServer {
  constructor(port = 4650, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // Captured outbound mail (each entry mirrors what was POSTed to mail/send,
    // enriched with a generated message id + batch info).
    this.messages = [];
    // API keys store
    this.apiKeys = new Map();
    // Suppression / unsubscribe groups (ASM) and global unsubscribes.
    this.asmGroups = new Map();
    this.globalUnsubscribes = new Map();
    // Verified senders.
    this.verifiedSenders = new Map();
    this.idCounter = 0;
    this._seedDefaults();
  }

  _seedDefaults() {
    // A default API key record so listing endpoints return something usable.
    const id = newApiKeyId();
    this.apiKeys.set(id, {
      api_key_id: id,
      name: "parlel-default",
      scopes: ["mail.send"],
    });
    // A default unsubscribe group.
    const groupId = 1;
    this.asmGroups.set(groupId, {
      id: groupId,
      name: "Parlel Notifications",
      description: "Default parlel unsubscribe group",
      is_default: true,
      unsubscribes: 0,
    });
    this._asmGroupCounter = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, sgError(error.message || "Internal server error"));
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
    if (body === SENTINEL_BAD_JSON) return; // response already sent

    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, On-Behalf-Of");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-sendgrid");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Unauthenticated infrastructure endpoints.
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    // Inspection + control endpoints (parlel extensions, not part of SendGrid).
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // Everything else is the SendGrid v3 API, which requires auth.
    if (parts[0] !== "v3") {
      return this.send(res, 404, sgError("not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, sgErrors([
        {
          message: "The provided authorization grant is invalid, expired, or revoked",
          field: null,
          help: null,
        },
      ]));
    }

    const route = parts.slice(1);

    // POST /v3/mail/send
    if (req.method === "POST" && route[0] === "mail" && route[1] === "send" && route.length === 2) {
      return this.mailSend(res, body);
    }

    // POST /v3/mail/batch  (create a batch id for scheduled/cancel sends)
    if (req.method === "POST" && route[0] === "mail" && route[1] === "batch" && route.length === 2) {
      return this.send(res, 201, { batch_id: newBatchId() });
    }
    // GET /v3/mail/batch/{batch_id}  (Validate batch ID — real API returns { batch_id })
    if (req.method === "GET" && route[0] === "mail" && route[1] === "batch" && route.length === 3) {
      return this.send(res, 200, { batch_id: route[2] });
    }

    // GET /v3/scopes  — scopes available to the authenticated key.
    if (req.method === "GET" && route[0] === "scopes" && route.length === 1) {
      return this.send(res, 200, { scopes: ["mail.send", "alerts.read", "api_keys.read"] });
    }

    // API key management: /v3/api_keys
    if (route[0] === "api_keys") return this.handleApiKeys(req, res, route, body);

    // Unsubscribe groups (ASM): /v3/asm/groups
    if (route[0] === "asm" && route[1] === "groups") return this.handleAsmGroups(req, res, route, body);

    // Global suppressions / unsubscribes: /v3/asm/suppressions/global
    if (route[0] === "asm" && route[1] === "suppressions" && route[2] === "global") {
      return this.handleGlobalSuppressions(req, res, route, body);
    }

    // Verified senders: /v3/verified_senders
    if (route[0] === "verified_senders") return this.handleVerifiedSenders(req, res, route, body);

    return this.send(res, 404, sgError("not found"));
  }

  // -------------------------------------------------------------------------
  // Core: POST /v3/mail/send
  // -------------------------------------------------------------------------
  mailSend(res, body) {
    const errors = validateMailSend(body);
    if (errors.length > 0) {
      return this.send(res, 400, sgErrors(errors));
    }

    const messageId = newMessageId();
    const captured = {
      message_id: messageId,
      received_at: now(),
      body: clone(body),
    };
    this.messages.push(captured);

    res.setHeader("X-Message-Id", messageId);
    // Real SendGrid returns 202 Accepted with an empty body.
    return this.send(res, 202, null);
  }

  // -------------------------------------------------------------------------
  // API keys: /v3/api_keys
  // -------------------------------------------------------------------------
  handleApiKeys(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        const result = Array.from(this.apiKeys.values()).map((k) => ({
          api_key_id: k.api_key_id,
          name: k.name,
        }));
        return this.send(res, 200, { result });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 400, sgError("name is required", "name"));
        }
        const id = newApiKeyId();
        const record = {
          api_key_id: id,
          name: body.name,
          scopes: Array.isArray(body.scopes) ? clone(body.scopes) : ["mail.send"],
        };
        this.apiKeys.set(id, record);
        // The full api_key value is only returned on creation by the real API.
        return this.send(res, 201, {
          api_key_id: id,
          api_key: `SG.${randomBytes(16).toString("base64").replace(/[+/=]/g, "")}`,
          name: record.name,
          scopes: record.scopes,
        });
      }
      return this.send(res, 405, sgError("method not allowed"));
    }

    // /v3/api_keys/{id}
    const id = route[1];
    const record = this.apiKeys.get(id);
    if (!record) return this.send(res, 404, sgError("not found"));

    if (req.method === "GET") {
      return this.send(res, 200, clone(record));
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      if (isPlainObject(body)) {
        if (typeof body.name === "string") record.name = body.name;
        if (Array.isArray(body.scopes)) record.scopes = clone(body.scopes);
      }
      return this.send(res, 200, clone(record));
    }
    if (req.method === "DELETE") {
      this.apiKeys.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, sgError("method not allowed"));
  }

  // -------------------------------------------------------------------------
  // ASM unsubscribe groups: /v3/asm/groups
  // -------------------------------------------------------------------------
  handleAsmGroups(req, res, route, body) {
    if (route.length === 2) {
      if (req.method === "GET") {
        return this.send(res, 200, Array.from(this.asmGroups.values()).map(clone));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 400, sgError("name is required", "name"));
        }
        this._asmGroupCounter += 1;
        const group = {
          id: this._asmGroupCounter,
          name: body.name,
          description: typeof body.description === "string" ? body.description : "",
          is_default: Boolean(body.is_default),
          unsubscribes: 0,
        };
        this.asmGroups.set(group.id, group);
        return this.send(res, 201, clone(group));
      }
      return this.send(res, 405, sgError("method not allowed"));
    }

    // /v3/asm/groups/{id}
    const id = Number(route[2]);
    const group = this.asmGroups.get(id);
    if (!group) return this.send(res, 404, sgError("not found"));

    if (req.method === "GET") return this.send(res, 200, clone(group));
    if (req.method === "PATCH" || req.method === "PUT") {
      if (isPlainObject(body)) {
        if (typeof body.name === "string") group.name = body.name;
        if (typeof body.description === "string") group.description = body.description;
        if (typeof body.is_default === "boolean") group.is_default = body.is_default;
      }
      return this.send(res, 200, clone(group));
    }
    if (req.method === "DELETE") {
      this.asmGroups.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, sgError("method not allowed"));
  }

  // -------------------------------------------------------------------------
  // Global suppressions: /v3/asm/suppressions/global
  // -------------------------------------------------------------------------
  handleGlobalSuppressions(req, res, route, body) {
    // POST /v3/asm/suppressions/global  { recipient_emails: [...] }
    if (route.length === 3 && req.method === "POST") {
      const emails = Array.isArray(body?.recipient_emails) ? body.recipient_emails : [];
      for (const email of emails) {
        if (typeof email === "string") {
          this.globalUnsubscribes.set(email, { email, created: Math.floor(Date.now() / 1000) });
        }
      }
      return this.send(res, 201, { recipient_emails: emails });
    }
    // GET /v3/asm/suppressions/global/{email}
    if (route.length === 4 && req.method === "GET") {
      const email = route[3];
      if (this.globalUnsubscribes.has(email)) {
        return this.send(res, 200, { recipient_email: email });
      }
      return this.send(res, 200, {});
    }
    // DELETE /v3/asm/suppressions/global/{email}
    if (route.length === 4 && req.method === "DELETE") {
      this.globalUnsubscribes.delete(route[3]);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, sgError("method not allowed"));
  }

  // -------------------------------------------------------------------------
  // Verified senders: /v3/verified_senders
  // -------------------------------------------------------------------------
  handleVerifiedSenders(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, { results: Array.from(this.verifiedSenders.values()).map(clone) });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || !isValidEmailObject(body.from_email)) {
          return this.send(res, 400, sgError("from_email is required and must be valid", "from_email"));
        }
        this.idCounter += 1;
        const sender = {
          id: this.idCounter,
          from_email: body.from_email,
          from_name: body.from_name || "",
          verified: true,
        };
        this.verifiedSenders.set(sender.id, sender);
        return this.send(res, 201, clone(sender));
      }
      return this.send(res, 405, sgError("method not allowed"));
    }
    return this.send(res, 404, sgError("not found"));
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection endpoints (not part of SendGrid).
  // -------------------------------------------------------------------------
  handleControl(req, res, parts, body) {
    // POST /__parlel/reset
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    // GET /__parlel/messages — all captured outbound mail.
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 2) {
      return this.send(res, 200, { messages: clone(this.messages), count: this.messages.length });
    }
    // GET /__parlel/messages/{message_id}
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 3) {
      const match = this.messages.find((m) => m.message_id === parts[2]);
      if (!match) return this.send(res, 404, sgError("message not found"));
      return this.send(res, 200, clone(match));
    }
    // DELETE /__parlel/messages — clear only the captured mailbox.
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, sgError("not found"));
  }

  root() {
    return {
      name: "sendgrid",
      version: "3.0",
      protocol: "sendgrid-v3",
      documentation: "/docs/sendgrid.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // Accept Bearer (SendGrid API key) or Basic (Twilio Email auth).
    return /^Bearer\s+\S+/i.test(auth) || /^Basic\s+\S+/i.test(auth);
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
          this.send(res, 400, sgError("Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, sgError("Bad request body"));
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

const SENTINEL_BAD_JSON = Symbol("bad-json");
