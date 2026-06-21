import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AssemblyaiServer } from "../services/assemblyai/src/server.js";

const PORT = 14858;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "parlelTestKey" };

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

describe("AssemblyAI Service", () => {
  let server: AssemblyaiServer;

  beforeAll(async () => {
    server = new AssemblyaiServer(PORT);
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
      expect(root.body.name).toBe("assemblyai");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const r = await fetch(`${BASE_URL}/v2/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_url: "http://x/a.wav" }),
      });
      expect(r.status).toBe(401);
      const body = await r.json();
      expect(body.error).toBe("Authentication error, API token missing/invalid");
      expect(body).not.toHaveProperty("status");
    });
    it("accepts raw key auth", async () => {
      const r = await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      expect(r.status).toBe(200);
    });
  });

  describe("Error envelope", () => {
    it("returns { error } without status field for 400", async () => {
      const r = await api("POST", "/v2/transcript", {});
      expect(r.status).toBe(400);
      expect(r.body).toHaveProperty("error");
      expect(r.body).not.toHaveProperty("status");
      expect(typeof r.body.error).toBe("string");
    });
    it("returns { error } without status field for 404", async () => {
      const r = await api("GET", "/v2/transcript/nope");
      expect(r.status).toBe(404);
      expect(r.body).toHaveProperty("error");
      expect(r.body).not.toHaveProperty("status");
    });
    it("returns { error } without status field for 401", async () => {
      const r = await fetch(`${BASE_URL}/v2/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_url: "http://x/a.wav" }),
      });
      expect(r.status).toBe(401);
      const body = await r.json();
      expect(body).toHaveProperty("error");
      expect(body).not.toHaveProperty("status");
    });
    it("returns { error } without status field for invalid JSON", async () => {
      const r = await fetch(`${BASE_URL}/v2/transcript`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body).toHaveProperty("error");
      expect(body).not.toHaveProperty("status");
    });
  });

  describe("Upload", () => {
    it("returns an upload_url for raw bytes", async () => {
      const r = await fetch(`${BASE_URL}/v2/upload`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/octet-stream" },
        body: Buffer.from("AUDIO"),
      });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(typeof body.upload_url).toBe("string");
      expect(body.upload_url).toContain("assemblyai.com");
    });
  });

  describe("Transcripts", () => {
    it("creates a queued transcript with all required fields", async () => {
      const r = await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("queued");
      expect(r.body.id).toBeTruthy();
      // Verify required fields from OpenAPI spec
      expect(r.body).toHaveProperty("audio_url", "http://x/a.wav");
      expect(r.body).toHaveProperty("language_code", "en_us");
      expect(r.body).toHaveProperty("speech_model");
      expect(r.body).toHaveProperty("language_model");
      expect(r.body).toHaveProperty("acoustic_model");
      expect(r.body).toHaveProperty("webhook_auth");
      expect(r.body).toHaveProperty("auto_highlights");
      expect(r.body).toHaveProperty("redact_pii");
      expect(r.body).toHaveProperty("summarization");
      expect(r.body).toHaveProperty("language_confidence_threshold");
      expect(r.body).toHaveProperty("language_confidence");
      expect(r.body).toHaveProperty("punctuate");
      expect(r.body).toHaveProperty("format_text");
      expect(r.body).toHaveProperty("multichannel");
    });

    it("creates transcript with valid UUID v4 format", async () => {
      const r = await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      const id = r.body.id;
      // UUID v4 regex
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("completes on first GET with deterministic text and words", async () => {
      const created = await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      const got = await api("GET", `/v2/transcript/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.status).toBe("completed");
      expect(typeof got.body.text).toBe("string");
      expect(Array.isArray(got.body.words)).toBe(true);
      expect(got.body.words[0]).toHaveProperty("text");

      const created2 = await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      const got2 = await api("GET", `/v2/transcript/${created2.body.id}`);
      expect(got2.body.text).toBe(got.body.text);
    });

    it("rejects transcript without audio_url", async () => {
      const r = await api("POST", "/v2/transcript", {});
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("audio_url");
    });

    it("returns 404 for unknown transcript", async () => {
      const r = await api("GET", "/v2/transcript/nope");
      expect(r.status).toBe(404);
    });

    it("lists transcripts with pagination", async () => {
      await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      await api("POST", "/v2/transcript", { audio_url: "http://x/b.wav" });
      const r = await api("GET", "/v2/transcript");
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.transcripts)).toBe(true);
      expect(r.body.transcripts.length).toBe(2);
      expect(r.body.page_details).toBeDefined();
      expect(r.body.page_details.limit).toBe(10);
      expect(r.body.page_details.result_count).toBe(2);
      expect(r.body.page_details).toHaveProperty("current_url");
      expect(r.body.page_details).toHaveProperty("prev_url");
      expect(r.body.page_details).toHaveProperty("next_url");
    });

    it("lists transcripts with limit param", async () => {
      await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      await api("POST", "/v2/transcript", { audio_url: "http://x/b.wav" });
      await api("POST", "/v2/transcript", { audio_url: "http://x/c.wav" });
      const r = await api("GET", "/v2/transcript?limit=2");
      expect(r.status).toBe(200);
      expect(r.body.transcripts.length).toBe(2);
      expect(r.body.page_details.limit).toBe(2);
      expect(r.body.page_details.result_count).toBe(2);
    });

    it("lists transcripts with status filter", async () => {
      const created = await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      await api("GET", `/v2/transcript/${created.body.id}`); // complete it
      await api("POST", "/v2/transcript", { audio_url: "http://x/b.wav" }); // still queued
      const r = await api("GET", "/v2/transcript?status=completed");
      expect(r.status).toBe(200);
      expect(r.body.transcripts.length).toBe(1);
      expect(r.body.transcripts[0].status).toBe("completed");
    });

    it("deletes a transcript", async () => {
      const created = await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      const id = created.body.id;
      const del = await api("DELETE", `/v2/transcript/${id}`);
      expect(del.status).toBe(200);
      expect(del.body.id).toBe(id);
      // Verify it's gone
      const get = await api("GET", `/v2/transcript/${id}`);
      expect(get.status).toBe(404);
    });

    it("returns 404 when deleting unknown transcript", async () => {
      const r = await api("DELETE", "/v2/transcript/nope");
      expect(r.status).toBe(404);
    });
  });

  describe("LeMUR", () => {
    it("generates a deterministic task response", async () => {
      const r1 = await api("POST", "/lemur/v3/generate/task", { prompt: "Summarize", transcript_ids: ["abc"] });
      expect(r1.status).toBe(200);
      expect(typeof r1.body.response).toBe("string");
      expect(r1.body.request_id).toBeTruthy();
      const r2 = await api("POST", "/lemur/v3/generate/task", { prompt: "Summarize", transcript_ids: ["abc"] });
      expect(r2.body.response).toBe(r1.body.response);
    });

    it("rejects missing prompt", async () => {
      const r = await api("POST", "/lemur/v3/generate/task", {});
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("prompt");
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/v2/transcript", { audio_url: "http://x/a.wav" });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/transcripts");
      expect(list.body.count).toBe(0);
    });
  });
});
