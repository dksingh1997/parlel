import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { VercelServer } from "../services/vercel/src/server.js";

const PORT = 14770;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer vercel_parlelTestKey" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Vercel Service", () => {
  let server: VercelServer;

  beforeAll(async () => {
    server = new VercelServer(PORT);
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
    it("starts on configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("vercel");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 403", async () => {
      const res = await fetch(`${BASE_URL}/v2/user`);
      expect(res.status).toBe(403);
    });

    it("accepts Bearer auth", async () => {
      const res = await api("GET", "/v2/user");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /v2/user", () => {
    it("returns the current user wrapped in { user }", async () => {
      const res = await api("GET", "/v2/user");
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe("parlel-user");
      expect(res.body.user.uid).toBeTruthy();
    });
  });

  describe("Projects", () => {
    it("lists projects with pagination", async () => {
      const res = await api("GET", "/v9/projects");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.projects)).toBe(true);
      expect(res.body.pagination).toBeTruthy();
      expect(res.body.projects.length).toBeGreaterThanOrEqual(1);
    });

    it("creates a project", async () => {
      const res = await api("POST", "/v9/projects", { name: "my-app", framework: "nextjs" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("my-app");
      expect(res.body.id).toMatch(/^prj_/);
    });

    it("rejects project without name", async () => {
      const res = await api("POST", "/v9/projects", {});
      expect(res.status).toBe(400);
    });

    it("gets a project by id and by name", async () => {
      const created = await api("POST", "/v9/projects", { name: "lookup-app" });
      const byId = await api("GET", `/v9/projects/${created.body.id}`);
      expect(byId.body.name).toBe("lookup-app");
      const byName = await api("GET", "/v9/projects/lookup-app");
      expect(byName.body.id).toBe(created.body.id);
    });
  });

  describe("Deployments", () => {
    it("creates a deployment via /v13/deployments", async () => {
      const res = await api("POST", "/v13/deployments", { name: "hello-world" });
      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(/^dpl_/);
      expect(res.body.readyState).toBe("READY");
      expect(res.body.url).toContain(".vercel.app");
    });

    it("lists deployments via /v6/deployments", async () => {
      await api("POST", "/v13/deployments", { name: "a" });
      await api("POST", "/v13/deployments", { name: "b" });
      const res = await api("GET", "/v6/deployments");
      expect(res.status).toBe(200);
      expect(res.body.deployments.length).toBe(2);
    });

    it("rejects deployment without name", async () => {
      const res = await api("POST", "/v13/deployments", {});
      expect(res.status).toBe(400);
    });
  });
});
