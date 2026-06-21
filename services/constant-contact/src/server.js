import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/constant-contact — a tiny, dependency-free fake of the Constant
// Contact v3 API.
//
// Speaks the wire protocol the language-agnostic Constant Contact v3 REST API
// uses: JSON bodies authenticated via Bearer auth. State is in-memory and
// ephemeral; created email campaigns are captured for inspection.
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

// Constant Contact error envelope: [{ error_key, error_message }]
function ccError(errorKey, errorMessage) {
  return [{ error_key: errorKey, error_message: errorMessage }];
}

export class ConstantContactServer {
  constructor(port = 4832, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.contacts = new Map(); // contact_id -> contact
    this.contactsByEmail = new Map();
    this.contactLists = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, ccError("internal_error", error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-constant-contact");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v3") {
      return this.send(res, 404, ccError("not_found", "Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, ccError("unauthorized", "The access token provided is expired, revoked, malformed, or invalid."));
    }

    const route = parts.slice(1);

    if (route[0] === "contacts") return this.handleContacts(req, res, route, body);
    if (route[0] === "contact_lists") return this.handleContactLists(req, res, route, body);
    if (req.method === "POST" && route[0] === "emails" && route.length === 1) {
      return this.createEmail(res, body);
    }
    if (req.method === "GET" && route[0] === "account" && route[1] === "summary") {
      return this.send(res, 200, {
        organization_name: "Parlel",
        country_code: "US",
        encoded_account_id: "parlel-account",
        contact_email: "owner@parlel.dev",
      });
    }

    return this.send(res, 404, ccError("not_found", "Not Found"));
  }

  handleContacts(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        const contacts = Array.from(this.contacts.values()).map(clone);
        return this.send(res, 200, { contacts, contacts_count: contacts.length });
      }
      if (req.method === "POST") {
        const email = isPlainObject(body) && isPlainObject(body.email_address) ? body.email_address.address : null;
        if (typeof email !== "string" || !EMAIL_RE.test(email)) {
          return this.send(res, 400, ccError("invalid_field", "email_address.address must be a valid email."));
        }
        if (this.contactsByEmail.has(email)) {
          return this.send(res, 409, ccError("conflict", "The contact already exists."));
        }
        const id = randomUUID();
        const record = {
          contact_id: id,
          email_address: clone(body.email_address),
          first_name: body.first_name || "",
          last_name: body.last_name || "",
          list_memberships: Array.isArray(body.list_memberships) ? clone(body.list_memberships) : [],
          create_source: body.create_source || "Account",
          created_at: now(),
          updated_at: now(),
        };
        this.contacts.set(id, record);
        this.contactsByEmail.set(email, record);
        return this.send(res, 201, clone(record));
      }
      return this.send(res, 405, ccError("method_not_allowed", "Method Not Allowed"));
    }

    if (route.length === 2) {
      const id = route[1];
      const contact = this.contacts.get(id);
      if (req.method === "GET") {
        if (!contact) return this.send(res, 404, ccError("not_found", "Contact not found."));
        return this.send(res, 200, clone(contact));
      }
      if (req.method === "PUT") {
        if (!contact) return this.send(res, 404, ccError("not_found", "Contact not found."));
        if (isPlainObject(body)) {
          if (typeof body.first_name === "string") contact.first_name = body.first_name;
          if (typeof body.last_name === "string") contact.last_name = body.last_name;
          if (Array.isArray(body.list_memberships)) contact.list_memberships = clone(body.list_memberships);
          contact.updated_at = now();
        }
        return this.send(res, 200, clone(contact));
      }
      if (req.method === "DELETE") {
        if (!contact) return this.send(res, 404, ccError("not_found", "Contact not found."));
        const email = contact.email_address?.address;
        this.contacts.delete(id);
        if (email) this.contactsByEmail.delete(email);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, ccError("method_not_allowed", "Method Not Allowed"));
    }
    return this.send(res, 404, ccError("not_found", "Not Found"));
  }

  handleContactLists(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        const lists = Array.from(this.contactLists.values()).map(clone);
        return this.send(res, 200, { lists, lists_count: lists.length });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 400, ccError("invalid_field", "name is required."));
        }
        const id = randomUUID();
        const record = {
          list_id: id,
          name: body.name,
          description: body.description || "",
          favorite: Boolean(body.favorite),
          created_at: now(),
          updated_at: now(),
          membership_count: 0,
        };
        this.contactLists.set(id, record);
        return this.send(res, 201, clone(record));
      }
      return this.send(res, 405, ccError("method_not_allowed", "Method Not Allowed"));
    }
    return this.send(res, 404, ccError("not_found", "Not Found"));
  }

  createEmail(res, body) {
    if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
      return this.send(res, 400, ccError("invalid_field", "name is required."));
    }
    const id = randomUUID();
    const record = {
      campaign_activity_id: randomUUID(),
      campaign_id: id,
      name: body.name,
      current_status: "Draft",
      type: "NEWSLETTER",
      created_at: now(),
      updated_at: now(),
    };
    this.messages.push({ id, received_at: now(), kind: "email_campaign", body: clone(body) });
    return this.send(res, 201, record);
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
      if (!match) return this.send(res, 404, ccError("not_found", "message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, ccError("not_found", "Not Found"));
  }

  root() {
    return {
      name: "constant-contact",
      version: "1.0",
      protocol: "constant-contact-v3",
      documentation: "/docs/constant-contact.md",
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
          this.send(res, 400, ccError("invalid_request", "Invalid request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, ccError("invalid_request", "Invalid request body."));
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
