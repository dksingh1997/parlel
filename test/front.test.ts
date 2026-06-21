import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FrontServer } from "../services/front/src/server.js";

const PORT = 14785;
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

describe("Front Service", () => {
  let server: FrontServer;

  beforeAll(async () => {
    server = new FrontServer(PORT);
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
      expect(root.body.name).toBe("front");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const r = await fetch(`${BASE_URL}/conversations`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/conversations", undefined, {});
      expect(result.status).toBe(401);
      expect(result.body._error).toBeTruthy();
    });
  });

  describe("Conversations", () => {
    it("creates a conversation with _links and cnv_ id", async () => {
      const result = await api("POST", "/conversations", { subject: "Hi there" });
      expect(result.status).toBe(201);
      expect(result.body.id).toMatch(/^cnv_/);
      expect(result.body._links).toBeTruthy();
      expect(result.body.subject).toBe("Hi there");
    });
    it("reads a conversation back", async () => {
      const created = await api("POST", "/conversations", { subject: "Read me" });
      const got = await api("GET", `/conversations/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.subject).toBe("Read me");
    });
    it("returns 404 for unknown conversation", async () => {
      const got = await api("GET", "/conversations/cnv_doesnotexist");
      expect(got.status).toBe(404);
    });
    it("lists conversations with _results/_pagination", async () => {
      await api("POST", "/conversations", { subject: "C1" });
      const list = await api("GET", "/conversations");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body._results)).toBe(true);
      expect(list.body._pagination).toBeTruthy();
    });
    it("patches a conversation (204)", async () => {
      const created = await api("POST", "/conversations", { subject: "old" });
      const patched = await api("PATCH", `/conversations/${created.body.id}`, { status: "archived" });
      expect(patched.status).toBe(204);
      const got = await api("GET", `/conversations/${created.body.id}`);
      expect(got.body.status).toBe("archived");
    });
    it("posts a reply message to a conversation (202)", async () => {
      const created = await api("POST", "/conversations", { subject: "thread" });
      const reply = await api("POST", `/conversations/${created.body.id}/messages`, { body: "reply text" });
      expect(reply.status).toBe(202);
      expect(reply.body.id).toMatch(/^msg_/);
    });
  });

  describe("Contacts", () => {
    it("creates and reads a contact", async () => {
      const created = await api("POST", "/contacts", { name: "Ada", handles: [{ handle: "ada@parlel.dev", source: "email" }] });
      expect(created.status).toBe(201);
      expect(created.body.id).toMatch(/^crd_/);
      const got = await api("GET", `/contacts/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("Ada");
    });
    it("lists contacts", async () => {
      await api("POST", "/contacts", { name: "C1" });
      const list = await api("GET", "/contacts");
      expect(Array.isArray(list.body._results)).toBe(true);
    });
  });

  describe("Channel messages", () => {
    it("sends a message through a channel (202)", async () => {
      const result = await api("POST", "/channels/cha_parlel/messages", {
        to: ["customer@parlel.dev"],
        subject: "Hello",
        body: "Body text",
      });
      expect(result.status).toBe(202);
      expect(result.body.id).toMatch(/^msg_/);
    });
    it("404 for unknown channel", async () => {
      const result = await api("POST", "/channels/cha_nope/messages", { body: "x" });
      expect(result.status).toBe(404);
    });
  });
});
