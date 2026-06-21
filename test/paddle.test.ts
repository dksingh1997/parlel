import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PaddleServer } from "../services/paddle/src/server.js";

const PORT = 14765;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer pdl_test_parlel" };

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

describe("Paddle Service", () => {
  let server: PaddleServer;

  beforeAll(async () => {
    server = new PaddleServer(PORT);
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
      expect(root.body.name).toBe("paddle");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without bearer (403)", async () => {
      const response = await fetch(`${BASE_URL}/products`, { method: "GET" });
      expect(response.status).toBe(403);
    });

    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/products");
      expect(result.status).toBe(200);
    });
  });

  describe("Products", () => {
    it("creates a product (201) with data/meta envelope", async () => {
      const result = await api("POST", "/products", { name: "Pro Plan", tax_category: "standard" });
      expect(result.status).toBe(201);
      expect(result.body.data.id).toMatch(/^pro_/);
      expect(result.body.data.name).toBe("Pro Plan");
      expect(result.body.meta.request_id).toBeTruthy();
    });

    it("lists products with pagination meta", async () => {
      await api("POST", "/products", { name: "A" });
      await api("POST", "/products", { name: "B" });
      const list = await api("GET", "/products");
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.data.length).toBe(2);
      expect(list.body.meta.pagination).toBeTruthy();
    });

    it("retrieves and updates a product", async () => {
      const created = await api("POST", "/products", { name: "X" });
      const id = created.body.data.id;
      const got = await api("GET", `/products/${id}`);
      expect(got.body.data.id).toBe(id);
      const updated = await api("PATCH", `/products/${id}`, { name: "Renamed" });
      expect(updated.body.data.name).toBe("Renamed");
    });

    it("returns 404 for unknown product", async () => {
      const got = await api("GET", "/products/pro_nope");
      expect(got.status).toBe(404);
    });
  });

  describe("Prices", () => {
    it("creates a price", async () => {
      const result = await api("POST", "/prices", { product_id: "pro_1", unit_price: { amount: "1000", currency_code: "USD" } });
      expect(result.body.data.id).toMatch(/^pri_/);
    });
  });

  describe("Customers", () => {
    it("creates and lists customers", async () => {
      const created = await api("POST", "/customers", { email: "c@parlel.dev" });
      expect(created.body.data.id).toMatch(/^ctm_/);
      const list = await api("GET", "/customers");
      expect(list.body.data.length).toBe(1);
    });
  });

  describe("Transactions & subscriptions", () => {
    it("creates a transaction", async () => {
      const result = await api("POST", "/transactions", { items: [] });
      expect(result.body.data.id).toMatch(/^txn_/);
    });

    it("creates a subscription", async () => {
      const result = await api("POST", "/subscriptions", { customer_id: "ctm_1" });
      expect(result.body.data.id).toMatch(/^sub_/);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/products", { name: "A" });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await api("GET", "/products");
      expect(list.body.data.length).toBe(0);
    });
  });
});
