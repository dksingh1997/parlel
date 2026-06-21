import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SentryServer } from "../services/sentry/src/server.js";

const PORT = 14773;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer sntrys_parlelTestKey" };

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

describe("Sentry Service", () => {
  let server: SentryServer;

  beforeAll(async () => {
    server = new SentryServer(PORT);
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
      expect(root.body.name).toBe("sentry");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects management API without auth (401)", async () => {
      const res = await fetch(`${BASE_URL}/api/0/organizations/parlel/projects/`);
      expect(res.status).toBe(401);
    });

    it("accepts Bearer auth", async () => {
      const res = await api("GET", "/api/0/organizations/parlel/projects/");
      expect(res.status).toBe(200);
    });
  });

  describe("Organizations & projects", () => {
    it("lists projects for an organization", async () => {
      const res = await api("GET", "/api/0/organizations/parlel/projects/");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0].slug).toBe("hello-world");
    });

    it("gets a project", async () => {
      const res = await api("GET", "/api/0/projects/parlel/hello-world/");
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe("hello-world");
    });

    it("creates a project", async () => {
      const res = await api("POST", "/api/0/projects/parlel/new-proj/", { platform: "python" });
      expect(res.status).toBe(201);
      expect(res.body.slug).toBe("new-proj");
      expect(res.body.platform).toBe("python");
    });

    it("404 for unknown project", async () => {
      const res = await api("GET", "/api/0/projects/parlel/nope/");
      expect(res.status).toBe(404);
    });
  });

  describe("Event ingest", () => {
    it("accepts events via /api/:project_id/store/ without management auth", async () => {
      const res = await api("POST", "/api/1/store/", {
        message: "Something broke",
        level: "error",
      }, {});
      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();

      const captured = await api("GET", "/__parlel/events", undefined, AUTH);
      expect(captured.body.count).toBe(1);
    });

    it("surfaces ingested events as issues", async () => {
      await api("POST", "/api/1/store/", { message: "Boom", level: "error" }, {});
      const issues = await api("GET", "/api/0/projects/parlel/hello-world/issues/");
      expect(issues.status).toBe(200);
      expect(issues.body.length).toBe(1);
      expect(issues.body[0].title).toBe("Boom");
    });
  });
});
