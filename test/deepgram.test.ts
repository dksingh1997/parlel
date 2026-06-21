import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DeepgramServer } from "../services/deepgram/src/server.js";

const PORT = 14857;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Token parlelTestKey" };

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

describe("Deepgram Service", () => {
  let server: DeepgramServer;

  beforeAll(async () => {
    server = new DeepgramServer(PORT);
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
      expect(root.body.name).toBe("deepgram");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const r = await fetch(`${BASE_URL}/v1/listen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://x/a.wav" }),
      });
      expect(r.status).toBe(401);
    });
    it("accepts Token auth", async () => {
      const r = await api("POST", "/v1/listen", { url: "http://x/a.wav" });
      expect(r.status).toBe(200);
    });
  });

  describe("POST /v1/listen (transcription)", () => {
    it("transcribes a remote url with full result shape", async () => {
      const r = await api("POST", "/v1/listen", { url: "http://x/a.wav" });
      expect(r.status).toBe(200);
      const alt = r.body.results.channels[0].alternatives[0];
      expect(typeof alt.transcript).toBe("string");
      expect(typeof alt.confidence).toBe("number");
      expect(Array.isArray(alt.words)).toBe(true);
      expect(alt.words[0]).toHaveProperty("word");
      expect(r.body.metadata.request_id).toBeTruthy();
    });

    it("is deterministic for the same url", async () => {
      const r1 = await api("POST", "/v1/listen", { url: "http://x/a.wav" });
      const r2 = await api("POST", "/v1/listen", { url: "http://x/a.wav" });
      expect(r1.body.results.channels[0].alternatives[0].transcript)
        .toBe(r2.body.results.channels[0].alternatives[0].transcript);
    });

    it("transcribes raw audio bytes", async () => {
      const r = await fetch(`${BASE_URL}/v1/listen`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "audio/wav" },
        body: Buffer.from("FAKEAUDIOBYTES"),
      });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.results.channels[0].alternatives[0].transcript).toBeTruthy();
    });

    it("rejects json without a url", async () => {
      const r = await api("POST", "/v1/listen", {});
      expect(r.status).toBe(400);
    });
  });

  describe("POST /v1/speak (TTS)", () => {
    it("returns deterministic audio bytes", async () => {
      const r1 = await fetch(`${BASE_URL}/v1/speak`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello world" }),
      });
      expect(r1.status).toBe(200);
      expect(r1.headers.get("content-type")).toContain("audio");
      const buf1 = Buffer.from(await r1.arrayBuffer());
      expect(buf1.length).toBeGreaterThan(0);

      const r2 = await fetch(`${BASE_URL}/v1/speak`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello world" }),
      });
      const buf2 = Buffer.from(await r2.arrayBuffer());
      expect(buf1.equals(buf2)).toBe(true);
    });

    it("rejects missing text", async () => {
      const r = await api("POST", "/v1/speak", {});
      expect(r.status).toBe(400);
    });
  });

  describe("GET /v1/projects", () => {
    it("lists projects", async () => {
      const r = await api("GET", "/v1/projects");
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.projects)).toBe(true);
      expect(r.body.projects.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/v1/listen", { url: "http://x/a.wav" });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(0);
    });
  });
});
