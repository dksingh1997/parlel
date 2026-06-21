import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { RenderServer } from "../services/render/src/server.js";

const PORT = 14881;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlelTestKey" };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
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

describe("Render Service", () => {
  let server: RenderServer;

  beforeAll(async () => {
    server = new RenderServer(PORT);
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
      expect(root.body.name).toBe("render");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer with 401", async () => {
      const res = await fetch(`${BASE_URL}/v1/services`);
      expect(res.status).toBe(401);
    });

    it("accepts bearer auth", async () => {
      const result = await api("GET", "/v1/services");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
    });
  });

  describe("Owners", () => {
    it("lists owners in [{owner,cursor}] shape", async () => {
      const result = await api("GET", "/v1/owners");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
      expect(result.body[0]).toHaveProperty("owner");
      expect(result.body[0]).toHaveProperty("cursor");
    });
  });

  describe("Services", () => {
    it("creates a service with type web_service", async () => {
      const result = await api("POST", "/v1/services", { name: "api-server", type: "web_service" });
      expect(result.status).toBe(201);
      expect(result.body.service.type).toBe("web_service");
      expect(result.body.service.name).toBe("api-server");
      expect(result.body.service.id).toBeTruthy();
    });

    it("rejects service creation without name", async () => {
      const result = await api("POST", "/v1/services", {});
      expect(result.status).toBe(400);
    });

    it("lists services in [{service,cursor}] shape", async () => {
      await api("POST", "/v1/services", { name: "svc-a" });
      const result = await api("GET", "/v1/services");
      expect(result.status).toBe(200);
      expect(result.body[0]).toHaveProperty("service");
      expect(result.body[0]).toHaveProperty("cursor");
    });

    it("retrieves, patches and deletes a service", async () => {
      const created = await api("POST", "/v1/services", { name: "lifecycle" });
      const id = created.body.service.id;
      const got = await api("GET", `/v1/services/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("lifecycle");

      const patched = await api("PATCH", `/v1/services/${id}`, { name: "renamed" });
      expect(patched.body.name).toBe("renamed");

      const deleted = await api("DELETE", `/v1/services/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v1/services/${id}`);
      expect(gone.status).toBe(404);
    });

    it("returns 404 for unknown service", async () => {
      const result = await api("GET", "/v1/services/does-not-exist");
      expect(result.status).toBe(404);
    });
  });

  describe("Deploys", () => {
    it("creates and lists deploys for a service", async () => {
      const created = await api("POST", "/v1/services", { name: "deployable" });
      const id = created.body.service.id;

      const deploy = await api("POST", `/v1/services/${id}/deploys`, { commitMessage: "ship it" });
      expect(deploy.status).toBe(201);
      expect(deploy.body.id).toBeTruthy();
      expect(deploy.body.status).toBe("created");

      const list = await api("GET", `/v1/services/${id}/deploys`);
      expect(list.status).toBe(200);
      expect(list.body[0]).toHaveProperty("deploy");
      expect(list.body.length).toBe(1);

      const got = await api("GET", `/v1/services/${id}/deploys/${deploy.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(deploy.body.id);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/v1/services", { name: "temp" });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const list = await api("GET", "/v1/services");
      expect(list.body.length).toBe(0);
    });
  });
});
