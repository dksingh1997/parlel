import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FreshbooksServer } from "../services/freshbooks/src/server.js";

const PORT = 14872;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-token" };
const ACCT = "parlelAcct";

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("FreshBooks Service", () => {
  let server: FreshbooksServer;

  beforeAll(async () => {
    server = new FreshbooksServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named FreshbooksServer on the right port", () => {
    expect(server.constructor.name).toBe("FreshbooksServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("freshbooks");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("requires bearer auth", async () => {
    const result = await api("GET", `/accounting/account/${ACCT}/users/clients`, undefined, {});
    expect(result.status).toBe(401);
  });

  it("returns the authenticated user via /auth/api/v1/users/me", async () => {
    const result = await api("GET", "/auth/api/v1/users/me");
    expect(result.status).toBe(200);
    expect(result.body.response.email).toBe("owner@parlel.dev");
    expect(result.body.response.business_memberships.length).toBeGreaterThan(0);
  });

  it("creates, lists and retrieves a client with the nested shape", async () => {
    const created = await api("POST", `/accounting/account/${ACCT}/users/clients`, {
      client: { fname: "Jane", lname: "Doe", email: "jane@parlel.dev", organization: "Parlel" },
    });
    expect(created.status).toBe(200);
    expect(created.body.response.result.client).toBeTruthy();
    expect(created.body.response.result.client.email).toBe("jane@parlel.dev");
    const id = created.body.response.result.client.id;

    const listed = await api("GET", `/accounting/account/${ACCT}/users/clients`);
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.response.result.clients)).toBe(true);
    expect(listed.body.response.result.clients.length).toBe(1);
    expect(listed.body.response.result.total).toBe(1);

    const got = await api("GET", `/accounting/account/${ACCT}/users/clients/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.response.result.client.id).toBe(id);

    const updated = await api("PUT", `/accounting/account/${ACCT}/users/clients/${id}`, { client: { fname: "Janet" } });
    expect(updated.body.response.result.client.fname).toBe("Janet");
  });

  it("rejects a client with no identifying fields", async () => {
    const result = await api("POST", `/accounting/account/${ACCT}/users/clients`, { client: {} });
    expect(result.status).toBe(422);
    expect(Array.isArray(result.body.response.errors)).toBe(true);
  });

  it("creates and lists invoices", async () => {
    const client = await api("POST", `/accounting/account/${ACCT}/users/clients`, { client: { email: "c@parlel.dev" } });
    const customerid = client.body.response.result.client.id;
    const created = await api("POST", `/accounting/account/${ACCT}/invoices/invoices`, {
      invoice: { customerid, currency_code: "USD", lines: [{ name: "Work", unit_cost: { amount: "100" }, qty: 1 }] },
    });
    expect(created.status).toBe(200);
    expect(created.body.response.result.invoice.customerid).toBe(customerid);

    const listed = await api("GET", `/accounting/account/${ACCT}/invoices/invoices`);
    expect(listed.body.response.result.invoices.length).toBe(1);
  });

  it("returns 404 for unknown client", async () => {
    const result = await api("GET", `/accounting/account/${ACCT}/users/clients/999999`);
    expect(result.status).toBe(404);
  });
});
