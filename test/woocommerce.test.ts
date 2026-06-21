import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WoocommerceServer } from "../services/woocommerce/src/server.js";

const PORT = 14759;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `/wp-json/wc/v3`;
const BASIC = "Basic " + Buffer.from("ck_parlel:cs_parlel").toString("base64");
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

describe("WooCommerce Service", () => {
  let server: WoocommerceServer;

  beforeAll(async () => {
    server = new WoocommerceServer(PORT);
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
      expect(root.body.name).toBe("woocommerce");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without credentials", async () => {
      const response = await fetch(`${BASE_URL}${API}/products`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth", async () => {
      const result = await api("GET", `${API}/products`);
      expect(result.status).toBe(200);
    });

    it("accepts query-param consumer key/secret", async () => {
      const response = await fetch(`${BASE_URL}${API}/products?consumer_key=ck_parlel&consumer_secret=cs_parlel`, { method: "GET" });
      expect(response.status).toBe(200);
    });
  });

  describe("Products", () => {
    it("creates a product (201) and lists it", async () => {
      const created = await api("POST", `${API}/products`, { name: "Beanie", regular_price: "9.99" });
      expect(created.status).toBe(201);
      expect(created.body.id).toBeTruthy();
      expect(created.body.name).toBe("Beanie");
      const list = await api("GET", `${API}/products`);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body.length).toBe(1);
    });

    it("retrieves, updates and deletes a product", async () => {
      const created = await api("POST", `${API}/products`, { name: "X" });
      const id = created.body.id;
      const got = await api("GET", `${API}/products/${id}`);
      expect(got.body.id).toBe(id);
      const updated = await api("PUT", `${API}/products/${id}`, { name: "Renamed" });
      expect(updated.body.name).toBe("Renamed");
      const deleted = await api("DELETE", `${API}/products/${id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `${API}/products/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Orders", () => {
    it("creates and lists orders with default status", async () => {
      const created = await api("POST", `${API}/orders`, { payment_method: "cod" });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("pending");
      const list = await api("GET", `${API}/orders`);
      expect(list.body.length).toBe(1);
    });
  });

  describe("Customers", () => {
    it("creates and lists customers", async () => {
      const created = await api("POST", `${API}/customers`, { email: "c@parlel.dev", first_name: "Jane" });
      expect(created.status).toBe(201);
      expect(created.body.email).toBe("c@parlel.dev");
      const list = await api("GET", `${API}/customers`);
      expect(list.body.length).toBe(1);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", `${API}/products`, { name: "A" });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await api("GET", `${API}/products`);
      expect(list.body.length).toBe(0);
    });
  });
});
