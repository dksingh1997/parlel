import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/clickup — a tiny, dependency-free fake of the ClickUp API v2.
//
// Speaks the /api/v2 wire protocol. Auth is a raw token in the Authorization
// header (ClickUp does NOT use the Bearer scheme). State is in-memory and
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

// ClickUp error envelope: { err, ECODE }
function cuError(err, ecode = "OAUTH_027") {
  return { err, ECODE: ecode };
}

export class ClickupServer {
  constructor(port = 4790, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.tasks = new Map();
    this.idCounter = 100000;
    this._seedDefaults();
  }

  _nextTaskId() {
    this.idCounter += 1;
    return this.idCounter.toString(36);
  }

  _seedDefaults() {
    this.team = {
      id: "9000001",
      name: "Parlel Team",
      color: "#000000",
      members: [],
    };
    this.user = {
      id: 1,
      username: "parlel",
      email: "parlel@example.com",
      color: "#000000",
      profilePicture: null,
    };
    this.team.members = [{ user: clone(this.user) }];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, cuError(error.message || "Internal server error", "INTERNAL"));
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
    res.setHeader("server", "parlel-clickup");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!(parts[0] === "api" && parts[1] === "v2")) {
      return this.send(res, 404, cuError("Route not found", "ROUTE_001"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, cuError("Token not found", "OAUTH_019"));
    }

    const route = parts.slice(2);

    // GET /api/v2/team
    if (route[0] === "team" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { teams: [clone(this.team)] });
    }
    // GET /api/v2/user
    if (route[0] === "user" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { user: clone(this.user) });
    }

    // GET/POST /api/v2/list/:list_id/task
    if (route[0] === "list" && route[2] === "task" && route.length === 3) {
      return this.handleListTasks(req, res, route[1], body);
    }

    // GET/PUT/DELETE /api/v2/task/:task_id
    if (route[0] === "task" && route.length === 2) {
      return this.handleTask(req, res, route[1], body);
    }

    return this.send(res, 404, cuError("Route not found", "ROUTE_001"));
  }

  handleListTasks(req, res, listId, body) {
    if (req.method === "GET") {
      const tasks = [...this.tasks.values()].filter((t) => t.list.id === String(listId)).map(clone);
      return this.send(res, 200, { tasks });
    }
    if (req.method === "POST") {
      if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
        return this.send(res, 400, cuError("Task name invalid", "INPUT_005"));
      }
      const id = this._nextTaskId();
      const task = {
        id,
        custom_id: null,
        name: body.name,
        description: body.description || "",
        status: {
          status: typeof body.status === "string" ? body.status : "to do",
          color: "#d3d3d3",
          type: "open",
          orderindex: 0,
        },
        priority: body.priority != null ? { priority: String(body.priority), color: "#f50000" } : null,
        assignees: Array.isArray(body.assignees) ? body.assignees.map((a) => ({ id: a })) : [],
        list: { id: String(listId) },
        url: `https://app.clickup.com/t/${id}`,
        date_created: String(Date.now()),
        date_updated: String(Date.now()),
      };
      this.tasks.set(id, task);
      return this.send(res, 200, clone(task));
    }
    return this.send(res, 405, cuError("Method not allowed", "ROUTE_002"));
  }

  handleTask(req, res, taskId, body) {
    const task = this.tasks.get(taskId);
    if (req.method === "GET") {
      if (!task) return this.send(res, 404, cuError("Task not found", "ITEM_013"));
      return this.send(res, 200, clone(task));
    }
    if (req.method === "PUT") {
      if (!task) return this.send(res, 404, cuError("Task not found", "ITEM_013"));
      if (isPlainObject(body)) {
        if (typeof body.name === "string") task.name = body.name;
        if (typeof body.description === "string") task.description = body.description;
        if (typeof body.status === "string") task.status.status = body.status;
        task.date_updated = String(Date.now());
      }
      return this.send(res, 200, clone(task));
    }
    if (req.method === "DELETE") {
      if (!task) return this.send(res, 404, cuError("Task not found", "ITEM_013"));
      this.tasks.delete(taskId);
      return this.send(res, 200, {});
    }
    return this.send(res, 405, cuError("Method not allowed", "ROUTE_002"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, cuError("Route not found", "ROUTE_001"));
  }

  root() {
    return {
      name: "clickup",
      version: "1",
      protocol: "clickup-v2",
      documentation: "/docs/clickup.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // ClickUp uses a raw token (e.g. "pk_..."), no Bearer prefix.
    return auth.trim().length > 0;
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
          this.send(res, 400, cuError("Bad request body", "JSON_001"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, cuError("Bad request body", "JSON_001"));
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
