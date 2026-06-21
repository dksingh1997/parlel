import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PaypalServer } from "../services/paypal/src/server.js";

const PORT = 14760;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = "Basic " + Buffer.from("parlel-client:parlel-secret").toString("base64");

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = {}) {
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

async function getToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: BASIC, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const json = await res.json();
  return json.access_token;
}

describe("PayPal Service", () => {
  let server: PaypalServer;
  let bearer: Json;

  beforeAll(async () => {
    server = new PaypalServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
    bearer = { Authorization: `Bearer ${await getToken()}` };
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
      expect(root.body.name).toBe("paypal");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("OAuth token", () => {
    it("returns an access_token with Basic auth", async () => {
      const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: BASIC, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.access_token).toBeTruthy();
      expect(json.token_type).toBe("Bearer");
    });

    it("rejects token without Basic auth", async () => {
      const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("Authentication", () => {
    it("rejects order create without bearer", async () => {
      const result = await api("POST", "/v2/checkout/orders", { intent: "CAPTURE" });
      expect(result.status).toBe(401);
    });
  });

  describe("Orders v2", () => {
    it("creates an order with CREATED status", async () => {
      const result = await api("POST", "/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }],
      }, bearer);
      expect(result.status).toBe(201);
      expect(result.body.id).toBeTruthy();
      expect(result.body.status).toBe("CREATED");
      expect(Array.isArray(result.body.links)).toBe(true);
    });

    it("retrieves an order", async () => {
      const created = await api("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [] }, bearer);
      const got = await api("GET", `/v2/checkout/orders/${created.body.id}`, undefined, bearer);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(created.body.id);
    });

    it("captures an order -> COMPLETED with capture record", async () => {
      const created = await api("POST", "/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "25.00" } }],
      }, bearer);
      const captured = await api("POST", `/v2/checkout/orders/${created.body.id}/capture`, {}, bearer);
      expect(captured.status).toBe(201);
      expect(captured.body.status).toBe("COMPLETED");
      const capture = captured.body.purchase_units[0].payments.captures[0];
      expect(capture.status).toBe("COMPLETED");
    });

    it("returns 404 for unknown order", async () => {
      const got = await api("GET", "/v2/checkout/orders/NOPE", undefined, bearer);
      expect(got.status).toBe(404);
    });
  });

  describe("Payments v2", () => {
    it("creates a payment record", async () => {
      const result = await api("POST", "/v2/payments", { amount: { currency_code: "USD", value: "5.00" } }, bearer);
      expect(result.status).toBe(201);
      expect(result.body.id).toBeTruthy();
      expect(result.body.status).toBe("COMPLETED");
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      const created = await api("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [] }, bearer);
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const got = await api("GET", `/v2/checkout/orders/${created.body.id}`, undefined, bearer);
      expect(got.status).toBe(404);
    });
  });
});
