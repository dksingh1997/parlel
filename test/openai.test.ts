import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OpenaiServer } from "../services/openai/src/server.js";

const PORT = 14747;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "sk-parlelTestKey";
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

async function stream(path: string, body: Json): Promise<string> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.text();
}

describe("OpenAI Service", () => {
  let server: OpenaiServer;

  beforeAll(async () => {
    server = new OpenaiServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("openai");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const r = await fetch(`${BASE_URL}/v1/chat/completions`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  describe("Authentication", () => {
    it("rejects a missing Authorization header with 401 + code:null", async () => {
      const r = await fetch(`${BASE_URL}/v1/models`, { method: "GET" });
      const body = await r.json();
      expect(r.status).toBe(401);
      // Real API: a MISSING key returns code:null with a "You didn't provide an API key" message.
      expect(body.error.code).toBe(null);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe(null);
      expect(body.error.message).toContain("didn't provide an API key");
    });
    it("rejects a malformed credential with 401 + invalid_api_key", async () => {
      // Present header but not a usable Bearer token -> invalid_api_key.
      const r = await fetch(`${BASE_URL}/v1/models`, {
        method: "GET",
        headers: { Authorization: "Basic abc123" },
      });
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.error.code).toBe("invalid_api_key");
      expect(body.error.type).toBe("invalid_request_error");
    });
    it("accepts Bearer auth", async () => {
      const r = await api("GET", "/v1/models");
      expect(r.status).toBe(200);
    });
  });

  describe("GET /v1/models", () => {
    it("lists models", async () => {
      const r = await api("GET", "/v1/models");
      expect(r.body.object).toBe("list");
      expect(r.body.data.some((m: Json) => m.id === "gpt-4o")).toBe(true);
      expect(r.body.data[0].object).toBe("model");
    });
    it("retrieves a single model", async () => {
      const r = await api("GET", "/v1/models/gpt-4o");
      expect(r.body.id).toBe("gpt-4o");
      expect(r.body.object).toBe("model");
      expect(r.body.owned_by).toBe("openai");
    });
    it("returns 404 model_not_found for an unknown model id", async () => {
      const r = await api("GET", "/v1/models/gpt-9-imaginary");
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("model_not_found");
      expect(r.body.error.type).toBe("invalid_request_error");
      expect(r.body.error.message).toContain("gpt-9-imaginary");
    });
  });

  describe("POST /v1/chat/completions", () => {
    it("returns a chat completion with realistic shape", async () => {
      const r = await api("POST", "/v1/chat/completions", {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello there" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("chat.completion");
      expect(r.body.model).toBe("gpt-4o");
      expect(r.body.choices[0].message.role).toBe("assistant");
      expect(typeof r.body.choices[0].message.content).toBe("string");
      expect(r.body.choices[0].finish_reason).toBe("stop");
      expect(r.body.usage.total_tokens).toBe(
        r.body.usage.prompt_tokens + r.body.usage.completion_tokens
      );
      expect(r.body.choices[0].message.refusal).toBe(null);
      // Real API always returns the usage token-detail sub-objects.
      expect(r.body.usage.prompt_tokens_details).toEqual({ cached_tokens: 0, audio_tokens: 0 });
      expect(r.body.usage.completion_tokens_details).toMatchObject({
        reasoning_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      });
    });

    it("is deterministic for the same prompt", async () => {
      const payload = { model: "gpt-4o", messages: [{ role: "user", content: "Repeat me" }] };
      const a = await api("POST", "/v1/chat/completions", payload);
      const b = await api("POST", "/v1/chat/completions", payload);
      expect(a.body.choices[0].message.content).toBe(b.body.choices[0].message.content);
      expect(a.body.id).toBe(b.body.id);
    });

    it("rejects when messages missing", async () => {
      const r = await api("POST", "/v1/chat/completions", { model: "gpt-4o" });
      expect(r.status).toBe(400);
      expect(r.body.error.param).toBe("messages");
    });

    it("rejects when model missing", async () => {
      const r = await api("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
      expect(r.status).toBe(400);
      expect(r.body.error.param).toBe("model");
    });

    it("streams via SSE ending with [DONE]", async () => {
      const text = await stream("/v1/chat/completions", {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Stream this" }],
        stream: true,
      });
      expect(text).toContain("data: ");
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
      const firstChunk = JSON.parse(text.split("\n")[0].replace("data: ", ""));
      expect(firstChunk.object).toBe("chat.completion.chunk");
      expect(firstChunk.choices[0].delta.role).toBe("assistant");
    });
  });

  describe("POST /v1/completions", () => {
    it("returns a legacy text completion", async () => {
      const r = await api("POST", "/v1/completions", { model: "gpt-3.5-turbo-instruct", prompt: "Once upon" });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("text_completion");
      expect(typeof r.body.choices[0].text).toBe("string");
    });
    it("rejects missing prompt", async () => {
      const r = await api("POST", "/v1/completions", { model: "x" });
      expect(r.status).toBe(400);
    });
  });

  describe("POST /v1/embeddings", () => {
    it("returns deterministic fixed-length vectors", async () => {
      const r = await api("POST", "/v1/embeddings", { model: "text-embedding-3-small", input: "hello" });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("list");
      expect(r.body.data[0].embedding.length).toBe(1536);
      const r2 = await api("POST", "/v1/embeddings", { model: "text-embedding-3-small", input: "hello" });
      expect(r2.body.data[0].embedding).toEqual(r.body.data[0].embedding);
    });
    it("supports array inputs and dimensions", async () => {
      const r = await api("POST", "/v1/embeddings", {
        model: "text-embedding-3-small",
        input: ["a", "b"],
        dimensions: 256,
      });
      expect(r.body.data.length).toBe(2);
      expect(r.body.data[0].embedding.length).toBe(256);
    });
  });

  describe("POST /v1/images/generations", () => {
    it("returns image URLs", async () => {
      const r = await api("POST", "/v1/images/generations", { model: "dall-e-3", prompt: "a cat", n: 2 });
      expect(r.status).toBe(200);
      expect(r.body.data.length).toBe(2);
      expect(r.body.data[0].url).toContain("https://");
    });
    it("supports b64_json response format", async () => {
      const r = await api("POST", "/v1/images/generations", {
        model: "dall-e-3", prompt: "a dog", response_format: "b64_json",
      });
      expect(r.body.data[0].b64_json).toBeTruthy();
    });
  });

  describe("POST /v1/moderations", () => {
    it("returns moderation results with the full omni category set", async () => {
      const r = await api("POST", "/v1/moderations", { input: "harmless text" });
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.results)).toBe(true);
      expect(typeof r.body.results[0].flagged).toBe("boolean");
      // Default model is omni-moderation-latest.
      expect(r.body.model).toBe("omni-moderation-latest");
      const cats = r.body.results[0].categories;
      // 13-category omni set, including the newer illicit categories.
      expect(Object.keys(cats).length).toBe(13);
      expect(cats).toHaveProperty("violence");
      expect(cats).toHaveProperty("illicit");
      expect(cats).toHaveProperty("illicit/violent");
      // category_applied_input_types present and aligned to categories.
      const applied = r.body.results[0].category_applied_input_types;
      expect(applied["violence"]).toEqual(["text"]);
      expect(Object.keys(applied).length).toBe(13);
    });
    it("rejects missing input", async () => {
      const r = await api("POST", "/v1/moderations", {});
      expect(r.status).toBe(400);
      expect(r.body.error.param).toBe("input");
    });
  });

  describe("Failure scenarios", () => {
    it("rejects missing input on embeddings", async () => {
      const r = await api("POST", "/v1/embeddings", { model: "text-embedding-3-small" });
      expect(r.status).toBe(400);
      expect(r.body.error.param).toBe("input");
      expect(r.body.error.type).toBe("invalid_request_error");
    });
    it("rejects missing prompt on images", async () => {
      const r = await api("POST", "/v1/images/generations", { model: "dall-e-3" });
      expect(r.status).toBe(400);
      expect(r.body.error.param).toBe("prompt");
    });
    it("returns 404 unknown_url for an unknown /v1 route", async () => {
      const r = await api("GET", "/v1/nonsense");
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("unknown_url");
      expect(r.body.error.type).toBe("invalid_request_error");
      expect(r.body.error.message).toContain("Invalid URL");
    });
    it("returns 404 unknown_url for a non-v1 path", async () => {
      const r = await api("GET", "/nope");
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("unknown_url");
    });
    it("rejects malformed JSON with 400 error envelope", async () => {
      const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "{not json",
      });
      const body = await r.json();
      expect(r.status).toBe(400);
      expect(body.error.type).toBe("invalid_request_error");
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await api("POST", "/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "x" }] });
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(1);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/requests");
      expect(after.body.count).toBe(0);
    });
  });
});
