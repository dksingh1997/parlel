import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FreshdeskServer } from "../services/freshdesk/src/server.js";

const PORT = 14782;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = Buffer.from("pat-parlel:X").toString("base64");
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

const validTicket = () => ({ subject: "Help", description: "It broke", email: "user@parlel.dev", priority: 1, status: 2 });

describe("Freshdesk Service", () => {
  let server: FreshdeskServer;

  beforeAll(async () => {
    server = new FreshdeskServer(PORT);
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
      expect(root.body.name).toBe("freshdesk");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const r = await fetch(`${BASE_URL}/api/v2/tickets`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/api/v2/tickets", undefined, {});
      expect(result.status).toBe(401);
    });
  });

  describe("Tickets CRUD", () => {
    it("creates a ticket (201) as plain JSON", async () => {
      const result = await api("POST", "/api/v2/tickets", validTicket());
      expect(result.status).toBe(201);
      expect(result.body.id).toBeTruthy();
      expect(result.body.subject).toBe("Help");
    });
    it("rejects ticket missing mandatory fields", async () => {
      const result = await api("POST", "/api/v2/tickets", { subject: "only subject" });
      expect(result.status).toBe(400);
      expect(Array.isArray(result.body.errors)).toBe(true);
      expect(result.body.errors.length).toBeGreaterThan(0);
    });
    it("reads a ticket back", async () => {
      const created = await api("POST", "/api/v2/tickets", validTicket());
      const got = await api("GET", `/api/v2/tickets/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.subject).toBe("Help");
    });
    it("returns 404 for unknown ticket", async () => {
      const got = await api("GET", "/api/v2/tickets/99999");
      expect(got.status).toBe(404);
    });
    it("lists tickets as a bare array", async () => {
      await api("POST", "/api/v2/tickets", validTicket());
      const list = await api("GET", "/api/v2/tickets");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body.length).toBe(1);
    });
    it("updates a ticket via PUT", async () => {
      const created = await api("POST", "/api/v2/tickets", validTicket());
      const updated = await api("PUT", `/api/v2/tickets/${created.body.id}`, { status: 5 });
      expect(updated.status).toBe(200);
      expect(updated.body.status).toBe(5);
    });
    it("deletes a ticket (204)", async () => {
      const created = await api("POST", "/api/v2/tickets", validTicket());
      const del = await api("DELETE", `/api/v2/tickets/${created.body.id}`);
      expect(del.status).toBe(204);
      const gone = await api("GET", `/api/v2/tickets/${created.body.id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Contacts & Companies", () => {
    it("creates a contact", async () => {
      const result = await api("POST", "/api/v2/contacts", { name: "Ada", email: "ada@parlel.dev" });
      expect(result.status).toBe(201);
      expect(result.body.name).toBe("Ada");
    });
    it("rejects contact without name", async () => {
      const result = await api("POST", "/api/v2/contacts", {});
      expect(result.status).toBe(400);
    });
    it("creates a company", async () => {
      const result = await api("POST", "/api/v2/companies", { name: "Parlel Inc" });
      expect(result.status).toBe(201);
      expect(result.body.name).toBe("Parlel Inc");
    });
  });
});
