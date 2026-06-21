import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { IntercomServer } from "../services/intercom/src/server.js";

const PORT = 14780;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer pat-parlelTestToken", "Intercom-Version": "2.11" };

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

describe("Intercom Service", () => {
  let server: IntercomServer;

  beforeAll(async () => {
    server = new IntercomServer(PORT);
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
      expect(root.body.name).toBe("intercom");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("echoes Intercom-Version header", async () => {
      const r = await fetch(`${BASE_URL}/contacts`, { headers: AUTH });
      expect(r.headers.get("intercom-version")).toBe("2.11");
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/contacts", undefined, {});
      expect(result.status).toBe(401);
      expect(result.body.type).toBe("error.list");
    });
  });

  describe("Contacts", () => {
    it("creates a contact with type=contact", async () => {
      const result = await api("POST", "/contacts", { email: "a@parlel.dev", name: "Ada" });
      expect(result.status).toBe(200);
      expect(result.body.type).toBe("contact");
      expect(result.body.id).toBeTruthy();
      expect(result.body.email).toBe("a@parlel.dev");
    });
    it("reads a contact back", async () => {
      const created = await api("POST", "/contacts", { email: "b@parlel.dev" });
      const got = await api("GET", `/contacts/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.email).toBe("b@parlel.dev");
    });
    it("returns 404 for unknown contact", async () => {
      const got = await api("GET", "/contacts/deadbeefdeadbeefdeadbeef");
      expect(got.status).toBe(404);
    });
    it("lists contacts with type=list shape", async () => {
      await api("POST", "/contacts", { email: "c@parlel.dev" });
      const list = await api("GET", "/contacts");
      expect(list.body.type).toBe("list");
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.pages).toBeTruthy();
    });
    it("updates a contact via PUT", async () => {
      const created = await api("POST", "/contacts", { email: "d@parlel.dev" });
      const updated = await api("PUT", `/contacts/${created.body.id}`, { name: "Updated" });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe("Updated");
    });
    it("deletes a contact", async () => {
      const created = await api("POST", "/contacts", { email: "e@parlel.dev" });
      const del = await api("DELETE", `/contacts/${created.body.id}`);
      expect(del.status).toBe(200);
      const gone = await api("GET", `/contacts/${created.body.id}`);
      expect(gone.status).toBe(404);
    });
    it("searches contacts by field", async () => {
      await api("POST", "/contacts", { email: "find@parlel.dev", name: "Findme" });
      await api("POST", "/contacts", { email: "other@parlel.dev" });
      const result = await api("POST", "/contacts/search", {
        query: { field: "email", operator: "=", value: "find@parlel.dev" },
      });
      expect(result.status).toBe(200);
      expect(result.body.total_count).toBe(1);
      expect(result.body.data[0].name).toBe("Findme");
    });
  });

  describe("Conversations & Messages", () => {
    it("creates and reads a conversation", async () => {
      const created = await api("POST", "/conversations", { from: { type: "user", id: "x" }, body: "hi" });
      expect(created.status).toBe(200);
      const got = await api("GET", `/conversations/${created.body.id}`);
      expect(got.status).toBe(200);
    });
    it("lists conversations", async () => {
      await api("POST", "/conversations", { body: "one" });
      const list = await api("GET", "/conversations");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.conversations)).toBe(true);
    });
    it("posts a message", async () => {
      const result = await api("POST", "/messages", {
        message_type: "inapp",
        body: "Hello!",
        from: { type: "admin", id: "1" },
        to: { type: "user", id: "2" },
      });
      expect(result.status).toBe(200);
      expect(result.body.id).toBeTruthy();
    });
    it("rejects message without from", async () => {
      const result = await api("POST", "/messages", { body: "no from" });
      expect(result.status).toBe(400);
    });
  });
});
