import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GoogleTasksServer } from "../services/google-tasks/src/server.js";

const PORT = 24626;
const BASE = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json | string, headers: Record<string, string> = {}): Promise<{ status: number; data: any; text: string; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: typeof body === "string" ? headers : body ? { "content-type": "application/json", ...headers } : headers,
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";
  return { status: res.status, data: text && contentType.includes("json") ? JSON.parse(text) : text, text, headers: res.headers };
}

async function createTasklist(title = "Project Tasks") {
  const response = await api("POST", "/tasks/v1/users/@me/lists", { title });
  expect(response.status).toBe(200);
  return response.data;
}

async function createTask(tasklist = "@default", title = "Write tests", body: Json = {}) {
  const response = await api("POST", `/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks`, { title, ...body });
  expect(response.status).toBe(200);
  return response.data;
}

describe("Google Tasks Service", () => {
  let server: GoogleTasksServer;

  beforeAll(async () => {
    server = new GoogleTasksServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server", () => {
    it("starts, serves discovery and health, supports v1 alias, and resets state", async () => {
      expect(server.port).toBe(PORT);
      expect(server.tasklists.has("@default")).toBe(true);

      const discovery = await api("GET", "/tasks/v1");
      expect(discovery).toMatchObject({ status: 200, data: { kind: "tasks#parlel" } });

      const alias = await api("GET", "/v1");
      expect(alias.data).toEqual({ kind: "tasks#parlel" });

      const health = await api("GET", "/_parlel/health");
      expect(health.data).toEqual({ status: "ok", service: "google-tasks", tasklists: 1, tasks: 0 });

      await createTasklist("Reset list");
      await createTask("@default", "Reset task");
      expect(server.tasklists.size).toBe(2);
      expect(server.tasks.get("@default")?.size).toBe(1);

      const reset = await api("POST", "/_parlel/reset");
      expect(reset).toMatchObject({ status: 200, data: { ok: true } });
      expect(server.tasklists.size).toBe(1);
      expect(server.tasks.get("@default")?.size).toBe(0);
    });

    it("returns Google-shaped JSON errors", async () => {
      const missing = await api("GET", "/tasks/v1/users/@me/lists/missing");
      expect(missing.status).toBe(404);
      expect(missing.data.error).toMatchObject({ code: 404, status: "NOT_FOUND" });
      expect(missing.data.error.errors[0]).toMatchObject({ domain: "global", reason: "notFound" });

      const invalid = await api("POST", "/tasks/v1/users/@me/lists", "{", { "content-type": "application/json" });
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.errors[0].reason).toBe("parseError");

      const method = await api("GET", "/tasks/v1/lists/@default/tasks/clear");
      expect(method.status).toBe(405);
      expect(method.data.error.status).toBe("METHOD_NOT_ALLOWED");
    });
  });

  describe("Tasklists", () => {
    it("insert, list, get, patch, update, and delete task lists", async () => {
      const created = await createTasklist("Engineering");
      expect(created).toMatchObject({ kind: "tasks#taskList", title: "Engineering" });
      expect(created.id).toMatch(/^tasklist_/);

      const duplicate = await api("POST", "/tasks/v1/users/@me/lists", { id: created.id, title: "Duplicate" });
      expect(duplicate.status).toBe(409);
      expect(duplicate.data.error.errors[0].reason).toBe("alreadyExists");

      const list = await api("GET", "/tasks/v1/users/@me/lists?maxResults=1");
      expect(list.data).toMatchObject({ kind: "tasks#taskLists" });
      expect(list.data.items).toHaveLength(1);
      expect(list.data.nextPageToken).toBeDefined();

      const got = await api("GET", `/tasks/v1/users/@me/lists/${created.id}`);
      expect(got.data.title).toBe("Engineering");

      const patched = await api("PATCH", `/tasks/v1/users/@me/lists/${created.id}`, { title: "Platform" });
      expect(patched.data).toMatchObject({ id: created.id, title: "Platform" });

      const updated = await api("PUT", `/tasks/v1/users/@me/lists/${created.id}`, { title: "Launch" });
      expect(updated.data).toMatchObject({ id: created.id, title: "Launch" });

      const deleted = await api("DELETE", `/tasks/v1/users/@me/lists/${created.id}`);
      expect(deleted.status).toBe(204);
      expect(server.tasklists.has(created.id)).toBe(false);
      expect(server.tasks.has(created.id)).toBe(false);
    });
  });

  describe("Tasks", () => {
    it("insert, get, list, patch, update, and delete tasks", async () => {
      const created = await createTask("@default", "Plan launch", { notes: "draft notes", due: "2026-07-01T00:00:00.000Z", links: [{ type: "email", link: "mailto:agent@example.com" }] });
      expect(created).toMatchObject({ kind: "tasks#task", title: "Plan launch", status: "needsAction", notes: "draft notes" });
      expect(created.links[0].link).toBe("mailto:agent@example.com");

      const duplicate = await api("POST", "/tasks/v1/lists/@default/tasks", { id: created.id, title: "duplicate" });
      expect(duplicate.status).toBe(409);

      const got = await api("GET", `/tasks/v1/lists/@default/tasks/${created.id}`);
      expect(got.data.due).toBe("2026-07-01T00:00:00.000Z");

      const patched = await api("PATCH", `/tasks/v1/lists/@default/tasks/${created.id}`, { title: "Plan launch updated", status: "completed" });
      expect(patched.data).toMatchObject({ title: "Plan launch updated", status: "completed" });
      expect(patched.data.completed).toBeDefined();

      const updated = await api("PUT", `/tasks/v1/lists/@default/tasks/${created.id}`, { title: "Plan launch replaced", status: "needsAction", notes: "new", due: "2026-07-01T00:00:00.000Z" });
      expect(updated.data).toMatchObject({ id: created.id, title: "Plan launch replaced", status: "needsAction", notes: "new" });
      expect(updated.data.completed).toBeUndefined();

      const listed = await api("GET", "/tasks/v1/lists/@default/tasks?dueMin=2026-06-01T00:00:00.000Z&dueMax=2026-08-01T00:00:00.000Z&maxResults=1");
      expect(listed.data.items).toHaveLength(1);
      expect(listed.data.items[0].id).toBe(created.id);

      const deleted = await api("DELETE", `/tasks/v1/lists/@default/tasks/${created.id}`);
      expect(deleted.status).toBe(204);
      const missing = await api("GET", `/tasks/v1/lists/@default/tasks/${created.id}`);
      expect(missing.status).toBe(404);
    });

    it("inserts and moves tasks with parent and previous ordering", async () => {
      const parent = await createTask("@default", "Parent");
      const first = await api("POST", `/tasks/v1/lists/@default/tasks?parent=${parent.id}`, { title: "First child" });
      expect(first.status).toBe(200);
      expect(first.data.parent).toBe(parent.id);

      const second = await api("POST", `/tasks/v1/lists/@default/tasks?parent=${parent.id}&previous=${first.data.id}`, { title: "Second child" });
      expect(second.data.parent).toBe(parent.id);
      expect(second.data.position > first.data.position).toBe(true);

      const moved = await api("POST", `/tasks/v1/lists/@default/tasks/${second.data.id}/move?parent=${parent.id}`);
      expect(moved.data.parent).toBe(parent.id);

      const listed = await api("GET", "/tasks/v1/lists/@default/tasks");
      const childIds = listed.data.items.filter((task: Json) => task.parent === parent.id).map((task: Json) => task.id);
      expect(childIds).toEqual([second.data.id, first.data.id]);

      const badPrevious = await api("POST", `/tasks/v1/lists/@default/tasks/${first.data.id}/move?previous=${parent.id}`);
      expect(badPrevious.status).toBe(400);
      expect(badPrevious.data.error.errors[0].reason).toBe("invalidArgument");
    });

    it("clear hides completed tasks and list filters match Google Tasks parameters", async () => {
      const active = await createTask("@default", "Active", { due: "2026-07-10T00:00:00.000Z" });
      const completed = await createTask("@default", "Done", { status: "completed", due: "2026-07-11T00:00:00.000Z" });
      const deleted = await createTask("@default", "Deleted", { deleted: true });
      const hidden = await createTask("@default", "Hidden", { hidden: true });

      const incompleteOnly = await api("GET", "/tasks/v1/lists/@default/tasks?showCompleted=false&showDeleted=true&showHidden=true");
      expect(incompleteOnly.data.items.map((task: Json) => task.id)).toContain(active.id);
      expect(incompleteOnly.data.items.map((task: Json) => task.id)).not.toContain(completed.id);

      const visibleOnly = await api("GET", "/tasks/v1/lists/@default/tasks");
      const visibleIds = visibleOnly.data.items.map((task: Json) => task.id);
      expect(visibleIds).toContain(active.id);
      expect(visibleIds).toContain(completed.id);
      expect(visibleIds).not.toContain(deleted.id);
      expect(visibleIds).not.toContain(hidden.id);

      const byCompletedDate = await api("GET", `/tasks/v1/lists/@default/tasks?completedMin=${encodeURIComponent(completed.completed)}&completedMax=${encodeURIComponent(completed.completed)}&showHidden=true`);
      expect(byCompletedDate.data.items.map((task: Json) => task.id)).toContain(completed.id);
      expect(byCompletedDate.data.items.map((task: Json) => task.id)).not.toContain(active.id);

      const cleared = await api("POST", "/tasks/v1/lists/@default/tasks/clear");
      expect(cleared.status).toBe(204);

      const afterClear = await api("GET", "/tasks/v1/lists/@default/tasks");
      expect(afterClear.data.items.map((task: Json) => task.id)).not.toContain(completed.id);

      const withHidden = await api("GET", "/tasks/v1/lists/@default/tasks?showHidden=true");
      const clearedTask = withHidden.data.items.find((task: Json) => task.id === completed.id);
      expect(clearedTask.hidden).toBe(true);

      const badDate = await api("GET", "/tasks/v1/lists/@default/tasks?dueMin=not-a-date");
      expect(badDate.status).toBe(400);
      expect(badDate.data.error.errors[0].reason).toBe("invalidArgument");
    });

    it("supports /v1 alias for googleapis rootUrl overrides", async () => {
      const tasklist = await api("POST", "/v1/users/@me/lists", { title: "Alias list" });
      expect(tasklist.status).toBe(200);

      const task = await api("POST", `/v1/lists/${tasklist.data.id}/tasks`, { title: "Alias task" });
      expect(task.data.title).toBe("Alias task");

      const listed = await api("GET", `/v1/lists/${tasklist.data.id}/tasks`);
      expect(listed.data.items[0].id).toBe(task.data.id);
    });
  });
});
