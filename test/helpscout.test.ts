import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { HelpscoutServer } from "../services/helpscout/src/server.js";

const PORT = 14786;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer pat-parlelTestToken" };

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

describe("HelpScout Service", () => {
  let server: HelpscoutServer;

  beforeAll(async () => {
    server = new HelpscoutServer(PORT);
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
      expect(root.body.name).toBe("helpscout");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const r = await fetch(`${BASE_URL}/v2/conversations`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    });
  });

  describe("OAuth token", () => {
    it("issues an access token (200)", async () => {
      const result = await api("POST", "/v2/oauth2/token", { grant_type: "client_credentials", client_id: "parlel", client_secret: "pat-parlel" }, {});
      expect(result.status).toBe(200);
      expect(result.body.token_type).toBe("bearer");
      expect(result.body.access_token).toBeTruthy();
    });
    it("rejects token request without grant_type", async () => {
      const result = await api("POST", "/v2/oauth2/token", {}, {});
      expect(result.status).toBe(400);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/v2/conversations", undefined, {});
      expect(result.status).toBe(401);
    });
  });

  describe("Conversations", () => {
    it("creates a conversation (201) with Resource-ID header", async () => {
      const result = await api("POST", "/v2/conversations", {
        subject: "Help me",
        mailboxId: 1,
        type: "email",
        customer: { email: "user@parlel.dev" },
      });
      expect(result.status).toBe(201);
      expect(result.headers.get("resource-id")).toBeTruthy();
    });
    it("rejects conversation missing required fields", async () => {
      const result = await api("POST", "/v2/conversations", { type: "email" });
      expect(result.status).toBe(400);
      expect(result.body._embedded.errors.length).toBeGreaterThan(0);
    });
    it("reads a created conversation back", async () => {
      const created = await api("POST", "/v2/conversations", { subject: "Read me", mailboxId: 1 });
      const id = created.headers.get("resource-id");
      const got = await api("GET", `/v2/conversations/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.subject).toBe("Read me");
      expect(got.body._links).toBeTruthy();
    });
    it("returns 404 for unknown conversation", async () => {
      const got = await api("GET", "/v2/conversations/99999");
      expect(got.status).toBe(404);
    });
    it("lists conversations with HAL _embedded/page shape", async () => {
      await api("POST", "/v2/conversations", { subject: "C1", mailboxId: 1 });
      const list = await api("GET", "/v2/conversations");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body._embedded.conversations)).toBe(true);
      expect(list.body.page.totalElements).toBe(1);
      expect(list.body._links).toBeTruthy();
    });
    it("updates a conversation via PATCH (204)", async () => {
      const created = await api("POST", "/v2/conversations", { subject: "old", mailboxId: 1 });
      const id = created.headers.get("resource-id");
      const patched = await api("PATCH", `/v2/conversations/${id}`, { status: "closed" });
      expect(patched.status).toBe(204);
      const got = await api("GET", `/v2/conversations/${id}`);
      expect(got.body.status).toBe("closed");
    });
  });

  describe("Customers & Mailboxes", () => {
    it("creates a customer", async () => {
      const result = await api("POST", "/v2/customers", { firstName: "Ada", lastName: "Lovelace" });
      expect(result.status).toBe(201);
      expect(result.headers.get("resource-id")).toBeTruthy();
    });
    it("lists seeded mailboxes", async () => {
      const list = await api("GET", "/v2/mailboxes");
      expect(list.status).toBe(200);
      expect(list.body._embedded.mailboxes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
