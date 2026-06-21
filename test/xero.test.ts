import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { XeroServer } from "../services/xero/src/server.js";

const PORT = 14763;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `/api.xro/2.0`;
const AUTH = { Authorization: "Bearer parlel-xero-token", "Xero-Tenant-Id": "parlel-tenant" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
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

describe("Xero Service", () => {
  let server: XeroServer;

  beforeAll(async () => {
    server = new XeroServer(PORT);
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
      expect(root.body.name).toBe("xero");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without bearer", async () => {
      const response = await fetch(`${BASE_URL}${API}/Invoices`, { method: "GET" });
      expect(response.status).toBe(401);
    });
  });

  describe("Invoices", () => {
    it("creates an invoice via PUT wrapped in { Invoices }", async () => {
      const result = await api("PUT", `${API}/Invoices`, {
        Invoices: [{ Type: "ACCREC", Contact: { Name: "Jane Co" }, LineItems: [], Status: "DRAFT" }],
      });
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.Invoices)).toBe(true);
      const inv = result.body.Invoices[0];
      expect(inv.InvoiceID).toBeTruthy();
      expect(inv.InvoiceNumber).toMatch(/^INV-/);
    });

    it("lists invoices wrapped in { Invoices }", async () => {
      await api("PUT", `${API}/Invoices`, { Invoices: [{ Type: "ACCREC" }] });
      const list = await api("GET", `${API}/Invoices`);
      expect(list.body.Invoices.length).toBe(1);
    });

    it("retrieves an invoice by id", async () => {
      const created = await api("PUT", `${API}/Invoices`, { Invoices: [{ Type: "ACCREC" }] });
      const id = created.body.Invoices[0].InvoiceID;
      const got = await api("GET", `${API}/Invoices/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.Invoices[0].InvoiceID).toBe(id);
    });

    it("updates an invoice via POST with InvoiceID", async () => {
      const created = await api("PUT", `${API}/Invoices`, { Invoices: [{ Type: "ACCREC", Status: "DRAFT" }] });
      const id = created.body.Invoices[0].InvoiceID;
      const updated = await api("POST", `${API}/Invoices`, { Invoices: [{ InvoiceID: id, Status: "AUTHORISED" }] });
      expect(updated.body.Invoices[0].Status).toBe("AUTHORISED");
      const list = await api("GET", `${API}/Invoices`);
      expect(list.body.Invoices.length).toBe(1);
    });
  });

  describe("Contacts", () => {
    it("creates and lists contacts", async () => {
      const created = await api("PUT", `${API}/Contacts`, { Contacts: [{ Name: "Jane Co" }] });
      expect(created.body.Contacts[0].ContactID).toBeTruthy();
      expect(created.body.Contacts[0].ContactStatus).toBe("ACTIVE");
      const list = await api("GET", `${API}/Contacts`);
      expect(list.body.Contacts.length).toBe(1);
    });
  });

  describe("Accounts", () => {
    it("creates and lists accounts", async () => {
      const created = await api("PUT", `${API}/Accounts`, { Accounts: [{ Code: "200", Name: "Sales", Type: "REVENUE" }] });
      expect(created.body.Accounts[0].AccountID).toBeTruthy();
      const list = await api("GET", `${API}/Accounts`);
      expect(list.body.Accounts.length).toBe(1);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("PUT", `${API}/Invoices`, { Invoices: [{ Type: "ACCREC" }] });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await api("GET", `${API}/Invoices`);
      expect(list.body.Invoices.length).toBe(0);
    });
  });
});
