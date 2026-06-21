import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ClickupServer } from "../services/clickup/src/server.js";

const PORT = 14790;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "pk_parlelTestKey" };

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

describe("ClickUp Service", () => {
  let server: ClickupServer;

  beforeAll(async () => {
    server = new ClickupServer(PORT);
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
      expect(root.body.name).toBe("clickup");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const response = await fetch(`${BASE_URL}/api/v2/user`);
      expect(response.status).toBe(401);
    });

    it("accepts a raw token header", async () => {
      const user = await api("GET", "/api/v2/user");
      expect(user.status).toBe(200);
      expect(user.body.user.email).toBe("parlel@example.com");
    });
  });

  describe("Team & User", () => {
    it("lists teams", async () => {
      const teams = await api("GET", "/api/v2/team");
      expect(Array.isArray(teams.body.teams)).toBe(true);
      expect(teams.body.teams.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Tasks CRUD", () => {
    it("creates a task in a list with status shape", async () => {
      const created = await api("POST", "/api/v2/list/901/task", { name: "Build it" });
      expect(created.status).toBe(200);
      expect(created.body.id).toBeTruthy();
      expect(created.body.name).toBe("Build it");
      expect(created.body.status.status).toBeTruthy();
    });

    it("rejects task without name", async () => {
      const created = await api("POST", "/api/v2/list/901/task", {});
      expect(created.status).toBe(400);
      expect(created.body.err).toBeTruthy();
    });

    it("lists tasks in a list", async () => {
      await api("POST", "/api/v2/list/901/task", { name: "A" });
      await api("POST", "/api/v2/list/901/task", { name: "B" });
      const list = await api("GET", "/api/v2/list/901/task");
      expect(list.body.tasks.length).toBe(2);
    });

    it("retrieves, updates, deletes a task", async () => {
      const created = await api("POST", "/api/v2/list/901/task", { name: "Before" });
      const id = created.body.id;
      const got = await api("GET", `/api/v2/task/${id}`);
      expect(got.body.name).toBe("Before");
      const updated = await api("PUT", `/api/v2/task/${id}`, { name: "After", status: "done" });
      expect(updated.body.name).toBe("After");
      expect(updated.body.status.status).toBe("done");
      const deleted = await api("DELETE", `/api/v2/task/${id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/api/v2/task/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await api("POST", "/api/v2/list/901/task", { name: "x" });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/api/v2/list/901/task");
      expect(list.body.tasks).toEqual([]);
    });
  });
});
