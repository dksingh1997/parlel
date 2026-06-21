import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { LinkedinServer } from "../services/linkedin/src/server.js";

const PORT = 14799;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.linkedintoken";
const AUTH = { Authorization: `Bearer ${TOKEN}`, "X-Restli-Protocol-Version": "2.0.0" };

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

describe("LinkedIn Service", () => {
  let server: LinkedinServer;

  beforeAll(async () => {
    server = new LinkedinServer(PORT);
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
      expect(root.body.name).toBe("linkedin");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing token with 401", async () => {
      const res = await api("GET", "/v2/me", undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.status).toBe(401);
    });
  });

  describe("Profile", () => {
    it("GET /v2/me returns the member profile", async () => {
      const res = await api("GET", "/v2/me");
      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
      expect(res.body.localizedFirstName).toBe("Parlel");
    });

    it("GET /v2/userinfo returns OpenID claims", async () => {
      const res = await api("GET", "/v2/userinfo");
      expect(res.status).toBe(200);
      expect(res.body.sub).toBeTruthy();
      expect(res.body.email).toBe("user@parlel.dev");
    });
  });

  describe("Posts", () => {
    it("POST /v2/ugcPosts creates a ugcPost and returns id", async () => {
      const res = await api("POST", "/v2/ugcPosts", {
        author: "urn:li:person:parlelMember001",
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: "Hello from parlel!" },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^urn:li:ugcPost:/);
      expect(res.headers.get("x-restli-id")).toBeTruthy();
    });

    it("POST /rest/posts creates a post with id in header", async () => {
      const res = await api("POST", "/rest/posts", {
        author: "urn:li:person:parlelMember001",
        commentary: "Posting via /rest/posts",
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED" },
        lifecycleState: "PUBLISHED",
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("x-restli-id")).toMatch(/^urn:li:share:/);
    });

    it("captures created posts for inspection", async () => {
      await api("POST", "/v2/ugcPosts", { author: "urn:li:person:x" });
      await api("POST", "/rest/posts", { author: "urn:li:person:x" });
      const res = await api("GET", "/__parlel/posts");
      expect(res.body.count).toBe(2);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/v2/ugcPosts", { author: "urn:li:person:x" });
      await api("POST", "/__parlel/reset");
      const res = await api("GET", "/__parlel/posts");
      expect(res.body.count).toBe(0);
    });
  });
});
