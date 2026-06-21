import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/tally — dependency-free in-memory fake of the Tally API.
// Bearer auth. List responses use { items: [], page, limit, total, hasMore }.
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

function id24(prefix, n) {
  return (prefix + String(n).padStart(20, "0")).slice(0, 24).padEnd(24, "A");
}

export class TallyServer {
  constructor(port = 4848, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.workspaces = new Map();
    this.forms = new Map();
    this.responses = new Map(); // formId -> array of responses
    this._formCounter = 0;
    this._respCounter = 0;
    this._wsCounter = 0;
    this._seed();
  }

  _seed() {
    const ws = this._createWorkspace({ name: "My Workspace" });
    this._createForm({ name: "Signup Form", workspaceId: ws.id, status: "PUBLISHED" });
  }

  _createWorkspace(props) {
    this._wsCounter += 1;
    const id = id24("wWS", this._wsCounter);
    const ws = {
      id,
      name: props.name || "Workspace",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    this.workspaces.set(id, ws);
    return ws;
  }

  _createForm(props) {
    this._formCounter += 1;
    const id = id24("wForm", this._formCounter);
    const form = {
      id,
      name: props.name || "Untitled",
      workspaceId: props.workspaceId || null,
      status: props.status || "DRAFT",
      numberOfSubmissions: 0,
      isClosed: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    this.forms.set(id, form);
    this.responses.set(id, []);
    return form;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message || "Internal server error" });
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-tally");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { message: "Unauthorized", statusCode: 401 });
    }

    // GET /workspaces
    if (req.method === "GET" && parts[0] === "workspaces" && parts.length === 1) {
      const items = Array.from(this.workspaces.values()).map(clone);
      return this.send(res, 200, this.listEnvelope(items, url));
    }

    // /forms ...
    if (parts[0] === "forms") {
      if (parts.length === 1) {
        if (req.method === "GET") {
          const items = Array.from(this.forms.values()).map(clone);
          return this.send(res, 200, this.listEnvelope(items, url));
        }
        if (req.method === "POST") {
          const form = this._createForm(isPlainObject(body) ? body : {});
          return this.send(res, 200, clone(form));
        }
      }

      const formId = parts[1];
      const form = this.forms.get(formId);

      // GET /forms/:id
      if (parts.length === 2 && req.method === "GET") {
        if (!form) return this.notFound(res);
        return this.send(res, 200, clone(form));
      }

      // GET /forms/:id/responses  OR /forms/:id/submissions
      if ((parts[2] === "responses" || parts[2] === "submissions") && parts.length === 3 && req.method === "GET") {
        if (!form) return this.notFound(res);
        const items = clone(this.responses.get(formId));
        const env = this.listEnvelope(items, url);
        // responses endpoint also reports questionId metadata
        env.questions = [];
        env.totalNumberOfSubmissionsPerFilter = { all: items.length, completed: items.length, partial: 0 };
        return this.send(res, 200, env);
      }

      // POST /forms/:id/submissions (parlel helper to seed responses)
      if (parts[2] === "submissions" && parts.length === 3 && req.method === "POST") {
        if (!form) return this.notFound(res);
        return this.createResponse(res, formId, body);
      }
    }

    return this.notFound(res);
  }

  createResponse(res, formId, body) {
    this._respCounter += 1;
    const id = id24("wResp", this._respCounter);
    const response = {
      id,
      formId,
      respondentId: id24("wRid", this._respCounter),
      isCompleted: true,
      submittedAt: "2024-01-01T00:00:00.000Z",
      responses: isPlainObject(body) && Array.isArray(body.responses) ? clone(body.responses) : [],
    };
    this.responses.get(formId).push(response);
    const form = this.forms.get(formId);
    if (form) form.numberOfSubmissions += 1;
    return this.send(res, 200, clone(response));
  }

  listEnvelope(items, url) {
    const page = Number(url.searchParams.get("page")) || 1;
    const limit = Number(url.searchParams.get("limit")) || 50;
    return {
      items,
      page,
      limit,
      total: items.length,
      hasMore: false,
    };
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.notFound(res);
  }

  notFound(res) {
    return this.send(res, 404, { message: "Not Found", statusCode: 404 });
  }

  root() {
    return {
      name: "tally",
      version: "1",
      protocol: "tally-api",
      documentation: "/docs/tally.md",
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
          this.send(res, 400, { message: "Bad request body", statusCode: 400 });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Bad request body", statusCode: 400 });
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
