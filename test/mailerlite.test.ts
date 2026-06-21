import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MailerliteServer } from "../services/mailerlite/src/server.js";

const PORT = 14831;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-mailerlite-key" };

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

describe("MailerLite Service", () => {
  let server: MailerliteServer;

  beforeAll(async () => {
    server = new MailerliteServer(PORT);
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
      expect(root.body.name).toBe("mailerlite");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/api/subscribers`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/api/subscribers`);
      expect(response.status).toBe(401);
    });

    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/api/subscribers");
      expect(result.status).toBe(200);
    });
  });

  describe("Subscribers CRUD", () => {
    it("creates, reads, updates and deletes a subscriber", async () => {
      const created = await api("POST", "/api/subscribers", { email: "s@parlel.dev", fields: { name: "S" } });
      expect(created.status).toBe(201);
      expect(created.body.data.email).toBe("s@parlel.dev");
      const id = created.body.data.id;

      const got = await api("GET", `/api/subscribers/${id}`);
      expect(got.status).toBe(200);

      const byEmail = await api("GET", "/api/subscribers/s@parlel.dev");
      expect(byEmail.status).toBe(200);

      const updated = await api("PUT", `/api/subscribers/${id}`, { fields: { name: "Updated" } });
      expect(updated.body.data.fields.name).toBe("Updated");

      const list = await api("GET", "/api/subscribers");
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.data.length).toBe(1);
      expect(list.body.meta.total).toBe(1);

      const deleted = await api("DELETE", `/api/subscribers/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/api/subscribers/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects invalid subscriber email", async () => {
      const result = await api("POST", "/api/subscribers", { email: "bad" });
      expect(result.status).toBe(422);
    });
  });

  describe("Groups", () => {
    it("creates and lists groups", async () => {
      const created = await api("POST", "/api/groups", { name: "Newsletter" });
      expect(created.status).toBe(201);
      expect(created.body.data.name).toBe("Newsletter");
      const list = await api("GET", "/api/groups");
      expect(list.body.data.length).toBe(1);
    });
  });

  describe("Campaigns", () => {
    it("creates a campaign and captures it", async () => {
      const created = await api("POST", "/api/campaigns", {
        name: "Spring",
        type: "regular",
        emails: [{ subject: "Hi", from: "f@parlel.dev", content: "<p>Hi</p>" }],
      });
      expect(created.status).toBe(201);
      expect(created.body.data.status).toBe("draft");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
    });
  });

  describe("GET /api/account", () => {
    it("returns account info", async () => {
      const result = await api("GET", "/api/account");
      expect(result.status).toBe(200);
      expect(result.body.data.account.name).toBeTruthy();
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", "/api/campaigns", { name: "x", type: "regular" });
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
