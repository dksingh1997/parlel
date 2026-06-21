import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { request as httpRequest } from "node:http";
import { CloudtasksServer } from "../services/cloudtasks/src/server.js";

// A lightweight, dependency-free fake of Google Cloud Tasks exercised through
// the real `@google-cloud/tasks` client over its HTTP/1.1 REST transport (the
// google-gax `fallback` mode). Mirrors the structure/style of
// tests/redis.test.ts, tests/postgres.test.ts and tests/pubsub.test.ts.

const PORT = 14584;
const PROJECT = "parlel";
const LOCATION = "us-central1";

process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
process.env.GCLOUD_PROJECT = PROJECT;

// A minimal, dependency-free auth client. It satisfies the google-gax (v5)
// fallback transport contract: `fetch()` resolves the response object on EVERY
// status (it never throws on non-2xx). This is required so that gax's REST
// decoder runs and transcodes the google.rpc.Status error body back into the
// canonical gRPC status code (e.g. NOT_FOUND -> 5) — exactly the behavior the
// real client surfaces. The parlel fake never validates credentials, so no key
// material is needed.
const fakeAuthClient = {
  async getRequestHeaders(): Promise<Headers> {
    return new Headers();
  },
  async getClient(): Promise<unknown> {
    return fakeAuthClient;
  },
  async getProjectId(): Promise<string> {
    return PROJECT;
  },
  universeDomain: "googleapis.com",
  fetch(url: string | URL, init: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = new URL(typeof url === "string" ? url : url.toString());
      const headers: Record<string, string> = {};
      if (init?.headers) for (const [k, v] of init.headers) headers[k] = v as string;
      const req = httpRequest(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: init?.method || "GET",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const status = res.statusCode || 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              arrayBuffer: async () => buffer,
            });
          });
        },
      );
      req.on("error", reject);
      if (init?.body) req.write(init.body);
      req.end();
    });
  },
};

// The low-level gapic CloudTasksClient needs the endpoint explicitly.
const CLIENT_OPTS = {
  projectId: PROJECT,
  fallback: true as const,
  protocol: "http" as const,
  apiEndpoint: "127.0.0.1",
  port: PORT,
  authClient: fakeAuthClient as any,
};

let CloudTasksClient: any;

let server: CloudtasksServer;
let client: any;

function queuePath(id: string): string {
  return `projects/${PROJECT}/locations/${LOCATION}/queues/${id}`;
}
function parentPath(): string {
  return `projects/${PROJECT}/locations/${LOCATION}`;
}
function projectPath(): string {
  return `projects/${PROJECT}`;
}
function taskPath(queueId: string, taskId: string): string {
  return `${queuePath(queueId)}/tasks/${taskId}`;
}

// Raw HTTP helper for the internal endpoints + wire-level assertions.
function rawRequest(opts: {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function resetServer(): Promise<void> {
  await rawRequest({ method: "POST", path: "/_parlel/reset" });
}

async function createQueue(id: string, extra: Record<string, unknown> = {}): Promise<any> {
  const [q] = await client.createQueue({
    parent: parentPath(),
    queue: { name: queuePath(id), ...extra },
  });
  return q;
}

async function createHttpTask(
  queueId: string,
  task: Record<string, unknown> = {},
): Promise<any> {
  const [t] = await client.createTask({
    parent: queuePath(queueId),
    task: {
      httpRequest: {
        url: "https://example.com/handler",
        httpMethod: "POST",
        body: Buffer.from("payload"),
      },
      ...task,
    },
  });
  return t;
}

describe("Cloud Tasks Service", () => {
  beforeAll(async () => {
    server = new CloudtasksServer(PORT);
    await server.start();
    const mod: any = await import("@google-cloud/tasks");
    CloudTasksClient = mod.v2.CloudTasksClient;
    client = new CloudTasksClient(CLIENT_OPTS);
    // sanity wait
    await new Promise((r) => setTimeout(r, 100));
  }, 20000);

  afterAll(async () => {
    if (client) await client.close();
    await server.stop();
  });

  beforeEach(async () => {
    await resetServer();
  });

  // -----------------------------------------------------------------------
  // Internal parlel endpoints
  // -----------------------------------------------------------------------
  describe("parlel internal endpoints", () => {
    it("health reports ok and counts", async () => {
      const res = await rawRequest({ path: "/_parlel/health" });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("cloudtasks");
      expect(body.queues).toBe(0);
      expect(body.tasks).toBe(0);
    });

    it("reset clears state", async () => {
      await createQueue("rq");
      let health = JSON.parse((await rawRequest({ path: "/_parlel/health" })).body);
      expect(health.queues).toBe(1);
      await resetServer();
      health = JSON.parse((await rawRequest({ path: "/_parlel/health" })).body);
      expect(health.queues).toBe(0);
    });

    it("dump returns queues and tasks", async () => {
      await createQueue("dq");
      await createHttpTask("dq");
      const res = await rawRequest({ path: "/_parlel/dump" });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.queues).toHaveLength(1);
      expect(body.queues[0].tasks).toHaveLength(1);
    });

    it("unknown path returns 404", async () => {
      const res = await rawRequest({ path: "/nope" });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Locations
  // -----------------------------------------------------------------------
  describe("Locations", () => {
    it("getLocation returns a known location", async () => {
      const [loc] = await client.getLocation({
        name: `${projectPath()}/locations/${LOCATION}`,
      });
      expect(loc.locationId).toBe(LOCATION);
      expect(loc.name).toBe(`${projectPath()}/locations/${LOCATION}`);
    });

    it("getLocation 404 for unknown location", async () => {
      await expect(
        client.getLocation({ name: `${projectPath()}/locations/nowhere-1` }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("listLocationsAsync iterates all locations", async () => {
      const names: string[] = [];
      for await (const loc of client.listLocationsAsync({ name: projectPath() })) {
        names.push(loc.locationId);
      }
      expect(names).toContain("us-central1");
      expect(names.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -----------------------------------------------------------------------
  // Queue CRUD
  // -----------------------------------------------------------------------
  describe("Queues", () => {
    it("createQueue creates a queue with defaults", async () => {
      const q = await createQueue("q1");
      expect(q.name).toBe(queuePath("q1"));
      expect(q.state).toBe("RUNNING");
      expect(q.rateLimits.maxDispatchesPerSecond).toBeGreaterThan(0);
      expect(q.retryConfig.maxAttempts).toBeDefined();
    });

    it("createQueue honors rateLimits and retryConfig", async () => {
      const q = await createQueue("q2", {
        rateLimits: { maxDispatchesPerSecond: 10, maxConcurrentDispatches: 5 },
        retryConfig: { maxAttempts: 3 },
      });
      expect(q.rateLimits.maxDispatchesPerSecond).toBe(10);
      expect(q.rateLimits.maxConcurrentDispatches).toBe(5);
      expect(q.retryConfig.maxAttempts).toBe(3);
    });

    it("createQueue ALREADY_EXISTS on duplicate", async () => {
      await createQueue("dup");
      await expect(createQueue("dup")).rejects.toMatchObject({ code: 6 });
    });

    it("createQueue INVALID_ARGUMENT on bad id", async () => {
      await expect(
        client.createQueue({
          parent: parentPath(),
          queue: { name: queuePath("bad id!") },
        }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("getQueue returns the queue", async () => {
      await createQueue("g1");
      const [q] = await client.getQueue({ name: queuePath("g1") });
      expect(q.name).toBe(queuePath("g1"));
    });

    it("getQueue NOT_FOUND for missing queue", async () => {
      await expect(client.getQueue({ name: queuePath("missing") })).rejects.toMatchObject({
        code: 5,
      });
    });

    it("listQueues lists and sorts queues", async () => {
      await createQueue("qb");
      await createQueue("qa");
      const [queues] = await client.listQueues({ parent: parentPath() });
      const names = queues.map((q: any) => q.name);
      expect(names).toContain(queuePath("qa"));
      expect(names).toContain(queuePath("qb"));
      expect(names.indexOf(queuePath("qa"))).toBeLessThan(names.indexOf(queuePath("qb")));
    });

    it("listQueuesAsync paginates", async () => {
      for (let i = 0; i < 5; i++) await createQueue(`page${i}`);
      const collected: string[] = [];
      const iterable = client.listQueuesAsync({ parent: parentPath() }, { pageSize: 2 });
      for await (const q of iterable) collected.push(q.name);
      expect(collected.length).toBe(5);
    });

    it("updateQueue patches rateLimits via updateMask", async () => {
      await createQueue("u1");
      const [q] = await client.updateQueue({
        queue: { name: queuePath("u1"), rateLimits: { maxDispatchesPerSecond: 42 } },
        updateMask: { paths: ["rate_limits.max_dispatches_per_second"] },
      });
      expect(q.rateLimits.maxDispatchesPerSecond).toBe(42);
    });

    it("deleteQueue removes the queue", async () => {
      await createQueue("d1");
      await client.deleteQueue({ name: queuePath("d1") });
      await expect(client.getQueue({ name: queuePath("d1") })).rejects.toMatchObject({
        code: 5,
      });
    });

    it("deleteQueue NOT_FOUND for missing queue", async () => {
      await expect(client.deleteQueue({ name: queuePath("ghost") })).rejects.toMatchObject({
        code: 5,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Queue lifecycle: pause / resume / purge
  // -----------------------------------------------------------------------
  describe("Queue lifecycle", () => {
    it("pauseQueue sets state PAUSED", async () => {
      await createQueue("p1");
      const [q] = await client.pauseQueue({ name: queuePath("p1") });
      expect(q.state).toBe("PAUSED");
    });

    it("resumeQueue sets state RUNNING", async () => {
      await createQueue("p2");
      await client.pauseQueue({ name: queuePath("p2") });
      const [q] = await client.resumeQueue({ name: queuePath("p2") });
      expect(q.state).toBe("RUNNING");
    });

    it("purgeQueue clears tasks", async () => {
      await createQueue("pg");
      await createHttpTask("pg");
      await createHttpTask("pg");
      let [tasks] = await client.listTasks({ parent: queuePath("pg") });
      expect(tasks).toHaveLength(2);
      await client.purgeQueue({ name: queuePath("pg") });
      [tasks] = await client.listTasks({ parent: queuePath("pg") });
      expect(tasks).toHaveLength(0);
    });

    it("pauseQueue NOT_FOUND for missing queue", async () => {
      await expect(client.pauseQueue({ name: queuePath("nope") })).rejects.toMatchObject({
        code: 5,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Task CRUD
  // -----------------------------------------------------------------------
  describe("Tasks", () => {
    it("createTask with httpRequest", async () => {
      await createQueue("tq");
      const t = await createHttpTask("tq");
      expect(t.name).toContain(`${queuePath("tq")}/tasks/`);
      expect(t.httpRequest.url).toBe("https://example.com/handler");
      expect(t.dispatchCount).toBe(0);
    });

    it("createTask with explicit name", async () => {
      await createQueue("tq2");
      const [t] = await client.createTask({
        parent: queuePath("tq2"),
        task: {
          name: taskPath("tq2", "my-task-id"),
          httpRequest: { url: "https://example.com/x", httpMethod: "GET" },
        },
      });
      expect(t.name).toBe(taskPath("tq2", "my-task-id"));
    });

    it("createTask ALREADY_EXISTS on duplicate name", async () => {
      await createQueue("tq3");
      const opts = {
        parent: queuePath("tq3"),
        task: {
          name: taskPath("tq3", "dup-task"),
          httpRequest: { url: "https://example.com/x" },
        },
      };
      await client.createTask(opts);
      await expect(client.createTask(opts)).rejects.toMatchObject({ code: 6 });
    });

    it("createTask INVALID_ARGUMENT when no request payload", async () => {
      await createQueue("tq4");
      await expect(
        client.createTask({ parent: queuePath("tq4"), task: {} }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("createTask NOT_FOUND for missing queue", async () => {
      await expect(
        client.createTask({
          parent: queuePath("noqueue"),
          task: { httpRequest: { url: "https://example.com/x" } },
        }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("createTask with scheduleTime", async () => {
      await createQueue("sq");
      const future = new Date(Date.now() + 60_000);
      const [t] = await client.createTask({
        parent: queuePath("sq"),
        task: {
          scheduleTime: { seconds: Math.floor(future.getTime() / 1000) },
          httpRequest: { url: "https://example.com/later" },
        },
      });
      expect(t.scheduleTime).toBeDefined();
      expect(Number(t.scheduleTime.seconds)).toBe(Math.floor(future.getTime() / 1000));
    });

    it("getTask returns the task (FULL view includes body)", async () => {
      await createQueue("gt");
      const created = await createHttpTask("gt");
      const [t] = await client.getTask({ name: created.name, responseView: "FULL" });
      expect(t.name).toBe(created.name);
      expect(t.httpRequest.body).toBeDefined();
      expect(t.httpRequest.body.length).toBeGreaterThan(0);
    });

    it("getTask BASIC view omits body", async () => {
      await createQueue("gtb");
      const created = await createHttpTask("gtb");
      const [t] = await client.getTask({ name: created.name, responseView: "BASIC" });
      // BASIC omits the body — gapic decodes absent bytes to an empty buffer.
      expect(t.httpRequest.body.length).toBe(0);
    });

    it("getTask NOT_FOUND for missing task", async () => {
      await createQueue("gtm");
      await expect(
        client.getTask({ name: taskPath("gtm", "missing") }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("listTasks lists tasks", async () => {
      await createQueue("lt");
      await createHttpTask("lt");
      await createHttpTask("lt");
      const [tasks] = await client.listTasks({ parent: queuePath("lt") });
      expect(tasks).toHaveLength(2);
    });

    it("listTasksAsync paginates", async () => {
      await createQueue("lta");
      for (let i = 0; i < 4; i++) await createHttpTask("lta");
      const collected: string[] = [];
      for await (const t of client.listTasksAsync(
        { parent: queuePath("lta") },
        { pageSize: 2 },
      )) {
        collected.push(t.name);
      }
      expect(collected.length).toBe(4);
    });

    it("deleteTask removes the task", async () => {
      await createQueue("dt");
      const created = await createHttpTask("dt");
      await client.deleteTask({ name: created.name });
      await expect(client.getTask({ name: created.name })).rejects.toMatchObject({
        code: 5,
      });
    });

    it("deleteTask NOT_FOUND for missing task", async () => {
      await createQueue("dtm");
      await expect(
        client.deleteTask({ name: taskPath("dtm", "missing") }),
      ).rejects.toMatchObject({ code: 5 });
    });
  });

  // -----------------------------------------------------------------------
  // RunTask
  // -----------------------------------------------------------------------
  describe("RunTask", () => {
    it("runTask increments dispatch and response counts", async () => {
      await createQueue("rt");
      const created = await createHttpTask("rt");
      expect(created.dispatchCount).toBe(0);
      const [ran] = await client.runTask({ name: created.name });
      expect(ran.dispatchCount).toBe(1);
      expect(ran.responseCount).toBe(1);
      expect(ran.lastAttempt).toBeDefined();
      expect(ran.firstAttempt).toBeDefined();
    });

    it("runTask FAILED_PRECONDITION when queue is paused", async () => {
      await createQueue("rtp");
      const created = await createHttpTask("rtp");
      await client.pauseQueue({ name: queuePath("rtp") });
      await expect(client.runTask({ name: created.name })).rejects.toMatchObject({
        code: 9,
      });
    });

    it("runTask NOT_FOUND for missing task", async () => {
      await createQueue("rtm");
      await expect(
        client.runTask({ name: taskPath("rtm", "missing") }),
      ).rejects.toMatchObject({ code: 5 });
    });
  });

  // -----------------------------------------------------------------------
  // IAM
  // -----------------------------------------------------------------------
  describe("IAM", () => {
    it("getIamPolicy returns an empty policy by default", async () => {
      await createQueue("iam1");
      const [policy] = await client.getIamPolicy({ resource: queuePath("iam1") });
      expect(policy.bindings).toEqual([]);
      expect(policy.etag).toBeDefined();
    });

    it("setIamPolicy then getIamPolicy round-trips bindings", async () => {
      await createQueue("iam2");
      const [set] = await client.setIamPolicy({
        resource: queuePath("iam2"),
        policy: {
          bindings: [{ role: "roles/cloudtasks.admin", members: ["user:a@b.com"] }],
        },
      });
      expect(set.bindings).toHaveLength(1);
      const [got] = await client.getIamPolicy({ resource: queuePath("iam2") });
      expect(got.bindings[0].role).toBe("roles/cloudtasks.admin");
    });

    it("testIamPermissions echoes requested permissions", async () => {
      await createQueue("iam3");
      const [resp] = await client.testIamPermissions({
        resource: queuePath("iam3"),
        permissions: ["cloudtasks.tasks.create", "cloudtasks.queues.get"],
      });
      expect(resp.permissions).toEqual([
        "cloudtasks.tasks.create",
        "cloudtasks.queues.get",
      ]);
    });

    it("getIamPolicy NOT_FOUND for missing queue", async () => {
      await expect(
        client.getIamPolicy({ resource: queuePath("noiam") }),
      ).rejects.toMatchObject({ code: 5 });
    });
  });

  // -----------------------------------------------------------------------
  // Wire-level error shape
  // -----------------------------------------------------------------------
  describe("Error wire format", () => {
    it("returns google.rpc.Status-shaped error JSON", async () => {
      const res = await rawRequest({
        path: `/v2/${queuePath("does-not-exist")}`,
      });
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(404);
      expect(body.error.status).toBe("NOT_FOUND");
      expect(typeof body.error.message).toBe("string");
    });
  });
});
