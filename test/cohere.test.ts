import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CohereServer } from "../services/cohere/src/server.js";

const PORT = 14754;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelTestKey";
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

describe("Cohere Service", () => {
  let server: CohereServer;

  beforeAll(async () => {
    server = new CohereServer(PORT);
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
      expect(root.body.name).toBe("cohere");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const r = await fetch(`${BASE_URL}/v2/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "command-r", messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.message).toBeTruthy();
    });
    it("accepts Bearer auth", async () => {
      const r = await api("POST", "/v2/chat", { model: "command-r", messages: [{ role: "user", content: "hi" }] });
      expect(r.status).toBe(200);
    });
  });

  describe("POST /v2/chat", () => {
    it("returns the Cohere v2 chat shape", async () => {
      const r = await api("POST", "/v2/chat", {
        model: "command-r-plus",
        messages: [{ role: "user", content: "Hello Cohere" }],
      });
      expect(r.status).toBe(200);
      expect(r.body.message.role).toBe("assistant");
      expect(r.body.message.content[0].type).toBe("text");
      expect(typeof r.body.message.content[0].text).toBe("string");
      expect(r.body.finish_reason).toBe("COMPLETE");
      expect(r.body.usage.tokens.input_tokens).toBeGreaterThan(0);
    });

    it("is deterministic", async () => {
      const payload = { model: "command-r", messages: [{ role: "user", content: "Same" }] };
      const a = await api("POST", "/v2/chat", payload);
      const b = await api("POST", "/v2/chat", payload);
      expect(a.body.message.content[0].text).toBe(b.body.message.content[0].text);
    });

    it("streams via SSE event types ending with [DONE]", async () => {
      const response = await fetch(`${BASE_URL}/v2/chat`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "command-r", messages: [{ role: "user", content: "Stream" }], stream: true }),
      });
      const text = await response.text();
      expect(text).toContain('"type":"message-start"');
      expect(text).toContain('"type":"content-delta"');
      expect(text).toContain('"type":"message-end"');
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    });

    it("rejects missing messages", async () => {
      const r = await api("POST", "/v2/chat", { model: "command-r" });
      expect(r.status).toBe(400);
    });
  });

  describe("POST /v2/embed", () => {
    it("returns deterministic float embeddings", async () => {
      const r = await api("POST", "/v2/embed", {
        model: "embed-english-v3.0",
        texts: ["hello", "world"],
        input_type: "search_document",
        embedding_types: ["float"],
      });
      expect(r.status).toBe(200);
      expect(r.body.embeddings.float.length).toBe(2);
      expect(r.body.embeddings.float[0].length).toBe(1024);
      const r2 = await api("POST", "/v2/embed", {
        model: "embed-english-v3.0",
        texts: ["hello", "world"],
        input_type: "search_document",
        embedding_types: ["float"],
      });
      expect(r2.body.embeddings.float[0]).toEqual(r.body.embeddings.float[0]);
    });

    it("rejects missing texts", async () => {
      const r = await api("POST", "/v2/embed", { model: "embed-english-v3.0", input_type: "search_document" });
      expect(r.status).toBe(400);
    });
  });

  describe("POST /v2/rerank", () => {
    it("returns sorted relevance scores", async () => {
      const r = await api("POST", "/v2/rerank", {
        model: "rerank-english-v3.0",
        query: "What is parlel?",
        documents: ["parlel is a tool", "an unrelated doc", "another parlel mention"],
        top_n: 2,
      });
      expect(r.status).toBe(200);
      expect(r.body.results.length).toBe(2);
      expect(r.body.results[0].relevance_score).toBeGreaterThanOrEqual(r.body.results[1].relevance_score);
      expect(typeof r.body.results[0].index).toBe("number");
    });

    it("rejects missing documents", async () => {
      const r = await api("POST", "/v2/rerank", { model: "rerank-english-v3.0", query: "x" });
      expect(r.status).toBe(400);
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await api("POST", "/v2/chat", { model: "command-r", messages: [{ role: "user", content: "x" }] });
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(1);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/requests");
      expect(after.body.count).toBe(0);
    });
  });
});
