import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ElevenlabsServer } from "../services/elevenlabs/src/server.js";

const PORT = 14753;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelTestKey";
const AUTH = { "xi-api-key": API_KEY };

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

const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

describe("ElevenLabs Service", () => {
  let server: ElevenlabsServer;

  beforeAll(async () => {
    server = new ElevenlabsServer(PORT);
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
      expect(root.body.name).toBe("elevenlabs");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing xi-api-key with 401", async () => {
      const r = await fetch(`${BASE_URL}/v1/voices`);
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.detail.status).toBe("invalid_api_key");
    });
    it("accepts xi-api-key header auth", async () => {
      const r = await api("GET", "/v1/voices");
      expect(r.status).toBe(200);
    });
  });

  describe("GET /v1/voices", () => {
    it("lists voices", async () => {
      const r = await api("GET", "/v1/voices");
      expect(r.body.voices.length).toBeGreaterThan(0);
      expect(r.body.voices[0].voice_id).toBeTruthy();
    });
    it("retrieves a single voice", async () => {
      const r = await api("GET", `/v1/voices/${VOICE_ID}`);
      expect(r.body.voice_id).toBe(VOICE_ID);
    });
  });

  describe("GET /v1/models", () => {
    it("lists models", async () => {
      const r = await api("GET", "/v1/models");
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.some((m: Json) => m.model_id === "eleven_multilingual_v2")).toBe(true);
    });
  });

  describe("GET /v1/user", () => {
    it("returns user info with subscription", async () => {
      const r = await api("GET", "/v1/user");
      expect(r.body.subscription.tier).toBeTruthy();
      expect(typeof r.body.subscription.character_limit).toBe("number");
    });
  });

  describe("POST /v1/text-to-speech/{voice_id}", () => {
    it("returns deterministic audio/mpeg bytes", async () => {
      const response = await fetch(`${BASE_URL}/v1/text-to-speech/${VOICE_ID}`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello world", model_id: "eleven_multilingual_v2" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/mpeg");
      const buf = Buffer.from(await response.arrayBuffer());
      expect(buf.length).toBeGreaterThan(0);
      // ID3 header prefix
      expect(buf.subarray(0, 3).toString("latin1")).toBe("ID3");

      const response2 = await fetch(`${BASE_URL}/v1/text-to-speech/${VOICE_ID}`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello world", model_id: "eleven_multilingual_v2" }),
      });
      const buf2 = Buffer.from(await response2.arrayBuffer());
      expect(buf2.equals(buf)).toBe(true);
    });

    it("produces different bytes for different text", async () => {
      const a = await fetch(`${BASE_URL}/v1/text-to-speech/${VOICE_ID}`, {
        method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "alpha" }),
      });
      const b = await fetch(`${BASE_URL}/v1/text-to-speech/${VOICE_ID}`, {
        method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "beta" }),
      });
      const bufA = Buffer.from(await a.arrayBuffer());
      const bufB = Buffer.from(await b.arrayBuffer());
      expect(bufA.equals(bufB)).toBe(false);
    });

    it("supports the /stream suffix", async () => {
      const response = await fetch(`${BASE_URL}/v1/text-to-speech/${VOICE_ID}/stream`, {
        method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "streamed" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/mpeg");
    });

    it("rejects missing text with 422", async () => {
      const r = await api("POST", `/v1/text-to-speech/${VOICE_ID}`, {});
      expect(r.status).toBe(422);
    });
  });

  describe("parlel inspection", () => {
    it("captures requests and resets", async () => {
      await fetch(`${BASE_URL}/v1/text-to-speech/${VOICE_ID}`, {
        method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x" }),
      });
      const list = await api("GET", "/__parlel/requests");
      expect(list.body.count).toBe(1);
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/requests");
      expect(after.body.count).toBe(0);
    });
  });
});
