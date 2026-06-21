// parlel/cloudtasks — a lightweight, dependency-free fake of Google Cloud Tasks.
//
// Speaks the Cloud Tasks v2 REST API (https://cloudtasks.googleapis.com/v2) so
// that application code using the real `@google-cloud/tasks` client can run
// against it with zero cost and zero side effects. Pure Node.js, no external
// npm dependencies. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).
//
// Point the low-level gapic client at this server with:
//   new CloudTasksClient({
//     projectId: "parlel",
//     fallback: true,        // use HTTP/1.1 REST transport, not gRPC
//     protocol: "http",
//     apiEndpoint: "127.0.0.1",
//     port: 4584,
//   })
//
// The google-gax REST fallback transcodes RPCs to these endpoints
// (google.api.http annotations from the Cloud Tasks v2 proto):
//
//   CloudTasks service
//   GET    /v2/{parent=projects/*/locations/*}/queues               ListQueues
//   GET    /v2/{name=projects/*/locations/*/queues/*}               GetQueue
//   POST   /v2/{parent=projects/*/locations/*}/queues               CreateQueue
//   PATCH  /v2/{queue.name=projects/*/locations/*/queues/*}         UpdateQueue
//   DELETE /v2/{name=projects/*/locations/*/queues/*}               DeleteQueue
//   POST   /v2/{name=projects/*/locations/*/queues/*}:purge         PurgeQueue
//   POST   /v2/{name=projects/*/locations/*/queues/*}:pause         PauseQueue
//   POST   /v2/{name=projects/*/locations/*/queues/*}:resume        ResumeQueue
//   POST   /v2/{resource=.../queues/*}:getIamPolicy                 GetIamPolicy
//   POST   /v2/{resource=.../queues/*}:setIamPolicy                 SetIamPolicy
//   POST   /v2/{resource=.../queues/*}:testIamPermissions           TestIamPermissions
//   GET    /v2/{parent=.../queues/*}/tasks                          ListTasks
//   GET    /v2/{name=.../queues/*/tasks/*}                          GetTask
//   POST   /v2/{parent=.../queues/*}/tasks                          CreateTask
//   DELETE /v2/{name=.../queues/*/tasks/*}                          DeleteTask
//   POST   /v2/{name=.../queues/*/tasks/*}:run                      RunTask
//
//   Locations mixin (google.cloud.location)
//   GET    /v2/{name=projects/*}/locations                         ListLocations
//   GET    /v2/{name=projects/*/locations/*}                       GetLocation

import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// gRPC canonical status codes (used to derive HTTP status + error shape).
// ---------------------------------------------------------------------------
const GRPC = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};

// The google-gax REST decoder maps an error by the HTTP status code we send.
// We pick the HTTP status whose canonical mapping recovers the intended gRPC
// status on the client side. ALREADY_EXISTS has no HTTP status that decodes
// back to code 6 through the gax REST table, and 409 decodes to ABORTED which
// is retried; we therefore surface create-conflicts as FAILED_PRECONDITION
// (412 -> code 9): a non-retryable, immediately-rejecting status.
const GRPC_TO_HTTP = {
  [GRPC.OK]: 200,
  [GRPC.CANCELLED]: 499,
  [GRPC.UNKNOWN]: 500,
  [GRPC.INVALID_ARGUMENT]: 400,
  [GRPC.DEADLINE_EXCEEDED]: 504,
  [GRPC.NOT_FOUND]: 404,
  [GRPC.ALREADY_EXISTS]: 409,
  [GRPC.PERMISSION_DENIED]: 403,
  [GRPC.RESOURCE_EXHAUSTED]: 429,
  [GRPC.FAILED_PRECONDITION]: 400,
  [GRPC.ABORTED]: 409,
  [GRPC.OUT_OF_RANGE]: 400,
  [GRPC.UNIMPLEMENTED]: 501,
  [GRPC.INTERNAL]: 500,
  [GRPC.UNAVAILABLE]: 503,
  [GRPC.DATA_LOSS]: 500,
  [GRPC.UNAUTHENTICATED]: 401,
};

const GRPC_STATUS_NAME = {
  [GRPC.OK]: "OK",
  [GRPC.CANCELLED]: "CANCELLED",
  [GRPC.UNKNOWN]: "UNKNOWN",
  [GRPC.INVALID_ARGUMENT]: "INVALID_ARGUMENT",
  [GRPC.DEADLINE_EXCEEDED]: "DEADLINE_EXCEEDED",
  [GRPC.NOT_FOUND]: "NOT_FOUND",
  [GRPC.ALREADY_EXISTS]: "ALREADY_EXISTS",
  [GRPC.PERMISSION_DENIED]: "PERMISSION_DENIED",
  [GRPC.RESOURCE_EXHAUSTED]: "RESOURCE_EXHAUSTED",
  [GRPC.FAILED_PRECONDITION]: "FAILED_PRECONDITION",
  [GRPC.ABORTED]: "ABORTED",
  [GRPC.OUT_OF_RANGE]: "OUT_OF_RANGE",
  [GRPC.UNIMPLEMENTED]: "UNIMPLEMENTED",
  [GRPC.INTERNAL]: "INTERNAL",
  [GRPC.UNAVAILABLE]: "UNAVAILABLE",
  [GRPC.DATA_LOSS]: "DATA_LOSS",
  [GRPC.UNAUTHENTICATED]: "UNAUTHENTICATED",
};

// Queue/Task id validation: queue ids are [a-zA-Z0-9-] up to 100 chars; task
// ids are [a-zA-Z0-9_-] up to 500 chars.
const QUEUE_ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,500}$/;

class TasksError extends Error {
  constructor(grpcCode, message) {
    super(message);
    this.grpcCode = grpcCode;
  }
}

// View enum (Task.View) — REST fallback emits ints, gRPC uses names.
const TASK_VIEW = {
  0: "VIEW_UNSPECIFIED",
  1: "BASIC",
  2: "FULL",
  VIEW_UNSPECIFIED: "VIEW_UNSPECIFIED",
  BASIC: "BASIC",
  FULL: "FULL",
};
function normView(v) {
  if (v === undefined || v === null) return "BASIC";
  return TASK_VIEW[v] || "BASIC";
}

// Queue.State enum.
const QUEUE_STATE = {
  0: "STATE_UNSPECIFIED",
  1: "RUNNING",
  2: "PAUSED",
  3: "DISABLED",
};

export class CloudtasksServer {
  constructor(port = 4584, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.projectId = options.projectId || "parlel";
    // Locations advertised by ListLocations / GetLocation.
    this.locations = options.locations || ["us-central1", "us-east1", "europe-west1"];
    this.server = null;
    this.reset();
  }

  reset() {
    // queues: Map<fullName, QueueRecord>
    this.queues = new Map();
    // tasks live inside their queue record (queue.tasks: Map<fullName, Task>).
    // policies: Map<resourceName, Policy>
    this.policies = new Map();
    this._seq = 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (error instanceof TasksError) {
            this.sendError(res, error.grpcCode, error.message);
          } else {
            this.sendError(res, GRPC.INTERNAL, error.message || "internal error");
          }
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
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    // Internal parlel endpoints (not part of Cloud Tasks).
    if (pathname === "/_parlel/health") {
      let taskCount = 0;
      for (const queue of this.queues.values()) taskCount += queue.tasks.size;
      return this.sendJson(res, 200, {
        status: "ok",
        service: "cloudtasks",
        queues: this.queues.size,
        tasks: taskCount,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/_parlel/dump" && method === "GET") {
      return this.sendJson(res, 200, {
        queues: [...this.queues.values()].map((qd) => ({
          ...cleanQueue(qd),
          tasks: [...qd.tasks.values()].map((t) => cleanTask(t, "FULL")),
        })),
      });
    }

    const rawBody = await this.readBody(req);
    let body = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new TasksError(GRPC.INVALID_ARGUMENT, "Invalid JSON body");
      }
    }

    // The CloudTasks service is versioned at /v2/, but the shared Locations
    // mixin (google.cloud.location.Locations) is served at /v1/. Accept both
    // prefixes so getLocation / listLocations transcode correctly.
    let rest;
    if (pathname.startsWith("/v2/")) {
      rest = pathname.slice("/v2/".length);
    } else if (pathname.startsWith("/v1/")) {
      rest = pathname.slice("/v1/".length);
    } else {
      throw new TasksError(GRPC.NOT_FOUND, "Not Found");
    }

    // Split off a trailing custom verb ":<verb>".
    const colon = rest.lastIndexOf(":");
    let verb = null;
    let resourcePath = rest;
    if (colon !== -1 && !rest.slice(colon + 1).includes("/")) {
      verb = rest.slice(colon + 1);
      resourcePath = rest.slice(0, colon);
    }

    const segs = resourcePath.split("/");
    // segs forms:
    //   projects/{p}/locations                                   (list locations)
    //   projects/{p}/locations/{loc}                             (get location)
    //   projects/{p}/locations/{loc}/queues                      (list/create queue)
    //   projects/{p}/locations/{loc}/queues/{q}                  (get/update/delete queue)
    //   projects/{p}/locations/{loc}/queues/{q}/tasks            (list/create task)
    //   projects/{p}/locations/{loc}/queues/{q}/tasks/{t}        (get/delete task)

    // ---- custom verbs ----
    if (verb) {
      switch (verb) {
        case "purge":
          return this.purgeQueue(res, resourcePath);
        case "pause":
          return this.pauseQueue(res, resourcePath);
        case "resume":
          return this.resumeQueue(res, resourcePath);
        case "run":
          return this.runTask(res, resourcePath, body);
        case "getIamPolicy":
          return this.getIamPolicy(res, resourcePath, body);
        case "setIamPolicy":
          return this.setIamPolicy(res, resourcePath, body);
        case "testIamPermissions":
          return this.testIamPermissions(res, resourcePath, body);
        default:
          throw new TasksError(GRPC.UNIMPLEMENTED, `Unknown verb: ${verb}`);
      }
    }

    // ---- Locations mixin ----
    // projects/{p}/locations
    if (segs.length === 3 && segs[0] === "projects" && segs[2] === "locations" && method === "GET") {
      return this.listLocations(res, `projects/${segs[1]}`, q);
    }
    // projects/{p}/locations/{loc}
    if (segs.length === 4 && segs[0] === "projects" && segs[2] === "locations" && method === "GET") {
      return this.getLocation(res, resourcePath);
    }

    // ---- queues collection: projects/{p}/locations/{loc}/queues ----
    if (segs.length === 5 && segs[4] === "queues") {
      const parent = segs.slice(0, 4).join("/");
      if (method === "GET") return this.listQueues(res, parent, q);
      if (method === "POST") return this.createQueue(res, parent, body);
      throw new TasksError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    // ---- single queue: projects/{p}/locations/{loc}/queues/{q} ----
    if (segs.length === 6 && segs[4] === "queues") {
      const name = resourcePath;
      if (method === "GET") return this.getQueue(res, name);
      if (method === "PATCH") return this.updateQueue(res, name, body, q);
      if (method === "DELETE") return this.deleteQueue(res, name);
      throw new TasksError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    // ---- tasks collection: .../queues/{q}/tasks ----
    if (segs.length === 7 && segs[4] === "queues" && segs[6] === "tasks") {
      const parent = segs.slice(0, 6).join("/");
      if (method === "GET") return this.listTasks(res, parent, q);
      if (method === "POST") return this.createTask(res, parent, body);
      throw new TasksError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    // ---- single task: .../queues/{q}/tasks/{t} ----
    if (segs.length === 8 && segs[4] === "queues" && segs[6] === "tasks") {
      const name = resourcePath;
      if (method === "GET") return this.getTask(res, name, q);
      if (method === "DELETE") return this.deleteTask(res, name);
      throw new TasksError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    throw new TasksError(GRPC.NOT_FOUND, `Unrecognized path: /v2/${rest}`);
  }

  // =========================================================================
  // Locations
  // =========================================================================
  listLocations(res, parent, q) {
    const m = parent.match(/^projects\/([^/]+)$/);
    if (!m) throw new TasksError(GRPC.INVALID_ARGUMENT, `Invalid parent: ${parent}`);
    const project = m[1];
    const all = this.locations.map((loc) => this._locationResource(project, loc));
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      locations: page,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  getLocation(res, name) {
    const m = name.match(/^projects\/([^/]+)\/locations\/([^/]+)$/);
    if (!m) throw new TasksError(GRPC.INVALID_ARGUMENT, `Invalid location name: ${name}`);
    const [, project, loc] = m;
    if (!this.locations.includes(loc)) {
      throw new TasksError(GRPC.NOT_FOUND, `Location not found: ${name}`);
    }
    return this.sendJson(res, 200, this._locationResource(project, loc));
  }

  _locationResource(project, loc) {
    return {
      name: `projects/${project}/locations/${loc}`,
      locationId: loc,
      displayName: loc,
      labels: {},
    };
  }

  // =========================================================================
  // Queues
  // =========================================================================
  createQueue(res, parent, body) {
    const m = parent.match(/^projects\/([^/]+)\/locations\/([^/]+)$/);
    if (!m) throw new TasksError(GRPC.INVALID_ARGUMENT, `Invalid parent: ${parent}`);
    const queue = body.queue || body;
    if (!queue || !queue.name) {
      throw new TasksError(GRPC.INVALID_ARGUMENT, "Queue.name is required");
    }
    this._assertQueueName(queue.name);
    if (!queue.name.startsWith(`${parent}/queues/`)) {
      throw new TasksError(
        GRPC.INVALID_ARGUMENT,
        `Queue name must be under parent ${parent}`,
      );
    }
    if (this.queues.has(queue.name)) {
      throw new TasksError(GRPC.ALREADY_EXISTS, `Queue already exists: ${queue.name}`);
    }
    const record = this._newQueueRecord(queue);
    this.queues.set(queue.name, record);
    return this.sendJson(res, 200, cleanQueue(record));
  }

  getQueue(res, name) {
    const queue = this.queues.get(name);
    if (!queue) throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${name}`);
    return this.sendJson(res, 200, cleanQueue(queue));
  }

  updateQueue(res, name, body, q) {
    // name here is the path resource (queue.name). The update payload sits in
    // body.queue (REST body binding is "queue").
    const update = body.queue || body;
    const queue = this.queues.get(name);
    const mask = fieldsOf(body.updateMask || q.get("updateMask"));
    if (!queue) {
      // UpdateQueue creates the queue if it does not exist (upsert semantics).
      this._assertQueueName(name);
      const record = this._newQueueRecord({ ...update, name });
      this.queues.set(name, record);
      return this.sendJson(res, 200, cleanQueue(record));
    }
    // Ensure mutable sub-objects exist with defaults before partial patching.
    if (!queue.rateLimits) queue.rateLimits = normRateLimits();
    if (!queue.retryConfig) queue.retryConfig = normRetryConfig();
    // updateMask paths arrive in snake_case (e.g. "rate_limits.max_attempts")
    // and may target a nested leaf. With no mask, patch every supplied field.
    const paths = mask.length
      ? mask.map(snakeToCamelPath)
      : Object.keys(update).filter((k) => k !== "name");
    for (const path of paths) {
      const parts = path.split(".");
      const field = parts[0];
      if (field === "name") continue; // immutable
      if (parts.length > 1) {
        // Nested leaf update, e.g. rateLimits.maxDispatchesPerSecond.
        const sub = update[field] || {};
        if (queue[field] === undefined || queue[field] === null) queue[field] = {};
        queue[field][parts[1]] = sub[parts[1]];
      } else if (field === "rateLimits") {
        queue.rateLimits = normRateLimits(update.rateLimits);
      } else if (field === "retryConfig") {
        queue.retryConfig = normRetryConfig(update.retryConfig);
      } else {
        queue[field] = update[field];
      }
    }
    return this.sendJson(res, 200, cleanQueue(queue));
  }

  listQueues(res, parent, q) {
    const m = parent.match(/^projects\/([^/]+)\/locations\/([^/]+)$/);
    if (!m) throw new TasksError(GRPC.INVALID_ARGUMENT, `Invalid parent: ${parent}`);
    let all = [...this.queues.values()]
      .filter((qd) => qd.name.startsWith(`${parent}/queues/`))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    // Optional server-side filter: "state:RUNNING" style is approximated by a
    // simple substring match on the queue name when a filter is supplied.
    const filter = q.get("filter");
    if (filter) {
      all = all.filter((qd) => qd.name.includes(filter) || filter.includes(qd.state));
    }
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      queues: page.map(cleanQueue),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  deleteQueue(res, name) {
    if (!this.queues.has(name)) {
      throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${name}`);
    }
    this.queues.delete(name);
    this.policies.delete(name);
    return this.sendJson(res, 200, {});
  }

  purgeQueue(res, name) {
    const queue = this.queues.get(name);
    if (!queue) throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${name}`);
    queue.tasks.clear();
    queue.purgeTime = nowTs();
    return this.sendJson(res, 200, cleanQueue(queue));
  }

  pauseQueue(res, name) {
    const queue = this.queues.get(name);
    if (!queue) throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${name}`);
    queue.state = "PAUSED";
    return this.sendJson(res, 200, cleanQueue(queue));
  }

  resumeQueue(res, name) {
    const queue = this.queues.get(name);
    if (!queue) throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${name}`);
    queue.state = "RUNNING";
    return this.sendJson(res, 200, cleanQueue(queue));
  }

  _newQueueRecord(queue) {
    return {
      name: queue.name,
      rateLimits: normRateLimits(queue.rateLimits),
      retryConfig: normRetryConfig(queue.retryConfig),
      state: QUEUE_STATE[queue.state] || (typeof queue.state === "string" ? queue.state : "RUNNING"),
      purgeTime: queue.purgeTime || undefined,
      stackdriverLoggingConfig: queue.stackdriverLoggingConfig || undefined,
      // App Engine routing override, if provided.
      appEngineRoutingOverride: queue.appEngineRoutingOverride || undefined,
      tasks: new Map(),
    };
  }

  // =========================================================================
  // Tasks
  // =========================================================================
  createTask(res, parent, body) {
    const queue = this.queues.get(parent);
    if (!queue) throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${parent}`);
    const task = body.task;
    if (!task) throw new TasksError(GRPC.INVALID_ARGUMENT, "Task is required");

    const hasHttp = !!task.httpRequest;
    const hasAppEngine = !!task.appEngineHttpRequest;
    if (!hasHttp && !hasAppEngine) {
      throw new TasksError(
        GRPC.INVALID_ARGUMENT,
        "Task must contain httpRequest or appEngineHttpRequest",
      );
    }
    if (hasHttp && hasAppEngine) {
      throw new TasksError(
        GRPC.INVALID_ARGUMENT,
        "Task must not contain both httpRequest and appEngineHttpRequest",
      );
    }
    if (hasHttp) {
      const url = task.httpRequest.url;
      if (!url || !/^https?:\/\//.test(url)) {
        throw new TasksError(
          GRPC.INVALID_ARGUMENT,
          "httpRequest.url must be a valid http(s) URL",
        );
      }
    }

    // Resolve the task name: caller may provide a full name, otherwise generate.
    let name = task.name;
    if (name) {
      if (!name.startsWith(`${parent}/tasks/`)) {
        throw new TasksError(
          GRPC.INVALID_ARGUMENT,
          `Task name must be under parent ${parent}`,
        );
      }
      const id = name.slice(`${parent}/tasks/`.length);
      if (!TASK_ID_RE.test(id)) {
        throw new TasksError(GRPC.INVALID_ARGUMENT, `Invalid task id: ${id}`);
      }
      if (queue.tasks.has(name)) {
        throw new TasksError(GRPC.ALREADY_EXISTS, `Task already exists: ${name}`);
      }
    } else {
      name = `${parent}/tasks/${randomBytes(13).toString("hex")}`;
    }

    const responseView = normView(body.responseView);
    const now = Date.now();
    const scheduleTime = task.scheduleTime || tsFromMillis(now);

    const record = {
      name,
      httpRequest: hasHttp ? normHttpRequest(task.httpRequest) : undefined,
      appEngineHttpRequest: hasAppEngine ? task.appEngineHttpRequest : undefined,
      scheduleTime,
      createTime: tsFromMillis(now),
      dispatchDeadline: task.dispatchDeadline || "600s",
      dispatchCount: 0,
      responseCount: 0,
      firstAttempt: undefined,
      lastAttempt: undefined,
      view: "FULL",
    };
    queue.tasks.set(name, record);
    return this.sendJson(res, 200, cleanTask(record, responseView));
  }

  getTask(res, name, q) {
    const { queue, task } = this._resolveTask(name);
    if (!task) throw new TasksError(GRPC.NOT_FOUND, `Task does not exist: ${name}`);
    void queue;
    const view = normView(q.get("responseView"));
    return this.sendJson(res, 200, cleanTask(task, view));
  }

  listTasks(res, parent, q) {
    const queue = this.queues.get(parent);
    if (!queue) throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${parent}`);
    const view = normView(q.get("responseView"));
    const all = [...queue.tasks.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      tasks: page.map((t) => cleanTask(t, view)),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  deleteTask(res, name) {
    const { queue, task } = this._resolveTask(name);
    if (!task) throw new TasksError(GRPC.NOT_FOUND, `Task does not exist: ${name}`);
    queue.tasks.delete(name);
    return this.sendJson(res, 200, {});
  }

  runTask(res, name, body) {
    const { queue, task } = this._resolveTask(name);
    if (!task) throw new TasksError(GRPC.NOT_FOUND, `Task does not exist: ${name}`);
    if (queue.state === "PAUSED" || queue.state === "DISABLED") {
      throw new TasksError(
        GRPC.FAILED_PRECONDITION,
        `Queue is ${queue.state}; cannot run task`,
      );
    }
    // Simulate forcing an immediate attempt. We don't actually dispatch the
    // HTTP request (zero side effects), but we record the attempt metadata as
    // the real service would, with a synthetic success response.
    const now = Date.now();
    const attempt = {
      scheduleTime: task.scheduleTime,
      dispatchTime: tsFromMillis(now),
      responseTime: tsFromMillis(now),
      responseStatus: { code: GRPC.OK, message: "" },
    };
    task.dispatchCount += 1;
    task.responseCount += 1;
    if (!task.firstAttempt) task.firstAttempt = attempt;
    task.lastAttempt = attempt;
    task.scheduleTime = tsFromMillis(now);
    const view = normView(body.responseView);
    return this.sendJson(res, 200, cleanTask(task, view));
  }

  _resolveTask(name) {
    const m = name.match(/^(projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+)\/tasks\/.+$/);
    if (!m) throw new TasksError(GRPC.INVALID_ARGUMENT, `Invalid task name: ${name}`);
    const queue = this.queues.get(m[1]);
    if (!queue) throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${m[1]}`);
    return { queue, task: queue.tasks.get(name) };
  }

  // =========================================================================
  // IAM
  // =========================================================================
  getIamPolicy(res, resource, body) {
    this._assertQueueExists(resource);
    const policy = this.policies.get(resource) || { version: 1, etag: makeEtag(), bindings: [] };
    void body;
    return this.sendJson(res, 200, policy);
  }

  setIamPolicy(res, resource, body) {
    this._assertQueueExists(resource);
    const incoming = body.policy || {};
    const policy = {
      version: incoming.version || 1,
      bindings: incoming.bindings || [],
      etag: makeEtag(),
    };
    this.policies.set(resource, policy);
    return this.sendJson(res, 200, policy);
  }

  testIamPermissions(res, resource, body) {
    this._assertQueueExists(resource);
    const permissions = body.permissions || [];
    // The fake grants every requested permission.
    return this.sendJson(res, 200, { permissions });
  }

  _assertQueueExists(resource) {
    if (!this.queues.has(resource)) {
      throw new TasksError(GRPC.NOT_FOUND, `Queue does not exist: ${resource}`);
    }
  }

  // =========================================================================
  // Name validation helpers
  // =========================================================================
  _assertQueueName(name) {
    const m = name.match(/^projects\/[^/]+\/locations\/[^/]+\/queues\/(.+)$/);
    if (!m || !QUEUE_ID_RE.test(m[1])) {
      throw new TasksError(GRPC.INVALID_ARGUMENT, `Invalid queue name: ${name}`);
    }
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    const data = JSON.stringify(obj);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(data);
  }

  sendError(res, grpcCode, message) {
    const httpStatus = GRPC_TO_HTTP[grpcCode] || 500;
    const status = GRPC_STATUS_NAME[grpcCode] || "UNKNOWN";
    const payload = {
      error: {
        code: httpStatus,
        message,
        status,
      },
    };
    res.statusCode = httpStatus;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
function nowTs() {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
}

function tsFromMillis(ms) {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
}

function makeEtag() {
  return randomBytes(8).toString("base64");
}

// Convert a (possibly dotted) snake_case field-mask path to camelCase, e.g.
// "rate_limits.max_attempts" -> "rateLimits.maxAttempts".
function snakeToCamelPath(path) {
  return path
    .split(".")
    .map((seg) => seg.replace(/_([a-z])/g, (_, c) => c.toUpperCase()))
    .join(".");
}

function fieldsOf(mask) {
  if (!mask) return [];
  if (typeof mask === "string") return mask.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(mask.paths)) return mask.paths;
  if (Array.isArray(mask)) return mask;
  return [];
}

// Stable pagination via pageSize + pageToken (token is the start offset).
function paginate(items, q) {
  const pageSize = parseInt(q.get("pageSize") || "0", 10) || 0;
  const startToken = q.get("pageToken");
  const start = startToken ? parseInt(Buffer.from(startToken, "base64").toString("utf8"), 10) || 0 : 0;
  if (pageSize <= 0) {
    return { page: items.slice(start), nextPageToken: null };
  }
  const page = items.slice(start, start + pageSize);
  const nextStart = start + pageSize;
  const nextPageToken =
    nextStart < items.length ? Buffer.from(String(nextStart), "utf8").toString("base64") : null;
  return { page, nextPageToken };
}

const DEFAULT_RATE_LIMITS = {
  maxDispatchesPerSecond: 500,
  maxBurstSize: 100,
  maxConcurrentDispatches: 1000,
};

function normRateLimits(rl) {
  if (!rl) return { ...DEFAULT_RATE_LIMITS };
  return {
    maxDispatchesPerSecond:
      rl.maxDispatchesPerSecond !== undefined
        ? rl.maxDispatchesPerSecond
        : DEFAULT_RATE_LIMITS.maxDispatchesPerSecond,
    maxBurstSize:
      rl.maxBurstSize !== undefined ? rl.maxBurstSize : DEFAULT_RATE_LIMITS.maxBurstSize,
    maxConcurrentDispatches:
      rl.maxConcurrentDispatches !== undefined
        ? rl.maxConcurrentDispatches
        : DEFAULT_RATE_LIMITS.maxConcurrentDispatches,
  };
}

const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 100,
  maxRetryDuration: "0s",
  minBackoff: "0.100s",
  maxBackoff: "3600s",
  maxDoublings: 16,
};

function normRetryConfig(rc) {
  if (!rc) return { ...DEFAULT_RETRY_CONFIG };
  return {
    maxAttempts: rc.maxAttempts !== undefined ? rc.maxAttempts : DEFAULT_RETRY_CONFIG.maxAttempts,
    maxRetryDuration: rc.maxRetryDuration || DEFAULT_RETRY_CONFIG.maxRetryDuration,
    minBackoff: rc.minBackoff || DEFAULT_RETRY_CONFIG.minBackoff,
    maxBackoff: rc.maxBackoff || DEFAULT_RETRY_CONFIG.maxBackoff,
    maxDoublings: rc.maxDoublings !== undefined ? rc.maxDoublings : DEFAULT_RETRY_CONFIG.maxDoublings,
  };
}

// HTTP method enum (HttpMethod) — REST fallback may send ints.
const HTTP_METHOD = {
  0: "HTTP_METHOD_UNSPECIFIED",
  1: "POST",
  2: "GET",
  3: "HEAD",
  4: "PUT",
  5: "DELETE",
  6: "PATCH",
  7: "OPTIONS",
};
function normHttpMethod(m) {
  if (m === undefined || m === null) return "POST";
  if (typeof m === "number") return HTTP_METHOD[m] || "POST";
  return m;
}

function normHttpRequest(hr) {
  return {
    url: hr.url,
    httpMethod: normHttpMethod(hr.httpMethod),
    headers: hr.headers || undefined,
    body: hr.body || undefined,
    oauthToken: hr.oauthToken || undefined,
    oidcToken: hr.oidcToken || undefined,
  };
}

function cleanQueue(qd) {
  return prune({
    name: qd.name,
    appEngineRoutingOverride: qd.appEngineRoutingOverride,
    rateLimits: qd.rateLimits,
    retryConfig: qd.retryConfig,
    state: qd.state,
    purgeTime: qd.purgeTime,
    stackdriverLoggingConfig: qd.stackdriverLoggingConfig,
  });
}

// Cloud Tasks task views:
//   BASIC: omits httpRequest.body and appEngineHttpRequest.body.
//   FULL: includes everything.
function cleanTask(t, view) {
  const v = view || t.view || "BASIC";
  const out = {
    name: t.name,
    scheduleTime: t.scheduleTime,
    createTime: t.createTime,
    dispatchDeadline: t.dispatchDeadline,
    dispatchCount: t.dispatchCount,
    responseCount: t.responseCount,
    view: v,
    firstAttempt: t.firstAttempt,
    lastAttempt: t.lastAttempt,
  };
  if (t.httpRequest) {
    const hr = { ...t.httpRequest };
    if (v !== "FULL") delete hr.body;
    out.httpRequest = prune(hr);
  }
  if (t.appEngineHttpRequest) {
    const ar = { ...t.appEngineHttpRequest };
    if (v !== "FULL") delete ar.body;
    out.appEngineHttpRequest = prune(ar);
  }
  return prune(out);
}

// Strip undefined values so JSON output matches the proto3-JSON wire format
// (absent optional fields are omitted).
function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// Exposed for completeness / potential digest-based dedup of task ids.
export function taskHash(name) {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

export function genId() {
  return randomUUID().replace(/-/g, "");
}

export default CloudtasksServer;
