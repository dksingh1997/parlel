import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/asana — a tiny, dependency-free fake of the Asana API v1.
//
// Speaks the /api/1.0 wire protocol used by the official node-asana client.
// All responses are wrapped in { data: ... }. State is in-memory and
// ephemeral.
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

// Asana error envelope: { errors: [{ message, phrase? }] }
// phrase is only included for 500 errors (for support lookup).
function asanaError(message, phrase) {
  const entry = { message };
  if (phrase) entry.phrase = phrase;
  return { errors: [entry] };
}

export class AsanaServer {
  constructor(port = 4789, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.tasks = new Map();
    this.projects = new Map();
    this.workspaces = new Map();
    this.gidCounter = 1000000;
    this._seedDefaults();
  }

  _nextGid() {
    this.gidCounter += 1;
    return String(this.gidCounter);
  }

  _seedDefaults() {
    const wsGid = this._nextGid();
    this.workspaces.set(wsGid, {
      gid: wsGid,
      resource_type: "workspace",
      name: "Parlel Workspace",
      is_organization: true,
    });
    this.defaultWorkspace = wsGid;

    const projGid = this._nextGid();
    this.projects.set(projGid, {
      gid: projGid,
      resource_type: "project",
      name: "Parlel Project",
      workspace: { gid: wsGid, resource_type: "workspace", name: "Parlel Workspace" },
    });
    this.defaultProject = projGid;

    this.me = {
      gid: this._nextGid(),
      resource_type: "user",
      name: "Parlel User",
      email: "parlel@example.com",
      workspaces: [{ gid: wsGid, resource_type: "workspace", name: "Parlel Workspace" }],
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, asanaError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-asana");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!(parts[0] === "api" && parts[1] === "1.0")) {
      return this.send(res, 404, asanaError("Not Found"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, asanaError("Not Authorized"));
    }

    const route = parts.slice(2);

    if (route[0] === "tasks") return this.handleTasks(req, res, route, body);
    if (route[0] === "projects") return this.handleProjects(req, res, route, body);
    if (route[0] === "workspaces") return this.handleWorkspaces(req, res, route, body);
    if (route[0] === "users" && route[1] === "me" && route.length === 2 && req.method === "GET") {
      return this.send(res, 200, { data: clone(this.me) });
    }

    return this.send(res, 404, asanaError("Not Found"));
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  handleTasks(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
        const workspace = url.searchParams.get("workspace");
        if (!workspace) {
          return this.send(res, 400, asanaError("workspace: Missing input"));
        }
        return this.send(res, 200, { data: [...this.tasks.values()].map(clone) });
      }
      if (req.method === "POST") {
        const data = isPlainObject(body) && isPlainObject(body.data) ? body.data : body;
        if (!isPlainObject(data) || typeof data.name !== "string" || !data.name) {
          return this.send(res, 400, asanaError("name: Missing input"));
        }
        const gid = this._nextGid();
        const task = {
          gid,
          resource_type: "task",
          name: data.name,
          notes: data.notes || "",
          html_notes: data.html_notes || "",
          completed: Boolean(data.completed),
          assignee: data.assignee ? { gid: String(data.assignee), resource_type: "user" } : null,
          due_on: data.due_on || null,
          due_at: data.due_at || null,
          start_on: data.start_on || null,
          projects: Array.isArray(data.projects)
            ? data.projects.map((p) => ({ gid: String(p), resource_type: "project" }))
            : [],
          workspace: data.workspace
            ? { gid: String(data.workspace), resource_type: "workspace" }
            : { gid: this.defaultWorkspace, resource_type: "workspace" },
          created_at: new Date().toISOString(),
          modified_at: new Date().toISOString(),
        };
        this.tasks.set(gid, task);
        return this.send(res, 201, { data: clone(task) });
      }
      return this.send(res, 405, asanaError("Method Not Allowed"));
    }

    const gid = route[1];
    const task = this.tasks.get(gid);

    if (route.length === 2) {
      if (req.method === "GET") {
        if (!task) return this.send(res, 404, asanaError("task: Not Found"));
        return this.send(res, 200, { data: clone(task) });
      }
      if (req.method === "PUT") {
        if (!task) return this.send(res, 404, asanaError("task: Not Found"));
        const data = isPlainObject(body) && isPlainObject(body.data) ? body.data : body;
        if (isPlainObject(data)) {
          if (typeof data.name === "string") task.name = data.name;
          if (typeof data.notes === "string") task.notes = data.notes;
          if (typeof data.html_notes === "string") task.html_notes = data.html_notes;
          if (typeof data.completed === "boolean") task.completed = data.completed;
          if (data.due_on !== undefined) task.due_on = data.due_on;
          if (data.due_at !== undefined) task.due_at = data.due_at;
          if (data.start_on !== undefined) task.start_on = data.start_on;
          if (data.assignee !== undefined) {
            task.assignee = data.assignee ? { gid: String(data.assignee), resource_type: "user" } : null;
          }
          task.modified_at = new Date().toISOString();
        }
        return this.send(res, 200, { data: clone(task) });
      }
      if (req.method === "DELETE") {
        if (!task) return this.send(res, 404, asanaError("task: Not Found"));
        this.tasks.delete(gid);
        return this.send(res, 200, { data: {} });
      }
      return this.send(res, 405, asanaError("Method Not Allowed"));
    }

    return this.send(res, 404, asanaError("Not Found"));
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  handleProjects(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
        const workspace = url.searchParams.get("workspace");
        if (!workspace) {
          return this.send(res, 400, asanaError("workspace: Missing input"));
        }
        return this.send(res, 200, { data: [...this.projects.values()].map(clone) });
      }
      if (req.method === "POST") {
        const data = isPlainObject(body) && isPlainObject(body.data) ? body.data : body;
        if (!isPlainObject(data) || typeof data.name !== "string" || !data.name) {
          return this.send(res, 400, asanaError("name: Missing input"));
        }
        const gid = this._nextGid();
        const project = {
          gid,
          resource_type: "project",
          name: data.name,
          workspace: { gid: data.workspace ? String(data.workspace) : this.defaultWorkspace, resource_type: "workspace" },
        };
        this.projects.set(gid, project);
        return this.send(res, 201, { data: clone(project) });
      }
      return this.send(res, 405, asanaError("Method Not Allowed"));
    }

    const gid = route[1];
    const project = this.projects.get(gid);
    if (route.length === 2 && req.method === "GET") {
      if (!project) return this.send(res, 404, asanaError("project: Not Found"));
      return this.send(res, 200, { data: clone(project) });
    }
    return this.send(res, 404, asanaError("Not Found"));
  }

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------
  handleWorkspaces(req, res, route, body) {
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { data: [...this.workspaces.values()].map(clone) });
    }
    const gid = route[1];
    const ws = this.workspaces.get(gid);
    if (route.length === 2 && req.method === "GET") {
      if (!ws) return this.send(res, 404, asanaError("workspace: Not Found"));
      return this.send(res, 200, { data: clone(ws) });
    }
    return this.send(res, 404, asanaError("Not Found"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, asanaError("Not Found"));
  }

  root() {
    return {
      name: "asana",
      version: "1",
      protocol: "asana-v1",
      documentation: "/docs/asana.md",
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
          this.send(res, 400, asanaError("Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, asanaError("Bad request body"));
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
