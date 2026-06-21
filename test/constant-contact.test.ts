import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ConstantContactServer } from "../services/constant-contact/src/server.js";

const PORT = 14832;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-cc-token" };

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

describe("Constant Contact Service", () => {
  let server: ConstantContactServer;

  beforeAll(async () => {
    server = new ConstantContactServer(PORT);
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
      expect(root.body.name).toBe("constant-contact");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v3/contacts`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/v3/contacts`);
      expect(response.status).toBe(401);
    });

    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/v3/contacts");
      expect(result.status).toBe(200);
    });
  });

  describe("Contacts CRUD", () => {
    it("creates, reads, updates and deletes a contact", async () => {
      const created = await api("POST", "/v3/contacts", {
        email_address: { address: "c@parlel.dev", permission_to_send: "implicit" },
        first_name: "C",
        create_source: "Account",
      });
      expect(created.status).toBe(201);
      const id = created.body.contact_id;
      expect(id).toBeTruthy();

      const got = await api("GET", `/v3/contacts/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.first_name).toBe("C");

      const updated = await api("PUT", `/v3/contacts/${id}`, { first_name: "Updated" });
      expect(updated.body.first_name).toBe("Updated");

      const list = await api("GET", "/v3/contacts");
      expect(list.body.contacts_count).toBe(1);

      const deleted = await api("DELETE", `/v3/contacts/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v3/contacts/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects invalid contact email", async () => {
      const result = await api("POST", "/v3/contacts", { email_address: { address: "bad" } });
      expect(result.status).toBe(400);
    });
  });

  describe("Contact lists", () => {
    it("creates and lists contact lists", async () => {
      const created = await api("POST", "/v3/contact_lists", { name: "Newsletter" });
      expect(created.status).toBe(201);
      expect(created.body.list_id).toBeTruthy();
      const list = await api("GET", "/v3/contact_lists");
      expect(list.body.lists_count).toBe(1);
    });
  });

  describe("Emails", () => {
    it("creates an email campaign and captures it", async () => {
      const created = await api("POST", "/v3/emails", {
        name: "Spring Promo",
        email_campaign_activities: [{ format_type: 5, subject: "Hi" }],
      });
      expect(created.status).toBe(201);
      expect(created.body.current_status).toBe("Draft");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
    });
  });

  describe("GET /v3/account/summary", () => {
    it("returns account summary", async () => {
      const result = await api("GET", "/v3/account/summary");
      expect(result.status).toBe(200);
      expect(result.body.organization_name).toBeTruthy();
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", "/v3/emails", { name: "x" });
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
