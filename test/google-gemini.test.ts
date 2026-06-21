import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GoogleGeminiServer } from "../services/google-gemini/src/server.js";

const PORT = 14749;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelTestKey";

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = {}): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

const contents = (text: string) => ({ contents: [{ role: "user", parts: [{ text }] }] });

describe("Google Gemini Service", () => {
  let server: GoogleGeminiServer;

  beforeAll(async () => {
    server = new GoogleGeminiServer(PORT);
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
      expect(root.body.name).toBe("google-gemini");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing key with 401", async () => {
      const r = await api("POST", "/v1beta/models/gemini-1.5-flash:generateContent", contents("hi"));
      expect(r.status).toBe(401);
      expect(r.body.error.status).toBe("UNAUTHENTICATED");
    });
    it("accepts ?key= query auth", async () => {
      const r = await api("POST", `/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, contents("hi"));
      expect(r.status).toBe(200);
    });
    it("accepts x-goog-api-key header auth", async () => {
      const r = await api(
        "POST",
        "/v1beta/models/gemini-1.5-flash:generateContent",
        contents("hi"),
        { "x-goog-api-key": API_KEY },
      );
      expect(r.status).toBe(200);
    });
  });

  describe("GET /v1beta/models", () => {
    it("lists models", async () => {
      const r = await api("GET", `/v1beta/models?key=${API_KEY}`);
      expect(r.status).toBe(200);
      expect(r.body.models.some((m: Json) => m.name === "models/gemini-1.5-flash")).toBe(true);
    });
  });

  describe("generateContent", () => {
    it("returns the documented candidates shape", async () => {
      const r = await api("POST", `/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, contents("Hello Gemini"));
      expect(r.status).toBe(200);
      expect(r.body.candidates[0].content.parts[0].text).toBeTruthy();
      expect(r.body.candidates[0].content.role).toBe("model");
      expect(r.body.candidates[0].finishReason).toBe("STOP");
      expect(r.body.usageMetadata.totalTokenCount).toBe(
        r.body.usageMetadata.promptTokenCount + r.body.usageMetadata.candidatesTokenCount
      );
    });

    it("is deterministic", async () => {
      const a = await api("POST", `/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, contents("Same"));
      const b = await api("POST", `/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, contents("Same"));
      expect(a.body.candidates[0].content.parts[0].text).toBe(b.body.candidates[0].content.parts[0].text);
    });

    it("rejects missing contents", async () => {
      const r = await api("POST", `/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, {});
      expect(r.status).toBe(400);
    });
  });

  describe("streamGenerateContent", () => {
    it("streams a JSON array of chunks by default", async () => {
      const r = await api("POST", `/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${API_KEY}`, contents("Stream"));
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body[0].candidates[0].content.parts[0].text).toBeTruthy();
      const last = r.body[r.body.length - 1];
      expect(last.usageMetadata).toBeTruthy();
    });

    it("streams SSE when alt=sse", async () => {
      const response = await fetch(
        `${BASE_URL}/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=${API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(contents("Stream")) },
      );
      const text = await response.text();
      expect(text).toContain("data: ");
      expect(text).toContain('"role":"model"');
    });
  });

  describe("countTokens", () => {
    it("returns totalTokens", async () => {
      const r = await api("POST", `/v1beta/models/gemini-1.5-flash:countTokens?key=${API_KEY}`, contents("one two"));
      expect(r.status).toBe(200);
      expect(r.body.totalTokens).toBe(2);
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await api("POST", `/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, contents("x"));
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(1);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/requests");
      expect(after.body.count).toBe(0);
    });
  });
});
