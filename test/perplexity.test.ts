import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PerplexityServer } from "../services/perplexity/src/server.js";

const PORT = 14751;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "pplx-parlelTestKey";
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

describe("Perplexity Service", () => {
  let server: PerplexityServer;

  beforeAll(async () => {
    server = new PerplexityServer(PORT);
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
      expect(root.body.name).toBe("perplexity");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const r = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.error.code).toBe("invalid_api_key");
    });
    it("accepts Bearer auth", async () => {
      const r = await api("POST", "/chat/completions", { model: "sonar", messages: [{ role: "user", content: "hi" }] });
      expect(r.status).toBe(200);
    });
  });

  describe("POST /chat/completions", () => {
    it("returns an OpenAI-compatible completion with citations", async () => {
      const r = await api("POST", "/chat/completions", {
        model: "sonar",
        messages: [{ role: "user", content: "What is parlel?" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("chat.completion");
      expect(r.body.choices[0].message.role).toBe("assistant");
      expect(Array.isArray(r.body.citations)).toBe(true);
      expect(r.body.citations.length).toBeGreaterThan(0);
      expect(r.body.citations[0]).toContain("https://");
      expect(r.body.usage.total_tokens).toBe(
        r.body.usage.prompt_tokens + r.body.usage.completion_tokens
      );
    });

    it("is deterministic", async () => {
      const payload = { model: "sonar-pro", messages: [{ role: "user", content: "Same" }] };
      const a = await api("POST", "/chat/completions", payload);
      const b = await api("POST", "/chat/completions", payload);
      expect(a.body.choices[0].message.content).toBe(b.body.choices[0].message.content);
      expect(a.body.citations).toEqual(b.body.citations);
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/chat/completions", { model: "sonar" });
      expect(r.status).toBe(400);
    });

    it("streams via SSE ending with [DONE]", async () => {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: "Stream" }], stream: true }),
      });
      const text = await response.text();
      expect(text).toContain("data: ");
      expect(text).toContain('"citations"');
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await api("POST", "/chat/completions", { model: "sonar", messages: [{ role: "user", content: "x" }] });
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(1);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/requests");
      expect(after.body.count).toBe(0);
    });
  });
});
