import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/intercom — a tiny, dependency-free fake of the Intercom REST API.
//
// Wire conventions replicated:
//   * Bearer (access token) auth, Intercom-Version header honoured/echoed.
//   * Object shape: { type: "contact", id, ... }
//   * List shape:   { type: "list", data: [...], pages: { ... }, total_count }
//   * Endpoints: /contacts, /conversations, /messages, /contacts/search
//   * Error envelope: { type:"error.list", request_id, errors:[{code,message}] }
//   * IDs are 24-hex (Mongo-style ObjectId).
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

function objectId() {
  return randomBytes(12).toString("hex");
}

function icError(code, message, status = 400) {
  return { type: "error.list", request_id: randomBytes(16).toString("hex"), errors: [{ code, message }] };
}

export class IntercomServer {
  constructor(port = 4780, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.contacts = new Map();
    this.conversations = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, icError("internal_error", error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Intercom-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-intercom");
    res.setHeader("Intercom-Version", req.headers["intercom-version"] || "2.11");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, {
        type: "error.list",
        request_id: randomBytes(16).toString("hex"),
        errors: [{ code: "unauthorized", message: "Access Token Invalid" }],
      });
    }

    if (parts[0] === "contacts") return this.handleContacts(req, res, parts, body, url);
    if (parts[0] === "conversations") return this.handleConversations(req, res, parts, body, url);
    if (parts[0] === "messages") return this.handleMessages(req, res, parts, body);

    return this.send(res, 404, icError("not_found", "not found", 404));
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------
  handleContacts(req, res, parts, body, url) {
    // POST /contacts/search
    if (parts[1] === "search" && parts.length === 2) {
      if (req.method !== "POST") return this.send(res, 405, icError("method_not_allowed", "method not allowed", 405));
      return this.searchContacts(res, body);
    }

    if (parts.length === 1) {
      if (req.method === "GET") return this.listContacts(res);
      if (req.method === "POST") return this.createContact(res, body);
      return this.send(res, 405, icError("method_not_allowed", "method not allowed", 405));
    }

    if (parts.length === 2) {
      const id = parts[1];
      const contact = this.contacts.get(id);
      if (req.method === "GET") {
        if (!contact) return this.send(res, 404, icError("not_found", "Contact Not Found", 404));
        return this.send(res, 200, clone(contact));
      }
      if (req.method === "PUT") {
        if (!contact) return this.send(res, 404, icError("not_found", "Contact Not Found", 404));
        Object.assign(contact, isPlainObject(body) ? clone(body) : {});
        contact.type = "contact";
        contact.id = id;
        contact.updated_at = nowUnix();
        return this.send(res, 200, clone(contact));
      }
      if (req.method === "DELETE") {
        if (!contact) return this.send(res, 404, icError("not_found", "Contact Not Found", 404));
        this.contacts.delete(id);
        return this.send(res, 200, { type: "contact", id, deleted: true });
      }
      return this.send(res, 405, icError("method_not_allowed", "method not allowed", 405));
    }

    return this.send(res, 404, icError("not_found", "not found", 404));
  }

  createContact(res, body) {
    if (!isPlainObject(body)) return this.send(res, 400, icError("bad_request", "Invalid body"));
    const id = objectId();
    const ts = nowUnix();
    const contact = {
      type: "contact",
      id,
      workspace_id: "parlel",
      external_id: body.external_id || null,
      role: body.role || "user",
      email: body.email || null,
      phone: body.phone || null,
      name: body.name || null,
      created_at: ts,
      updated_at: ts,
      ...clone(body),
    };
    contact.type = "contact";
    contact.id = id;
    this.contacts.set(id, contact);
    return this.send(res, 200, clone(contact));
  }

  listContacts(res) {
    const data = Array.from(this.contacts.values()).map(clone);
    return this.send(res, 200, {
      type: "list",
      data,
      total_count: data.length,
      pages: { type: "pages", page: 1, per_page: 50, total_pages: 1 },
    });
  }

  searchContacts(res, body) {
    let data = Array.from(this.contacts.values());
    const q = isPlainObject(body) ? body.query : undefined;
    if (isPlainObject(q) && q.field && q.value !== undefined) {
      data = data.filter((c) => {
        const v = c[q.field];
        switch (q.operator) {
          case "!=":
            return String(v) !== String(q.value);
          case "~":
            return typeof v === "string" && v.includes(String(q.value));
          case "=":
          default:
            return String(v) === String(q.value);
        }
      });
    }
    return this.send(res, 200, {
      type: "list",
      data: data.map(clone),
      total_count: data.length,
      pages: { type: "pages", page: 1, per_page: 50, total_pages: 1 },
    });
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------
  handleConversations(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        const data = Array.from(this.conversations.values()).map(clone);
        return this.send(res, 200, {
          type: "conversation.list",
          conversations: data,
          total_count: data.length,
          pages: { type: "pages", page: 1, per_page: 20, total_pages: 1 },
        });
      }
      if (req.method === "POST") {
        const id = objectId();
        const ts = nowUnix();
        const conv = {
          type: "conversation",
          id,
          created_at: ts,
          updated_at: ts,
          ...clone(isPlainObject(body) ? body : {}),
        };
        conv.type = "conversation";
        conv.id = id;
        this.conversations.set(id, conv);
        return this.send(res, 200, clone(conv));
      }
      return this.send(res, 405, icError("method_not_allowed", "method not allowed", 405));
    }
    if (parts.length === 2) {
      const id = parts[1];
      const conv = this.conversations.get(id);
      if (req.method === "GET") {
        if (!conv) return this.send(res, 404, icError("not_found", "Conversation Not Found", 404));
        return this.send(res, 200, clone(conv));
      }
      if (req.method === "PUT") {
        if (!conv) return this.send(res, 404, icError("not_found", "Conversation Not Found", 404));
        Object.assign(conv, isPlainObject(body) ? clone(body) : {});
        conv.type = "conversation";
        conv.id = id;
        conv.updated_at = nowUnix();
        return this.send(res, 200, clone(conv));
      }
      return this.send(res, 405, icError("method_not_allowed", "method not allowed", 405));
    }
    return this.send(res, 404, icError("not_found", "not found", 404));
  }

  // -------------------------------------------------------------------------
  // Messages — POST /messages creates an admin-initiated conversation/message.
  // -------------------------------------------------------------------------
  handleMessages(req, res, parts, body) {
    if (parts.length === 1 && req.method === "POST") {
      if (!isPlainObject(body) || !isPlainObject(body.from)) {
        return this.send(res, 400, icError("parameter_invalid", "from is required", 400));
      }
      const id = objectId();
      const ts = nowUnix();
      const message = {
        type: "admin_message",
        id,
        created_at: ts,
        message_type: body.message_type || "inapp",
        body: body.body || "",
        ...clone(body),
      };
      message.type = "admin_message";
      message.id = id;
      // Also surface as a conversation for retrieval.
      this.conversations.set(id, { type: "conversation", id, created_at: ts, updated_at: ts, source: clone(body) });
      return this.send(res, 200, clone(message));
    }
    return this.send(res, 405, icError("method_not_allowed", "method not allowed", 405));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, icError("not_found", "not found", 404));
  }

  root() {
    return { name: "intercom", version: "2.11", protocol: "intercom-rest", documentation: "/docs/intercom.md" };
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
          this.send(res, 400, icError("bad_request", "Invalid JSON"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, icError("bad_request", "Invalid JSON"));
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
