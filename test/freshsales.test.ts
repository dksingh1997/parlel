import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FreshsalesServer } from "../services/freshsales/src/server.js";

const PORT = 14783;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Token token=pat-parlel" };

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

describe("Freshsales Service", () => {
  let server: FreshsalesServer;

  beforeAll(async () => {
    server = new FreshsalesServer(PORT);
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
      expect(root.body.name).toBe("freshsales");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const r = await fetch(`${BASE_URL}/api/contacts`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/api/contacts", undefined, {});
      expect(result.status).toBe(401);
    });
    it("accepts Token token= auth", async () => {
      const result = await api("GET", "/api/contacts");
      expect(result.status).toBe(200);
    });
  });

  describe("Contacts CRUD", () => {
    it("creates a contact wrapped in {contact}", async () => {
      const result = await api("POST", "/api/contacts", { contact: { first_name: "Ada", last_name: "Lovelace", email: "ada@parlel.dev" } });
      expect(result.status).toBe(201);
      expect(result.body.contact.id).toBeTruthy();
      expect(result.body.contact.first_name).toBe("Ada");
    });
    it("rejects empty contact", async () => {
      const result = await api("POST", "/api/contacts", { contact: {} });
      expect(result.status).toBe(400);
      expect(result.body.errors).toBeTruthy();
    });
    it("reads a contact back", async () => {
      const created = await api("POST", "/api/contacts", { contact: { last_name: "Read" } });
      const got = await api("GET", `/api/contacts/${created.body.contact.id}`);
      expect(got.status).toBe(200);
      expect(got.body.contact.last_name).toBe("Read");
    });
    it("returns 404 for unknown contact", async () => {
      const got = await api("GET", "/api/contacts/99999");
      expect(got.status).toBe(404);
    });
    it("lists contacts wrapped in {contacts} with meta", async () => {
      await api("POST", "/api/contacts", { contact: { last_name: "L1" } });
      const list = await api("GET", "/api/contacts");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.contacts)).toBe(true);
      expect(list.body.meta.total).toBe(1);
    });
    it("updates a contact via PUT", async () => {
      const created = await api("POST", "/api/contacts", { contact: { last_name: "Old" } });
      const updated = await api("PUT", `/api/contacts/${created.body.contact.id}`, { contact: { last_name: "New" } });
      expect(updated.status).toBe(200);
      expect(updated.body.contact.last_name).toBe("New");
    });
    it("deletes a contact", async () => {
      const created = await api("POST", "/api/contacts", { contact: { last_name: "Bye" } });
      const del = await api("DELETE", `/api/contacts/${created.body.contact.id}`);
      expect(del.status).toBe(200);
      const gone = await api("GET", `/api/contacts/${created.body.contact.id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Leads, Deals, Sales accounts", () => {
    it("creates a lead", async () => {
      const result = await api("POST", "/api/leads", { lead: { last_name: "Hot", email: "hot@parlel.dev" } });
      expect(result.status).toBe(201);
      expect(result.body.lead.last_name).toBe("Hot");
    });
    it("creates a deal", async () => {
      const result = await api("POST", "/api/deals", { deal: { name: "Big Deal", amount: 1000 } });
      expect(result.status).toBe(201);
      expect(result.body.deal.name).toBe("Big Deal");
    });
    it("creates a sales account", async () => {
      const result = await api("POST", "/api/sales_accounts", { sales_account: { name: "Parlel Inc" } });
      expect(result.status).toBe(201);
      expect(result.body.sales_account.name).toBe("Parlel Inc");
    });
  });
});
