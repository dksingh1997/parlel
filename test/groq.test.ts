import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GroqServer } from "../services/groq/src/server.js";

const PORT = 14750;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "gsk_parlelTestKey";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Groq Service", () => {
  let server: GroqServer;

  beforeAll(async () => {
    server = new GroqServer(PORT);
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
      expect(root.body.name).toBe("groq");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const r = await fetch(`${BASE_URL}/openai/v1/models`);
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.error.code).toBe("invalid_api_key");
    });
    it("accepts Bearer auth", async () => {
      const r = await api("GET", "/openai/v1/models");
      expect(r.status).toBe(200);
    });
  });

  describe("GET /openai/v1/models", () => {
    it("lists Groq models", async () => {
      const r = await api("GET", "/openai/v1/models");
      expect(r.body.object).toBe("list");
      expect(r.body.data.some((m: Json) => m.id === "llama-3.3-70b-versatile")).toBe(true);
      expect(r.body.data[0].owned_by).toBe("Groq");
    });
  });

  describe("POST /openai/v1/chat/completions", () => {
    it("returns an OpenAI-compatible chat completion", async () => {
      const r = await api("POST", "/openai/v1/chat/completions", {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "Hello Groq" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("chat.completion");
      expect(r.body.choices[0].message.role).toBe("assistant");
      expect(r.body.choices[0].finish_reason).toBe("stop");
      expect(r.body.x_groq).toBeTruthy();
      expect(r.body.usage.total_tokens).toBe(
        r.body.usage.prompt_tokens + r.body.usage.completion_tokens
      );
    });

    it("is deterministic", async () => {
      const payload = { model: "llama-3.1-8b-instant", messages: [{ role: "user", content: "Same" }] };
      const a = await api("POST", "/openai/v1/chat/completions", payload);
      const b = await api("POST", "/openai/v1/chat/completions", payload);
      expect(a.body.choices[0].message.content).toBe(b.body.choices[0].message.content);
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/openai/v1/chat/completions", { model: "x" });
      expect(r.status).toBe(400);
    });

    it("streams via SSE ending with [DONE]", async () => {
      const response = await fetch(`${BASE_URL}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: "Stream" }],
          stream: true,
        }),
      });
      const text = await response.text();
      expect(text).toContain("data: ");
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await api("POST", "/openai/v1/chat/completions", {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "x" }],
      });
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(1);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/requests");
      expect(after.body.count).toBe(0);
    });
  });
});
