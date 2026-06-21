import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/front — a tiny, dependency-free fake of the Front API.
//
// Wire conventions replicated:
//   * Bearer (API token) auth.
//   * Resource shape: { _links: { self, related }, id, ... }.
//   * List shape:     { _pagination: { next }, _links: { self }, _results: [...] }.
//   * Prefixed ids: cnv_ (conversation), crd_ (contact), msg_ (message),
//     cha_ (channel).
//   * Endpoints: /conversations (+/:id), /contacts, POST /channels/:id/messages,
//     POST /conversations/:id/messages.
//   * Error envelope: { _error: { status, title, message } }.
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function frontId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function frError(status, title, message) {
  return { _error: { status, title, message } };
}

export class FrontServer {
  constructor(port = 4785, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.conversations = new Map();
    this.contacts = new Map();
    this.messages = new Map();
    this.channels = new Map();
    this._seedChannels();
  }

  _seedChannels() {
    const id = "cha_parlel";
    this.channels.set(id, {
      _links: { self: `${this._base()}/channels/${id}` },
      id,
      name: "Parlel Inbox",
      address: "support@parlel.dev",
      type: "smtp",
      send_as: "support@parlel.dev",
    });
  }

  _base() {
    return `http://${this.host}:${this.port}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, frError(500, "internal_error", error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-front");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, frError(401, "unauthorized", "No valid API credentials were provided."));
    }

    if (parts[0] === "conversations") return this.handleConversations(req, res, parts, body);
    if (parts[0] === "contacts") return this.handleContacts(req, res, parts, body);
    if (parts[0] === "channels") return this.handleChannels(req, res, parts, body);

    return this.send(res, 404, frError(404, "not_found", "not found"));
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------
  handleConversations(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.listConversations(res);
      if (req.method === "POST") return this.createConversation(res, body);
      return this.send(res, 405, frError(405, "method_not_allowed", "method not allowed"));
    }

    if (parts.length === 2) {
      const id = parts[1];
      const conv = this.conversations.get(id);
      if (req.method === "GET") {
        if (!conv) return this.send(res, 404, frError(404, "not_found", "Conversation not found"));
        return this.send(res, 200, clone(conv));
      }
      if (req.method === "PATCH") {
        if (!conv) return this.send(res, 404, frError(404, "not_found", "Conversation not found"));
        Object.assign(conv, isPlainObject(body) ? clone(body) : {});
        conv.id = id;
        return this.send(res, 204, null);
      }
      return this.send(res, 405, frError(405, "method_not_allowed", "method not allowed"));
    }

    // POST /conversations/:id/messages
    if (parts.length === 3 && parts[2] === "messages") {
      if (req.method !== "POST") return this.send(res, 405, frError(405, "method_not_allowed", "method not allowed"));
      const conv = this.conversations.get(parts[1]);
      if (!conv) return this.send(res, 404, frError(404, "not_found", "Conversation not found"));
      const message = this._createMessage(body, parts[1]);
      return this.send(res, 202, clone(message));
    }

    return this.send(res, 404, frError(404, "not_found", "not found"));
  }

  createConversation(res, body) {
    if (!isPlainObject(body)) return this.send(res, 400, frError(400, "bad_request", "Invalid body"));
    const id = frontId("cnv");
    const ts = nowUnix();
    const conv = {
      _links: { self: `${this._base()}/conversations/${id}`, related: {} },
      id,
      subject: body.subject || "",
      status: body.status || "unassigned",
      created_at: ts,
      is_private: false,
      ...clone(body),
    };
    conv.id = id;
    this.conversations.set(id, conv);
    return this.send(res, 201, clone(conv));
  }

  listConversations(res) {
    const results = Array.from(this.conversations.values()).map(clone);
    return this.send(res, 200, {
      _pagination: { next: null },
      _links: { self: `${this._base()}/conversations` },
      _results: results,
    });
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------
  handleContacts(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        const results = Array.from(this.contacts.values()).map(clone);
        return this.send(res, 200, {
          _pagination: { next: null },
          _links: { self: `${this._base()}/contacts` },
          _results: results,
        });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body)) return this.send(res, 400, frError(400, "bad_request", "Invalid body"));
        const id = frontId("crd");
        const contact = {
          _links: { self: `${this._base()}/contacts/${id}` },
          id,
          name: body.name || null,
          handles: Array.isArray(body.handles) ? clone(body.handles) : [],
          ...clone(body),
        };
        contact.id = id;
        this.contacts.set(id, contact);
        return this.send(res, 201, clone(contact));
      }
      return this.send(res, 405, frError(405, "method_not_allowed", "method not allowed"));
    }

    if (parts.length === 2) {
      const id = parts[1];
      const contact = this.contacts.get(id);
      if (req.method === "GET") {
        if (!contact) return this.send(res, 404, frError(404, "not_found", "Contact not found"));
        return this.send(res, 200, clone(contact));
      }
      if (req.method === "PATCH") {
        if (!contact) return this.send(res, 404, frError(404, "not_found", "Contact not found"));
        Object.assign(contact, isPlainObject(body) ? clone(body) : {});
        contact.id = id;
        return this.send(res, 204, null);
      }
      if (req.method === "DELETE") {
        if (!contact) return this.send(res, 404, frError(404, "not_found", "Contact not found"));
        this.contacts.delete(id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, frError(405, "method_not_allowed", "method not allowed"));
    }

    return this.send(res, 404, frError(404, "not_found", "not found"));
  }

  // -------------------------------------------------------------------------
  // Channels  (POST /channels/:id/messages)
  // -------------------------------------------------------------------------
  handleChannels(req, res, parts, body) {
    if (parts.length === 3 && parts[2] === "messages" && req.method === "POST") {
      const channelId = parts[1];
      if (!this.channels.has(channelId)) {
        return this.send(res, 404, frError(404, "not_found", "Channel not found"));
      }
      // Outbound message creates a new conversation.
      const convId = frontId("cnv");
      const ts = nowUnix();
      const conv = {
        _links: { self: `${this._base()}/conversations/${convId}` },
        id: convId,
        subject: isPlainObject(body) ? body.subject || "" : "",
        status: "assigned",
        created_at: ts,
      };
      this.conversations.set(convId, conv);
      const message = this._createMessage(body, convId);
      return this.send(res, 202, { ...clone(message), conversation_reference: convId });
    }
    return this.send(res, 404, frError(404, "not_found", "not found"));
  }

  _createMessage(body, conversationId) {
    const id = frontId("msg");
    const ts = nowUnix();
    const message = {
      _links: { self: `${this._base()}/messages/${id}`, related: { conversation: `${this._base()}/conversations/${conversationId}` } },
      id,
      type: "email",
      is_inbound: false,
      created_at: ts,
      blurb: isPlainObject(body) ? (body.body || body.text || "") : "",
      body: isPlainObject(body) ? (body.body || "") : "",
    };
    this.messages.set(id, message);
    return message;
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, frError(404, "not_found", "not found"));
  }

  root() {
    return { name: "front", version: "1", protocol: "front-api", documentation: "/docs/front.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
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
          this.send(res, 400, frError(400, "bad_request", "Invalid JSON"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, frError(400, "bad_request", "Invalid JSON"));
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
