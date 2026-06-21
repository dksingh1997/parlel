import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FireworksAiServer } from "../services/fireworks-ai/src/server.js";

const PORT = 14864;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-fireworks-test" };
const MODEL = "accounts/fireworks/models/llama-v3p3-70b-instruct";

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

async function streamChunks(path: string, body: Json): Promise<string[]> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return text.split("\n\n").map((l) => l.replace(/^data: /, "").trim()).filter(Boolean);
}

describe("Fireworks AI Service", () => {
  let server: FireworksAiServer;

  beforeAll(async () => {
    server = new FireworksAiServer(PORT);
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
      expect(root.body.name).toBe("fireworks-ai");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const r = await fetch(`${BASE_URL}/inference/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(401);
    });
    it("accepts Bearer auth", async () => {
      const r = await api("POST", "/inference/v1/chat/completions", {
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r.status).toBe(200);
    });
  });

  describe("Models", () => {
    it("lists models", async () => {
      const r = await api("GET", "/inference/v1/models");
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.data)).toBe(true);
      expect(r.body.data[0].id).toContain("accounts/fireworks");
    });
  });

  describe("Chat completions", () => {
    it("returns an OpenAI-compatible completion", async () => {
      const r = await api("POST", "/inference/v1/chat/completions", {
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("chat.completion");
      expect(typeof r.body.choices[0].message.content).toBe("string");
      expect(r.body.usage.total_tokens).toBeGreaterThan(0);
    });

    it("is deterministic", async () => {
      const a = await api("POST", "/inference/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "z" }] });
      const b = await api("POST", "/inference/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "z" }] });
      expect(a.body.choices[0].message.content).toBe(b.body.choices[0].message.content);
    });

    it("rejects missing model", async () => {
      const r = await api("POST", "/inference/v1/chat/completions", { messages: [{ role: "user", content: "x" }] });
      expect(r.status).toBe(400);
    });

    it("streams SSE chunks ending in [DONE]", async () => {
      const chunks = await streamChunks("/inference/v1/chat/completions", {
        model: MODEL,
        messages: [{ role: "user", content: "stream" }],
        stream: true,
      });
      expect(chunks[chunks.length - 1]).toBe("[DONE]");
      const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
      expect(parsed[0].object).toBe("chat.completion.chunk");
      const content = parsed.map((c) => c.choices[0].delta.content || "").join("");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe("Completions + Embeddings", () => {
    it("returns a legacy completion", async () => {
      const r = await api("POST", "/inference/v1/completions", { model: MODEL, prompt: "Once" });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("text_completion");
    });
    it("returns deterministic embeddings", async () => {
      const r = await api("POST", "/inference/v1/embeddings", {
        model: "accounts/fireworks/models/nomic-embed-text-v1.5",
        input: "hi",
      });
      expect(r.status).toBe(200);
      expect(r.body.data[0].embedding.length).toBe(768);
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/inference/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "x" }] });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(0);
    });
  });
});
