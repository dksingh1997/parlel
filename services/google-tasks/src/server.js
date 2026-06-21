// parlel/google-tasks - lightweight, dependency-free fake of Google Tasks API v1.
// Compatible with the `googleapis` Tasks client when its rootUrl is pointed at
// this server. State is in-memory and ephemeral. Reset with reset() or
// POST /_parlel/reset.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

class ApiError extends Error {
  constructor(code, message, reason = "badRequest", status) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.status = status || statusForCode(code);
  }
}

function statusForCode(code) {
  return {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "ALREADY_EXISTS",
    500: "INTERNAL",
  }[code] || "UNKNOWN";
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function etag() {
  return `\"${randomBytes(8).toString("hex")}\"`;
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function boolParam(q, name, defaultValue) {
  const value = q.get(name);
  if (value === null || value === undefined) return defaultValue;
  return value === "true";
}

function compareIso(value, min, max) {
  if (min && (!value || value < min)) return false;
  if (max && (!value || value > max)) return false;
  return true;
}

export class GoogleTasksServer {
  constructor(port = 4626, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.tasklists = new Map();
    this.tasks = new Map();
    this.listCounter = 0;
    this.taskCounter = 0;
    const defaultList = this.makeTaskList({ id: "@default", title: "My Tasks" });
    this.tasklists.set(defaultList.id, defaultList);
    this.tasks.set(defaultList.id, new Map());
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, error instanceof ApiError ? error : new ApiError(500, error.message || "Internal error", "backendError"));
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

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = url.pathname;
    res.setHeader("x-google-tasks-emulator", "parlel");

    if (pathname === "/_parlel/health") return this.sendJson(res, 200, { status: "ok", service: "google-tasks", tasklists: this.tasklists.size, tasks: this.totalTasks() });
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/" || pathname === "/tasks/v1" || pathname === "/v1") return this.sendJson(res, 200, { kind: "tasks#parlel" });

    const body = this.parseJson(await this.readBody(req));
    const prefix = pathname.startsWith("/tasks/v1/") ? "/tasks/v1/" : pathname.startsWith("/v1/") ? "/v1/" : null;
    if (!prefix) throw new ApiError(404, "Not Found", "notFound");
    return this.route(res, method, splitPath(pathname.slice(prefix.length)), url.searchParams, body);
  }

  route(res, method, parts, q, body) {
    if (parts[0] === "users" && parts[1] === "@me" && parts[2] === "lists") return this.routeTasklists(res, method, parts.slice(3), q, body);
    if (parts[0] === "lists" && parts[2] === "tasks") return this.routeTasks(res, method, parts[1], parts.slice(3), q, body);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeTasklists(res, method, parts, q, body) {
    if (parts.length === 0) {
      if (method === "GET") return this.listTasklists(res, q);
      if (method === "POST") return this.insertTasklist(res, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1) {
      if (method === "GET") return this.getTasklist(res, parts[0]);
      if (method === "PATCH" || method === "PUT") return this.updateTasklist(res, parts[0], body, method === "PUT");
      if (method === "DELETE") return this.deleteTasklist(res, parts[0]);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeTasks(res, method, tasklistId, parts, q, body) {
    this.mustTasklist(tasklistId);
    if (parts.length === 0) {
      if (method === "GET") return this.listTasks(res, tasklistId, q);
      if (method === "POST") return this.insertTask(res, tasklistId, body, q);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1 && parts[0] === "clear") {
      if (method === "POST") return this.clearTasks(res, tasklistId);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1) {
      if (method === "GET") return this.getTask(res, tasklistId, parts[0]);
      if (method === "PATCH" || method === "PUT") return this.updateTask(res, tasklistId, parts[0], body, method === "PUT");
      if (method === "DELETE") return this.deleteTask(res, tasklistId, parts[0]);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 2 && parts[1] === "move" && method === "POST") return this.moveTask(res, tasklistId, parts[0], q);
    throw new ApiError(404, "Not Found", "notFound");
  }

  listTasklists(res, q) {
    const items = [...this.tasklists.values()].sort((a, b) => a.updated.localeCompare(b.updated));
    return this.sendPage(res, "tasks#taskLists", items.map(clone), q);
  }

  insertTasklist(res, body) {
    const tasklist = this.makeTaskList(body);
    if (this.tasklists.has(tasklist.id)) throw new ApiError(409, "Task list already exists", "alreadyExists");
    this.tasklists.set(tasklist.id, tasklist);
    this.tasks.set(tasklist.id, new Map());
    return this.sendJson(res, 200, clone(tasklist));
  }

  getTasklist(res, tasklistId) {
    return this.sendJson(res, 200, clone(this.mustTasklist(tasklistId)));
  }

  updateTasklist(res, tasklistId, body, replace) {
    const current = this.mustTasklist(tasklistId);
    const updated = replace ? this.makeTaskList({ id: tasklistId, ...body }) : { ...current, ...clone(body) };
    updated.id = tasklistId;
    updated.kind = "tasks#taskList";
    updated.updated = now();
    updated.etag = etag();
    updated.selfLink = this.tasklistSelfLink(tasklistId);
    this.tasklists.set(tasklistId, updated);
    return this.sendJson(res, 200, clone(updated));
  }

  deleteTasklist(res, tasklistId) {
    this.mustTasklist(tasklistId);
    this.tasklists.delete(tasklistId);
    this.tasks.delete(tasklistId);
    return this.sendEmpty(res, 204);
  }

  listTasks(res, tasklistId, q) {
    this.validateDateRange(q, "completedMin", "completedMax");
    this.validateDateRange(q, "dueMin", "dueMax");
    const showCompleted = boolParam(q, "showCompleted", true);
    const showDeleted = boolParam(q, "showDeleted", false);
    const showHidden = boolParam(q, "showHidden", false);
    let items = [...this.mustTaskMap(tasklistId).values()];
    items = items.filter((task) => {
      if (task.status === "completed" && !showCompleted) return false;
      if (task.deleted && !showDeleted) return false;
      if (task.hidden && !showHidden) return false;
      if (q.get("updatedMin") && task.updated < q.get("updatedMin")) return false;
      if (!compareIso(task.completed, q.get("completedMin"), q.get("completedMax"))) return false;
      if (!compareIso(task.due, q.get("dueMin"), q.get("dueMax"))) return false;
      return true;
    });
    items.sort((a, b) => a.position.localeCompare(b.position));
    return this.sendPage(res, "tasks#tasks", items.map(clone), q);
  }

  insertTask(res, tasklistId, body, q) {
    const task = this.makeTask(tasklistId, body);
    const taskMap = this.mustTaskMap(tasklistId);
    if (taskMap.has(task.id)) throw new ApiError(409, "Task already exists", "alreadyExists");
    taskMap.set(task.id, task);
    this.placeTask(tasklistId, task.id, q.get("parent") || task.parent, q.get("previous") || null);
    return this.sendJson(res, 200, clone(taskMap.get(task.id)));
  }

  getTask(res, tasklistId, taskId) {
    return this.sendJson(res, 200, clone(this.mustTask(tasklistId, taskId)));
  }

  updateTask(res, tasklistId, taskId, body, replace) {
    const current = this.mustTask(tasklistId, taskId);
    const replacement = replace ? this.makeTask(tasklistId, { id: taskId, ...body, parent: current.parent, position: current.position }) : { ...current, ...clone(body) };
    replacement.id = taskId;
    replacement.kind = "tasks#task";
    replacement.updated = now();
    replacement.etag = etag();
    replacement.selfLink = this.taskSelfLink(tasklistId, taskId);
    if (replacement.status === "completed" && !replacement.completed) replacement.completed = now();
    if (replacement.status !== "completed") delete replacement.completed;
    this.mustTaskMap(tasklistId).set(taskId, replacement);
    return this.sendJson(res, 200, clone(replacement));
  }

  deleteTask(res, tasklistId, taskId) {
    this.mustTask(tasklistId, taskId);
    this.mustTaskMap(tasklistId).delete(taskId);
    return this.sendEmpty(res, 204);
  }

  moveTask(res, tasklistId, taskId, q) {
    this.mustTask(tasklistId, taskId);
    this.placeTask(tasklistId, taskId, q.get("parent"), q.get("previous"));
    const moved = this.mustTask(tasklistId, taskId);
    moved.updated = now();
    moved.etag = etag();
    return this.sendJson(res, 200, clone(moved));
  }

  clearTasks(res, tasklistId) {
    for (const task of this.mustTaskMap(tasklistId).values()) {
      if (task.status === "completed" && !task.deleted) {
        task.hidden = true;
        task.updated = now();
        task.etag = etag();
      }
    }
    return this.sendEmpty(res, 204);
  }

  makeTaskList(input = {}) {
    const tasklistId = input.id || `tasklist_${++this.listCounter}`;
    const timestamp = now();
    return {
      kind: "tasks#taskList",
      id: tasklistId,
      etag: input.etag || etag(),
      title: input.title || "Untitled list",
      updated: input.updated || timestamp,
      selfLink: this.tasklistSelfLink(tasklistId),
    };
  }

  makeTask(tasklistId, input = {}) {
    const taskId = input.id || `task_${++this.taskCounter}`;
    const timestamp = now();
    const task = {
      kind: "tasks#task",
      id: taskId,
      etag: input.etag || etag(),
      title: input.title || "",
      updated: input.updated || timestamp,
      selfLink: this.taskSelfLink(tasklistId, taskId),
      position: input.position || this.nextPosition(tasklistId),
      status: input.status || "needsAction",
      links: Array.isArray(input.links) ? clone(input.links) : [],
    };
    for (const key of ["parent", "notes", "due", "completed", "deleted", "hidden"]) {
      if (Object.prototype.hasOwnProperty.call(input, key)) task[key] = clone(input[key]);
    }
    if (task.status === "completed" && !task.completed) task.completed = timestamp;
    if (task.status !== "completed") delete task.completed;
    return task;
  }

  placeTask(tasklistId, taskId, parent, previous) {
    const taskMap = this.mustTaskMap(tasklistId);
    const task = this.mustTask(tasklistId, taskId);
    if (parent) this.mustTask(tasklistId, parent);
    if (previous) this.mustTask(tasklistId, previous);
    if (previous && parent !== (taskMap.get(previous).parent || undefined)) throw new ApiError(400, "Previous task must have the same parent", "invalidArgument");
    task.parent = parent || undefined;
    if (!task.parent) delete task.parent;

    const siblings = [...taskMap.values()]
      .filter((item) => item.id !== taskId && (item.parent || undefined) === (task.parent || undefined))
      .sort((a, b) => a.position.localeCompare(b.position));
    let index = 0;
    if (previous) index = siblings.findIndex((item) => item.id === previous) + 1;
    siblings.splice(index < 0 ? 0 : index, 0, task);
    siblings.forEach((item, position) => {
      item.position = String((position + 1) * 100000).padStart(20, "0");
    });
  }

  nextPosition(tasklistId) {
    const size = this.tasks.get(tasklistId)?.size || 0;
    return String((size + 1) * 100000).padStart(20, "0");
  }

  validateDateRange(q, minName, maxName) {
    const min = q.get(minName);
    const max = q.get(maxName);
    if (min && Number.isNaN(Date.parse(min))) throw new ApiError(400, `Invalid value for ${minName}`, "invalidArgument");
    if (max && Number.isNaN(Date.parse(max))) throw new ApiError(400, `Invalid value for ${maxName}`, "invalidArgument");
    if (min && max && min > max) throw new ApiError(400, `${minName} must not be greater than ${maxName}`, "invalidArgument");
  }

  mustTasklist(tasklistId) {
    const tasklist = this.tasklists.get(tasklistId);
    if (!tasklist) throw new ApiError(404, "Task list not found", "notFound");
    return tasklist;
  }

  mustTaskMap(tasklistId) {
    this.mustTasklist(tasklistId);
    const taskMap = this.tasks.get(tasklistId);
    if (!taskMap) throw new ApiError(404, "Task list not found", "notFound");
    return taskMap;
  }

  mustTask(tasklistId, taskId) {
    const task = this.mustTaskMap(tasklistId).get(taskId);
    if (!task) throw new ApiError(404, "Task not found", "notFound");
    return task;
  }

  tasklistSelfLink(tasklistId) {
    return `https://tasks.googleapis.com/tasks/v1/users/@me/lists/${encodeURIComponent(tasklistId)}`;
  }

  taskSelfLink(tasklistId, taskId) {
    return `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`;
  }

  totalTasks() {
    return [...this.tasks.values()].reduce((count, taskMap) => count + taskMap.size, 0);
  }

  sendPage(res, kind, items, q) {
    const max = Math.max(1, Math.min(Number(q.get("maxResults") || items.length || 100), 100));
    const start = Number(q.get("pageToken") || 0);
    if (!Number.isInteger(start) || start < 0) throw new ApiError(400, "Invalid page token", "invalidArgument");
    const pageItems = items.slice(start, start + max);
    const body = { kind, etag: etag(), items: pageItems };
    if (start + max < items.length) body.nextPageToken = String(start + max);
    return this.sendJson(res, 200, body);
  }

  parseJson(buffer) {
    if (!buffer.length) return {};
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new ApiError(400, "Invalid JSON payload received. Unknown name.", "parseError");
    }
  }

  sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=UTF-8");
    res.setHeader("content-length", Buffer.byteLength(body));
    res.end(body);
  }

  sendEmpty(res, status) {
    res.statusCode = status;
    res.end();
  }

  sendError(res, error) {
    const code = error.code || 500;
    return this.sendJson(res, code, {
      error: {
        code,
        message: error.message,
        errors: [{ message: error.message, domain: "global", reason: error.reason || "backendError" }],
        status: error.status || statusForCode(code),
      },
    });
  }
}

export default GoogleTasksServer;
