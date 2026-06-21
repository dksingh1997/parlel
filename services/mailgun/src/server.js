import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mailgun — a tiny, dependency-free fake of the Mailgun API v3.
//
// Speaks the wire protocol the official `mailgun.js` / form-data clients use:
// messages are POSTed as application/x-www-form-urlencoded (or multipart) form
// fields (from, to, subject, text, html). State is in-memory and ephemeral;
// sent mail is captured for inspection via /__parlel/* endpoints.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_BODY = Symbol("bad-body");

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

function mgError(message) {
  return { message };
}

function newMessageId(domain) {
  const left = randomBytes(16).toString("hex");
  return `<${left}@${domain}>`;
}

function newId(len = 16) {
  return randomBytes(len).toString("hex").slice(0, len);
}

// Parse application/x-www-form-urlencoded into an object. Repeated keys (e.g.
// multiple `to=`) collapse into an array, matching Mailgun's form semantics.
function parseUrlEncoded(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const idx = pair.indexOf("=");
    const key = decodeURIComponent((idx === -1 ? pair : pair.slice(0, idx)).replace(/\+/g, " "));
    const val = idx === -1 ? "" : decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    if (key in out) {
      if (Array.isArray(out[key])) out[key].push(val);
      else out[key] = [out[key], val];
    } else {
      out[key] = val;
    }
  }
  return out;
}

// Best-effort multipart/form-data parser (text fields only — enough for the
// common from/to/subject/text/html send path).
function parseMultipart(raw, boundary) {
  const out = {};
  const marker = `--${boundary}`;
  const segments = raw.split(marker);
  for (const seg of segments) {
    const trimmed = seg.replace(/^\r\n/, "");
    if (!trimmed || trimmed === "--" || trimmed === "--\r\n") continue;
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = trimmed.slice(0, headerEnd);
    let value = trimmed.slice(headerEnd + 4);
    value = value.replace(/\r\n$/, "");
    const nameMatch = headers.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const key = nameMatch[1];
    if (key in out) {
      if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export class MailgunServer {
  constructor(port = 4826, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.events = [];
    this.mailingLists = new Map();
    this.domains = new Map();
    this.idCounter = 0;
    this._seedDefaults();
  }

  _seedDefaults() {
    // Shape mirrors the official mailgun.js Domain model (lib/Classes/Domains/domain.ts):
    // the SDK reads body.items[] from GET /v4/domains and tolerates missing fields, but we
    // populate the common ones for realism.
    this.domains.set("sandbox.parlel", {
      id: newId(16),
      name: "sandbox.parlel",
      require_tls: false,
      skip_verification: false,
      state: "active",
      wildcard: false,
      spam_action: "disabled",
      created_at: now(),
      smtp_password: "",
      smtp_login: "postmaster@sandbox.parlel",
      type: "sandbox",
      is_disabled: false,
      web_prefix: "email",
      web_scheme: "http",
      use_automatic_sender_security: false,
    });
  }

  _baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, mgError(error.message || "Internal server error"));
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
    if (body === SENTINEL_BAD_BODY) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-mailgun");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // The official mailgun.js SDK lists/creates domains on /v4 and lists on /v3/lists.
    if (parts[0] !== "v3" && parts[0] !== "v4") {
      return this.send(res, 404, mgError("Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, mgError("Invalid private key"));
    }

    const version = parts[0];
    const route = parts.slice(1);

    // GET /v4/domains  (SDK domains.list) — also accept /v3/domains as a legacy alias.
    if (req.method === "GET" && route[0] === "domains" && route.length === 1) {
      const items = Array.from(this.domains.values()).map(clone);
      return this.send(res, 200, { total_count: items.length, items });
    }

    // Mailing lists live at /v3/lists in the real API (SDK lists.* methods).
    if (version === "v3" && route[0] === "lists") {
      return this.handleLists(req, res, route, body);
    }

    // /v3/:domain/messages  (multipart or urlencoded form)
    if (version === "v3" && route.length === 2 && route[1] === "messages" && req.method === "POST") {
      return this.sendMessage(res, route[0], body);
    }

    // GET /v3/:domain/events
    if (version === "v3" && route.length === 2 && route[1] === "events" && req.method === "GET") {
      return this.send(res, 200, { items: clone(this.events), paging: this._eventsPaging(route[0]) });
    }

    // Legacy alias: /v3/:domain/mailing_lists (kept working for backwards compatibility).
    if (version === "v3" && route.length === 2 && route[1] === "mailing_lists") {
      return this.handleMailingLists(req, res, body);
    }

    return this.send(res, 404, mgError("Not Found"));
  }

  // Real Mailgun events return absolute paging URLs; the SDK runs `new URL(pageUrl)`
  // over each value (NavigationThruPages.parsePage), so empty strings would throw.
  _eventsPaging(domain) {
    const base = `${this._baseUrl()}/v3/${encodeURIComponent(domain)}/events`;
    return { first: base, last: base, next: base, previous: base };
  }

  sendMessage(res, domain, form) {
    if (!isPlainObject(form)) form = {};
    const from = form.from;
    const to = form.to;
    if (!from) return this.send(res, 400, mgError("'from' parameter is missing"));
    if (!to) return this.send(res, 400, mgError("'to' parameter is missing"));

    const id = newMessageId(domain);
    const captured = {
      id,
      domain,
      received_at: now(),
      from,
      to: toArray(to),
      subject: form.subject ?? null,
      text: form.text ?? null,
      html: form.html ?? null,
      form: clone(form),
    };
    this.messages.push(captured);
    this.events.push({
      event: "accepted",
      id: newId(16),
      timestamp: Date.now() / 1000,
      message: { headers: { "message-id": id.replace(/[<>]/g, ""), from, to, subject: form.subject } },
      recipient: toArray(to)[0],
    });

    return this.send(res, 200, { id, message: "Queued. Thank you." });
  }

  // Shape mirrors the official mailgun.js MailingList type
  // (lib/Types/MailingLists/MailingLists.ts): includes reply_preference (nullable).
  _makeList(body) {
    return {
      address: body.address,
      name: body.name || "",
      description: body.description || "",
      access_level: body.access_level || "readonly",
      reply_preference: body.reply_preference || null,
      members_count: 0,
      created_at: now(),
    };
  }

  _listsPaging() {
    const base = `${this._baseUrl()}/v3/lists/pages`;
    return { first: base, last: base, next: base, previous: base };
  }

  // Real API + SDK routes: GET /v3/lists/pages (list), POST /v3/lists (create),
  // GET /v3/lists/:address (get), PUT /v3/lists/:address (update),
  // DELETE /v3/lists/:address (delete).  route === parts.slice(1), so route[0] === "lists".
  handleLists(req, res, route, body) {
    const rest = route.slice(1); // after "lists"

    // GET /v3/lists/pages  and  GET /v3/lists
    if (req.method === "GET" && (rest.length === 0 || (rest.length === 1 && rest[0] === "pages"))) {
      const items = Array.from(this.mailingLists.values()).map(clone);
      return this.send(res, 200, { items, paging: this._listsPaging() });
    }

    // POST /v3/lists
    if (req.method === "POST" && rest.length === 0) {
      if (!isPlainObject(body) || !body.address) {
        return this.send(res, 400, mgError("Need at least one of the following parameters: address"));
      }
      const list = this._makeList(body);
      this.mailingLists.set(list.address, list);
      return this.send(res, 200, { message: "Mailing list has been created", list: clone(list) });
    }

    // operations on a single list: /v3/lists/:address
    if (rest.length === 1 && rest[0] !== "pages") {
      const address = rest[0];
      if (req.method === "GET") {
        const list = this.mailingLists.get(address);
        if (!list) return this.send(res, 404, mgError("Mailing list not found"));
        return this.send(res, 200, { list: clone(list) });
      }
      if (req.method === "PUT") {
        const existing = this.mailingLists.get(address);
        if (!existing) return this.send(res, 404, mgError("Mailing list not found"));
        const updated = { ...existing };
        if (isPlainObject(body)) {
          for (const k of ["name", "description", "access_level", "reply_preference"]) {
            if (body[k] !== undefined) updated[k] = body[k];
          }
          if (body.address !== undefined && body.address !== address) {
            this.mailingLists.delete(address);
            updated.address = body.address;
          }
        }
        this.mailingLists.set(updated.address, updated);
        return this.send(res, 200, { message: "Mailing list has been updated", list: clone(updated) });
      }
      if (req.method === "DELETE") {
        if (!this.mailingLists.has(address)) return this.send(res, 404, mgError("Mailing list not found"));
        this.mailingLists.delete(address);
        return this.send(res, 200, { address, message: "Mailing list has been deleted" });
      }
      return this.send(res, 405, mgError("Method Not Allowed"));
    }

    return this.send(res, 404, mgError("Not Found"));
  }

  // Legacy alias: POST/GET /v3/:domain/mailing_lists. Kept so older callers don't break.
  handleMailingLists(req, res, body) {
    if (req.method === "GET") {
      const items = Array.from(this.mailingLists.values()).map(clone);
      return this.send(res, 200, { items, paging: this._listsPaging() });
    }
    if (req.method === "POST") {
      if (!isPlainObject(body) || !body.address) {
        return this.send(res, 400, mgError("'address' parameter is missing"));
      }
      const list = this._makeList(body);
      this.mailingLists.set(list.address, list);
      return this.send(res, 200, { message: "Mailing list has been created", list: clone(list) });
    }
    return this.send(res, 405, mgError("Method Not Allowed"));
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
      const match = this.messages.find((m) => m.id === parts[2] || m.id.replace(/[<>]/g, "") === parts[2]);
      if (!match) return this.send(res, 404, mgError("message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, mgError("Not Found"));
  }

  root() {
    return {
      name: "mailgun",
      version: "1.0",
      protocol: "mailgun-v3",
      documentation: "/docs/mailgun.md",
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
        const ctype = (req.headers["content-type"] || "").toLowerCase();
        try {
          if (ctype.includes("application/json")) {
            resolve(JSON.parse(data));
          } else if (ctype.includes("multipart/form-data")) {
            const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
            const boundary = m ? (m[1] || m[2]).trim() : "";
            resolve(boundary ? parseMultipart(data, boundary) : {});
          } else {
            // default + application/x-www-form-urlencoded
            resolve(parseUrlEncoded(data));
          }
        } catch {
          this.send(res, 400, mgError("Bad request body"));
          resolve(SENTINEL_BAD_BODY);
        }
      });
      req.on("error", () => {
        this.send(res, 400, mgError("Bad request body"));
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
}
