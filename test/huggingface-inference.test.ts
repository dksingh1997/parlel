import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { HuggingfaceInferenceServer } from "../services/huggingface-inference/src/server.js";

const PORT = 14756;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "hf_parlelTestKey";
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

describe("HuggingFace Inference Service", () => {
  let server: HuggingfaceInferenceServer;

  beforeAll(async () => {
    server = new HuggingfaceInferenceServer(PORT);
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
      expect(root.body.name).toBe("huggingface-inference");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const r = await fetch(`${BASE_URL}/models/gpt2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: "hi" }),
      });
      expect(r.status).toBe(401);
    });
    it("accepts Bearer auth", async () => {
      const r = await api("POST", "/models/gpt2", { inputs: "hi" });
      expect(r.status).toBe(200);
    });
  });

  describe("POST /models/{model} — text-generation", () => {
    it("returns [{ generated_text }]", async () => {
      const r = await api("POST", "/models/meta-llama/Llama-3.1-8B-Instruct", { inputs: "Once upon a time" });
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(typeof r.body[0].generated_text).toBe("string");
      expect(r.body[0].generated_text).toContain("Once upon a time");
    });

    it("is deterministic", async () => {
      const a = await api("POST", "/models/gpt2", { inputs: "Same" });
      const b = await api("POST", "/models/gpt2", { inputs: "Same" });
      expect(a.body[0].generated_text).toBe(b.body[0].generated_text);
    });

    it("omits the prompt when return_full_text is false", async () => {
      const r = await api("POST", "/models/gpt2", { inputs: "Prefix", parameters: { return_full_text: false } });
      expect(r.body[0].generated_text.startsWith("Prefix ")).toBe(false);
    });

    it("rejects missing inputs", async () => {
      const r = await api("POST", "/models/gpt2", {});
      expect(r.status).toBe(400);
    });
  });

  describe("POST /models/{model} — feature-extraction", () => {
    it("returns a single embedding vector for a string", async () => {
      const r = await api("POST", "/models/sentence-transformers/all-MiniLM-L6-v2", { inputs: "hello" });
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBe(384);
      expect(typeof r.body[0]).toBe("number");
    });

    it("returns an array of vectors for an array input", async () => {
      const r = await api("POST", "/models/sentence-transformers/all-MiniLM-L6-v2", { inputs: ["a", "b"] });
      expect(r.body.length).toBe(2);
      expect(r.body[0].length).toBe(384);
    });

    it("respects an explicit ?task=feature-extraction override", async () => {
      const r = await api("POST", "/models/gpt2?task=feature-extraction", { inputs: "hello" });
      expect(r.body.length).toBe(384);
    });

    it("is deterministic", async () => {
      const a = await api("POST", "/models/sentence-transformers/all-MiniLM-L6-v2", { inputs: "x" });
      const b = await api("POST", "/models/sentence-transformers/all-MiniLM-L6-v2", { inputs: "x" });
      expect(a.body).toEqual(b.body);
    });
  });

  describe("POST /v1/chat/completions — router", () => {
    it("returns an OpenAI-compatible completion", async () => {
      const r = await api("POST", "/v1/chat/completions", {
        model: "meta-llama/Llama-3.1-8B-Instruct",
        messages: [{ role: "user", content: "Hello HF" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("chat.completion");
      expect(r.body.choices[0].message.role).toBe("assistant");
      expect(r.body.usage.total_tokens).toBe(
        r.body.usage.prompt_tokens + r.body.usage.completion_tokens
      );
    });

    it("streams via SSE ending with [DONE]", async () => {
      const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/Llama-3.1-8B-Instruct",
          messages: [{ role: "user", content: "Stream" }],
          stream: true,
        }),
      });
      const text = await response.text();
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/v1/chat/completions", { model: "gpt2" });
      expect(r.status).toBe(400);
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await api("POST", "/models/gpt2", { inputs: "x" });
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(1);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/requests");
      expect(after.body.count).toBe(0);
    });
  });
});
