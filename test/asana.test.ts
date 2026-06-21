import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AsanaServer } from "../services/asana/src/server.js";

const PORT = 14789;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer asana_parlelTestKey" };

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

describe("Asana Service", () => {
  let server: AsanaServer;

  beforeAll(async () => {
    server = new AsanaServer(PORT);
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
      expect(root.body.name).toBe("asana");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const response = await fetch(`${BASE_URL}/api/1.0/users/me`);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe("Not Authorized");
    });

    it("accepts Bearer auth and returns wrapped data", async () => {
      const me = await api("GET", "/api/1.0/users/me");
      expect(me.status).toBe(200);
      expect(me.body.data.gid).toBeTruthy();
      expect(me.body.data.email).toBe("parlel@example.com");
    });
  });

  describe("Error envelope", () => {
    it("uses standard Asana error shape { errors: [{ message }] }", async () => {
      const res = await api("POST", "/api/1.0/tasks", { data: {} });
      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(res.body.errors[0].message).toBeTruthy();
      expect(res.body.errors[0].help).toBeUndefined();
    });

    it("returns 404 with error envelope for unknown endpoints", async () => {
      const res = await api("GET", "/api/1.0/unknown");
      expect(res.status).toBe(404);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toBe("Not Found");
    });
  });

  describe("Tasks CRUD", () => {
    const WS = "1000001";

    it("creates a task wrapped in {data}", async () => {
      const created = await api("POST", "/api/1.0/tasks", { data: { name: "Do thing", workspace: WS } });
      expect(created.status).toBe(201);
      expect(created.body.data.gid).toBeTruthy();
      expect(created.body.data.name).toBe("Do thing");
      expect(created.body.data.resource_type).toBe("task");
    });

    it("creates task with due_at, start_on, html_notes", async () => {
      const created = await api("POST", "/api/1.0/tasks", {
        data: {
          name: "Task with dates",
          workspace: WS,
          due_at: "2025-06-15T12:00:00Z",
          start_on: "2025-06-10",
          html_notes: "<body>Notes</body>",
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.data.due_at).toBe("2025-06-15T12:00:00Z");
      expect(created.body.data.start_on).toBe("2025-06-10");
      expect(created.body.data.html_notes).toBe("<body>Notes</body>");
    });

    it("rejects task without name", async () => {
      const created = await api("POST", "/api/1.0/tasks", { data: { workspace: WS } });
      expect(created.status).toBe(400);
      expect(created.body.errors).toBeTruthy();
      expect(created.body.errors[0].message).toBe("name: Missing input");
    });

    it("requires workspace param on task list", async () => {
      const res = await api("GET", "/api/1.0/tasks");
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toBe("workspace: Missing input");
    });

    it("lists tasks when workspace param provided", async () => {
      await api("POST", "/api/1.0/tasks", { data: { name: "A", workspace: WS } });
      await api("POST", "/api/1.0/tasks", { data: { name: "B", workspace: WS } });
      const list = await api("GET", `/api/1.0/tasks?workspace=${WS}`);
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.data.length).toBe(2);
    });

    it("retrieves, updates, deletes a task", async () => {
      const created = await api("POST", "/api/1.0/tasks", { data: { name: "Before", workspace: WS } });
      const gid = created.body.data.gid;
      const got = await api("GET", `/api/1.0/tasks/${gid}`);
      expect(got.body.data.name).toBe("Before");
      const updated = await api("PUT", `/api/1.0/tasks/${gid}`, { data: { name: "After", completed: true } });
      expect(updated.body.data.name).toBe("After");
      expect(updated.body.data.completed).toBe(true);
      const deleted = await api("DELETE", `/api/1.0/tasks/${gid}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.data).toEqual({});
      const gone = await api("GET", `/api/1.0/tasks/${gid}`);
      expect(gone.status).toBe(404);
    });

    it("updates task assignee, due_at, start_on, html_notes", async () => {
      const created = await api("POST", "/api/1.0/tasks", { data: { name: "Update me", workspace: WS } });
      const gid = created.body.data.gid;
      const updated = await api("PUT", `/api/1.0/tasks/${gid}`, {
        data: {
          assignee: "999",
          due_at: "2025-07-01T09:00:00Z",
          start_on: "2025-06-28",
          html_notes: "<body>Updated</body>",
        },
      });
      expect(updated.body.data.assignee.gid).toBe("999");
      expect(updated.body.data.due_at).toBe("2025-07-01T09:00:00Z");
      expect(updated.body.data.start_on).toBe("2025-06-28");
      expect(updated.body.data.html_notes).toBe("<body>Updated</body>");
    });

    it("returns 404 for non-existent task", async () => {
      const res = await api("GET", "/api/1.0/tasks/999999");
      expect(res.status).toBe(404);
      expect(res.body.errors[0].message).toBe("task: Not Found");
    });
  });

  describe("Projects", () => {
    const WS = "1000001";

    it("requires workspace param on project list", async () => {
      const res = await api("GET", "/api/1.0/projects");
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toBe("workspace: Missing input");
    });

    it("lists and creates projects", async () => {
      const list = await api("GET", `/api/1.0/projects?workspace=${WS}`);
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBeGreaterThanOrEqual(1);
      const created = await api("POST", "/api/1.0/projects", { data: { name: "New Proj", workspace: WS } });
      expect(created.status).toBe(201);
      expect(created.body.data.name).toBe("New Proj");
    });
  });

  describe("Workspaces", () => {
    it("lists workspaces", async () => {
      const list = await api("GET", "/api/1.0/workspaces");
      expect(list.body.data.length).toBeGreaterThanOrEqual(1);
      expect(list.body.data[0].resource_type).toBe("workspace");
    });

    it("retrieves a single workspace", async () => {
      const list = await api("GET", "/api/1.0/workspaces");
      const wsGid = list.body.data[0].gid;
      const got = await api("GET", `/api/1.0/workspaces/${wsGid}`);
      expect(got.status).toBe(200);
      expect(got.body.data.gid).toBe(wsGid);
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await api("POST", "/api/1.0/tasks", { data: { name: "x", workspace: "1000001" } });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/api/1.0/tasks?workspace=1000001");
      expect(list.body.data).toEqual([]);
    });
  });
});
