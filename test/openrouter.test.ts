import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OpenrouterServer } from "../services/openrouter/src/server.js";

const PORT = 14861;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer sk-or-parlelTest" };

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

describe("OpenRouter Service", () => {
  let server: OpenrouterServer;

  beforeAll(async () => {
    server = new OpenrouterServer(PORT);
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
      expect(root.body.name).toBe("openrouter");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const r = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(401);
    });
    it("accepts Bearer auth", async () => {
      const r = await api("POST", "/api/v1/chat/completions", {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r.status).toBe(200);
    });
  });

  describe("Models", () => {
    it("lists models (public, no auth)", async () => {
      const r = await fetch(`${BASE_URL}/api/v1/models`);
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data[0].id).toContain("/");
    });
  });

  describe("Chat completions", () => {
    it("returns an OpenAI-compatible completion with routing field", async () => {
      const r = await api("POST", "/api/v1/chat/completions", {
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("chat.completion");
      expect(r.body.choices[0].message.role).toBe("assistant");
      expect(typeof r.body.choices[0].message.content).toBe("string");
      expect(r.body.provider).toBe("anthropic");
      expect(r.body.usage.total_tokens).toBeGreaterThan(0);
    });

    it("is deterministic for the same prompt", async () => {
      const a = await api("POST", "/api/v1/chat/completions", { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }] });
      const b = await api("POST", "/api/v1/chat/completions", { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }] });
      expect(a.body.choices[0].message.content).toBe(b.body.choices[0].message.content);
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/api/v1/chat/completions", { model: "openai/gpt-4o" });
      expect(r.status).toBe(400);
    });

    it("streams SSE chunks ending in [DONE]", async () => {
      const chunks = await streamChunks("/api/v1/chat/completions", {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "stream please" }],
        stream: true,
      });
      expect(chunks[chunks.length - 1]).toBe("[DONE]");
      const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
      expect(parsed[0].object).toBe("chat.completion.chunk");
      const content = parsed.map((c) => c.choices[0].delta.content || "").join("");
      expect(content.length).toBeGreaterThan(0);
      expect(parsed[parsed.length - 1].choices[0].finish_reason).toBe("stop");
    });
  });

  describe("Embeddings", () => {
    it("returns deterministic embeddings", async () => {
      const r = await api("POST", "/api/v1/embeddings", { model: "openai/text-embedding-3-small", input: "hello" });
      expect(r.status).toBe(200);
      expect(r.body.data[0].embedding.length).toBe(1536);
      const r2 = await api("POST", "/api/v1/embeddings", { model: "openai/text-embedding-3-small", input: "hello" });
      expect(r2.body.data[0].embedding).toEqual(r.body.data[0].embedding);
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/api/v1/chat/completions", { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }] });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(0);
    });
  });
});
