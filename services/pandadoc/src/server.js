import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/pandadoc — dependency-free in-memory fake of the PandaDoc API v1.
// Header auth: `Authorization: API-Key <key>`. List responses use { results: [] }.
// Document status follows the real lifecycle: document.uploaded -> document.draft
// -> document.sent -> document.completed.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function docId() {
  return randomBytes(16).toString("base64").replace(/[+/=]/g, "").slice(0, 22);
}

export class PandadocServer {
  constructor(port = 4851, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.documents = new Map();
    this.templates = new Map();
    this._templateCounter = 0;
    this._seed();
  }

  _seed() {
    this._createTemplate({ name: "MSA Template" });
    this._createTemplate({ name: "NDA Template" });
  }

  _createTemplate(props) {
    this._templateCounter += 1;
    const id = docId();
    const template = {
      id,
      name: props.name || "Template",
      date_created: "2024-01-01T00:00:00.000000Z",
      date_modified: "2024-01-01T00:00:00.000000Z",
      version: "1",
    };
    this.templates.set(id, template);
    return template;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { type: "internal_error", detail: error.message || "Internal server error" });
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-pandadoc");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!(parts[0] === "public" && parts[1] === "v1")) {
      return this.send(res, 404, { type: "not_found", detail: "not found" });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { detail: "Invalid or missing API key." });
    }

    const route = parts.slice(2);

    // GET /public/v1/templates
    if (req.method === "GET" && route[0] === "templates" && route.length === 1) {
      return this.send(res, 200, { results: Array.from(this.templates.values()).map(clone) });
    }

    // /public/v1/documents ...
    if (route[0] === "documents") {
      // GET/POST /public/v1/documents
      if (route.length === 1) {
        if (req.method === "GET") {
          const results = Array.from(this.documents.values()).map((d) => ({
            id: d.id,
            name: d.name,
            status: d.status,
            date_created: d.date_created,
            date_modified: d.date_modified,
            expiration_date: d.expiration_date,
            version: d.version,
          }));
          return this.send(res, 200, { results });
        }
        if (req.method === "POST") {
          return this.createDocument(res, body);
        }
      }

      const docId_ = route[1];
      const doc = this.documents.get(docId_);

      // GET /public/v1/documents/:id  (details)
      if (route.length === 2 && req.method === "GET") {
        if (!doc) return this.notFound(res);
        return this.send(res, 200, clone(doc));
      }
      // POST /public/v1/documents/:id/send
      if (route.length === 3 && route[2] === "send" && req.method === "POST") {
        if (!doc) return this.notFound(res);
        doc.status = "document.sent";
        doc.date_modified = "2024-01-01T00:00:00.000000Z";
        if (isPlainObject(body) && typeof body.subject === "string") doc.subject = body.subject;
        return this.send(res, 200, {
          id: doc.id,
          name: doc.name,
          status: doc.status,
          date_created: doc.date_created,
          date_modified: doc.date_modified,
          recipients: doc.recipients,
        });
      }
      // GET /public/v1/documents/:id/details
      if (route.length === 3 && route[2] === "details" && req.method === "GET") {
        if (!doc) return this.notFound(res);
        return this.send(res, 200, clone(doc));
      }
      // DELETE /public/v1/documents/:id
      if (route.length === 2 && req.method === "DELETE") {
        if (!doc) return this.notFound(res);
        this.documents.delete(docId_);
        return this.send(res, 204, null);
      }
    }

    return this.notFound(res);
  }

  createDocument(res, body) {
    const data = isPlainObject(body) ? body : {};
    if (!data.name && !data.template_uuid && !data.url) {
      return this.send(res, 400, {
        type: "validation_error",
        detail: "name is required",
      });
    }
    const id = docId();
    const recipients = Array.isArray(data.recipients)
      ? data.recipients.map((r, i) => ({
          id: docId(),
          email: r.email || `recipient${i}@parlel.dev`,
          first_name: r.first_name || "",
          last_name: r.last_name || "",
          role: r.role || "",
          recipient_type: r.recipient_type || "default",
          has_completed: false,
        }))
      : [];
    const doc = {
      id,
      name: data.name || "Untitled Document",
      status: "document.uploaded",
      date_created: "2024-01-01T00:00:00.000000Z",
      date_modified: "2024-01-01T00:00:00.000000Z",
      expiration_date: null,
      version: "1",
      uuid: id,
      template_uuid: data.template_uuid || null,
      recipients,
      tokens: Array.isArray(data.tokens) ? clone(data.tokens) : [],
      fields: {},
      metadata: isPlainObject(data.metadata) ? clone(data.metadata) : {},
      tags: Array.isArray(data.tags) ? clone(data.tags) : [],
    };
    this.documents.set(id, doc);
    return this.send(res, 201, {
      id: doc.id,
      uuid: doc.uuid,
      name: doc.name,
      status: doc.status,
      date_created: doc.date_created,
      date_modified: doc.date_modified,
      expiration_date: doc.expiration_date,
      version: doc.version,
    });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    // Test helper: advance a document to completed.
    if (req.method === "POST" && parts[1] === "complete" && parts[2]) {
      const doc = this.documents.get(parts[2]);
      if (!doc) return this.notFound(res);
      doc.status = "document.completed";
      return this.send(res, 200, clone(doc));
    }
    return this.notFound(res);
  }

  notFound(res) {
    return this.send(res, 404, { type: "not_found", detail: "Not found." });
  }

  root() {
    return {
      name: "pandadoc",
      version: "1",
      protocol: "pandadoc-v1",
      documentation: "/docs/pandadoc.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^API-Key\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        const ct = String(req.headers["content-type"] || "");
        if (ct.includes("multipart/form-data")) {
          // Accept multipart uploads loosely; treat metadata only.
          return resolve({});
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { type: "validation_error", detail: "Bad request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { type: "validation_error", detail: "Bad request body" });
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
