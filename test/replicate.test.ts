import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ReplicateServer } from "../services/replicate/src/server.js";

const PORT = 14856;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Token r8_parlelTestKey" };

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

describe("Replicate Service", () => {
  let server: ReplicateServer;

  beforeAll(async () => {
    server = new ReplicateServer(PORT);
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
      expect(root.body.name).toBe("replicate");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const r = await fetch(`${BASE_URL}/v1/predictions`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const r = await fetch(`${BASE_URL}/v1/predictions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { prompt: "hi" } }),
      });
      expect(r.status).toBe(401);
    });

    it("accepts Token auth", async () => {
      const r = await api("POST", "/v1/predictions", { input: { prompt: "hi" } });
      expect(r.status).toBe(201);
    });
  });

  describe("Predictions", () => {
    it("creates a prediction in starting state", async () => {
      const r = await api("POST", "/v1/predictions", {
        version: "abc123",
        input: { prompt: "a cat" },
      });
      expect(r.status).toBe(201);
      expect(r.body.status).toBe("starting");
      expect(r.body.id).toBeTruthy();
      expect(r.body.urls.get).toContain(r.body.id);
    });

    it("resolves to succeeded on first GET with deterministic output", async () => {
      const created = await api("POST", "/v1/predictions", { input: { prompt: "a cat" } });
      const got1 = await api("GET", `/v1/predictions/${created.body.id}`);
      expect(got1.status).toBe(200);
      expect(got1.body.status).toBe("succeeded");
      expect(Array.isArray(got1.body.output)).toBe(true);
      // Determinism: same input prompt yields same output text.
      const created2 = await api("POST", "/v1/predictions", { input: { prompt: "a cat" } });
      const got2 = await api("GET", `/v1/predictions/${created2.body.id}`);
      expect(got2.body.output).toEqual(got1.body.output);
    });

    it("returns 404 for unknown prediction", async () => {
      const r = await api("GET", "/v1/predictions/does-not-exist");
      expect(r.status).toBe(404);
    });

    it("cancels a prediction", async () => {
      const created = await api("POST", "/v1/predictions", { input: { prompt: "x" } });
      const cancelled = await api("POST", `/v1/predictions/${created.body.id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe("canceled");
    });
  });

  describe("Models", () => {
    it("retrieves a model by owner/name", async () => {
      const r = await api("GET", "/v1/models/stability-ai/sdxl");
      expect(r.status).toBe(200);
      expect(r.body.owner).toBe("stability-ai");
      expect(r.body.name).toBe("sdxl");
      expect(r.body.latest_version.id).toBeTruthy();
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/v1/predictions", { input: { prompt: "x" } });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const list = await api("GET", "/__parlel/predictions");
      expect(list.body.count).toBe(0);
    });
  });
});
