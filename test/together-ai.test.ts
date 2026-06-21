import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TogetherAiServer } from "../services/together-ai/src/server.js";

const PORT = 14863;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-together-test" };

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

describe("Together AI Service", () => {
  let server: TogetherAiServer;

  beforeAll(async () => {
    server = new TogetherAiServer(PORT);
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
      expect(root.body.name).toBe("together-ai");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(401);
    });
    it("accepts Bearer auth", async () => {
      const r = await api("POST", "/v1/chat/completions", {
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r.status).toBe(200);
    });
  });

  describe("Models", () => {
    it("lists models", async () => {
      const r = await api("GET", "/v1/models");
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body[0].id).toContain("/");
    });
  });

  describe("Chat completions", () => {
    it("returns an OpenAI-compatible completion", async () => {
      const r = await api("POST", "/v1/chat/completions", {
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("chat.completion");
      expect(typeof r.body.choices[0].message.content).toBe("string");
      expect(r.body.usage.total_tokens).toBeGreaterThan(0);
    });

    it("is deterministic", async () => {
      const a = await api("POST", "/v1/chat/completions", { model: "x", messages: [{ role: "user", content: "z" }] });
      const b = await api("POST", "/v1/chat/completions", { model: "x", messages: [{ role: "user", content: "z" }] });
      expect(a.body.choices[0].message.content).toBe(b.body.choices[0].message.content);
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/v1/chat/completions", { model: "x" });
      expect(r.status).toBe(400);
    });

    it("streams SSE chunks ending in [DONE]", async () => {
      const chunks = await streamChunks("/v1/chat/completions", {
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
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

  describe("Completions", () => {
    it("returns a legacy completion", async () => {
      const r = await api("POST", "/v1/completions", { model: "x", prompt: "Once upon a time" });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("text_completion");
      expect(typeof r.body.choices[0].text).toBe("string");
    });
  });

  describe("Embeddings", () => {
    it("returns deterministic embeddings", async () => {
      const r = await api("POST", "/v1/embeddings", { model: "togethercomputer/m2-bert-80M-8k-retrieval", input: "hi" });
      expect(r.status).toBe(200);
      expect(r.body.data[0].embedding.length).toBe(768);
    });
  });

  describe("Images", () => {
    it("returns deterministic images", async () => {
      const r = await api("POST", "/v1/images/generations", { model: "black-forest-labs/FLUX.1-schnell", prompt: "a cat" });
      expect(r.status).toBe(200);
      expect(typeof r.body.data[0].b64_json).toBe("string");
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/v1/chat/completions", { model: "x", messages: [{ role: "user", content: "x" }] });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(0);
    });
  });
});
