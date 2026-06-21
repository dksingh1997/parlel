import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/jotform — a dependency-free, in-memory fake of the JotForm API.
//
// Speaks the JotForm REST wire protocol: APIKEY header OR ?apiKey= query auth,
// and the response envelope { responseCode, message, content }. State is
// in-memory and ephemeral; ids are deterministic.
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

// JotForm uses long numeric-ish ids. Derive deterministic ones from a counter.
function makeId(prefix, n) {
  const base = "2" + String(prefix).length + "0000000000";
  const tail = String(n).padStart(8, "0");
  return (base.slice(0, 13 - tail.length) + tail).slice(0, 19);
}

export class JotformServer {
  constructor(port = 4846, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.forms = new Map();
    this.questions = new Map(); // formId -> Map(qid -> question)
    this.submissions = new Map(); // submissionId -> submission
    this._formCounter = 0;
    this._subCounter = 0;
    this.user = {
      name: "Parlel User",
      email: "user@parlel.dev",
      username: "parlel",
      accountType: "ADMIN",
      status: "ACTIVE",
      website: "https://parlel.dev",
      timezone: "UTC",
      created_at: "2024-01-01 00:00:00",
      usage: { submissions: 0 },
    };
    this._seed();
  }

  _seed() {
    const form = this._createForm({ title: "Contact Form", status: "ENABLED" });
    this._addQuestion(form.id, { type: "control_textbox", text: "Name", name: "name", order: "1" });
    this._addQuestion(form.id, { type: "control_email", text: "Email", name: "email", order: "2" });
    this._addQuestion(form.id, { type: "control_textarea", text: "Message", name: "message", order: "3" });
  }

  _createForm(props) {
    this._formCounter += 1;
    const id = makeId("form", this._formCounter);
    const form = {
      id,
      username: this.user.username,
      title: props.title || "Untitled Form",
      height: "539",
      status: props.status || "ENABLED",
      created_at: "2024-01-01 00:00:00",
      updated_at: "2024-01-01 00:00:00",
      last_submission: null,
      new: "0",
      count: "0",
      type: "LEGACY",
      favorite: "0",
      archived: "0",
      url: `http://127.0.0.1:${this.port}/${id}`,
    };
    this.forms.set(id, form);
    this.questions.set(id, new Map());
    return form;
  }

  _addQuestion(formId, props) {
    const map = this.questions.get(formId);
    const qid = String(map.size + 1);
    const question = {
      qid,
      type: props.type || "control_textbox",
      text: props.text || "Field",
      name: props.name || `field${qid}`,
      order: props.order || qid,
      ...props,
    };
    question.qid = qid;
    map.set(qid, question);
    return question;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, this.envelope(500, error.message || "Internal server error", null));
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

  envelope(responseCode, message, content) {
    return { responseCode, message, content };
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res, url);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "APIKEY, Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-jotform");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req, url)) {
      return this.send(res, 401, this.envelope(401, "Invalid API Key", "You are not authorized to make this request."));
    }

    // GET /user
    if (req.method === "GET" && parts[0] === "user" && parts.length === 1) {
      return this.send(res, 200, this.envelope(200, "success", clone(this.user)));
    }
    // GET /user/forms
    if (req.method === "GET" && parts[0] === "user" && parts[1] === "forms" && parts.length === 2) {
      const list = Array.from(this.forms.values()).map(clone);
      res.setHeader("Content-Type", "application/json");
      return this.send(res, 200, {
        responseCode: 200,
        message: "success",
        content: list,
        "result-set": { offset: 0, limit: 20, count: list.length },
      });
    }
    // GET /user/submissions
    if (req.method === "GET" && parts[0] === "user" && parts[1] === "submissions" && parts.length === 2) {
      const list = Array.from(this.submissions.values()).map(clone);
      return this.send(res, 200, this.envelope(200, "success", list));
    }

    // /form/:id...
    if (parts[0] === "form" && parts[1]) {
      const formId = parts[1];
      const form = this.forms.get(formId);

      // GET /form/:id
      if (req.method === "GET" && parts.length === 2) {
        if (!form) return this.notFound(res);
        return this.send(res, 200, this.envelope(200, "success", clone(form)));
      }
      // GET/POST /form/:id/questions
      if (parts[2] === "questions" && parts.length === 3) {
        if (!form) return this.notFound(res);
        if (req.method === "GET") {
          const map = this.questions.get(formId);
          const out = {};
          for (const [qid, q] of map) out[qid] = clone(q);
          return this.send(res, 200, this.envelope(200, "success", out));
        }
        if (req.method === "POST") {
          // body.questions can be a JSON-encoded object of questions, or direct props
          let toAdd = body;
          if (body && typeof body.question === "object") toAdd = body.question;
          else if (body && typeof body.questions === "object") toAdd = body.questions;
          const added = this._addQuestion(formId, isPlainObject(toAdd) ? toAdd : {});
          const out = {};
          out[added.qid] = clone(added);
          return this.send(res, 200, this.envelope(200, "success", out));
        }
      }
      // GET /form/:id/question/:qid
      if (parts[2] === "question" && parts[3] && parts.length === 4) {
        if (!form) return this.notFound(res);
        const q = this.questions.get(formId).get(parts[3]);
        if (!q) return this.notFound(res);
        return this.send(res, 200, this.envelope(200, "success", clone(q)));
      }
      // GET/POST /form/:id/submissions
      if (parts[2] === "submissions" && parts.length === 3) {
        if (!form) return this.notFound(res);
        if (req.method === "GET") {
          const list = Array.from(this.submissions.values())
            .filter((s) => s.form_id === formId)
            .map(clone);
          return this.send(res, 200, {
            responseCode: 200,
            message: "success",
            content: list,
            "result-set": { offset: 0, limit: 20, count: list.length },
          });
        }
        if (req.method === "POST") {
          return this.createSubmission(res, formId, body);
        }
      }
    }

    // GET /submission/:id
    if (req.method === "GET" && parts[0] === "submission" && parts[1] && parts.length === 2) {
      const sub = this.submissions.get(parts[1]);
      if (!sub) return this.notFound(res);
      return this.send(res, 200, this.envelope(200, "success", clone(sub)));
    }
    // DELETE /submission/:id
    if (req.method === "DELETE" && parts[0] === "submission" && parts[1] && parts.length === 2) {
      const existed = this.submissions.delete(parts[1]);
      if (!existed) return this.notFound(res);
      return this.send(res, 200, this.envelope(200, "success", "Submission deleted."));
    }

    return this.notFound(res);
  }

  createSubmission(res, formId, body) {
    this._subCounter += 1;
    const id = makeId("sub", this._subCounter);
    // JotForm accepts answers keyed like submission[qid] => value, or { answers: {} }
    let answers = {};
    if (isPlainObject(body)) {
      if (isPlainObject(body.answers)) {
        answers = clone(body.answers);
      } else {
        for (const [key, value] of Object.entries(body)) {
          const m = /^submission\[(\d+)\]$/.exec(key);
          if (m) answers[m[1]] = { answer: value };
          else if (/^\d+$/.test(key)) answers[key] = { answer: value };
        }
      }
    }
    const submission = {
      id,
      form_id: formId,
      ip: "127.0.0.1",
      created_at: "2024-01-01 00:00:00",
      status: "ACTIVE",
      new: "1",
      flag: "0",
      notes: "",
      answers,
    };
    this.submissions.set(id, submission);
    const form = this.forms.get(formId);
    if (form) {
      form.count = String(Number(form.count) + 1);
      form.last_submission = "2024-01-01 00:00:00";
    }
    this.user.usage.submissions += 1;
    return this.send(res, 200, this.envelope(200, "success", {
      submissionID: id,
      URL: `http://127.0.0.1:${this.port}/submission/${id}`,
    }));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "submissions") {
      const list = Array.from(this.submissions.values()).map(clone);
      return this.send(res, 200, { submissions: list, count: list.length });
    }
    return this.notFound(res);
  }

  notFound(res) {
    return this.send(res, 404, this.envelope(404, "404 Not Found", "Resource not found."));
  }

  root() {
    return {
      name: "jotform",
      version: "1",
      protocol: "jotform-api",
      documentation: "/docs/jotform.md",
    };
  }

  isAuthorized(req, url) {
    if (!this.requireAuth) return true;
    const header = req.headers["apikey"];
    if (typeof header === "string" && header.length > 0) return true;
    const query = url.searchParams.get("apiKey") || url.searchParams.get("apikey");
    if (query && query.length > 0) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    return false;
  }

  readBody(req, res, url) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          // Support form-encoded params already in query string
          resolve({});
          return;
        }
        const ct = String(req.headers["content-type"] || "");
        if (ct.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          resolve(obj);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          // JotForm is lenient; treat unparseable as empty rather than erroring.
          resolve({});
        }
      });
      req.on("error", () => {
        this.send(res, 400, this.envelope(400, "Bad request body", null));
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
