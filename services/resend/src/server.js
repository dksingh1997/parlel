import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/resend — a tiny, dependency-free fake of the Resend REST API.
//
// It speaks the exact wire protocol used by the official `resend` Node.js SDK
// (and the language-agnostic REST API) so application code and AI agents can
// run against it with zero cost and zero side effects. State is in-memory and
// ephemeral; sent mail is captured for inspection and assertions.
//
// Base URL surface mirrors https://api.resend.com:
//   POST   /emails                                  emails.send
//   GET    /emails/:id                               emails.get
//   PATCH  /emails/:id                               emails.update
//   POST   /emails/:id/cancel                        emails.cancel
//   POST   /emails/batch                             batch.send
//   POST   /domains                                  domains.create
//   GET    /domains                                  domains.list
//   GET    /domains/:id                              domains.get
//   PATCH  /domains/:id                              domains.update
//   POST   /domains/:id/verify                       domains.verify
//   DELETE /domains/:id                              domains.remove
//   POST   /api-keys                                 apiKeys.create
//   GET    /api-keys                                 apiKeys.list
//   DELETE /api-keys/:id                             apiKeys.remove
//   POST   /audiences                                audiences.create
//   GET    /audiences                                audiences.list
//   GET    /audiences/:id                            audiences.get
//   DELETE /audiences/:id                            audiences.remove
//   POST   /audiences/:aid/contacts                  contacts.create
//   GET    /audiences/:aid/contacts                  contacts.list
//   GET    /audiences/:aid/contacts/:id              contacts.get
//   PATCH  /audiences/:aid/contacts/:id              contacts.update
//   DELETE /audiences/:aid/contacts/:id              contacts.remove
//   POST   /broadcasts                               broadcasts.create
//   GET    /broadcasts                               broadcasts.list
//   GET    /broadcasts/:id                           broadcasts.get
//   PATCH  /broadcasts/:id                           broadcasts.update
//   POST   /broadcasts/:id/send                      broadcasts.send
//   DELETE /broadcasts/:id                           broadcasts.remove
//
// Plus parlel control/inspection endpoints under /__parlel.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"];
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

// Resend error envelope: { statusCode, name, message }
function resendError(statusCode, name, message) {
  return { statusCode, name, message };
}

// Extract a bare email from "Name <email@host>" or "email@host" forms.
function extractEmail(value) {
  if (typeof value !== "string") return null;
  const angle = value.match(/<([^>]+)>/);
  const candidate = angle ? angle[1].trim() : value.trim();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

function isValidFrom(value) {
  return extractEmail(value) !== null;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Validate a single email payload (used by send + batch). Returns null on
// success, or a { statusCode, name, message } error envelope.
function validateEmailPayload(body) {
  if (!isPlainObject(body)) {
    return resendError(422, "missing_required_field", "The request body is missing one or more required fields.");
  }

  const missing = [];
  if (!body.from) missing.push("from");
  if (body.to === undefined || body.to === null || (Array.isArray(body.to) && body.to.length === 0)) {
    missing.push("to");
  }
  if (body.subject === undefined || body.subject === null || body.subject === "") {
    missing.push("subject");
  }
  if (missing.length > 0) {
    return resendError(
      422,
      "missing_required_field",
      `The request body is missing one or more required fields: ${missing.join(", ")}.`,
    );
  }

  if (!isValidFrom(body.from)) {
    return resendError(
      422,
      "invalid_from_address",
      "Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
    );
  }

  // Recipients must be valid email addresses.
  // (Real Resend returns 400 `validation_error` for generic field errors;
  //  only the typed errors below use 422.)
  for (const field of ["to", "cc", "bcc"]) {
    for (const addr of toArray(body[field])) {
      if (typeof addr !== "string" || !EMAIL_RE.test(addr)) {
        return resendError(
          400,
          "validation_error",
          `The \`${field}\` field must contain valid email addresses.`,
        );
      }
    }
  }

  // template vs html/text/react are mutually exclusive.
  const hasTemplate = isPlainObject(body.template) || typeof body.template === "string";
  const hasContent =
    typeof body.html === "string" || typeof body.text === "string" || body.react !== undefined;
  if (hasTemplate && hasContent) {
    return resendError(
      400,
      "validation_error",
      "You cannot send `html`, `text`, or `react` when a `template` is provided.",
    );
  }
  if (!hasTemplate && !hasContent) {
    return resendError(
      400,
      "validation_error",
      "You must provide either `html`, `text`, `react`, or a `template`.",
    );
  }

  // Attachments must have content or path.
  for (const att of toArray(body.attachments)) {
    if (!isPlainObject(att) || (att.content === undefined && att.path === undefined)) {
      return resendError(422, "invalid_attachment", "Attachment must have either a `content` or `path`.");
    }
  }

  return null;
}

export class ResendServer {
  constructor(port = 4651, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // Captured / stored emails keyed by id.
    this.emails = new Map();
    // Insertion-ordered list of captured emails (for inspection + list).
    this.emailOrder = [];
    this.domains = new Map();
    this.apiKeys = new Map();
    this.audiences = new Map();
    // contacts keyed by audienceId -> Map(contactId -> contact)
    this.contacts = new Map();
    this.broadcasts = new Map();
    // Idempotency-Key -> stored response for replay.
    this.idempotency = new Map();
    this._seedDefaults();
  }

  _seedDefaults() {
    // A default API key so listing endpoints return something usable.
    const id = randomUUID();
    this.apiKeys.set(id, {
      id,
      name: "parlel-default",
      created_at: now(),
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, resendError(500, "application_error", error.message || "An unexpected error occurred."));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, User-Agent");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-resend");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Unauthenticated infrastructure endpoints.
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    // Inspection + control endpoints (parlel extensions, not part of Resend).
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body, url);

    // Everything else is the Resend API, which requires auth.
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, resendError(401, "missing_api_key", "Missing API key in the authorization header."));
    }

    try {
      switch (parts[0]) {
        case "emails":
          return this.routeEmails(req, res, parts, body);
        case "domains":
          return this.routeDomains(req, res, parts, body);
        case "api-keys":
          return this.routeApiKeys(req, res, parts, body);
        case "audiences":
          return this.routeAudiences(req, res, parts, body, url);
        case "broadcasts":
          return this.routeBroadcasts(req, res, parts, body);
        default:
          return this.send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
      }
    } catch (error) {
      return this.send(res, 500, resendError(500, "application_error", error.message || "An unexpected error occurred."));
    }
  }

  // -------------------------------------------------------------------------
  // /emails
  // -------------------------------------------------------------------------
  routeEmails(req, res, parts, body) {
    // POST /emails/batch  (batch.send)
    if (parts.length === 2 && parts[1] === "batch" && req.method === "POST") {
      return this.batchSend(req, res, body);
    }
    // POST /emails  (emails.send)
    if (parts.length === 1 && req.method === "POST") {
      return this.emailSend(req, res, body);
    }
    // POST /emails/:id/cancel  (emails.cancel)
    if (parts.length === 3 && parts[2] === "cancel" && req.method === "POST") {
      return this.emailCancel(res, parts[1]);
    }
    // GET /emails/:id  (emails.get)
    if (parts.length === 2 && req.method === "GET") {
      return this.emailGet(res, parts[1]);
    }
    // PATCH /emails/:id  (emails.update)
    if (parts.length === 2 && req.method === "PATCH") {
      return this.emailUpdate(res, parts[1], body);
    }
    return this.notFoundOrMethod(res, req.method);
  }

  emailSend(req, res, body) {
    // Idempotency replay.
    const idemKey = req.headers["idempotency-key"];
    if (typeof idemKey === "string" && idemKey.length > 0) {
      if (idemKey.length > 256) {
        return this.send(res, 400, resendError(400, "invalid_idempotency_key", "The key must be between 1-256 chars."));
      }
      const prior = this.idempotency.get(idemKey);
      if (prior) {
        return this.send(res, prior.status, prior.body);
      }
    }

    const error = validateEmailPayload(body);
    if (error) return this.send(res, error.statusCode, error);

    const stored = this._storeEmail(body);
    const response = { id: stored.id };

    if (typeof idemKey === "string" && idemKey.length > 0 && idemKey.length <= 256) {
      this.idempotency.set(idemKey, { status: 200, body: response });
    }
    return this.send(res, 200, response);
  }

  _storeEmail(body) {
    const id = randomUUID();
    const scheduledAt = body.scheduled_at || body.scheduledAt || null;
    const record = {
      object: "email",
      id,
      to: toArray(body.to),
      from: body.from,
      created_at: now(),
      subject: body.subject ?? null,
      html: typeof body.html === "string" ? body.html : null,
      text: typeof body.text === "string" ? body.text : null,
      bcc: toArray(body.bcc),
      cc: toArray(body.cc),
      reply_to: toArray(body.reply_to ?? body.replyTo),
      last_event: scheduledAt ? "scheduled" : "delivered",
      scheduled_at: scheduledAt,
      tags: Array.isArray(body.tags) ? clone(body.tags) : [],
      // parlel inspection extras (preserved separately from the API shape).
      _request: clone(body),
    };
    this.emails.set(id, record);
    this.emailOrder.push(id);
    return record;
  }

  emailGet(res, id) {
    const record = this.emails.get(id);
    if (!record) return this.send(res, 404, resendError(404, "not_found", "Email not found."));
    return this.send(res, 200, this._emailView(record));
  }

  emailUpdate(res, id, body) {
    const record = this.emails.get(id);
    if (!record) return this.send(res, 404, resendError(404, "not_found", "Email not found."));
    if (isPlainObject(body)) {
      const sched = body.scheduled_at ?? body.scheduledAt;
      if (sched !== undefined) {
        record.scheduled_at = sched;
        record.last_event = sched ? "scheduled" : record.last_event;
      }
    }
    return this.send(res, 200, { object: "email", id });
  }

  emailCancel(res, id) {
    const record = this.emails.get(id);
    if (!record) return this.send(res, 404, resendError(404, "not_found", "Email not found."));
    record.last_event = "canceled";
    record.scheduled_at = null;
    return this.send(res, 200, { object: "email", id });
  }

  batchSend(req, res, body) {
    if (!Array.isArray(body)) {
      return this.send(res, 400, resendError(400, "validation_error", "Batch send expects an array of emails."));
    }
    if (body.length > 100) {
      return this.send(res, 400, resendError(400, "validation_error", "You can only send up to 100 emails in a single batch."));
    }
    // Validate every email up front; batch is all-or-nothing on validation.
    for (const item of body) {
      const error = validateEmailPayload(item);
      if (error) return this.send(res, error.statusCode, error);
      // Batch does not support attachments or scheduled_at.
      if (item && (item.attachments !== undefined)) {
        return this.send(res, 400, resendError(400, "validation_error", "The `attachments` field is not supported in batch sending."));
      }
      if (item && (item.scheduled_at !== undefined || item.scheduledAt !== undefined)) {
        return this.send(res, 400, resendError(400, "validation_error", "The `scheduled_at` field is not supported in batch sending."));
      }
    }
    const data = body.map((item) => ({ id: this._storeEmail(item).id }));
    return this.send(res, 200, { data });
  }

  _emailView(record) {
    const view = clone(record);
    delete view._request;
    return view;
  }

  // -------------------------------------------------------------------------
  // /domains
  // -------------------------------------------------------------------------
  routeDomains(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "POST") return this.domainCreate(res, body);
      if (req.method === "GET") return this.domainList(res);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    // POST /domains/:id/verify
    if (parts.length === 3 && parts[2] === "verify" && req.method === "POST") {
      return this.domainVerify(res, id);
    }
    if (parts.length === 2) {
      const record = this.domains.get(id);
      if (!record) return this.send(res, 404, resendError(404, "not_found", "Domain not found."));
      if (req.method === "GET") return this.send(res, 200, clone(record));
      if (req.method === "PATCH") return this.domainUpdate(res, record, body);
      if (req.method === "DELETE") {
        this.domains.delete(id);
        return this.send(res, 200, { object: "domain", id, deleted: true });
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
  }

  domainCreate(res, body) {
    if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
      return this.send(res, 422, resendError(422, "missing_required_field", "The request body is missing one or more required fields: name."));
    }
    const region = body.region || "us-east-1";
    if (!REGIONS.includes(region)) {
      return this.send(res, 422, resendError(422, "invalid_region", `Region must be ${REGIONS.map((r) => `"${r}"`).join(" | ")}.`));
    }
    const id = randomUUID();
    const sub = body.tracking_subdomain || "links";
    const dkimToken = () => randomUUID().replace(/-/g, "");
    const record = {
      object: "domain",
      id,
      name: body.name,
      created_at: now(),
      status: "not_started",
      open_tracking: Boolean(body.open_tracking),
      click_tracking: Boolean(body.click_tracking),
      tracking_subdomain: sub,
      capabilities: {
        sending: body.capabilities?.sending || "enabled",
        receiving: body.capabilities?.receiving || "disabled",
      },
      records: [
        { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "not_started", value: `feedback-smtp.${region}.amazonses.com`, priority: 10 },
        { record: "SPF", name: "send", value: '"v=spf1 include:amazonses.com ~all"', type: "TXT", ttl: "Auto", status: "not_started" },
        // Real Resend emits three DKIM CNAME records, each keyed by a random token.
        { record: "DKIM", name: `${dkimToken()}._domainkey`, value: `${dkimToken()}.dkim.amazonses.com.`, type: "CNAME", status: "not_started", ttl: "Auto" },
        { record: "DKIM", name: `${dkimToken()}._domainkey`, value: `${dkimToken()}.dkim.amazonses.com.`, type: "CNAME", status: "not_started", ttl: "Auto" },
        { record: "DKIM", name: `${dkimToken()}._domainkey`, value: `${dkimToken()}.dkim.amazonses.com.`, type: "CNAME", status: "not_started", ttl: "Auto" },
        // Tracking CNAME, present when a tracking subdomain is configured.
        { record: "Tracking", name: `${sub}.${body.name}`, type: "CNAME", value: "links1.resend-dns.com", ttl: "Auto", status: "not_started" },
      ],
      region,
    };
    this.domains.set(id, record);
    return this.send(res, 201, clone(record));
  }

  domainList(res) {
    const data = Array.from(this.domains.values()).map(clone);
    return this.send(res, 200, { object: "list", data });
  }

  domainUpdate(res, record, body) {
    if (isPlainObject(body)) {
      if (typeof body.open_tracking === "boolean") record.open_tracking = body.open_tracking;
      if (typeof body.click_tracking === "boolean") record.click_tracking = body.click_tracking;
      if (typeof body.tls === "string") record.tls = body.tls;
    }
    return this.send(res, 200, { object: "domain", id: record.id });
  }

  domainVerify(res, id) {
    const record = this.domains.get(id);
    if (!record) return this.send(res, 404, resendError(404, "not_found", "Domain not found."));
    record.status = "pending";
    return this.send(res, 200, { object: "domain", id });
  }

  // -------------------------------------------------------------------------
  // /api-keys
  // -------------------------------------------------------------------------
  routeApiKeys(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "POST") return this.apiKeyCreate(res, body);
      if (req.method === "GET") return this.apiKeyList(res);
      return this.methodNotAllowed(res);
    }
    if (parts.length === 2) {
      const id = parts[1];
      if (req.method === "DELETE") {
        if (!this.apiKeys.has(id)) {
          return this.send(res, 404, resendError(404, "not_found", "API key not found."));
        }
        this.apiKeys.delete(id);
        return this.send(res, 200, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
  }

  apiKeyCreate(res, body) {
    if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
      return this.send(res, 422, resendError(422, "missing_required_field", "The request body is missing one or more required fields: name."));
    }
    if (body.permission !== undefined && !["full_access", "sending_access"].includes(body.permission)) {
      return this.send(res, 422, resendError(422, "invalid_access", 'Access must be "full_access" | "sending_access".'));
    }
    const id = randomUUID();
    const token = `re_${randomUUID().replace(/-/g, "")}`;
    this.apiKeys.set(id, {
      id,
      name: body.name,
      permission: body.permission || "full_access",
      created_at: now(),
    });
    return this.send(res, 201, { id, object: "api_key", token });
  }

  apiKeyList(res) {
    const data = Array.from(this.apiKeys.values()).map((k) => ({
      id: k.id,
      name: k.name,
      created_at: k.created_at,
    }));
    return this.send(res, 200, { object: "list", data });
  }

  // -------------------------------------------------------------------------
  // /audiences  (+ nested contacts)
  // -------------------------------------------------------------------------
  routeAudiences(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "POST") return this.audienceCreate(res, body);
      if (req.method === "GET") return this.audienceList(res);
      return this.methodNotAllowed(res);
    }

    const audienceId = parts[1];

    // Nested contacts: /audiences/:aid/contacts...
    if (parts.length >= 3 && parts[2] === "contacts") {
      return this.routeContacts(req, res, parts, body, audienceId, url);
    }

    if (parts.length === 2) {
      const record = this.audiences.get(audienceId);
      if (req.method === "GET") {
        if (!record) return this.send(res, 404, resendError(404, "not_found", "Audience not found."));
        return this.send(res, 200, clone(record));
      }
      if (req.method === "DELETE") {
        if (!record) return this.send(res, 404, resendError(404, "not_found", "Audience not found."));
        this.audiences.delete(audienceId);
        this.contacts.delete(audienceId);
        return this.send(res, 200, { object: "audience", id: audienceId, deleted: true });
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
  }

  audienceCreate(res, body) {
    if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
      return this.send(res, 422, resendError(422, "missing_required_field", "The request body is missing one or more required fields: name."));
    }
    const id = randomUUID();
    const record = { object: "audience", id, name: body.name, created_at: now() };
    this.audiences.set(id, record);
    this.contacts.set(id, new Map());
    return this.send(res, 201, { object: "audience", id, name: body.name });
  }

  audienceList(res) {
    const data = Array.from(this.audiences.values()).map((a) => ({
      id: a.id,
      name: a.name,
      created_at: a.created_at,
    }));
    return this.send(res, 200, { object: "list", data });
  }

  // -------------------------------------------------------------------------
  // /audiences/:aid/contacts
  // -------------------------------------------------------------------------
  routeContacts(req, res, parts, body, audienceId, url) {
    if (!this.audiences.has(audienceId)) {
      return this.send(res, 404, resendError(404, "not_found", "Audience not found."));
    }
    if (!this.contacts.has(audienceId)) this.contacts.set(audienceId, new Map());
    const bucket = this.contacts.get(audienceId);

    // /audiences/:aid/contacts
    if (parts.length === 3) {
      if (req.method === "POST") return this.contactCreate(res, bucket, audienceId, body);
      if (req.method === "GET") return this.contactList(res, bucket);
      return this.methodNotAllowed(res);
    }

    // /audiences/:aid/contacts/:idOrEmail
    if (parts.length === 4) {
      const key = parts[3];
      const contact = this._findContact(bucket, key);
      if (req.method === "GET") {
        if (!contact) return this.send(res, 404, resendError(404, "not_found", "Contact not found."));
        return this.send(res, 200, this._contactView(contact));
      }
      if (req.method === "PATCH") {
        if (!contact) return this.send(res, 404, resendError(404, "not_found", "Contact not found."));
        if (isPlainObject(body)) {
          if (typeof body.first_name === "string" || typeof body.firstName === "string") {
            contact.first_name = body.first_name ?? body.firstName;
          }
          if (typeof body.last_name === "string" || typeof body.lastName === "string") {
            contact.last_name = body.last_name ?? body.lastName;
          }
          if (typeof body.unsubscribed === "boolean") contact.unsubscribed = body.unsubscribed;
        }
        return this.send(res, 200, { object: "contact", id: contact.id });
      }
      if (req.method === "DELETE") {
        if (!contact) return this.send(res, 404, resendError(404, "not_found", "Contact not found."));
        bucket.delete(contact.id);
        return this.send(res, 200, { object: "contact", id: contact.id, deleted: true, contact: contact.id });
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
  }

  _findContact(bucket, key) {
    if (bucket.has(key)) return bucket.get(key);
    // Allow lookup/delete by email.
    for (const contact of bucket.values()) {
      if (contact.email === key) return contact;
    }
    return null;
  }

  // Public contact shape: strip the parlel-internal `_audience_id` so the
  // response matches the real Resend `GET /contacts/:id` body.
  _contactView(contact) {
    const view = clone(contact);
    delete view._audience_id;
    return view;
  }

  contactCreate(res, bucket, audienceId, body) {
    if (!isPlainObject(body) || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
      return this.send(res, 422, resendError(422, "missing_required_field", "The request body is missing one or more required fields: email."));
    }
    const id = randomUUID();
    const record = {
      object: "contact",
      id,
      email: body.email,
      first_name: body.first_name ?? body.firstName ?? "",
      last_name: body.last_name ?? body.lastName ?? "",
      created_at: now(),
      unsubscribed: Boolean(body.unsubscribed),
      properties: isPlainObject(body.properties) ? clone(body.properties) : {},
      // parlel inspection extra — not part of the public contact shape.
      _audience_id: audienceId,
    };
    bucket.set(id, record);
    return this.send(res, 201, { object: "contact", id });
  }

  contactList(res, bucket) {
    const data = Array.from(bucket.values()).map((c) => ({
      id: c.id,
      email: c.email,
      first_name: c.first_name,
      last_name: c.last_name,
      created_at: c.created_at,
      unsubscribed: c.unsubscribed,
    }));
    return this.send(res, 200, { object: "list", has_more: false, data });
  }

  // -------------------------------------------------------------------------
  // /broadcasts
  // -------------------------------------------------------------------------
  routeBroadcasts(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "POST") return this.broadcastCreate(res, body);
      if (req.method === "GET") return this.broadcastList(res);
      return this.methodNotAllowed(res);
    }
    const id = parts[1];
    // POST /broadcasts/:id/send
    if (parts.length === 3 && parts[2] === "send" && req.method === "POST") {
      return this.broadcastSend(res, id, body);
    }
    if (parts.length === 2) {
      const record = this.broadcasts.get(id);
      if (req.method === "GET") {
        if (!record) return this.send(res, 404, resendError(404, "not_found", "Broadcast not found."));
        return this.send(res, 200, clone(record));
      }
      if (req.method === "PATCH") {
        if (!record) return this.send(res, 404, resendError(404, "not_found", "Broadcast not found."));
        if (isPlainObject(body)) {
          for (const key of ["name", "subject", "from", "html", "text"]) {
            if (typeof body[key] === "string") record[key] = body[key];
          }
        }
        return this.send(res, 200, { id });
      }
      if (req.method === "DELETE") {
        if (!record) return this.send(res, 404, resendError(404, "not_found", "Broadcast not found."));
        if (record.status === "sent") {
          return this.send(res, 400, resendError(400, "validation_error", "Cannot delete a broadcast that has already been sent."));
        }
        this.broadcasts.delete(id);
        return this.send(res, 200, { object: "broadcast", id, deleted: true });
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
  }

  broadcastCreate(res, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 422, resendError(422, "missing_required_field", "The request body is missing one or more required fields."));
    }
    const missing = [];
    if (!body.from) missing.push("from");
    if (!body.subject) missing.push("subject");
    if (missing.length > 0) {
      return this.send(res, 422, resendError(422, "missing_required_field", `The request body is missing one or more required fields: ${missing.join(", ")}.`));
    }
    if (!isValidFrom(body.from)) {
      return this.send(res, 422, resendError(422, "invalid_from_address", "Invalid `from` field."));
    }
    const scheduledAt = body.scheduled_at ?? body.scheduledAt ?? null;
    if (scheduledAt && !(body.send === true)) {
      return this.send(res, 400, resendError(400, "validation_error", "`scheduled_at` requires `send` to be set to `true`."));
    }
    const id = randomUUID();
    const sendNow = body.send === true;
    const record = {
      object: "broadcast",
      id,
      name: body.name || null,
      audience_id: body.audience_id ?? body.audienceId ?? body.segment_id ?? body.segmentId ?? null,
      from: body.from,
      subject: body.subject,
      reply_to: toArray(body.reply_to ?? body.replyTo),
      preview_text: body.preview_text ?? body.previewText ?? null,
      html: typeof body.html === "string" ? body.html : null,
      text: typeof body.text === "string" ? body.text : null,
      status: sendNow ? (scheduledAt ? "queued" : "sent") : "draft",
      created_at: now(),
      scheduled_at: scheduledAt,
      sent_at: sendNow && !scheduledAt ? now() : null,
    };
    this.broadcasts.set(id, record);
    return this.send(res, 201, { id });
  }

  broadcastList(res) {
    const data = Array.from(this.broadcasts.values()).map((b) => ({
      id: b.id,
      audience_id: b.audience_id,
      status: b.status,
      created_at: b.created_at,
      scheduled_at: b.scheduled_at,
      sent_at: b.sent_at,
      name: b.name,
    }));
    return this.send(res, 200, { object: "list", data });
  }

  broadcastSend(res, id, body) {
    const record = this.broadcasts.get(id);
    if (!record) return this.send(res, 404, resendError(404, "not_found", "Broadcast not found."));
    const scheduledAt = isPlainObject(body) ? (body.scheduled_at ?? body.scheduledAt ?? null) : null;
    if (scheduledAt) {
      record.status = "queued";
      record.scheduled_at = scheduledAt;
    } else {
      record.status = "sent";
      record.sent_at = now();
    }
    return this.send(res, 200, { id });
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection endpoints (not part of Resend).
  // -------------------------------------------------------------------------
  handleControl(req, res, parts, body, url) {
    // POST /__parlel/reset
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    // GET /__parlel/emails — all captured emails (full request preserved).
    if (req.method === "GET" && parts[1] === "emails" && parts.length === 2) {
      const messages = this.emailOrder.map((id) => clone(this.emails.get(id)));
      return this.send(res, 200, { emails: messages, count: messages.length });
    }
    // GET /__parlel/emails/:id
    if (req.method === "GET" && parts[1] === "emails" && parts.length === 3) {
      const record = this.emails.get(parts[2]);
      if (!record) return this.send(res, 404, resendError(404, "not_found", "Email not found."));
      return this.send(res, 200, clone(record));
    }
    // DELETE /__parlel/emails — clear only the captured mailbox.
    if (req.method === "DELETE" && parts[1] === "emails") {
      this.emails = new Map();
      this.emailOrder = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
  }

  root() {
    return {
      name: "resend",
      version: "1.0",
      protocol: "resend-rest",
      documentation: "/docs/resend.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  notFoundOrMethod(res, method) {
    if (["POST", "GET", "PATCH", "PUT", "DELETE"].includes(method)) {
      return this.send(res, 404, resendError(404, "not_found", "The requested endpoint does not exist."));
    }
    return this.methodNotAllowed(res);
  }

  methodNotAllowed(res) {
    return this.send(res, 405, resendError(405, "method_not_allowed", "Method is not allowed for the requested path."));
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
          this.send(res, 400, resendError(400, "validation_error", "We found an error with the request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, resendError(400, "validation_error", "We found an error with the request body."));
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
