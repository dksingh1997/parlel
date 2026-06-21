import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/typeform — a tiny, dependency-free fake of the Typeform Create &
// Responses API. Forms CRUD, responses listing, and /me. Bearer auth.
// State is in-memory and ephemeral.
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

function newFormId() {
  return randomBytes(4).toString("hex").slice(0, 6);
}

function newToken() {
  return randomBytes(16).toString("hex");
}

export class TypeformServer {
  constructor(port = 4812, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.forms = new Map();
    this.responses = new Map(); // formId -> [responses]
    this._seedDefaults();
  }

  _seedDefaults() {
    const form = this._makeForm({ title: "Parlel Default Form", fields: [] });
    this.forms.set(form.id, form);
    this.responses.set(form.id, []);
  }

  _makeForm(input) {
    const id = newFormId();
    const fields = Array.isArray(input.fields)
      ? input.fields.map((f, i) => ({
          id: newToken().slice(0, 16),
          title: f.title || `Question ${i + 1}`,
          type: f.type || "short_text",
          ref: f.ref || `ref_${i + 1}`,
          properties: f.properties || {},
          validations: f.validations || { required: false },
        }))
      : [];
    return {
      id,
      title: input.title || "Untitled",
      type: input.type || "form",
      fields,
      settings: input.settings || { is_public: true, progress_bar: "proportion" },
      _links: { display: `https://parlel.typeform.com/to/${id}` },
      created_at: new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { code: "INTERNAL_SERVER_ERROR", message: error.message || "error" });
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
    res.setHeader("server", "parlel-typeform");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { code: "AUTHENTICATION_FAILED", message: "Authentication credentials not provided." });
    }

    // GET /me
    if (parts[0] === "me" && parts.length === 1 && req.method === "GET") {
      return this.send(res, 200, {
        user_id: "parlel-user",
        email: "user@parlel.dev",
        alias: "parlel",
        language: "en",
      });
    }

    if (parts[0] === "forms") {
      // /forms/:id/responses
      if (parts.length === 3 && parts[2] === "responses") {
        return this.handleResponses(req, res, parts[1], body, url);
      }
      return this.handleForms(req, res, parts, body, url);
    }

    return this.send(res, 404, { code: "NOT_FOUND", message: "not found" });
  }

  handleForms(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        const page = Number(url.searchParams.get("page") || 1);
        const pageSize = Number(url.searchParams.get("page_size") || 10);
        const items = Array.from(this.forms.values()).map((f) => ({
          id: f.id,
          title: f.title,
          last_updated_at: f.last_updated_at,
          self: { href: `/forms/${f.id}` },
          _links: f._links,
        }));
        return this.send(res, 200, {
          total_items: items.length,
          page_count: Math.max(1, Math.ceil(items.length / pageSize)),
          items: items.slice((page - 1) * pageSize, page * pageSize),
        });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.title !== "string") {
          return this.send(res, 400, { code: "VALIDATION_ERROR", message: "title is required" });
        }
        const form = this._makeForm(body);
        this.forms.set(form.id, form);
        this.responses.set(form.id, []);
        return this.send(res, 201, clone(form));
      }
      return this.send(res, 405, { code: "METHOD_NOT_ALLOWED", message: "method not allowed" });
    }

    // /forms/:id
    const id = parts[1];
    const form = this.forms.get(id);
    if (!form) return this.send(res, 404, { code: "FORM_NOT_FOUND", message: "Non existing form" });

    if (req.method === "GET") return this.send(res, 200, clone(form));
    if (req.method === "PUT" || req.method === "PATCH") {
      if (isPlainObject(body)) {
        if (typeof body.title === "string") form.title = body.title;
        if (Array.isArray(body.fields)) {
          const rebuilt = this._makeForm({ ...body, title: form.title });
          form.fields = rebuilt.fields;
        }
        if (body.settings) form.settings = clone(body.settings);
        form.last_updated_at = new Date().toISOString();
      }
      return this.send(res, 200, clone(form));
    }
    if (req.method === "DELETE") {
      this.forms.delete(id);
      this.responses.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, { code: "METHOD_NOT_ALLOWED", message: "method not allowed" });
  }

  handleResponses(req, res, formId, body, url) {
    const form = this.forms.get(formId);
    if (!form) return this.send(res, 404, { code: "FORM_NOT_FOUND", message: "Non existing form" });
    const list = this.responses.get(formId) || [];

    if (req.method === "GET") {
      const pageSize = Number(url.searchParams.get("page_size") || 25);
      return this.send(res, 200, {
        total_items: list.length,
        page_count: Math.max(1, Math.ceil(list.length / pageSize)),
        items: list.slice(0, pageSize).map(clone),
      });
    }
    // POST a response (parlel convenience for seeding responses for inspection).
    if (req.method === "POST") {
      const token = newToken();
      const response = {
        landing_id: token,
        token,
        response_id: token,
        submitted_at: new Date().toISOString(),
        landed_at: new Date().toISOString(),
        answers: isPlainObject(body) && Array.isArray(body.answers) ? clone(body.answers) : [],
        hidden: isPlainObject(body) ? clone(body.hidden) || {} : {},
      };
      list.push(response);
      this.responses.set(formId, list);
      return this.send(res, 201, clone(response));
    }
    return this.send(res, 405, { code: "METHOD_NOT_ALLOWED", message: "method not allowed" });
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "forms") {
      return this.send(res, 200, { forms: Array.from(this.forms.values()).map(clone), count: this.forms.size });
    }
    return this.send(res, 404, { code: "NOT_FOUND", message: "not found" });
  }

  root() {
    return { name: "typeform", version: "1.0", protocol: "typeform", documentation: "/docs/typeform.md" };
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
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { code: "VALIDATION_ERROR", message: "Malformed JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { code: "VALIDATION_ERROR", message: "Bad request body" });
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
