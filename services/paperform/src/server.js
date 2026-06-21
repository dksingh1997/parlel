import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/paperform — dependency-free in-memory fake of the Paperform API v1.
// Bearer auth. Responses use the documented results-wrapper shape:
//   list:   { results: { forms: [...] }, total, ... }
//           { results: { submissions: [...] }, total, ... }
//   single: { results: { form: {...} } } / { results: { submission: {...} } }
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

function slug() {
  return randomBytes(6).toString("hex");
}

export class PaperformServer {
  constructor(port = 4855, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.forms = new Map(); // form_id -> form
    this.submissions = new Map(); // submissionId -> submission
    this._subCounter = 0;
    this._seed();
  }

  _seed() {
    const form = this._createForm({ title: "Event Registration", slug: "event-reg" });
    form.fields = [
      { id: "name", title: "Name", type: "text", custom_key: "name" },
      { id: "email", title: "Email", type: "email", custom_key: "email" },
    ];
  }

  _createForm(props) {
    const id = props.slug || slug();
    const form = {
      id,
      slug: id,
      title: props.title || "Untitled Form",
      live: true,
      url: `http://127.0.0.1:${this.port}/${id}`,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      submission_count: 0,
      fields: Array.isArray(props.fields) ? clone(props.fields) : [],
    };
    this.forms.set(id, form);
    return form;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: true, message: error.message || "Internal server error" });
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
    res.setHeader("server", "parlel-paperform");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!(parts[0] === "api" && parts[1] === "v1")) {
      return this.send(res, 404, { error: true, message: "not found" });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { error: true, message: "Unauthenticated. A valid API key is required." });
    }

    const route = parts.slice(2);

    // /api/v1/forms ...
    if (route[0] === "forms") {
      // GET /api/v1/forms
      if (route.length === 1 && req.method === "GET") {
        const forms = Array.from(this.forms.values()).map((f) => ({
          id: f.id,
          slug: f.slug,
          title: f.title,
          live: f.live,
          url: f.url,
          submission_count: f.submission_count,
        }));
        return this.send(res, 200, { results: { forms }, total: forms.length, has_more: false });
      }

      const formId = route[1];
      const form = this.forms.get(formId);

      // GET /api/v1/forms/:form_id
      if (route.length === 2 && req.method === "GET") {
        if (!form) return this.notFound(res);
        return this.send(res, 200, { results: { form: clone(form) } });
      }

      // GET /api/v1/forms/:form_id/fields
      if (route[2] === "fields" && route.length === 3 && req.method === "GET") {
        if (!form) return this.notFound(res);
        return this.send(res, 200, { results: { fields: clone(form.fields) }, total: form.fields.length });
      }

      // GET/POST /api/v1/forms/:form_id/submissions
      if (route[2] === "submissions" && route.length === 3) {
        if (!form) return this.notFound(res);
        if (req.method === "GET") {
          const submissions = Array.from(this.submissions.values())
            .filter((s) => s.form_id === formId)
            .map(clone);
          return this.send(res, 200, { results: { submissions }, total: submissions.length, has_more: false });
        }
        if (req.method === "POST") {
          return this.createSubmission(res, formId, body);
        }
      }
    }

    // GET /api/v1/submissions/:id
    if (route[0] === "submissions" && route[1] && route.length === 2 && req.method === "GET") {
      const sub = this.submissions.get(route[1]);
      if (!sub) return this.notFound(res);
      return this.send(res, 200, { results: { submission: clone(sub) } });
    }

    return this.notFound(res);
  }

  createSubmission(res, formId, body) {
    this._subCounter += 1;
    const id = slug() + String(this._subCounter);
    const data = isPlainObject(body) ? body : {};
    const fieldData = isPlainObject(data.data)
      ? clone(data.data)
      : Object.fromEntries(
          Object.entries(data).filter(([k]) => k !== "device_type"),
        );
    const submission = {
      id,
      form_id: formId,
      created_at: "2024-01-01T00:00:00Z",
      device_type: data.device_type || "desktop",
      data: fieldData,
    };
    this.submissions.set(id, submission);
    const form = this.forms.get(formId);
    if (form) form.submission_count += 1;
    return this.send(res, 201, { results: { submission: clone(submission) } });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.notFound(res);
  }

  notFound(res) {
    return this.send(res, 404, { error: true, message: "The requested resource could not be found." });
  }

  root() {
    return {
      name: "paperform",
      version: "1",
      protocol: "paperform-v1",
      documentation: "/docs/paperform.md",
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
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { error: true, message: "Bad request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { error: true, message: "Bad request body" });
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
