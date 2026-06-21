import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FacebookPagesServer } from "../services/facebook-pages/src/server.js";

const PORT = 14801;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.fbtoken";
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

describe("Facebook Pages Service", () => {
  let server: FacebookPagesServer;
  let pageId: string;

  beforeAll(async () => {
    server = new FacebookPagesServer(PORT);
    await server.start();
    pageId = server._defaultPageId;
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
    pageId = server._defaultPageId;
  });

  describe("Server lifecycle", () => {
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("facebook-pages");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing token with Graph 401", async () => {
      const res = await api("GET", "/v18.0/me", undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("OAuthException");
    });

    it("accepts access_token via query string", async () => {
      const res = await api("GET", `/v18.0/me?access_token=${TOKEN}`, undefined, {});
      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
    });
  });

  describe("Me & accounts", () => {
    it("GET /v18.0/me returns the user", async () => {
      const res = await api("GET", "/v18.0/me");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Parlel User");
    });

    it("GET /v18.0/me/accounts lists pages with data array", async () => {
      const res = await api("GET", "/v18.0/me/accounts");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].access_token).toBeTruthy();
    });
  });

  describe("Page & feed", () => {
    it("GET /v18.0/:pageId returns the page", async () => {
      const res = await api("GET", `/v18.0/${pageId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(pageId);
      expect(res.body.name).toBe("Parlel Page");
    });

    it("POST /v18.0/:pageId/feed publishes a post -> { id }", async () => {
      const res = await api("POST", `/v18.0/${pageId}/feed`, { message: "Hello world from parlel" });
      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(new RegExp(`^${pageId}_`));
    });

    it("rejects feed publish without message or link", async () => {
      const res = await api("POST", `/v18.0/${pageId}/feed`, {});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(100);
    });

    it("GET /v18.0/:pageId/posts lists published posts", async () => {
      await api("POST", `/v18.0/${pageId}/feed`, { message: "post 1" });
      await api("POST", `/v18.0/${pageId}/feed`, { message: "post 2" });
      const res = await api("GET", `/v18.0/${pageId}/posts`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.paging).toBeDefined();
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", `/v18.0/${pageId}/feed`, { message: "x" });
      await api("POST", "/__parlel/reset");
      const res = await api("GET", "/__parlel/posts");
      expect(res.body.count).toBe(0);
    });
  });
});
