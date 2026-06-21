import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { VoyageAiServer } from "../services/voyage-ai/src/server.js";

const PORT = 14865;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer pa-parlel-test" };

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

describe("Voyage AI Service", () => {
  let server: VoyageAiServer;

  beforeAll(async () => {
    server = new VoyageAiServer(PORT);
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
      expect(root.body.name).toBe("voyage-ai");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const r = await fetch(`${BASE_URL}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "voyage-3", input: "hi" }),
      });
      expect(r.status).toBe(401);
    });
    it("accepts Bearer auth", async () => {
      const r = await api("POST", "/v1/embeddings", { model: "voyage-3", input: "hi" });
      expect(r.status).toBe(200);
    });
  });

  describe("Embeddings", () => {
    it("returns 1024-dim deterministic embeddings in voyage shape", async () => {
      const r = await api("POST", "/v1/embeddings", { model: "voyage-3", input: ["a", "b"] });
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("list");
      expect(r.body.data.length).toBe(2);
      expect(r.body.data[0].object).toBe("embedding");
      expect(r.body.data[0].embedding.length).toBe(1024);
      expect(r.body.data[0].index).toBe(0);
      expect(typeof r.body.usage.total_tokens).toBe("number");
    });

    it("is deterministic", async () => {
      const a = await api("POST", "/v1/embeddings", { model: "voyage-3", input: "hello" });
      const b = await api("POST", "/v1/embeddings", { model: "voyage-3", input: "hello" });
      expect(a.body.data[0].embedding).toEqual(b.body.data[0].embedding);
    });

    it("rejects missing input", async () => {
      const r = await api("POST", "/v1/embeddings", { model: "voyage-3" });
      expect(r.status).toBe(400);
    });
  });

  describe("Rerank", () => {
    it("returns ranked results sorted by relevance_score (descending)", async () => {
      const r = await api("POST", "/v1/rerank", {
        query: "What is the capital of France?",
        documents: ["Paris is the capital of France.", "Bananas are yellow.", "The Eiffel Tower is in Paris."],
        model: "rerank-2",
      });
      expect(r.status).toBe(200);
      expect(r.body.data.length).toBe(3);
      // Each entry has relevance_score and index.
      for (const d of r.body.data) {
        expect(typeof d.relevance_score).toBe("number");
        expect(typeof d.index).toBe("number");
      }
      // Descending order.
      const scores = r.body.data.map((d: Json) => d.relevance_score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
      }
    });

    it("respects top_k", async () => {
      const r = await api("POST", "/v1/rerank", {
        query: "q",
        documents: ["a", "b", "c", "d"],
        model: "rerank-2",
        top_k: 2,
      });
      expect(r.body.data.length).toBe(2);
    });

    it("returns documents when return_documents is true", async () => {
      const r = await api("POST", "/v1/rerank", {
        query: "q",
        documents: ["alpha", "beta"],
        model: "rerank-2",
        return_documents: true,
      });
      expect(typeof r.body.data[0].document).toBe("string");
    });

    it("is deterministic", async () => {
      const body = { query: "q", documents: ["a", "b", "c"], model: "rerank-2" };
      const a = await api("POST", "/v1/rerank", body);
      const b = await api("POST", "/v1/rerank", body);
      expect(a.body.data).toEqual(b.body.data);
    });

    it("rejects missing documents", async () => {
      const r = await api("POST", "/v1/rerank", { query: "q", model: "rerank-2" });
      expect(r.status).toBe(400);
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/v1/embeddings", { model: "voyage-3", input: "x" });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(0);
    });
  });
});
