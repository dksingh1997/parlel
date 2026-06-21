import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AnthropicServer } from "../services/anthropic/src/server.js";

const PORT = 14748;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "sk-ant-parlelTestKey";
const AUTH = { "x-api-key": API_KEY, "anthropic-version": "2023-06-01" };

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

describe("Anthropic Service", () => {
  let server: AnthropicServer;

  beforeAll(async () => {
    server = new AnthropicServer(PORT);
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
      expect(root.body.name).toBe("anthropic");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing x-api-key with 401 + error envelope", async () => {
      const r = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", max_tokens: 64, messages: [] }),
      });
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("authentication_error");
      expect(typeof body.request_id).toBe("string");
      expect(body.request_id).toMatch(/^req_/);
    });
    it("accepts x-api-key auth", async () => {
      const r = await api("POST", "/v1/messages", {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(r.status).toBe(200);
    });
  });

  describe("POST /v1/messages", () => {
    it("returns the documented message shape", async () => {
      const r = await api("POST", "/v1/messages", {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 256,
        messages: [{ role: "user", content: "Hello, Claude" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.type).toBe("message");
      expect(r.body.role).toBe("assistant");
      expect(r.body.content[0].type).toBe("text");
      expect(typeof r.body.content[0].text).toBe("string");
      expect(r.body.model).toBe("claude-3-5-sonnet-20241022");
      expect(r.body.stop_reason).toBe("end_turn");
      expect(r.body.stop_sequence).toBeNull();
      expect(r.body.usage.input_tokens).toBeGreaterThan(0);
      expect(r.body.usage.output_tokens).toBeGreaterThan(0);
      expect(typeof r.body.id).toBe("string");
      expect(r.body.id).toMatch(/^msg_/);
      expect(typeof r.body.request_id).toBe("string");
      expect(r.body.request_id).toMatch(/^req_/);
      expect(r.headers.get("request-id")).toMatch(/^req_/);
    });

    it("is deterministic for the same input", async () => {
      const payload = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 256,
        messages: [{ role: "user", content: "Deterministic?" }],
      };
      const a = await api("POST", "/v1/messages", payload);
      const b = await api("POST", "/v1/messages", payload);
      expect(a.body.content[0].text).toBe(b.body.content[0].text);
      expect(a.body.id).toBe(b.body.id);
    });

    it("supports system prompts and array content blocks", async () => {
      const r = await api("POST", "/v1/messages", {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        system: "You are concise.",
        messages: [{ role: "user", content: [{ type: "text", text: "Hi there" }] }],
      });
      expect(r.status).toBe(200);
      expect(r.body.content[0].text).toBeTruthy();
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/v1/messages", { model: "claude-3-5-sonnet-20241022", max_tokens: 64 });
      expect(r.status).toBe(400);
      expect(r.body.error.type).toBe("invalid_request_error");
    });

    it("rejects missing max_tokens", async () => {
      const r = await api("POST", "/v1/messages", {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r.status).toBe(400);
    });

    it("rejects missing model", async () => {
      const r = await api("POST", "/v1/messages", {
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r.status).toBe(400);
      expect(r.body.error.type).toBe("invalid_request_error");
    });

    it("returns 404 for unknown v1 routes", async () => {
      const r = await api("GET", "/v1/unknown");
      expect(r.status).toBe(404);
      expect(r.body.type).toBe("error");
      expect(r.body.error.type).toBe("not_found_error");
      expect(typeof r.body.request_id).toBe("string");
    });

    it("returns 400 for malformed JSON", async () => {
      const response = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "not json",
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("streams via SSE event format (message_start..message_stop)", async () => {
      const r = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 256,
          stream: true,
          messages: [{ role: "user", content: "Stream me" }],
        }),
      });
      const text = await r.text();
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: content_block_delta");
      expect(text).toContain("event: message_stop");
      expect(text).toContain('"type":"text_delta"');
      expect(r.headers.get("request-id")).toMatch(/^req_/);
      expect(text).toContain('"request_id":"req_');
    });
  });

  describe("POST /v1/messages/count_tokens", () => {
    it("returns input_tokens with details", async () => {
      const r = await api("POST", "/v1/messages/count_tokens", {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "one two three" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.input_tokens).toBe(3);
      expect(r.body.input_tokens_details).toEqual({ cache_read: 0, cache_creation: 0 });
      expect(typeof r.body.request_id).toBe("string");
      expect(r.body.request_id).toMatch(/^req_/);
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/v1/messages/count_tokens", {
        model: "claude-3-5-sonnet-20241022",
      });
      expect(r.status).toBe(400);
      expect(r.body.type).toBe("error");
      expect(r.body.error.type).toBe("invalid_request_error");
      expect(typeof r.body.request_id).toBe("string");
    });

    it("rejects missing model", async () => {
      const r = await api("POST", "/v1/messages/count_tokens", {
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r.status).toBe(400);
      expect(r.body.type).toBe("error");
      expect(r.body.error.type).toBe("invalid_request_error");
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await api("POST", "/v1/messages", {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
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
