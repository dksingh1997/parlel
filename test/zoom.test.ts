import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ZoomServer } from "../services/zoom/src/server.js";

const PORT = 14797;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.zoomtoken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
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

describe("Zoom Service", () => {
  let server: ZoomServer;

  beforeAll(async () => {
    server = new ZoomServer(PORT);
    await server.start();
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("zoom");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("OAuth", () => {
    it("issues an access token without auth", async () => {
      const res = await api("POST", "/oauth/token", { grant_type: "account_credentials" }, {});
      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeTruthy();
      expect(res.body.token_type).toBe("bearer");
      expect(res.body.expires_in).toBe(3599);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401 + code 124", async () => {
      const res = await api("GET", "/v2/users/me", undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.code).toBe(124);
    });
  });

  describe("Users", () => {
    it("GET /v2/users/me returns the current user", async () => {
      const res = await api("GET", "/v2/users/me");
      expect(res.status).toBe(200);
      expect(res.body.email).toBe("user@parlel.dev");
      expect(res.body.id).toBeTruthy();
    });

    it("GET /v2/users lists users with pagination wrapper", async () => {
      const res = await api("GET", "/v2/users");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("page_count");
      expect(res.body).toHaveProperty("total_records");
      expect(Array.isArray(res.body.users)).toBe(true);
    });

    it("returns 404 for unknown user", async () => {
      const res = await api("GET", "/v2/users/nobody@nope.dev");
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(1001);
    });
  });

  describe("Meetings", () => {
    it("creates a meeting (201) with the documented shape", async () => {
      const res = await api("POST", "/v2/users/me/meetings", { topic: "Standup", type: 2, duration: 30 });
      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();
      expect(res.body.uuid).toBeTruthy();
      expect(res.body.host_id).toBeTruthy();
      expect(res.body.topic).toBe("Standup");
      expect(res.body.join_url).toMatch(/zoom\.us\/j\//);
      expect(res.body.start_url).toMatch(/zoom\.us\/s\//);
    });

    it("lists meetings for a user with wrapper shape", async () => {
      await api("POST", "/v2/users/me/meetings", { topic: "One" });
      await api("POST", "/v2/users/me/meetings", { topic: "Two" });
      const res = await api("GET", "/v2/users/me/meetings");
      expect(res.status).toBe(200);
      expect(res.body.total_records).toBe(2);
      expect(res.body.meetings.length).toBe(2);
      expect(res.body.page_size).toBeDefined();
    });

    it("round-trips get / patch / delete a meeting", async () => {
      const created = await api("POST", "/v2/users/me/meetings", { topic: "Original" });
      const id = created.body.id;

      const got = await api("GET", `/v2/meetings/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.topic).toBe("Original");

      const patched = await api("PATCH", `/v2/meetings/${id}`, { topic: "Updated" });
      expect(patched.status).toBe(204);

      const refetched = await api("GET", `/v2/meetings/${id}`);
      expect(refetched.body.topic).toBe("Updated");

      const deleted = await api("DELETE", `/v2/meetings/${id}`);
      expect(deleted.status).toBe(204);

      const gone = await api("GET", `/v2/meetings/${id}`);
      expect(gone.status).toBe(404);
      expect(gone.body.code).toBe(3001);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/v2/users/me/meetings", { topic: "x" });
      const before = await api("GET", "/__parlel/meetings");
      expect(before.body.count).toBe(1);
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const after = await api("GET", "/__parlel/meetings");
      expect(after.body.count).toBe(0);
    });
  });
});
