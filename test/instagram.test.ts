import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { InstagramServer } from "../services/instagram/src/server.js";

const PORT = 14802;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.igtoken";
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

describe("Instagram Service", () => {
  let server: InstagramServer;
  let igUserId: string;

  beforeAll(async () => {
    server = new InstagramServer(PORT);
    await server.start();
    igUserId = server._defaultIgUserId;
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
    igUserId = server._defaultIgUserId;
  });

  describe("Server lifecycle", () => {
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("instagram");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing token with 401", async () => {
      const res = await api("GET", `/v18.0/${igUserId}`, undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("OAuthException");
    });

    it("accepts access_token via query string", async () => {
      const res = await api("GET", `/v18.0/${igUserId}?access_token=${TOKEN}`, undefined, {});
      expect(res.status).toBe(200);
    });
  });

  describe("IG user node", () => {
    it("GET /v18.0/:igUserId returns the account", async () => {
      const res = await api("GET", `/v18.0/${igUserId}`);
      expect(res.status).toBe(200);
      expect(res.body.username).toBe("parlel");
      expect(res.body.id).toBe(igUserId);
    });
  });

  describe("Publish flow", () => {
    it("creates a container then publishes it", async () => {
      const container = await api("POST", `/v18.0/${igUserId}/media`, {
        image_url: "https://example.com/photo.jpg",
        caption: "Hello from parlel",
      });
      expect(container.status).toBe(200);
      expect(container.body.id).toBeTruthy();

      const published = await api("POST", `/v18.0/${igUserId}/media_publish`, {
        creation_id: container.body.id,
      });
      expect(published.status).toBe(200);
      expect(published.body.id).toBeTruthy();

      const media = await api("GET", `/v18.0/${igUserId}/media`);
      expect(media.body.data.length).toBe(1);
      expect(media.body.data[0].id).toBe(published.body.id);
    });

    it("rejects container creation without image/video url", async () => {
      const res = await api("POST", `/v18.0/${igUserId}/media`, { caption: "no media" });
      expect(res.status).toBe(400);
    });

    it("rejects publish with an unknown creation_id", async () => {
      const res = await api("POST", `/v18.0/${igUserId}/media_publish`, { creation_id: "999999999" });
      expect(res.status).toBe(400);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      const c = await api("POST", `/v18.0/${igUserId}/media`, { image_url: "https://x/y.jpg" });
      await api("POST", `/v18.0/${igUserId}/media_publish`, { creation_id: c.body.id });
      await api("POST", "/__parlel/reset");
      const res = await api("GET", "/__parlel/media");
      expect(res.body.count).toBe(0);
    });
  });
});
