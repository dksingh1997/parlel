import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { RedditServer } from "../services/reddit/src/server.js";

const PORT = 14804;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.reddittoken";
const UA = "parlel-test/1.0 (by /u/parlel)";
const AUTH = { Authorization: `Bearer ${TOKEN}`, "User-Agent": UA };

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

describe("Reddit Service", () => {
  let server: RedditServer;

  beforeAll(async () => {
    server = new RedditServer(PORT);
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
      expect(root.body.name).toBe("reddit");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("OAuth", () => {
    it("issues an access token", async () => {
      const res = await api("POST", "/api/v1/access_token", { grant_type: "client_credentials" }, {});
      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeTruthy();
      expect(res.body.token_type).toBe("bearer");
    });
  });

  describe("Authentication", () => {
    it("rejects missing token with 401", async () => {
      const res = await api("GET", "/api/v1/me", undefined, { "User-Agent": UA });
      expect(res.status).toBe(401);
    });

    it("requires a User-Agent header", async () => {
      const res = await api("GET", "/api/v1/me", undefined, { Authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(429);
    });
  });

  describe("Identity", () => {
    it("GET /api/v1/me returns the account", async () => {
      const res = await api("GET", "/api/v1/me");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("parlel");
    });
  });

  describe("Listings", () => {
    it("GET /r/:subreddit/hot.json returns a Listing of t3", async () => {
      const res = await api("GET", "/r/test/hot.json");
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("Listing");
      expect(Array.isArray(res.body.data.children)).toBe(true);
      expect(res.body.data.children[0].kind).toBe("t3");
      expect(res.body.data.children[0].data.title).toBeTruthy();
    });

    it("GET /r/:subreddit/about.json returns a t5", async () => {
      const res = await api("GET", "/r/test/about.json");
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("t5");
      expect(res.body.data.display_name).toBe("test");
    });
  });

  describe("Submit", () => {
    it("POST /api/submit creates a post", async () => {
      const res = await api("POST", "/api/submit", {
        sr: "test",
        kind: "self",
        title: "Hello parlel",
        text: "body text",
      });
      expect(res.status).toBe(200);
      expect(res.body.json.errors.length).toBe(0);
      expect(res.body.json.data.name).toMatch(/^t3_/);

      const hot = await api("GET", "/r/test/hot.json");
      const titles = hot.body.data.children.map((c: Json) => c.data.title);
      expect(titles).toContain("Hello parlel");
    });

    it("returns errors for a submission missing title", async () => {
      const res = await api("POST", "/api/submit", { sr: "test", kind: "self" });
      expect(res.status).toBe(200);
      expect(res.body.json.errors.length).toBeGreaterThan(0);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/api/submit", { sr: "test", kind: "self", title: "x" });
      await api("POST", "/__parlel/reset");
      const res = await api("GET", "/__parlel/posts");
      // back to the 2 seeded posts
      expect(res.body.count).toBe(2);
    });
  });
});
