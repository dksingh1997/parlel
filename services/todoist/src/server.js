import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/todoist — a tiny, dependency-free fake of the Todoist REST API v2.
//
// Speaks the /rest/v2 wire protocol used by the official @doist/todoist-api
// client. Bearer auth. State is in-memory and ephemeral.
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

export class TodoistServer {
  constructor(port = 4793, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.tasks = new Map();
    this.projects = new Map();
    this.idCounter = 6000000000;
    this._seedDefaults();
  }

  _nextId() {
    this.idCounter += 1;
    return String(this.idCounter);
  }

  _seedDefaults() {
    const id = this._nextId();
    this.projects.set(id, {
      id,
      name: "Inbox",
      color: "charcoal",
      is_shared: false,
      is_favorite: false,
      is_inbox_project: true,
      view_style: "list",
      url: `https://todoist.com/showProject?id=${id}`,
      parent_id: null,
      order: 0,
    });
    this.inboxProject = id;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: error.message || "Internal server error" });
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("server", "parlel-todoist");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!(parts[0] === "rest" && parts[1] === "v2")) {
      return this.send(res, 404, { error: "Not found" });
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { error: "Authentication is required, and has failed or has not yet been provided." });
    }

    const route = parts.slice(2);

    if (route[0] === "tasks") return this.handleTasks(req, res, route, body, url);
    if (route[0] === "projects") return this.handleProjects(req, res, route, body);

    return this.send(res, 404, { error: "Not found" });
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  handleTasks(req, res, route, body, url) {
    if (route.length === 1) {
      if (req.method === "GET") {
        let tasks = [...this.tasks.values()].filter((t) => !t.is_completed);
        const projectId = url.searchParams.get("project_id");
        if (projectId) tasks = tasks.filter((t) => t.project_id === projectId);
        return this.send(res, 200, tasks.map(clone));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.content !== "string" || !body.content) {
          return this.send(res, 400, { error: "content is required" });
        }
        const id = this._nextId();
        const task = {
          id,
          content: body.content,
          description: body.description || "",
          project_id: body.project_id ? String(body.project_id) : this.inboxProject,
          section_id: body.section_id || null,
          parent_id: body.parent_id || null,
          order: 1,
          priority: Number.isFinite(body.priority) ? body.priority : 1,
          labels: Array.isArray(body.labels) ? clone(body.labels) : [],
          due: body.due_string || body.due_date ? { string: body.due_string || body.due_date } : null,
          is_completed: false,
          creator_id: "1",
          created_at: new Date().toISOString(),
          url: `https://todoist.com/showTask?id=${id}`,
          comment_count: 0,
        };
        this.tasks.set(id, task);
        return this.send(res, 200, clone(task));
      }
      return this.send(res, 405, { error: "Method not allowed" });
    }

    const id = route[1];
    const task = this.tasks.get(id);

    // POST /rest/v2/tasks/:id/close
    if (route.length === 3 && route[2] === "close" && req.method === "POST") {
      if (!task) return this.send(res, 404, { error: "Task not found" });
      task.is_completed = true;
      return this.send(res, 204, null);
    }
    // POST /rest/v2/tasks/:id/reopen
    if (route.length === 3 && route[2] === "reopen" && req.method === "POST") {
      if (!task) return this.send(res, 404, { error: "Task not found" });
      task.is_completed = false;
      return this.send(res, 204, null);
    }

    if (route.length === 2) {
      if (req.method === "GET") {
        if (!task) return this.send(res, 404, { error: "Task not found" });
        return this.send(res, 200, clone(task));
      }
      // Todoist REST v2 updates use POST /tasks/:id.
      if (req.method === "POST") {
        if (!task) return this.send(res, 404, { error: "Task not found" });
        if (isPlainObject(body)) {
          if (typeof body.content === "string") task.content = body.content;
          if (typeof body.description === "string") task.description = body.description;
          if (Number.isFinite(body.priority)) task.priority = body.priority;
          if (Array.isArray(body.labels)) task.labels = clone(body.labels);
        }
        return this.send(res, 200, clone(task));
      }
      if (req.method === "DELETE") {
        if (!task) return this.send(res, 404, { error: "Task not found" });
        this.tasks.delete(id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, { error: "Method not allowed" });
    }

    return this.send(res, 404, { error: "Not found" });
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  handleProjects(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.projects.values()].map(clone));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 400, { error: "name is required" });
        }
        const id = this._nextId();
        const project = {
          id,
          name: body.name,
          color: body.color || "charcoal",
          is_shared: false,
          is_favorite: Boolean(body.is_favorite),
          is_inbox_project: false,
          view_style: body.view_style || "list",
          url: `https://todoist.com/showProject?id=${id}`,
          parent_id: body.parent_id || null,
          order: this.projects.size,
        };
        this.projects.set(id, project);
        return this.send(res, 200, clone(project));
      }
      return this.send(res, 405, { error: "Method not allowed" });
    }

    const id = route[1];
    const project = this.projects.get(id);
    if (route.length === 2 && req.method === "GET") {
      if (!project) return this.send(res, 404, { error: "Project not found" });
      return this.send(res, 200, clone(project));
    }
    return this.send(res, 404, { error: "Not found" });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: "Not found" });
  }

  root() {
    return {
      name: "todoist",
      version: "1",
      protocol: "todoist-rest-v2",
      documentation: "/docs/todoist.md",
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
          this.send(res, 400, { error: "Bad request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { error: "Bad request body" });
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
