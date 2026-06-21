import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/gravity-forms — dependency-free in-memory fake of the Gravity Forms
// REST API v2 (WordPress, under /wp-json/gf/v2). Basic auth with consumer
// key/secret (any non-empty Basic credentials accepted). Form shape:
//   { id, title, fields: [] }
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

export class GravityFormsServer {
  constructor(port = 4854, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.forms = new Map();
    this.entries = new Map(); // entryId -> entry
    this._formCounter = 0;
    this._entryCounter = 0;
    this._seed();
  }

  _seed() {
    this._createForm({
      title: "Contact Us",
      fields: [
        { id: 1, label: "Name", type: "text", isRequired: true },
        { id: 2, label: "Email", type: "email", isRequired: true },
        { id: 3, label: "Message", type: "textarea", isRequired: false },
      ],
    });
  }

  _createForm(props) {
    this._formCounter += 1;
    const id = String(this._formCounter);
    const form = {
      id,
      title: props.title || "Untitled Form",
      description: props.description || "",
      labelPlacement: "top_label",
      button: { type: "text", text: "Submit" },
      fields: Array.isArray(props.fields) ? clone(props.fields) : [],
      version: "2.8",
      date_created: "2024-01-01 00:00:00",
      is_active: "1",
      is_trash: "0",
      entries: "0",
    };
    this.forms.set(id, form);
    return form;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { code: "internal_error", message: error.message, data: { status: 500 } });
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
    res.setHeader("server", "parlel-gravity-forms");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!(parts[0] === "wp-json" && parts[1] === "gf" && parts[2] === "v2")) {
      return this.send(res, 404, { code: "rest_no_route", message: "No route was found matching the URL and request method.", data: { status: 404 } });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, {
        code: "rest_forbidden",
        message: "Sorry, you are not allowed to do that.",
        data: { status: 401 },
      });
    }

    const route = parts.slice(3);

    // /wp-json/gf/v2/forms ...
    if (route[0] === "forms") {
      // GET /forms  -> object keyed by id (GF convention)
      if (route.length === 1) {
        if (req.method === "GET") {
          const out = {};
          for (const [id, form] of this.forms) {
            out[id] = { id, title: form.title, entries: form.entries, is_active: form.is_active, is_trash: form.is_trash };
          }
          return this.send(res, 200, out);
        }
        if (req.method === "POST") {
          const form = this._createForm(isPlainObject(body) ? body : {});
          return this.send(res, 201, clone(form));
        }
      }

      const formId = route[1];
      const form = this.forms.get(formId);

      // GET /forms/:id
      if (route.length === 2 && req.method === "GET") {
        if (!form) return this.notFound(res);
        return this.send(res, 200, clone(form));
      }

      // GET/POST /forms/:id/entries
      if (route[2] === "entries" && route.length === 3) {
        if (!form) return this.notFound(res);
        if (req.method === "GET") {
          const entries = Array.from(this.entries.values())
            .filter((e) => e.form_id === formId)
            .map(clone);
          return this.send(res, 200, {
            total_count: entries.length,
            entries,
          });
        }
        if (req.method === "POST") {
          return this.createEntry(res, formId, body);
        }
      }
    }

    // /wp-json/gf/v2/entries ...
    if (route[0] === "entries") {
      // GET /entries (all)
      if (route.length === 1 && req.method === "GET") {
        const entries = Array.from(this.entries.values()).map(clone);
        return this.send(res, 200, { total_count: entries.length, entries });
      }
      const entryId = route[1];
      const entry = this.entries.get(entryId);
      // GET /entries/:id
      if (route.length === 2 && req.method === "GET") {
        if (!entry) return this.notFound(res);
        return this.send(res, 200, clone(entry));
      }
      // DELETE /entries/:id
      if (route.length === 2 && req.method === "DELETE") {
        if (!entry) return this.notFound(res);
        this.entries.delete(entryId);
        return this.send(res, 200, { id: entryId });
      }
    }

    return this.notFound(res);
  }

  createEntry(res, formId, body) {
    this._entryCounter += 1;
    const id = String(this._entryCounter);
    const data = isPlainObject(body) ? body : {};
    const entry = {
      id,
      form_id: formId,
      date_created: "2024-01-01 00:00:00",
      date_updated: "2024-01-01 00:00:00",
      is_starred: "0",
      is_read: "0",
      ip: "127.0.0.1",
      source_url: "",
      status: "active",
    };
    // Field values keyed by numeric field id (GF convention).
    for (const [key, value] of Object.entries(data)) {
      if (/^\d+(\.\d+)?$/.test(key)) entry[key] = String(value);
    }
    this.entries.set(id, entry);
    const form = this.forms.get(formId);
    if (form) form.entries = String(Number(form.entries) + 1);
    return this.send(res, 201, clone(entry));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.notFound(res);
  }

  notFound(res) {
    return this.send(res, 404, {
      code: "gf_rest_not_found",
      message: "The requested resource was not found.",
      data: { status: 404 },
    });
  }

  root() {
    return {
      name: "gravity-forms",
      version: "1",
      protocol: "gravity-forms-v2",
      documentation: "/docs/gravity-forms.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // Accept Basic (consumer key/secret) or Bearer; any non-empty credential.
    return /^Basic\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, { code: "rest_invalid_json", message: "Invalid JSON body passed.", data: { status: 400 } });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { code: "rest_invalid_json", message: "Invalid JSON body passed.", data: { status: 400 } });
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
