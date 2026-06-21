import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { QuickbooksServer } from "../services/quickbooks/src/server.js";

const PORT = 14762;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REALM = "parlel-realm";
const AUTH = { Authorization: "Bearer parlel-qbo-token" };

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

describe("QuickBooks Service", () => {
  let server: QuickbooksServer;

  beforeAll(async () => {
    server = new QuickbooksServer(PORT);
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
      expect(root.body.name).toBe("quickbooks");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without bearer", async () => {
      const response = await fetch(`${BASE_URL}/v3/company/${REALM}/customer/1`, { method: "GET" });
      expect(response.status).toBe(401);
    });
  });

  describe("Customer", () => {
    it("creates a customer wrapped in { Customer }", async () => {
      const result = await api("POST", `/v3/company/${REALM}/customer`, { DisplayName: "Jane Co" });
      expect(result.status).toBe(200);
      expect(result.body.Customer.Id).toBeTruthy();
      expect(result.body.Customer.DisplayName).toBe("Jane Co");
      expect(result.body.Customer.SyncToken).toBe("0");
    });

    it("retrieves a customer by id", async () => {
      const created = await api("POST", `/v3/company/${REALM}/customer`, { DisplayName: "Jane Co" });
      const id = created.body.Customer.Id;
      const got = await api("GET", `/v3/company/${REALM}/customer/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.Customer.Id).toBe(id);
    });

    it("updates a customer via sparse POST with Id", async () => {
      const created = await api("POST", `/v3/company/${REALM}/customer`, { DisplayName: "Jane Co" });
      const id = created.body.Customer.Id;
      const updated = await api("POST", `/v3/company/${REALM}/customer`, { Id: id, DisplayName: "Renamed" });
      expect(updated.body.Customer.DisplayName).toBe("Renamed");
      expect(updated.body.Customer.SyncToken).toBe("1");
    });

    it("returns Fault 404 for unknown customer", async () => {
      const got = await api("GET", `/v3/company/${REALM}/customer/999`);
      expect(got.status).toBe(404);
      expect(got.body.Fault).toBeTruthy();
    });
  });

  describe("Invoice", () => {
    it("creates an invoice with default DocNumber", async () => {
      const result = await api("POST", `/v3/company/${REALM}/invoice`, { CustomerRef: { value: "1" }, TotalAmt: 100 });
      expect(result.status).toBe(200);
      expect(result.body.Invoice.Id).toBeTruthy();
      expect(result.body.Invoice.DocNumber).toMatch(/^INV-/);
    });
  });

  describe("Query", () => {
    it("queries customers via GET ?query=", async () => {
      await api("POST", `/v3/company/${REALM}/customer`, { DisplayName: "A" });
      await api("POST", `/v3/company/${REALM}/customer`, { DisplayName: "B" });
      const result = await api("GET", `/v3/company/${REALM}/query?query=${encodeURIComponent("select * from Customer")}`);
      expect(result.status).toBe(200);
      expect(result.body.QueryResponse.Customer.length).toBe(2);
      expect(result.body.QueryResponse.maxResults).toBe(2);
    });

    it("queries invoices via POST raw body", async () => {
      await api("POST", `/v3/company/${REALM}/invoice`, { TotalAmt: 5 });
      const response = await fetch(`${BASE_URL}/v3/company/${REALM}/query`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/text" },
        body: "select * from Invoice",
      });
      const json = await response.json();
      expect(response.status).toBe(200);
      expect(json.QueryResponse.Invoice.length).toBe(1);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", `/v3/company/${REALM}/customer`, { DisplayName: "A" });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const result = await api("GET", `/v3/company/${REALM}/query?query=${encodeURIComponent("select * from Customer")}`);
      expect(result.body.QueryResponse.maxResults).toBe(0);
    });
  });
});
