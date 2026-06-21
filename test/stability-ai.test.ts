import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { StabilityAiServer } from "../services/stability-ai/src/server.js";

const PORT = 14862;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer sk-parlel-test" };

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

describe("Stability AI Service", () => {
  let server: StabilityAiServer;

  beforeAll(async () => {
    server = new StabilityAiServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("stability-ai");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const r = await fetch(`${BASE_URL}/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text_prompts: [{ text: "a cat" }] }),
      });
      expect(r.status).toBe(401);
    });
  });

  describe("v1 text-to-image", () => {
    it("returns artifacts with base64, seed, finishReason", async () => {
      const r = await api("POST", "/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
        text_prompts: [{ text: "a cat" }],
        samples: 1,
      });
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.artifacts)).toBe(true);
      expect(r.body.artifacts[0].finishReason).toBe("SUCCESS");
      expect(typeof r.body.artifacts[0].base64).toBe("string");
      expect(typeof r.body.artifacts[0].seed).toBe("number");
      // base64 decodes to a valid buffer
      expect(Buffer.from(r.body.artifacts[0].base64, "base64").length).toBeGreaterThan(0);
    });

    it("is deterministic for the same prompt", async () => {
      const a = await api("POST", "/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", { text_prompts: [{ text: "a dog" }] });
      const b = await api("POST", "/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", { text_prompts: [{ text: "a dog" }] });
      expect(a.body.artifacts[0].base64).toBe(b.body.artifacts[0].base64);
    });

    it("rejects missing text_prompts", async () => {
      const r = await api("POST", "/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {});
      expect(r.status).toBe(400);
    });

    it("respects samples count", async () => {
      const r = await api("POST", "/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
        text_prompts: [{ text: "x" }], samples: 3,
      });
      expect(r.body.artifacts.length).toBe(3);
    });
  });

  describe("v2beta stable-image core", () => {
    it("returns json with image, seed, finish_reason when Accept is json", async () => {
      const r = await fetch(`${BASE_URL}/v2beta/stable-image/generate/core`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ prompt: "a sunset" }),
      });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.finish_reason).toBe("SUCCESS");
      expect(typeof body.image).toBe("string");
    });

    it("returns raw image bytes by default", async () => {
      const r = await fetch(`${BASE_URL}/v2beta/stable-image/generate/core`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a sunset" }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("image");
      const buf = Buffer.from(await r.arrayBuffer());
      expect(buf.length).toBeGreaterThan(0);
    });
  });

  describe("Engines + account", () => {
    it("lists engines", async () => {
      const r = await api("GET", "/v1/engines/list");
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBeGreaterThanOrEqual(1);
    });
    it("returns account info", async () => {
      const r = await api("GET", "/v1/user/account");
      expect(r.status).toBe(200);
      expect(r.body.email).toBeTruthy();
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", { text_prompts: [{ text: "x" }] });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(0);
    });
  });
});
