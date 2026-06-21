import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TodoistServer } from "../services/todoist/src/server.js";

const PORT = 14793;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer todoist_parlelTestKey" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Todoist Service", () => {
  let server: TodoistServer;

  beforeAll(async () => {
    server = new TodoistServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("todoist");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const response = await fetch(`${BASE_URL}/rest/v2/tasks`);
      expect(response.status).toBe(401);
    });

    it("accepts Bearer auth", async () => {
      const list = await api("GET", "/rest/v2/tasks");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);
    });
  });

  describe("Tasks CRUD", () => {
    it("creates a task with expected shape", async () => {
      const created = await api("POST", "/rest/v2/tasks", { content: "Buy milk" });
      expect(created.status).toBe(200);
      expect(created.body.id).toBeTruthy();
      expect(created.body.content).toBe("Buy milk");
      expect(created.body.project_id).toBeTruthy();
      expect(created.body.is_completed).toBe(false);
    });

    it("rejects task without content", async () => {
      const created = await api("POST", "/rest/v2/tasks", {});
      expect(created.status).toBe(400);
    });

    it("lists, retrieves, updates and deletes a task", async () => {
      const created = await api("POST", "/rest/v2/tasks", { content: "Before" });
      const id = created.body.id;
      const got = await api("GET", `/rest/v2/tasks/${id}`);
      expect(got.body.content).toBe("Before");
      const updated = await api("POST", `/rest/v2/tasks/${id}`, { content: "After", priority: 4 });
      expect(updated.body.content).toBe("After");
      expect(updated.body.priority).toBe(4);
      const deleted = await api("DELETE", `/rest/v2/tasks/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/rest/v2/tasks/${id}`);
      expect(gone.status).toBe(404);
    });

    it("closes a task (204) and removes it from active list", async () => {
      const created = await api("POST", "/rest/v2/tasks", { content: "Finish me" });
      const id = created.body.id;
      const closed = await api("POST", `/rest/v2/tasks/${id}/close`);
      expect(closed.status).toBe(204);
      const list = await api("GET", "/rest/v2/tasks");
      expect(list.body.find((t: Json) => t.id === id)).toBeUndefined();
    });
  });

  describe("Projects", () => {
    it("lists default Inbox and creates a project", async () => {
      const list = await api("GET", "/rest/v2/projects");
      expect(list.body.length).toBeGreaterThanOrEqual(1);
      const created = await api("POST", "/rest/v2/projects", { name: "Work" });
      expect(created.status).toBe(200);
      expect(created.body.name).toBe("Work");
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await api("POST", "/rest/v2/tasks", { content: "x" });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/rest/v2/tasks");
      expect(list.body).toEqual([]);
    });
  });
});
