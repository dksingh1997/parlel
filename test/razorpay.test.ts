import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { RazorpayServer } from "../services/razorpay/src/server.js";

const PORT = 14761;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = "Basic " + Buffer.from("rzp_test_parlel:parlel_secret").toString("base64");
const AUTH = { Authorization: BASIC };

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

describe("Razorpay Service", () => {
  let server: RazorpayServer;

  beforeAll(async () => {
    server = new RazorpayServer(PORT);
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
      expect(root.body.name).toBe("razorpay");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without basic auth", async () => {
      const response = await fetch(`${BASE_URL}/v1/orders`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth", async () => {
      const result = await api("GET", "/v1/orders");
      expect(result.status).toBe(200);
    });
  });

  describe("Orders", () => {
    it("creates an order with order_ id", async () => {
      const result = await api("POST", "/v1/orders", { amount: 50000, currency: "INR", receipt: "rcpt#1" });
      expect(result.status).toBe(200);
      expect(result.body.id).toMatch(/^order_/);
      expect(result.body.entity).toBe("order");
      expect(result.body.amount).toBe(50000);
      expect(result.body.status).toBe("created");
    });

    it("rejects order without amount", async () => {
      const result = await api("POST", "/v1/orders", { currency: "INR" });
      expect(result.status).toBe(400);
      expect(result.body.error.field).toBe("amount");
    });

    it("retrieves and lists orders", async () => {
      const created = await api("POST", "/v1/orders", { amount: 100 });
      const got = await api("GET", `/v1/orders/${created.body.id}`);
      expect(got.body.id).toBe(created.body.id);
      const list = await api("GET", "/v1/orders");
      expect(list.body.entity).toBe("collection");
      expect(list.body.count).toBe(1);
    });
  });

  describe("Payments", () => {
    it("creates a payment with pay_ id", async () => {
      const result = await api("POST", "/v1/payments", { amount: 1000, currency: "INR" });
      expect(result.status).toBe(200);
      expect(result.body.id).toMatch(/^pay_/);
      expect(result.body.status).toBe("captured");
    });

    it("captures a payment", async () => {
      const created = await api("POST", "/v1/payments", { amount: 1000 });
      const captured = await api("POST", `/v1/payments/${created.body.id}/capture`, { amount: 1000, currency: "INR" });
      expect(captured.status).toBe(200);
      expect(captured.body.captured).toBe(true);
    });

    it("lists payments", async () => {
      await api("POST", "/v1/payments", { amount: 1000 });
      const list = await api("GET", "/v1/payments");
      expect(list.body.count).toBe(1);
    });
  });

  describe("Refunds", () => {
    it("creates a refund tied to a payment", async () => {
      const payment = await api("POST", "/v1/payments", { amount: 1000 });
      const refund = await api("POST", "/v1/refunds", { payment_id: payment.body.id });
      expect(refund.status).toBe(200);
      expect(refund.body.id).toMatch(/^rfnd_/);
      expect(refund.body.amount).toBe(1000);
    });
  });

  describe("Customers", () => {
    it("creates and lists customers", async () => {
      const created = await api("POST", "/v1/customers", { name: "Jane", email: "j@parlel.dev" });
      expect(created.body.id).toMatch(/^cust_/);
      const list = await api("GET", "/v1/customers");
      expect(list.body.count).toBe(1);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/v1/orders", { amount: 100 });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await api("GET", "/v1/orders");
      expect(list.body.count).toBe(0);
    });
  });
});
