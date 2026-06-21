import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ChargebeeServer } from "../services/chargebee/src/server.js";

const PORT = 14764;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `/api/v2`;
const BASIC = "Basic " + Buffer.from("test_parlel:").toString("base64");
const AUTH = { Authorization: BASIC };

type Json = Record<string, any>;

// Chargebee accepts x-www-form-urlencoded with bracket notation.
function encodeForm(obj: Json): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        pairs.push(`${encodeURIComponent(`${key}[${k}]`)}=${encodeURIComponent(String(v))}`);
      }
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return pairs.join("&");
}

async function form(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body !== undefined ? encodeForm(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

async function get(path: string, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, { method: "GET", headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Chargebee Service", () => {
  let server: ChargebeeServer;

  beforeAll(async () => {
    server = new ChargebeeServer(PORT);
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
      const root = await get("/");
      const health = await get("/health");
      expect(root.body.name).toBe("chargebee");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without basic auth", async () => {
      const response = await fetch(`${BASE_URL}${API}/customers`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth (api key as username)", async () => {
      const result = await get(`${API}/customers`);
      expect(result.status).toBe(200);
    });
  });

  describe("Customers", () => {
    it("creates a customer wrapped in { customer }", async () => {
      const result = await form("POST", `${API}/customers`, { first_name: "Jane", email: "jane@parlel.dev" });
      expect(result.status).toBe(200);
      expect(result.body.customer.id).toMatch(/^cust_/);
      expect(result.body.customer.email).toBe("jane@parlel.dev");
      expect(result.body.customer.object).toBe("customer");
    });

    it("lists customers wrapped in { list: [{ customer }] }", async () => {
      await form("POST", `${API}/customers`, { email: "a@parlel.dev" });
      await form("POST", `${API}/customers`, { email: "b@parlel.dev" });
      const list = await get(`${API}/customers`);
      expect(Array.isArray(list.body.list)).toBe(true);
      expect(list.body.list.length).toBe(2);
      expect(list.body.list[0].customer).toBeTruthy();
    });

    it("retrieves and updates a customer", async () => {
      const created = await form("POST", `${API}/customers`, { email: "x@parlel.dev" });
      const id = created.body.customer.id;
      const got = await get(`${API}/customers/${id}`);
      expect(got.body.customer.id).toBe(id);
      const updated = await form("POST", `${API}/customers/${id}`, { first_name: "Renamed" });
      expect(updated.body.customer.first_name).toBe("Renamed");
    });

    it("returns 404 for unknown customer", async () => {
      const got = await get(`${API}/customers/nope`);
      expect(got.status).toBe(404);
      expect(got.body.api_error_code).toBe("resource_not_found");
    });
  });

  describe("Subscriptions", () => {
    it("creates a subscription with bracket notation and default status", async () => {
      const result = await form("POST", `${API}/subscriptions`, { subscription: { plan_id: "basic" } });
      expect(result.status).toBe(200);
      expect(result.body.subscription.id).toMatch(/^sub_/);
      expect(result.body.subscription.plan_id).toBe("basic");
      expect(result.body.subscription.status).toBe("active");
    });

    it("cancels a subscription", async () => {
      const created = await form("POST", `${API}/subscriptions`, { subscription: { plan_id: "basic" } });
      const id = created.body.subscription.id;
      const cancelled = await form("POST", `${API}/subscriptions/${id}/cancel`, {});
      expect(cancelled.body.subscription.status).toBe("cancelled");
    });
  });

  describe("Plans & invoices", () => {
    it("creates a plan", async () => {
      const result = await form("POST", `${API}/plans`, { id: "basic", name: "Basic", price: 1000 });
      expect(result.body.plan.id).toBe("basic");
    });

    it("creates an invoice with default status", async () => {
      const result = await form("POST", `${API}/invoices`, { customer_id: "cust_1" });
      expect(result.body.invoice.id).toMatch(/^inv_/);
      expect(result.body.invoice.status).toBe("paid");
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await form("POST", `${API}/customers`, { email: "a@parlel.dev" });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await get(`${API}/customers`);
      expect(list.body.list.length).toBe(0);
    });
  });
});
