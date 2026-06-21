import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CircleciServer } from "../services/circleci/src/server.js";

const PORT = 14876;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { "Circle-Token": "parlelTestToken" };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

const SLUG = "gh/parlel/demo";

describe("CircleCI Service", () => {
  let server: CircleciServer;

  beforeAll(async () => {
    server = new CircleciServer(PORT);
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
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("circleci");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing Circle-Token with 401", async () => {
      const res = await fetch(`${BASE_URL}/api/v2/me`);
      expect(res.status).toBe(401);
    });

    it("accepts Circle-Token header", async () => {
      const result = await api("GET", "/api/v2/me");
      expect(result.status).toBe(200);
      expect(result.body.login).toBeTruthy();
    });
  });

  describe("Projects", () => {
    it("returns project metadata", async () => {
      const result = await api("GET", `/api/v2/project/${SLUG}`);
      expect(result.status).toBe(200);
      expect(result.body.slug).toBe(SLUG);
      expect(result.body.name).toBe("demo");
    });
  });

  describe("Pipelines", () => {
    it("creates a pipeline returning {id,state,number,created_at}", async () => {
      const result = await api("POST", `/api/v2/project/${SLUG}/pipeline`, { branch: "main" });
      expect(result.status).toBe(201);
      expect(result.body.state).toBe("created");
      expect(result.body.number).toBe(1);
      expect(result.body.id).toBeTruthy();
      expect(result.body.created_at).toBeTruthy();
    });

    it("retrieves a pipeline by id", async () => {
      const created = await api("POST", `/api/v2/project/${SLUG}/pipeline`, {});
      const got = await api("GET", `/api/v2/pipeline/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(created.body.id);
      expect(got.body.project_slug).toBe(SLUG);
    });

    it("lists pipeline workflows in {items,next_page_token} shape", async () => {
      const created = await api("POST", `/api/v2/project/${SLUG}/pipeline`, {});
      const wf = await api("GET", `/api/v2/pipeline/${created.body.id}/workflow`);
      expect(wf.status).toBe(200);
      expect(Array.isArray(wf.body.items)).toBe(true);
      expect(wf.body.items.length).toBeGreaterThanOrEqual(1);
      expect(wf.body).toHaveProperty("next_page_token");
    });

    it("retrieves a workflow by id", async () => {
      const created = await api("POST", `/api/v2/project/${SLUG}/pipeline`, {});
      const wf = await api("GET", `/api/v2/pipeline/${created.body.id}/workflow`);
      const workflowId = wf.body.items[0].id;
      const got = await api("GET", `/api/v2/workflow/${workflowId}`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(workflowId);
      expect(got.body.pipeline_id).toBe(created.body.id);
    });

    it("returns 404 for unknown pipeline", async () => {
      const result = await api("GET", "/api/v2/pipeline/does-not-exist");
      expect(result.status).toBe(404);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", `/api/v2/project/${SLUG}/pipeline`, {});
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const list = await api("GET", `/api/v2/project/${SLUG}/pipeline`);
      expect(list.body.items.length).toBe(0);
    });
  });
});
