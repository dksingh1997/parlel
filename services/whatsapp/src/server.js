import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/whatsapp — a tiny, dependency-free fake of the WhatsApp Cloud API.
//
// It speaks the exact wire protocol that application code using `axios` talks
// to against the Meta Graph API (https://graph.facebook.com/<version>/...):
//
//   * Bearer-token auth: `Authorization: Bearer <ACCESS_TOKEN>`.
//   * application/json request bodies for messaging endpoints.
//   * multipart/form-data (best-effort) for media upload.
//   * JSON responses with the Cloud API envelopes:
//       - send message -> { messaging_product, contacts:[...], messages:[{id}] }
//       - media upload -> { id }
//       - media fetch  -> { messaging_product, url, mime_type, sha256,
//                           file_size, id }
//   * Graph-style error envelope on failure:
//       { error: { message, type, code, error_subcode, fbtrace_id,
//                  error_data:{ messaging_product, details } } }
//
// Routes (Graph API resource tree, version prefix is optional/loose):
//   POST   /<version>/<PHONE_NUMBER_ID>/messages          send / mark-read / typing
//   POST   /<version>/<PHONE_NUMBER_ID>/media             upload media
//   GET    /<version>/<MEDIA_ID>                          retrieve media metadata/url
//   DELETE /<version>/<MEDIA_ID>                          delete media
//   GET    /<version>/<PHONE_NUMBER_ID>                   phone number info
//   GET    /<version>/<PHONE_NUMBER_ID>/whatsapp_business_profile   get profile
//   POST   /<version>/<PHONE_NUMBER_ID>/whatsapp_business_profile   update profile
//   POST   /<version>/<PHONE_NUMBER_ID>/register          register number
//   POST   /<version>/<PHONE_NUMBER_ID>/deregister        deregister number
//   POST   /<version>/<PHONE_NUMBER_ID>/request_code      request verification code
//   POST   /<version>/<PHONE_NUMBER_ID>/verify_code       verify code
//   GET    /<version>/<WABA_ID>/phone_numbers             list phone numbers
//   GET    /<version>/<WABA_ID>/message_templates         list templates
//   POST   /<version>/<WABA_ID>/message_templates         create template
//   DELETE /<version>/<WABA_ID>/message_templates         delete template
//   GET    /<version>/<WABA_ID>                           WABA info
//   GET    /<webhook path> (hub.mode=subscribe)           webhook verification
//   GET    /__media/<MEDIA_ID>                            download media binary
//
// Plus parlel control/inspection endpoints under /__parlel and helpers that
// let tests inspect everything the integration sent and inject inbound
// webhook events (incoming messages, status callbacks). State is in-memory
// and ephemeral; the whole world is resettable. Zero cost, zero side effects.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_BODY = Symbol("bad-body");

const GRAPH_VERSION_RE = /^v\d+\.\d+$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

// Graph API error envelope. WhatsApp Cloud API enriches `error_data` with a
// `messaging_product` field for messaging endpoints.
function graphError(httpStatus, message, code, options = {}) {
  const error = {
    message,
    type: options.type || "OAuthException",
    code,
    fbtrace_id: randomBytes(8).toString("base64url"),
  };
  if (options.error_subcode !== undefined) error.error_subcode = options.error_subcode;
  if (options.error_data) error.error_data = options.error_data;
  if (options.details) {
    error.error_data = {
      messaging_product: "whatsapp",
      details: options.details,
    };
  }
  return { status: httpStatus, body: { error } };
}

export class WhatsappServer {
  constructor(port = 4657, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.accessToken = options.accessToken || "parlel-test-access-token";
    this.phoneNumberId = options.phoneNumberId || "100000000000001";
    this.businessAccountId = options.businessAccountId || "200000000000001";
    this.apiVersion = options.apiVersion || "v21.0";
    this.verifyToken = options.verifyToken || "parlel-verify-token";
    this.displayPhoneNumber = options.displayPhoneNumber || "+1 555 010 0001";
    this.server = null;
    this.reset();
  }

  reset() {
    this._msgCounter = 1;
    this._mediaCounter = 1;
    this._templateCounter = 1;

    // Everything the integration sent through /messages (for inspection).
    this.sentMessages = []; // [{ id, to, type, payload, status, timestamp }]
    this.messagesById = new Map(); // wamid -> message record
    // Read receipts the integration acknowledged.
    this.readReceipts = [];
    // Typing indicators sent.
    this.typingIndicators = [];

    // Uploaded media: id -> record.
    this.media = new Map();

    // Inbound webhook events queued for inspection (tests inject these).
    this.inboundEvents = [];

    // Business profile.
    this.businessProfile = {
      messaging_product: "whatsapp",
      about: "parlel test business",
      address: "123 Parlel St",
      description: "A parlel fake WhatsApp business",
      email: "hello@parlel.test",
      profile_picture_url: "",
      websites: ["https://parlel.test"],
      vertical: "PROF_SERVICES",
    };

    // Registration / verification state.
    this.registered = true;
    this.verificationRequested = false;
    this.verificationCode = "123456";

    // Phone numbers attached to the WABA.
    this.phoneNumbers = new Map();
    this.phoneNumbers.set(this.phoneNumberId, {
      id: this.phoneNumberId,
      display_phone_number: this.displayPhoneNumber,
      verified_name: "Parlel Test Business",
      quality_rating: "GREEN",
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      throughput: { level: "STANDARD" },
    });

    // Message templates: name -> record.
    this.templates = new Map();
    this._seedTemplates();
  }

  _seedTemplates() {
    const id = `${this._templateCounter++}000000000000001`;
    this.templates.set("hello_world", {
      id,
      name: "hello_world",
      language: "en_US",
      status: "APPROVED",
      category: "UTILITY",
      components: [
        { type: "BODY", text: "Hello World" },
      ],
    });
  }

  _nextWamid() {
    const raw = `parlel.${Date.now()}.${this._msgCounter++}.${randomBytes(6).toString("hex")}`;
    return "wamid." + Buffer.from(raw).toString("base64");
  }

  _nextMediaId() {
    return `${Date.now()}${String(this._mediaCounter++).padStart(6, "0")}`;
  }

  _absUrl(path) {
    return `http://${this.host}:${this.port}${path}`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(
            res,
            500,
            graphError(500, error.message || "Internal server error", 1, { type: "GraphMethodException" }).body,
          );
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

  // -------------------------------------------------------------------------
  // HTTP entry
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const query = url.searchParams;
    const parsed = await this.readBody(req, res);
    if (parsed === SENTINEL_BAD_BODY) return; // response already sent

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-whatsapp");
    res.setHeader("facebook-api-version", this.apiVersion);

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Infra endpoints (no auth).
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    // parlel control / inspection (not part of WhatsApp).
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, parsed, query);

    // Media binary download: /__media/<id>
    if (parts[0] === "__media" && parts[1]) {
      return this.handleMediaDownload(req, res, parts[1]);
    }

    // Webhook verification handshake (GET with hub.mode=subscribe). This is
    // unauthenticated and identified by the hub.* query params.
    if (req.method === "GET" && query.get("hub.mode")) {
      return this.handleWebhookVerify(res, query);
    }

    // Strip an optional leading version segment (v21.0 etc.).
    let route = parts;
    if (route[0] && GRAPH_VERSION_RE.test(route[0])) route = route.slice(1);

    if (route.length === 0) {
      return this.send(res, 404, graphError(404, "Unknown path", 2500).body);
    }

    // Everything below requires a bearer token.
    if (!this.isAuthorized(req)) {
      return this.send(
        res,
        401,
        graphError(401, "Invalid OAuth access token - Cannot parse access token", 190, {
          type: "OAuthException",
        }).body,
      );
    }

    const body = isPlainObject(parsed.body) ? parsed.body : {};
    const id = route[0];
    const sub = route[1];

    // --- Resource: by phone-number-id ---
    if (id === this.phoneNumberId || this.phoneNumbers.has(id)) {
      if (!sub) {
        if (req.method === "GET") return this.getPhoneNumber(res, id, query);
        return this.send(res, 405, this._405());
      }
      if (sub === "messages" && req.method === "POST") {
        return this.handleMessages(res, body, id);
      }
      if (sub === "media" && req.method === "POST") {
        return this.uploadMedia(res, parsed, id);
      }
      if (sub === "whatsapp_business_profile") {
        if (req.method === "GET") return this.getBusinessProfile(res, query);
        if (req.method === "POST") return this.updateBusinessProfile(res, body);
        return this.send(res, 405, this._405());
      }
      if (sub === "register" && req.method === "POST") {
        return this.registerNumber(res, body);
      }
      if (sub === "deregister" && req.method === "POST") {
        return this.deregisterNumber(res);
      }
      if (sub === "request_code" && req.method === "POST") {
        return this.requestCode(res, body);
      }
      if (sub === "verify_code" && req.method === "POST") {
        return this.verifyCode(res, body);
      }
      return this.send(res, 404, graphError(404, `Unsupported get request on ${id}/${sub}`, 100).body);
    }

    // --- Resource: by WABA id ---
    if (id === this.businessAccountId) {
      if (!sub && req.method === "GET") return this.getWaba(res, query);
      if (sub === "phone_numbers" && req.method === "GET") {
        return this.listPhoneNumbers(res, query);
      }
      if (sub === "message_templates") {
        if (req.method === "GET") return this.listTemplates(res, query);
        if (req.method === "POST") return this.createTemplate(res, body);
        if (req.method === "DELETE") return this.deleteTemplate(res, query, body);
        return this.send(res, 405, this._405());
      }
      return this.send(res, 404, graphError(404, `Unsupported request on ${id}/${sub || ""}`, 100).body);
    }

    // --- Resource: by media id ---
    if (this.media.has(id) && !sub) {
      if (req.method === "GET") return this.getMedia(res, id);
      if (req.method === "DELETE") return this.deleteMedia(res, id);
      return this.send(res, 405, this._405());
    }

    // Unknown id: WhatsApp returns code 100 (invalid object / does not exist).
    return this.send(
      res,
      404,
      graphError(404, `Unsupported get request. Object with ID '${id}' does not exist`, 100, {
        type: "GraphMethodException",
        error_subcode: 33,
      }).body,
    );
  }

  // -------------------------------------------------------------------------
  // POST /<PHONE_NUMBER_ID>/messages
  // -------------------------------------------------------------------------
  handleMessages(res, body, phoneNumberId) {
    if (body.messaging_product !== "whatsapp") {
      return this.send(
        res,
        400,
        graphError(400, "(#100) Param messaging_product must be set to 'whatsapp'", 100, {
          type: "GraphMethodException",
          details: "messaging_product is required and must be 'whatsapp'",
        }).body,
      );
    }

    // status=read marks an inbound message as read (and optionally sends a
    // typing indicator). It does NOT require `to`.
    if (body.status === "read") {
      if (!body.message_id) {
        return this.send(
          res,
          400,
          graphError(400, "(#100) The parameter message_id is required.", 100, {
            details: "message_id is required when status=read",
          }).body,
        );
      }
      this.readReceipts.push({ message_id: body.message_id, at: nowUnix() });
      if (body.typing_indicator && body.typing_indicator.type) {
        this.typingIndicators.push({
          message_id: body.message_id,
          type: body.typing_indicator.type,
          at: nowUnix(),
        });
      }
      return this.send(res, 200, { success: true });
    }

    // Sending a message.
    const to = body.to;
    if (!to || typeof to !== "string") {
      return this.send(
        res,
        400,
        graphError(400, "(#100) The parameter to is required.", 100, {
          details: "to is required",
        }).body,
      );
    }

    const type = body.type || "text";
    const SUPPORTED = [
      "text",
      "template",
      "image",
      "audio",
      "video",
      "document",
      "sticker",
      "location",
      "contacts",
      "interactive",
      "reaction",
    ];
    if (!SUPPORTED.includes(type)) {
      return this.send(
        res,
        400,
        graphError(400, `(#100) Invalid message type: ${type}`, 100, {
          details: `Unsupported message type '${type}'`,
        }).body,
      );
    }

    // Type-specific validation that mirrors the real API's required fields.
    const validationError = this._validateMessage(type, body);
    if (validationError) {
      return this.send(res, validationError.status, validationError.body);
    }

    const wamid = this._nextWamid();
    const record = {
      id: wamid,
      messaging_product: "whatsapp",
      to,
      type,
      payload: clone(body),
      status: "accepted",
      message_status: "accepted",
      timestamp: nowUnix(),
      context: body.context ? clone(body.context) : undefined,
    };
    this.sentMessages.push(record);
    this.messagesById.set(wamid, record);

    // The Cloud API send envelope.
    const responseBody = {
      messaging_product: "whatsapp",
      contacts: [
        {
          input: to,
          wa_id: to.replace(/[^\d]/g, ""),
        },
      ],
      messages: [
        {
          id: wamid,
          // For some types (e.g. template / interactive) the API echoes a
          // message_status of "accepted".
          message_status: "accepted",
        },
      ],
    };
    return this.send(res, 200, responseBody);
  }

  _validateMessage(type, body) {
    const need = (cond, msg, details) => {
      if (!cond) return graphError(400, msg, 100, { details: details || msg });
      return null;
    };
    switch (type) {
      case "text":
        return need(
          isPlainObject(body.text) && typeof body.text.body === "string" && body.text.body.length > 0,
          "(#100) The parameter text['body'] is required.",
          "text.body is required and must be a non-empty string",
        );
      case "template": {
        if (!isPlainObject(body.template)) {
          return graphError(400, "(#100) The parameter template is required.", 100, {
            details: "template object is required",
          });
        }
        if (!body.template.name) {
          return graphError(400, "(#100) The parameter template['name'] is required.", 100, {
            details: "template.name is required",
          });
        }
        if (!isPlainObject(body.template.language) || !body.template.language.code) {
          return graphError(400, "(#100) The parameter template['language'] is required.", 100, {
            details: "template.language.code is required",
          });
        }
        // Template must exist & be approved.
        const tpl = this.templates.get(body.template.name);
        if (!tpl) {
          return graphError(
            404,
            `(#132001) Template name does not exist in the translation`,
            132001,
            { details: `Template "${body.template.name}" does not exist` },
          );
        }
        return null;
      }
      case "image":
      case "audio":
      case "video":
      case "document":
      case "sticker":
        if (!isPlainObject(body[type])) {
          return graphError(400, `(#100) The parameter ${type} is required.`, 100, {
            details: `${type} object is required`,
          });
        }
        if (!body[type].id && !body[type].link) {
          return graphError(400, `(#100) ${type} requires id or link.`, 100, {
            details: `${type}.id or ${type}.link is required`,
          });
        }
        return null;
      case "location":
        if (
          !isPlainObject(body.location) ||
          body.location.latitude === undefined ||
          body.location.longitude === undefined
        ) {
          return graphError(400, "(#100) The parameter location requires latitude and longitude.", 100, {
            details: "location.latitude and location.longitude are required",
          });
        }
        return null;
      case "contacts":
        if (!Array.isArray(body.contacts) || body.contacts.length === 0) {
          return graphError(400, "(#100) The parameter contacts must be a non-empty array.", 100, {
            details: "contacts must be a non-empty array",
          });
        }
        return null;
      case "interactive":
        if (!isPlainObject(body.interactive) || !body.interactive.type) {
          return graphError(400, "(#100) The parameter interactive['type'] is required.", 100, {
            details: "interactive.type is required",
          });
        }
        return null;
      case "reaction":
        if (!isPlainObject(body.reaction) || !body.reaction.message_id) {
          return graphError(400, "(#100) The parameter reaction['message_id'] is required.", 100, {
            details: "reaction.message_id is required",
          });
        }
        return null;
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Media: upload / retrieve / delete / download
  // -------------------------------------------------------------------------
  uploadMedia(res, parsed, phoneNumberId) {
    // The real client sends multipart/form-data with messaging_product +
    // type + file. We accept JSON too, and best-effort parse multipart.
    const fields = parsed.fields || (isPlainObject(parsed.body) ? parsed.body : {});
    const messagingProduct = fields.messaging_product;
    if (messagingProduct !== "whatsapp") {
      return this.send(
        res,
        400,
        graphError(400, "(#100) Param messaging_product must be set to 'whatsapp'", 100, {
          details: "messaging_product is required and must be 'whatsapp'",
        }).body,
      );
    }
    const fileBuffer = parsed.fileBuffer;
    const mime = fields.type || (parsed.fileMime) || "application/octet-stream";
    const size = fileBuffer ? fileBuffer.length : Number(fields.file_size) || 1024;
    const data = fileBuffer || Buffer.from(`parlel-media-${this._mediaCounter}`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const id = this._nextMediaId();
    this.media.set(id, {
      id,
      mime_type: mime,
      sha256,
      file_size: size,
      messaging_product: "whatsapp",
      phone_number_id: phoneNumberId,
      filename: fields.filename || `parlel-media-${id}`,
      _data: data.toString("base64"),
    });
    return this.send(res, 200, { id });
  }

  getMedia(res, id) {
    const m = this.media.get(id);
    if (!m) {
      return this.send(
        res,
        404,
        graphError(404, `(#100) Object with ID '${id}' does not exist`, 100, {
          type: "GraphMethodException",
        }).body,
      );
    }
    return this.send(res, 200, {
      messaging_product: "whatsapp",
      url: this._absUrl(`/__media/${id}`),
      mime_type: m.mime_type,
      sha256: m.sha256,
      file_size: m.file_size,
      id: m.id,
    });
  }

  deleteMedia(res, id) {
    if (!this.media.has(id)) {
      return this.send(
        res,
        404,
        graphError(404, `(#100) Object with ID '${id}' does not exist`, 100).body,
      );
    }
    this.media.delete(id);
    return this.send(res, 200, { success: true });
  }

  handleMediaDownload(req, res, id) {
    const m = this.media.get(id);
    if (!m) {
      return this.send(res, 404, graphError(404, "Media not found", 100).body);
    }
    // The real download requires the bearer token too.
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, graphError(401, "Invalid OAuth access token", 190).body);
    }
    const buf = Buffer.from(m._data, "base64");
    res.setHeader("Content-Type", m.mime_type);
    res.statusCode = 200;
    res.end(buf);
  }

  // -------------------------------------------------------------------------
  // Phone number / WABA / profile
  // -------------------------------------------------------------------------
  getPhoneNumber(res, id, query) {
    const pn = this.phoneNumbers.get(id);
    if (!pn) {
      return this.send(res, 404, graphError(404, `Object with ID '${id}' does not exist`, 100).body);
    }
    const fields = (query.get("fields") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (fields.length === 0) return this.send(res, 200, clone(pn));
    const out = { id: pn.id };
    for (const f of fields) if (pn[f] !== undefined) out[f] = clone(pn[f]);
    return this.send(res, 200, out);
  }

  listPhoneNumbers(res, query) {
    const data = Array.from(this.phoneNumbers.values()).map(clone);
    return this.send(res, 200, {
      data,
      paging: { cursors: { before: "before-cursor", after: "after-cursor" } },
    });
  }

  getWaba(res, query) {
    const fields = (query.get("fields") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const full = {
      id: this.businessAccountId,
      name: "Parlel Test WABA",
      currency: "USD",
      timezone_id: "1",
      message_template_namespace: "parlel_namespace",
      account_review_status: "APPROVED",
    };
    if (fields.length === 0) return this.send(res, 200, full);
    const out = { id: full.id };
    for (const f of fields) if (full[f] !== undefined) out[f] = full[f];
    return this.send(res, 200, out);
  }

  getBusinessProfile(res, query) {
    const fields = (query.get("fields") || "").split(",").map((s) => s.trim()).filter(Boolean);
    let profile = clone(this.businessProfile);
    if (fields.length > 0) {
      const filtered = { messaging_product: "whatsapp" };
      for (const f of fields) if (profile[f] !== undefined) filtered[f] = profile[f];
      profile = filtered;
    }
    return this.send(res, 200, { data: [profile] });
  }

  updateBusinessProfile(res, body) {
    if (body.messaging_product !== "whatsapp") {
      return this.send(
        res,
        400,
        graphError(400, "(#100) Param messaging_product must be set to 'whatsapp'", 100, {
          details: "messaging_product is required and must be 'whatsapp'",
        }).body,
      );
    }
    const editable = ["about", "address", "description", "email", "profile_picture_url", "websites", "vertical"];
    for (const key of editable) {
      if (body[key] !== undefined) this.businessProfile[key] = clone(body[key]);
    }
    return this.send(res, 200, { success: true });
  }

  registerNumber(res, body) {
    if (body.messaging_product !== "whatsapp") {
      return this.send(
        res,
        400,
        graphError(400, "(#100) Param messaging_product must be set to 'whatsapp'", 100, {
          details: "messaging_product is required and must be 'whatsapp'",
        }).body,
      );
    }
    if (!body.pin || !/^\d{6}$/.test(String(body.pin))) {
      return this.send(
        res,
        400,
        graphError(400, "(#100) The parameter pin must be a 6-digit number.", 100, {
          details: "pin is required and must be a 6-digit string",
        }).body,
      );
    }
    this.registered = true;
    return this.send(res, 200, { success: true });
  }

  deregisterNumber(res) {
    this.registered = false;
    return this.send(res, 200, { success: true });
  }

  requestCode(res, body) {
    const method = body.code_method;
    if (method !== "SMS" && method !== "VOICE") {
      return this.send(
        res,
        400,
        graphError(400, "(#100) The parameter code_method must be SMS or VOICE.", 100, {
          details: "code_method must be 'SMS' or 'VOICE'",
        }).body,
      );
    }
    this.verificationRequested = true;
    return this.send(res, 200, { success: true });
  }

  verifyCode(res, body) {
    if (!this.verificationRequested) {
      return this.send(
        res,
        400,
        graphError(400, "(#136025) Phone number verification code was not requested.", 136025, {
          details: "request_code must be called before verify_code",
        }).body,
      );
    }
    if (String(body.code) !== this.verificationCode) {
      return this.send(
        res,
        400,
        graphError(400, "(#136024) The verification code is incorrect.", 136024, {
          details: "The provided verification code does not match",
        }).body,
      );
    }
    this.verificationRequested = false;
    this.registered = true;
    return this.send(res, 200, { success: true });
  }

  // -------------------------------------------------------------------------
  // Message templates
  // -------------------------------------------------------------------------
  listTemplates(res, query) {
    const data = Array.from(this.templates.values()).map(clone);
    return this.send(res, 200, {
      data,
      paging: { cursors: { before: "before-cursor", after: "after-cursor" } },
    });
  }

  createTemplate(res, body) {
    if (!body.name || typeof body.name !== "string") {
      return this.send(
        res,
        400,
        graphError(400, "(#100) The parameter name is required.", 100, { details: "name is required" }).body,
      );
    }
    if (!body.category) {
      return this.send(
        res,
        400,
        graphError(400, "(#100) The parameter category is required.", 100, { details: "category is required" }).body,
      );
    }
    if (!body.language) {
      return this.send(
        res,
        400,
        graphError(400, "(#100) The parameter language is required.", 100, { details: "language is required" }).body,
      );
    }
    if (this.templates.has(body.name)) {
      return this.send(
        res,
        400,
        graphError(400, `(#100) A template named ${body.name} already exists.`, 100, {
          details: `Template "${body.name}" already exists`,
        }).body,
      );
    }
    const id = `${this._templateCounter++}000000000000001`;
    const record = {
      id,
      name: body.name,
      language: body.language,
      status: "PENDING",
      category: body.category,
      components: Array.isArray(body.components) ? clone(body.components) : [],
    };
    this.templates.set(body.name, record);
    return this.send(res, 200, { id, status: "PENDING", category: body.category });
  }

  deleteTemplate(res, query, body) {
    const name = query.get("name") || body.name;
    if (!name) {
      return this.send(
        res,
        400,
        graphError(400, "(#100) The parameter name is required.", 100, { details: "name is required" }).body,
      );
    }
    if (!this.templates.has(name)) {
      return this.send(
        res,
        404,
        graphError(404, `(#100) Template ${name} not found.`, 100, { details: `Template "${name}" not found` }).body,
      );
    }
    this.templates.delete(name);
    return this.send(res, 200, { success: true });
  }

  // -------------------------------------------------------------------------
  // Webhook verification (GET hub.challenge)
  // -------------------------------------------------------------------------
  handleWebhookVerify(res, query) {
    const mode = query.get("hub.mode");
    const token = query.get("hub.verify_token");
    const challenge = query.get("hub.challenge");
    if (mode === "subscribe" && token === this.verifyToken) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end(String(challenge ?? ""));
      return;
    }
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain");
    res.end("Forbidden");
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection endpoints (not part of WhatsApp)
  // -------------------------------------------------------------------------
  handleControl(req, res, parts, parsed, query) {
    const body = isPlainObject(parsed.body) ? parsed.body : {};
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "messages") {
      return this.send(res, 200, { messages: clone(this.sentMessages), count: this.sentMessages.length });
    }
    if (req.method === "GET" && parts[1] === "read-receipts") {
      return this.send(res, 200, { read_receipts: clone(this.readReceipts), count: this.readReceipts.length });
    }
    if (req.method === "GET" && parts[1] === "typing") {
      return this.send(res, 200, { typing: clone(this.typingIndicators), count: this.typingIndicators.length });
    }
    if (req.method === "GET" && parts[1] === "media") {
      const list = Array.from(this.media.values()).map((m) => {
        const { _data, ...rest } = m;
        return rest;
      });
      return this.send(res, 200, { media: list, count: list.length });
    }
    if (req.method === "GET" && parts[1] === "templates") {
      const list = Array.from(this.templates.values()).map(clone);
      return this.send(res, 200, { templates: list, count: list.length });
    }
    // Build a webhook event payload that mirrors what Meta posts to a
    // configured webhook. Tests can use this to drive inbound-message logic.
    if (req.method === "POST" && parts[1] === "inbound") {
      const event = this._buildInboundEvent(body);
      this.inboundEvents.push(event);
      return this.send(res, 200, { ok: true, event });
    }
    if (req.method === "GET" && parts[1] === "inbound") {
      return this.send(res, 200, { events: clone(this.inboundEvents), count: this.inboundEvents.length });
    }
    if (req.method === "POST" && parts[1] === "status") {
      const event = this._buildStatusEvent(body);
      this.inboundEvents.push(event);
      return this.send(res, 200, { ok: true, event });
    }
    return this.send(res, 404, graphError(404, "Unknown control endpoint", 2500).body);
  }

  _buildInboundEvent(body) {
    const from = body.from || "15551230000";
    const text = body.text || "hello from parlel";
    const wamid = this._nextWamid();
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: this.businessAccountId,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: this.displayPhoneNumber,
                  phone_number_id: this.phoneNumberId,
                },
                contacts: [{ profile: { name: body.name || "Test User" }, wa_id: from }],
                messages: [
                  {
                    from,
                    id: wamid,
                    timestamp: String(nowUnix()),
                    type: "text",
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  _buildStatusEvent(body) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: this.businessAccountId,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: this.displayPhoneNumber,
                  phone_number_id: this.phoneNumberId,
                },
                statuses: [
                  {
                    id: body.message_id || this._nextWamid(),
                    status: body.status || "delivered",
                    timestamp: String(nowUnix()),
                    recipient_id: body.recipient_id || "15551230000",
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  root() {
    return {
      name: "whatsapp",
      version: "1.0",
      protocol: "whatsapp-cloud-api",
      api_version: this.apiVersion,
      documentation: "/docs/whatsapp.md",
    };
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    const match = /^Bearer\s+(\S+)/i.exec(auth);
    if (!match) return false;
    return match[1] === this.accessToken;
  }

  // -------------------------------------------------------------------------
  // Body parsing
  // -------------------------------------------------------------------------
  readBody(req, res) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        if (raw.length === 0) {
          resolve({ body: {} });
          return;
        }
        const contentType = (req.headers["content-type"] || "").toLowerCase();
        try {
          if (contentType.includes("application/json")) {
            resolve({ body: JSON.parse(raw.toString("utf8")) });
          } else if (contentType.includes("application/x-www-form-urlencoded")) {
            resolve({ body: parseForm(raw.toString("utf8")) });
          } else if (contentType.includes("multipart/form-data")) {
            resolve(parseMultipart(raw, contentType));
          } else {
            // Best-effort: try JSON, then fall back to raw fields.
            const text = raw.toString("utf8").trim();
            if (text.startsWith("{") || text.startsWith("[")) {
              resolve({ body: JSON.parse(text) });
            } else {
              resolve({ body: {}, raw: text });
            }
          }
        } catch {
          this.send(res, 400, graphError(400, "Malformed request body", 100, { type: "GraphMethodException" }).body);
          resolve(SENTINEL_BAD_BODY);
        }
      });
      req.on("error", () => {
        this.send(res, 400, graphError(400, "Malformed request body", 100).body);
        resolve(SENTINEL_BAD_BODY);
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

  _405() {
    return graphError(405, "Method not allowed", 100, { type: "GraphMethodException" }).body;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseForm(data) {
  const params = new URLSearchParams(data);
  const out = {};
  for (const [key, value] of params.entries()) {
    if (key in out) {
      if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Best-effort multipart/form-data parser sufficient for media uploads
// (messaging_product, type, file). Not RFC-complete, but handles the shapes
// the WhatsApp media upload sends.
function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) return { body: {}, fields: {} };
  const boundary = "--" + (boundaryMatch[1] || boundaryMatch[2]).trim();
  const fields = {};
  let fileBuffer;
  let fileMime;

  const sep = Buffer.from(boundary);
  const parts = splitBuffer(buffer, sep);
  for (const part of parts) {
    // Skip the trailing "--" terminator part and strip a leading CRLF.
    let trimmed = part;
    if (trimmed.length >= 2 && trimmed[0] === 13 && trimmed[1] === 10) {
      trimmed = trimmed.slice(2);
    }
    // The final part after the closing boundary begins with "--".
    if (trimmed.length >= 2 && trimmed[0] === 45 && trimmed[1] === 45) continue;
    if (trimmed.length === 0) continue;
    const headerEnd = indexOfDouble(trimmed);
    if (headerEnd === -1) continue;
    const headerText = trimmed.slice(0, headerEnd).toString("utf8");
    let content = trimmed.slice(headerEnd + 4);
    // Drop a single trailing CRLF that precedes the next boundary.
    if (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10) {
      content = content.slice(0, content.length - 2);
    }
    const nameMatch = /name="([^"]+)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const name = nameMatch ? nameMatch[1] : undefined;
    if (fileMatch) {
      fileBuffer = content;
      if (ctMatch) fileMime = ctMatch[1].trim();
      if (name && !fields[name]) fields[name] = fileMatch[1];
    } else if (name) {
      fields[name] = content.toString("utf8");
    }
  }
  return { body: fields, fields, fileBuffer, fileMime };
}

function splitBuffer(buffer, sep) {
  const out = [];
  let start = 0;
  let idx;
  while ((idx = buffer.indexOf(sep, start)) !== -1) {
    out.push(buffer.slice(start, idx));
    start = idx + sep.length;
  }
  out.push(buffer.slice(start));
  return out;
}

function indexOfDouble(buf) {
  // Find \r\n\r\n.
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}
