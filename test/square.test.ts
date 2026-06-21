import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SquareServer } from "../services/square/src/server.js";

const PORT = 14766;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-square-token" };

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

describe("Square Service", () => {
  let server: SquareServer;

  beforeAll(async () => {
    server = new SquareServer(PORT);
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
      expect(root.body.name).toBe("square");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without bearer", async () => {
      const response = await fetch(`${BASE_URL}/v2/payments`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/v2/payments");
      expect(result.status).toBe(200);
    });
  });

  describe("Payments", () => {
    it("creates a payment wrapped in { payment }", async () => {
      const result = await api("POST", "/v2/payments", {
        idempotency_key: "key-1",
        amount_money: { amount: 1000, currency: "USD" },
        source_id: "cnon:card-nonce-ok",
      });
      expect(result.status).toBe(200);
      expect(result.body.payment.id).toBeTruthy();
      expect(result.body.payment.status).toBe("COMPLETED");
      expect(result.body.payment.amount_money.amount).toBe(1000);
    });

    it("rejects payment without idempotency_key", async () => {
      const result = await api("POST", "/v2/payments", { amount_money: { amount: 1000, currency: "USD" } });
      expect(result.status).toBe(400);
      expect(result.body.errors[0].field).toBe("idempotency_key");
    });

    it("replays the same response for a repeated idempotency_key", async () => {
      const first = await api("POST", "/v2/payments", { idempotency_key: "dup", amount_money: { amount: 500, currency: "USD" } });
      const second = await api("POST", "/v2/payments", { idempotency_key: "dup", amount_money: { amount: 9999, currency: "USD" } });
      expect(second.body.payment.id).toBe(first.body.payment.id);
    });

    it("lists payments wrapped in { payments }", async () => {
      await api("POST", "/v2/payments", { idempotency_key: "a", amount_money: { amount: 100, currency: "USD" } });
      const list = await api("GET", "/v2/payments");
      expect(Array.isArray(list.body.payments)).toBe(true);
      expect(list.body.payments.length).toBe(1);
    });

    it("retrieves a payment by id", async () => {
      const created = await api("POST", "/v2/payments", { idempotency_key: "r", amount_money: { amount: 100, currency: "USD" } });
      const id = created.body.payment.id;
      const got = await api("GET", `/v2/payments/${id}`);
      expect(got.body.payment.id).toBe(id);
    });
  });

  describe("Customers", () => {
    it("creates and lists customers", async () => {
      const created = await api("POST", "/v2/customers", { given_name: "Jane", email_address: "j@parlel.dev" });
      expect(created.body.customer.id).toBeTruthy();
      expect(created.body.customer.given_name).toBe("Jane");
      const list = await api("GET", "/v2/customers");
      expect(list.body.customers.length).toBe(1);
    });

    it("retrieves and updates a customer", async () => {
      const created = await api("POST", "/v2/customers", { given_name: "Jane" });
      const id = created.body.customer.id;
      const got = await api("GET", `/v2/customers/${id}`);
      expect(got.body.customer.id).toBe(id);
      const updated = await api("PUT", `/v2/customers/${id}`, { given_name: "Renamed" });
      expect(updated.body.customer.given_name).toBe("Renamed");
    });
  });

  describe("Orders", () => {
    it("creates an order wrapped in { order }", async () => {
      const result = await api("POST", "/v2/orders", { order: { location_id: "L_PARLEL_MAIN", line_items: [] } });
      expect(result.status).toBe(200);
      expect(result.body.order.id).toBeTruthy();
      expect(result.body.order.state).toBe("OPEN");
    });
  });

  describe("Locations", () => {
    it("lists locations", async () => {
      const result = await api("GET", "/v2/locations");
      expect(result.status).toBe(200);
      expect(result.body.locations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/v2/payments", { idempotency_key: "x", amount_money: { amount: 100, currency: "USD" } });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await api("GET", "/v2/payments");
      expect(list.body.payments.length).toBe(0);
    });
  });
});
