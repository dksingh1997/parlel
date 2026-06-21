import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DeepseekServer } from "../services/deepseek/src/server.js";

const PORT = 14752;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "sk-parlelTestKey";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

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

describe("DeepSeek Service", () => {
  let server: DeepseekServer;

  beforeAll(async () => {
    server = new DeepseekServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => expect(server.port).toBe(PORT));
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("deepseek");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const r = await fetch(`${BASE_URL}/models`);
      expect(r.status).toBe(401);
    });
    it("accepts Bearer auth", async () => {
      const r = await api("GET", "/models");
      expect(r.status).toBe(200);
    });
  });

  describe("GET /models", () => {
    it("lists deepseek models", async () => {
      const r = await api("GET", "/models");
      expect(r.body.object).toBe("list");
      expect(r.body.data.some((m: Json) => m.id === "deepseek-chat")).toBe(true);
    });
    it("works with /v1 prefix too", async () => {
      const r = await api("GET", "/v1/models");
      expect(r.status).toBe(200);
    });
  });

  describe("POST /chat/completions", () => {
    it("returns an OpenAI-compatible completion", async () => {
      const r = await api("POST", "/chat/completions", {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hello DeepSeek" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("chat.completion");
      expect(r.body.choices[0].message.role).toBe("assistant");
      expect(r.body.usage.total_tokens).toBe(
        r.body.usage.prompt_tokens + r.body.usage.completion_tokens
      );
    });

    it("returns reasoning_content for deepseek-reasoner", async () => {
      const r = await api("POST", "/chat/completions", {
        model: "deepseek-reasoner",
        messages: [{ role: "user", content: "Think hard" }],
      });
      expect(r.body.choices[0].message.reasoning_content).toBeTruthy();
    });

    it("is deterministic", async () => {
      const payload = { model: "deepseek-chat", messages: [{ role: "user", content: "Same" }] };
      const a = await api("POST", "/chat/completions", payload);
      const b = await api("POST", "/chat/completions", payload);
      expect(a.body.choices[0].message.content).toBe(b.body.choices[0].message.content);
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/chat/completions", { model: "deepseek-chat" });
      expect(r.status).toBe(400);
    });

    it("streams via SSE ending with [DONE]", async () => {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "Stream" }], stream: true }),
      });
      const text = await response.text();
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await api("POST", "/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "x" }] });
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(1);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/requests");
      expect(after.body.count).toBe(0);
    });
  });
});
