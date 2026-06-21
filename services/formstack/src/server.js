import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/formstack — dependency-free in-memory fake of the Formstack Forms
// API v2. Bearer auth. Paths carry a `.json` suffix. List shape:
//   { forms: [], total, page, per_page }
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

// Strip a trailing ".json" from a path segment (Formstack convention).
function stripJson(segment) {
  if (typeof segment !== "string") return segment;
  return segment.endsWith(".json") ? segment.slice(0, -5) : segment;
}

export class FormstackServer {
  constructor(port = 4853, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.forms = new Map();
    this.submissions = new Map(); // submissionId -> submission
    this._formCounter = 0;
    this._subCounter = 0;
    this._seed();
  }

  _seed() {
    const form = this._createForm({ name: "Lead Capture" });
    form.fields = [
      { id: "1", label: "Name", type: "text", required: "1" },
      { id: "2", label: "Email", type: "email", required: "1" },
    ];
  }

  _createForm(props) {
    this._formCounter += 1;
    const id = String(4000000 + this._formCounter);
    const form = {
      id,
      name: props.name || "Untitled Form",
      description: props.description || "",
      views: 0,
      created: "2024-01-01 00:00:00",
      updated: "2024-01-01 00:00:00",
      deleted: 0,
      submissions: 0,
      submissions_unread: 0,
      url: `http://127.0.0.1:${this.port}/forms/${id}`,
      encrypted: false,
      inactive: false,
      timezone: "US/Eastern",
      fields: [],
    };
    this.forms.set(id, form);
    return form;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { status: "error", error: error.message || "Internal server error" });
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
    const raw = splitPath(url.pathname);
    const parts = raw.map(stripJson);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-formstack");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && raw.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!(parts[0] === "api" && parts[1] === "v2")) {
      return this.send(res, 404, { status: "error", error: "not found" });
    }

    if (!this.isAuthorized(req, url)) {
      return this.send(res, 401, { status: "error", error: "A valid access token is required to request this resource." });
    }

    const route = parts.slice(2);

    // /api/v2/form ...
    if (route[0] === "form") {
      // GET /api/v2/form.json (list)
      if (route.length === 1) {
        if (req.method === "GET") {
          const forms = Array.from(this.forms.values()).map(clone);
          const page = Number(url.searchParams.get("page")) || 1;
          const per_page = Number(url.searchParams.get("per_page")) || 25;
          return this.send(res, 200, { forms, total: forms.length, page, per_page });
        }
        if (req.method === "POST") {
          const form = this._createForm(isPlainObject(body) ? body : {});
          return this.send(res, 200, clone(form));
        }
      }

      const formId = route[1];
      const form = this.forms.get(formId);

      // GET /api/v2/form/:id.json
      if (route.length === 2 && req.method === "GET") {
        if (!form) return this.notFound(res);
        return this.send(res, 200, clone(form));
      }

      // GET/POST /api/v2/form/:id/submission.json
      if (route[2] === "submission" && route.length === 3) {
        if (!form) return this.notFound(res);
        if (req.method === "GET") {
          const submissions = Array.from(this.submissions.values())
            .filter((s) => s.form === formId)
            .map(clone);
          const page = Number(url.searchParams.get("page")) || 1;
          const per_page = Number(url.searchParams.get("per_page")) || 25;
          return this.send(res, 200, { submissions, total: submissions.length, page, per_page, pages: 1 });
        }
        if (req.method === "POST") {
          return this.createSubmission(res, formId, body);
        }
      }
    }

    // GET /api/v2/submission/:id.json
    if (route[0] === "submission" && route[1] && route.length === 2 && req.method === "GET") {
      const sub = this.submissions.get(route[1]);
      if (!sub) return this.notFound(res);
      return this.send(res, 200, clone(sub));
    }
    // DELETE /api/v2/submission/:id.json
    if (route[0] === "submission" && route[1] && route.length === 2 && req.method === "DELETE") {
      const existed = this.submissions.delete(route[1]);
      if (!existed) return this.notFound(res);
      return this.send(res, 200, { success: "1" });
    }

    return this.notFound(res);
  }

  createSubmission(res, formId, body) {
    this._subCounter += 1;
    const id = String(900000000 + this._subCounter);
    const data = isPlainObject(body) ? body : {};
    const fieldData = [];
    for (const [key, value] of Object.entries(data)) {
      const m = /^field_(\d+)$/.exec(key);
      if (m) fieldData.push({ field: m[1], value: String(value) });
      else if (/^\d+$/.test(key)) fieldData.push({ field: key, value: String(value) });
    }
    if (isPlainObject(data.data)) {
      for (const [field, value] of Object.entries(data.data)) {
        fieldData.push({ field, value: String(value) });
      }
    }
    const submission = {
      id,
      form: formId,
      timestamp: "2024-01-01 00:00:00",
      user_agent: "parlel",
      remote_addr: "127.0.0.1",
      payment_status: "",
      read: "0",
      data: fieldData,
    };
    this.submissions.set(id, submission);
    const form = this.forms.get(formId);
    if (form) form.submissions += 1;
    return this.send(res, 200, clone(submission));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.notFound(res);
  }

  notFound(res) {
    return this.send(res, 404, { status: "error", error: "The resource requested could not be found." });
  }

  root() {
    return {
      name: "formstack",
      version: "1",
      protocol: "formstack-v2",
      documentation: "/docs/formstack.md",
    };
  }

  isAuthorized(req, url) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    const query = url.searchParams.get("access_token") || url.searchParams.get("oauth_token");
    if (query && query.length > 0) return true;
    return false;
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        const ct = String(req.headers["content-type"] || "");
        if (ct.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          return resolve(obj);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { status: "error", error: "Bad request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { status: "error", error: "Bad request body" });
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
