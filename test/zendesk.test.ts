import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ZendeskServer } from "../services/zendesk/src/server.js";

const PORT = 14781;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = Buffer.from("agent@parlel.dev/token:pat-parlel").toString("base64");
const AUTH = { Authorization: `Basic ${BASIC}` };

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

describe("Zendesk Service", () => {
  let server: ZendeskServer;

  beforeAll(async () => {
    server = new ZendeskServer(PORT);
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
      expect(root.body.name).toBe("zendesk");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const r = await fetch(`${BASE_URL}/api/v2/tickets.json`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/api/v2/tickets.json", undefined, {});
      expect(result.status).toBe(401);
    });
    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/api/v2/tickets.json", undefined, { Authorization: "Bearer abc" });
      expect(result.status).toBe(200);
    });
  });

  describe("Tickets CRUD", () => {
    it("creates a ticket wrapped in {ticket}", async () => {
      const result = await api("POST", "/api/v2/tickets.json", { ticket: { subject: "Help", comment: { body: "broken" } } });
      expect(result.status).toBe(201);
      expect(result.body.ticket.id).toBeTruthy();
      expect(result.body.ticket.subject).toBe("Help");
      expect(result.body.ticket.status).toBe("open");
    });
    it("rejects ticket without subject/comment", async () => {
      const result = await api("POST", "/api/v2/tickets.json", { ticket: {} });
      expect(result.status).toBe(422);
    });
    it("reads a ticket via /:id.json", async () => {
      const created = await api("POST", "/api/v2/tickets.json", { ticket: { subject: "Read me" } });
      const got = await api("GET", `/api/v2/tickets/${created.body.ticket.id}.json`);
      expect(got.status).toBe(200);
      expect(got.body.ticket.subject).toBe("Read me");
    });
    it("returns 404 for unknown ticket", async () => {
      const got = await api("GET", "/api/v2/tickets/99999.json");
      expect(got.status).toBe(404);
    });
    it("lists tickets wrapped in {tickets}", async () => {
      await api("POST", "/api/v2/tickets.json", { ticket: { subject: "T1" } });
      const list = await api("GET", "/api/v2/tickets.json");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.tickets)).toBe(true);
      expect(list.body.count).toBe(1);
    });
    it("updates a ticket via PUT", async () => {
      const created = await api("POST", "/api/v2/tickets.json", { ticket: { subject: "old" } });
      const updated = await api("PUT", `/api/v2/tickets/${created.body.ticket.id}.json`, { ticket: { status: "solved" } });
      expect(updated.status).toBe(200);
      expect(updated.body.ticket.status).toBe("solved");
    });
    it("deletes a ticket (204)", async () => {
      const created = await api("POST", "/api/v2/tickets.json", { ticket: { subject: "bye" } });
      const del = await api("DELETE", `/api/v2/tickets/${created.body.ticket.id}.json`);
      expect(del.status).toBe(204);
      const gone = await api("GET", `/api/v2/tickets/${created.body.ticket.id}.json`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Users & Organizations", () => {
    it("creates a user", async () => {
      const result = await api("POST", "/api/v2/users.json", { user: { name: "Ada", email: "a@parlel.dev" } });
      expect(result.status).toBe(201);
      expect(result.body.user.name).toBe("Ada");
    });
    it("creates an organization", async () => {
      const result = await api("POST", "/api/v2/organizations.json", { organization: { name: "Parlel Inc" } });
      expect(result.status).toBe(201);
      expect(result.body.organization.name).toBe("Parlel Inc");
    });
    it("lists users", async () => {
      await api("POST", "/api/v2/users.json", { user: { name: "U1" } });
      const list = await api("GET", "/api/v2/users.json");
      expect(Array.isArray(list.body.users)).toBe(true);
    });
  });
});
