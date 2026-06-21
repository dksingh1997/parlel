import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GocardlessServer } from "../services/gocardless/src/server.js";

const PORT = 14871;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-token", "GoCardless-Version": "2015-07-06" };

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

describe("GoCardless Service", () => {
  let server: GocardlessServer;

  beforeAll(async () => {
    server = new GocardlessServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named GocardlessServer on the right port", () => {
    expect(server.constructor.name).toBe("GocardlessServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("gocardless");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("requires bearer auth", async () => {
    const result = await api("GET", "/customers", undefined, {});
    expect(result.status).toBe(401);
  });

  it("creates, lists and retrieves a customer with wrapped shapes", async () => {
    const created = await api("POST", "/customers", {
      customers: { email: "jane@parlel.dev", given_name: "Jane", family_name: "Doe", country_code: "GB" },
    });
    expect(created.status).toBe(201);
    expect(created.body.customers.id).toMatch(/^CU/);
    expect(created.body.customers.email).toBe("jane@parlel.dev");
    const id = created.body.customers.id;

    const listed = await api("GET", "/customers");
    expect(Array.isArray(listed.body.customers)).toBe(true);
    expect(listed.body.customers.length).toBe(1);
    expect(listed.body.meta.cursors).toHaveProperty("before");
    expect(listed.body.meta.cursors).toHaveProperty("after");
    expect(listed.body.meta).toHaveProperty("limit");

    const got = await api("GET", `/customers/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.customers.id).toBe(id);

    const updated = await api("PUT", `/customers/${id}`, { customers: { email: "new@parlel.dev" } });
    expect(updated.body.customers.email).toBe("new@parlel.dev");
  });

  it("creates a mandate", async () => {
    const result = await api("POST", "/mandates", { mandates: { scheme: "bacs", links: { customer_bank_account: "BA123" } } });
    expect(result.status).toBe(201);
    expect(result.body.mandates.id).toMatch(/^MD/);
    expect(result.body.mandates.status).toBeTruthy();
  });

  it("creates, lists and retrieves a payment", async () => {
    const created = await api("POST", "/payments", {
      payments: { amount: 1000, currency: "GBP", description: "Invoice", links: { mandate: "MD123" } },
    });
    expect(created.status).toBe(201);
    expect(created.body.payments.id).toMatch(/^PM/);
    expect(created.body.payments.amount).toBe(1000);

    const listed = await api("GET", "/payments");
    expect(listed.body.payments.length).toBe(1);

    const got = await api("GET", `/payments/${created.body.payments.id}`);
    expect(got.body.payments.id).toBe(created.body.payments.id);
  });

  it("rejects a payment missing amount/currency", async () => {
    const result = await api("POST", "/payments", { payments: { description: "x" } });
    expect(result.status).toBe(422);
  });

  it("lists creditors", async () => {
    const result = await api("GET", "/creditors");
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.creditors)).toBe(true);
    expect(result.body.creditors.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 404 for unknown customer", async () => {
    const result = await api("GET", "/customers/CU-missing");
    expect(result.status).toBe(404);
  });
});
