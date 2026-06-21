import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BeehiivServer } from "../services/beehiiv/src/server.js";

const PORT = 14835;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PUB = "pub_parlel";
const AUTH = { Authorization: "Bearer parlel-beehiiv-key" };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, body?: any, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("beehiiv Service", () => {
  let server: BeehiivServer;

  beforeAll(async () => {
    server = new BeehiivServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
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
      expect(root.body.name).toBe("beehiiv");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v2/publications`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401 and correct error envelope", async () => {
      const response = await fetch(`${BASE_URL}/v2/publications`);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.status).toBe(401);
      expect(body.statusText).toBe("Unauthorized");
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors[0]).toHaveProperty("message");
      expect(body.errors[0]).toHaveProperty("code");
      expect(body.errors[0].code).toBe("unauthorized");
    });

    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/v2/publications");
      expect(result.status).toBe(200);
    });
  });

  describe("Error envelope shape", () => {
    it("returns correct error shape for not-found", async () => {
      const result = await api("GET", "/v2/publications/pub_nope/subscriptions");
      expect(result.status).toBe(404);
      expect(result.body.status).toBe(404);
      expect(result.body.statusText).toBe("Not Found");
      expect(Array.isArray(result.body.errors)).toBe(true);
      expect(result.body.errors[0]).toHaveProperty("message");
      expect(result.body.errors[0]).toHaveProperty("code");
      expect(result.body.errors[0].code).toBe("not_found");
    });

    it("returns correct error shape for method not allowed", async () => {
      const result = await api("PUT", "/v2/publications");
      expect(result.status).toBe(404);
      expect(result.body).toHaveProperty("status");
      expect(result.body).toHaveProperty("statusText");
      expect(result.body).toHaveProperty("errors");
    });

    it("returns correct error shape for bad JSON body", async () => {
      const response = await fetch(`${BASE_URL}/v2/publications/${PUB}/subscriptions`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "not json",
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.status).toBe(400);
      expect(body.statusText).toBe("Bad Request");
      expect(body.errors[0].code).toBe("bad_request");
    });
  });

  describe("Publications", () => {
    it("lists publications (seeded default present)", async () => {
      const result = await api("GET", "/v2/publications");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.data)).toBe(true);
      expect(result.body.total_results).toBeGreaterThanOrEqual(1);
      expect(result.body.total_pages).toBe(1);
      expect(result.body).toHaveProperty("limit");
      expect(result.body).toHaveProperty("page");
    });

    it("returns 404 for unknown publication", async () => {
      const result = await api("GET", "/v2/publications/pub_nope/subscriptions");
      expect(result.status).toBe(404);
      expect(result.body.errors[0].code).toBe("not_found");
    });
  });

  describe("Subscriptions CRUD", () => {
    it("creates a subscription with status 200 and all required fields", async () => {
      const created = await api("POST", `/v2/publications/${PUB}/subscriptions`, { email: "s@parlel.dev" });
      expect(created.status).toBe(200);
      expect(created.body.data.email).toBe("s@parlel.dev");
      expect(created.body.data.status).toBe("active");
      expect(created.body.data.subscription_tier).toBe("free");
      expect(created.body.data).toHaveProperty("id");
      expect(created.body.data).toHaveProperty("created");
      expect(created.body.data).toHaveProperty("subscription_premium_tier_names");
      expect(Array.isArray(created.body.data.subscription_premium_tier_names)).toBe(true);
      expect(created.body.data).toHaveProperty("utm_channel");
      expect(created.body.data).toHaveProperty("utm_term");
      expect(created.body.data).toHaveProperty("utm_content");
      expect(created.body.data).toHaveProperty("referral_code");
      expect(created.body.data).toHaveProperty("utm_source");
      expect(created.body.data).toHaveProperty("utm_medium");
      expect(created.body.data).toHaveProperty("utm_campaign");
      expect(created.body.data).toHaveProperty("referring_site");
    });

    it("creates, reads, updates and deletes a subscription", async () => {
      const created = await api("POST", `/v2/publications/${PUB}/subscriptions`, { email: "s@parlel.dev" });
      expect(created.status).toBe(200);
      const id = created.body.data.id;

      const got = await api("GET", `/v2/publications/${PUB}/subscriptions/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.data.email).toBe("s@parlel.dev");

      const updated = await api("PUT", `/v2/publications/${PUB}/subscriptions/${id}`, { unsubscribe: true });
      expect(updated.status).toBe(200);
      expect(updated.body.data.status).toBe("inactive");

      const list = await api("GET", `/v2/publications/${PUB}/subscriptions`);
      expect(list.body.data.length).toBe(1);
      expect(list.body.total_results).toBe(1);

      const deleted = await api("DELETE", `/v2/publications/${PUB}/subscriptions/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v2/publications/${PUB}/subscriptions/${id}`);
      expect(gone.status).toBe(404);
    });

    it("upserts by email (returns existing on duplicate POST)", async () => {
      const first = await api("POST", `/v2/publications/${PUB}/subscriptions`, { email: "dup@parlel.dev" });
      expect(first.status).toBe(200);
      const second = await api("POST", `/v2/publications/${PUB}/subscriptions`, { email: "dup@parlel.dev" });
      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(first.body.data.id);
    });

    it("rejects invalid subscription email with correct error shape", async () => {
      const result = await api("POST", `/v2/publications/${PUB}/subscriptions`, { email: "bad" });
      expect(result.status).toBe(400);
      expect(result.body.status).toBe(400);
      expect(result.body.statusText).toBe("Bad Request");
      expect(result.body.errors[0]).toHaveProperty("message");
      expect(result.body.errors[0]).toHaveProperty("code");
      expect(result.body.errors[0].code).toBe("bad_request");
    });

    it("supports by_email lookup route", async () => {
      await api("POST", `/v2/publications/${PUB}/subscriptions`, { email: "lookup@parlel.dev" });
      const result = await api("GET", `/v2/publications/${PUB}/subscriptions/by_email/lookup@parlel.dev`);
      expect(result.status).toBe(200);
      expect(result.body.data.email).toBe("lookup@parlel.dev");
    });

    it("returns 404 for unknown by_email lookup", async () => {
      const result = await api("GET", `/v2/publications/${PUB}/subscriptions/by_email/nope@parlel.dev`);
      expect(result.status).toBe(404);
      expect(result.body.errors[0].code).toBe("not_found");
    });

    it("supports PUT update with tier and unsubscribe", async () => {
      const created = await api("POST", `/v2/publications/${PUB}/subscriptions`, { email: "tier@parlel.dev" });
      const id = created.body.data.id;

      const tiered = await api("PUT", `/v2/publications/${PUB}/subscriptions/${id}`, { tier: "premium" });
      expect(tiered.status).toBe(200);
      expect(tiered.body.data.subscription_tier).toBe("premium");

      const unsub = await api("PUT", `/v2/publications/${PUB}/subscriptions/${id}`, { unsubscribe: true });
      expect(unsub.status).toBe(200);
      expect(unsub.body.data.status).toBe("inactive");
    });

    it("returns 404 for unknown subscription", async () => {
      const result = await api("GET", `/v2/publications/${PUB}/subscriptions/sub_nope`);
      expect(result.status).toBe(404);
    });

    it("returns 405 for unsupported method on subscriptions list", async () => {
      const result = await api("DELETE", `/v2/publications/${PUB}/subscriptions`);
      expect(result.status).toBe(405);
      expect(result.body.errors[0].code).toBe("method_not_allowed");
    });
  });

  describe("Posts", () => {
    it("creates a post with all required fields", async () => {
      const created = await api("POST", `/v2/publications/${PUB}/posts`, { title: "Issue #1", subtitle: "Hi" });
      expect(created.status).toBe(201);
      expect(created.body.data.title).toBe("Issue #1");
      expect(created.body.data.subtitle).toBe("Hi");
      expect(created.body.data.status).toBe("draft");
      expect(created.body.data).toHaveProperty("id");
      expect(created.body.data).toHaveProperty("created");
      expect(created.body.data).toHaveProperty("authors");
      expect(Array.isArray(created.body.data.authors)).toBe(true);
      expect(created.body.data).toHaveProperty("slug");
      expect(created.body.data).toHaveProperty("web_url");
      expect(created.body.data).toHaveProperty("audience");
      expect(created.body.data).toHaveProperty("platform");
      expect(created.body.data).toHaveProperty("subject_line");
      expect(created.body.data).toHaveProperty("preview_text");
      expect(created.body.data).toHaveProperty("split_tested");
      expect(created.body.data).toHaveProperty("hidden_from_feed");
      expect(created.body.data).toHaveProperty("enforce_gated_content");
      expect(created.body.data).toHaveProperty("email_capture_popup");
      expect(created.body.data).toHaveProperty("publish_date");
      expect(created.body.data).toHaveProperty("displayed_date");
      expect(created.body.data).toHaveProperty("thumbnail_url");
    });

    it("captures posts in the parlel inbox", async () => {
      await api("POST", `/v2/publications/${PUB}/posts`, { title: "Issue #1" });
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
    });

    it("lists posts", async () => {
      await api("POST", `/v2/publications/${PUB}/posts`, { title: "Issue #1" });
      const list = await api("GET", `/v2/publications/${PUB}/posts`);
      expect(list.body.data.length).toBe(1);
      expect(list.body.data[0].title).toBe("Issue #1");
    });

    it("gets a post by ID", async () => {
      const created = await api("POST", `/v2/publications/${PUB}/posts`, { title: "Get Me" });
      const id = created.body.data.id;
      const got = await api("GET", `/v2/publications/${PUB}/posts/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.data.title).toBe("Get Me");
    });

    it("updates a post via PATCH", async () => {
      const created = await api("POST", `/v2/publications/${PUB}/posts`, { title: "Old Title" });
      const id = created.body.data.id;
      const updated = await api("PATCH", `/v2/publications/${PUB}/posts/${id}`, { title: "New Title", status: "confirmed" });
      expect(updated.status).toBe(200);
      expect(updated.body.data.title).toBe("New Title");
      expect(updated.body.data.status).toBe("confirmed");
    });

    it("deletes a post", async () => {
      const created = await api("POST", `/v2/publications/${PUB}/posts`, { title: "Delete Me" });
      const id = created.body.data.id;
      const deleted = await api("DELETE", `/v2/publications/${PUB}/posts/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v2/publications/${PUB}/posts/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects post without title with correct error shape", async () => {
      const result = await api("POST", `/v2/publications/${PUB}/posts`, {});
      expect(result.status).toBe(400);
      expect(result.body.status).toBe(400);
      expect(result.body.statusText).toBe("Bad Request");
      expect(result.body.errors[0]).toHaveProperty("message");
      expect(result.body.errors[0]).toHaveProperty("code");
    });

    it("returns 404 for unknown post", async () => {
      const result = await api("GET", `/v2/publications/${PUB}/posts/post_nope`);
      expect(result.status).toBe(404);
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", `/v2/publications/${PUB}/posts`, { title: "x" });
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
