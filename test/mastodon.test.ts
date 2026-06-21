import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MastodonServer } from "../services/mastodon/src/server.js";

const PORT = 14806;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.mastotoken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Mastodon Service", () => {
  let server: MastodonServer;

  beforeAll(async () => {
    server = new MastodonServer(PORT);
    await server.start();
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("mastodon");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing token with 401", async () => {
      const res = await api("GET", "/api/v1/accounts/verify_credentials", undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid/i);
    });
  });

  describe("Credentials", () => {
    it("GET /api/v1/accounts/verify_credentials returns the account", async () => {
      const res = await api("GET", "/api/v1/accounts/verify_credentials");
      expect(res.status).toBe(200);
      expect(res.body.username).toBe("parlel");
      expect(res.body.source).toBeDefined();
    });
  });

  describe("Statuses", () => {
    it("POST /api/v1/statuses creates a status with the documented shape", async () => {
      const res = await api("POST", "/api/v1/statuses", { status: "Hello from parlel!" });
      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
      expect(res.body.created_at).toBeTruthy();
      expect(res.body.content).toContain("Hello from parlel!");
      expect(res.body.account.username).toBe("parlel");
    });

    it("rejects an empty status with 422", async () => {
      const res = await api("POST", "/api/v1/statuses", { status: "" });
      expect(res.status).toBe(422);
    });

    it("round-trips create / get / delete", async () => {
      const created = await api("POST", "/api/v1/statuses", { status: "Round trip" });
      const id = created.body.id;

      const got = await api("GET", `/api/v1/statuses/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.content).toContain("Round trip");

      const deleted = await api("DELETE", `/api/v1/statuses/${id}`);
      expect(deleted.status).toBe(200);

      const gone = await api("GET", `/api/v1/statuses/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Timeline", () => {
    it("GET /api/v1/timelines/home returns an array of statuses", async () => {
      await api("POST", "/api/v1/statuses", { status: "one" });
      await api("POST", "/api/v1/statuses", { status: "two" });
      const res = await api("GET", "/api/v1/timelines/home");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
      // newest first
      expect(res.body[0].content).toContain("two");
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/api/v1/statuses", { status: "x" });
      await api("POST", "/__parlel/reset");
      const res = await api("GET", "/__parlel/statuses");
      expect(res.body.count).toBe(0);
    });
  });
});
