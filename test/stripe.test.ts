import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { StripeServer } from "../services/stripe/src/server.js";

const PORT = 14757;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "sk_test_parlelTestKey";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

// Encode an object into Stripe-style x-www-form-urlencoded with bracket notation.
function encodeForm(obj: Json, prefix = ""): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      pairs.push(encodeForm(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === "object") pairs.push(encodeForm(v, `${fullKey}[${i}]`));
        else pairs.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(String(v))}`);
      });
    } else {
      pairs.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return pairs.filter(Boolean).join("&");
}

async function form(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
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

async function get(path: string, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, { method: "GET", headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Stripe Service", () => {
  let server: StripeServer;

  beforeAll(async () => {
    server = new StripeServer(PORT);
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
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("stripe");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/v1/customers`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401 + full error envelope", async () => {
      const response = await fetch(`${BASE_URL}/v1/customers`, { method: "GET" });
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("authentication_required");
      expect(body.error.doc_url).toContain("authentication");
      expect(body.error.message).toContain("API key");
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="Stripe"');
    });

    it("accepts Bearer auth", async () => {
      const result = await form("POST", "/v1/customers", { email: "a@parlel.dev" });
      expect(result.status).toBe(200);
    });
  });

  describe("Customers", () => {
    it("creates a customer with form encoding incl. bracket metadata", async () => {
      const result = await form("POST", "/v1/customers", {
        email: "jane@parlel.dev",
        name: "Jane",
        metadata: { plan: "pro", level: "3" },
      });
      expect(result.status).toBe(200);
      expect(result.body.id).toMatch(/^cus_/);
      expect(result.body.object).toBe("customer");
      expect(result.body.livemode).toBe(false);
      expect(result.body.email).toBe("jane@parlel.dev");
      expect(result.body.metadata).toEqual({ plan: "pro", level: "3" });
      // Always-present fields the real Customer object returns.
      expect(result.body.balance).toBe(0);
      expect(result.body.delinquent).toBe(false);
      expect(result.body.tax_exempt).toBe("none");
      expect(result.body.default_source).toBeNull();
      expect(result.body.invoice_settings).toMatchObject({ default_payment_method: null });
    });

    it("retrieves a customer", async () => {
      const created = await form("POST", "/v1/customers", { email: "x@parlel.dev" });
      const got = await get(`/v1/customers/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(created.body.id);
    });

    it("updates a customer", async () => {
      const created = await form("POST", "/v1/customers", { email: "x@parlel.dev" });
      const updated = await form("POST", `/v1/customers/${created.body.id}`, { name: "Renamed" });
      expect(updated.body.name).toBe("Renamed");
    });

    it("lists customers with list shape", async () => {
      await form("POST", "/v1/customers", { email: "a@parlel.dev" });
      await form("POST", "/v1/customers", { email: "b@parlel.dev" });
      const list = await get("/v1/customers");
      expect(list.body.object).toBe("list");
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.data.length).toBe(2);
      expect(list.body.url).toBe("/v1/customers");
      expect(list.body).toHaveProperty("has_more");
    });

    it("deletes a customer", async () => {
      const created = await form("POST", "/v1/customers", { email: "x@parlel.dev" });
      const deleted = await form("DELETE", `/v1/customers/${created.body.id}`);
      expect(deleted.body.deleted).toBe(true);
      const gone = await get(`/v1/customers/${created.body.id}`);
      expect(gone.status).toBe(404);
    });

    it("returns 404 with error envelope for unknown customer", async () => {
      const got = await get("/v1/customers/cus_nope");
      expect(got.status).toBe(404);
      expect(got.body.error.code).toBe("resource_missing");
      expect(got.body.error.param).toBe("id");
      expect(got.body.error.type).toBe("invalid_request_error");
    });

    it("honors limit + has_more cursor pagination semantics", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const c = await form("POST", "/v1/customers", { email: `p${i}@parlel.dev` });
        ids.push(c.body.id);
      }
      const page1 = await get("/v1/customers?limit=2");
      expect(page1.body.data.length).toBe(2);
      expect(page1.body.has_more).toBe(true);
      expect(page1.body.data[0].id).toBe(ids[0]);
      expect(page1.body.data[1].id).toBe(ids[1]);

      const page2 = await get(`/v1/customers?limit=2&starting_after=${ids[1]}`);
      expect(page2.body.data.length).toBe(2);
      expect(page2.body.data[0].id).toBe(ids[2]);
      expect(page2.body.has_more).toBe(true);

      const page3 = await get(`/v1/customers?limit=2&starting_after=${ids[3]}`);
      expect(page3.body.data.length).toBe(1);
      expect(page3.body.data[0].id).toBe(ids[4]);
      expect(page3.body.has_more).toBe(false);
    });

    it("paginates backwards with ending_before", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const c = await form("POST", "/v1/customers", { email: `e${i}@parlel.dev` });
        ids.push(c.body.id);
      }
      const page = await get(`/v1/customers?limit=2&ending_before=${ids[3]}`);
      expect(page.body.data.map((c: Json) => c.id)).toEqual([ids[1], ids[2]]);
      expect(page.body.has_more).toBe(true);
    });
  });

  describe("Charges", () => {
    it("creates and reads a charge", async () => {
      const created = await form("POST", "/v1/charges", { amount: 2000, currency: "usd" });
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(/^ch_/);
      expect(created.body.amount).toBe(2000);
      expect(created.body.status).toBe("succeeded");
      // Always-present fields on the real Charge object.
      expect(created.body).toHaveProperty("receipt_url", null);
      expect(created.body).toHaveProperty("balance_transaction", null);
      expect(created.body).toHaveProperty("payment_method_details", null);
      expect(created.body.billing_details).toBeDefined();
      const got = await get(`/v1/charges/${created.body.id}`);
      expect(got.body.id).toBe(created.body.id);
    });

    it("lists charges", async () => {
      await form("POST", "/v1/charges", { amount: 100 });
      const list = await get("/v1/charges");
      expect(list.body.object).toBe("list");
    });
  });

  describe("Payment intents", () => {
    it("creates a payment intent", async () => {
      const created = await form("POST", "/v1/payment_intents", { amount: 5000, currency: "usd" });
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(/^pi_/);
      expect(created.body.client_secret).toContain("_secret_");
      // Real Stripe default for an automatic-confirmation intent with no payment
      // method attached. https://docs.stripe.com/api/payment_intents/object
      expect(created.body.status).toBe("requires_payment_method");
      expect(created.body.amount_received).toBe(0);
      expect(created.body.amount_capturable).toBe(0);
      expect(created.body.capture_method).toBe("automatic");
      expect(created.body.confirmation_method).toBe("automatic");
      expect(created.body.payment_method_types).toEqual(["card"]);
    });

    it("confirms with confirm=true at create time → succeeded", async () => {
      const created = await form("POST", "/v1/payment_intents", { amount: 5000, confirm: "true" });
      expect(created.body.status).toBe("succeeded");
      expect(created.body.amount_received).toBe(5000);
    });

    it("supports the manual-capture flow", async () => {
      const created = await form("POST", "/v1/payment_intents", { amount: 7000, capture_method: "manual" });
      expect(created.body.capture_method).toBe("manual");
      const confirmed = await form("POST", `/v1/payment_intents/${created.body.id}/confirm`, {
        payment_method: "pm_card_visa",
      });
      expect(confirmed.body.status).toBe("requires_capture");
      expect(confirmed.body.amount_capturable).toBe(7000);
      const captured = await form("POST", `/v1/payment_intents/${created.body.id}/capture`, {});
      expect(captured.status).toBe(200);
      expect(captured.body.status).toBe("succeeded");
      expect(captured.body.amount_received).toBe(7000);
      expect(captured.body.amount_capturable).toBe(0);
    });

    it("cancels a payment intent with reason + canceled_at", async () => {
      const created = await form("POST", "/v1/payment_intents", { amount: 1000 });
      const canceled = await form("POST", `/v1/payment_intents/${created.body.id}/cancel`, {
        cancellation_reason: "requested_by_customer",
      });
      expect(canceled.body.status).toBe("canceled");
      expect(canceled.body.cancellation_reason).toBe("requested_by_customer");
      expect(typeof canceled.body.canceled_at).toBe("number");
    });

    it("rejects payment intent without amount", async () => {
      const result = await form("POST", "/v1/payment_intents", { currency: "usd" });
      expect(result.status).toBe(400);
      expect(result.body.error.param).toBe("amount");
    });

    it("confirms a payment intent", async () => {
      const created = await form("POST", "/v1/payment_intents", { amount: 5000 });
      const confirmed = await form("POST", `/v1/payment_intents/${created.body.id}/confirm`, { payment_method: "pm_card_visa" });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.status).toBe("succeeded");
    });

    it("retrieves and lists payment intents", async () => {
      const created = await form("POST", "/v1/payment_intents", { amount: 1000 });
      const got = await get(`/v1/payment_intents/${created.body.id}`);
      expect(got.body.id).toBe(created.body.id);
      const list = await get("/v1/payment_intents");
      expect(list.body.object).toBe("list");
    });
  });

  describe("Refunds", () => {
    it("creates a refund tied to a charge", async () => {
      const charge = await form("POST", "/v1/charges", { amount: 3000, currency: "usd" });
      const refund = await form("POST", "/v1/refunds", { charge: charge.body.id });
      expect(refund.status).toBe(200);
      expect(refund.body.id).toMatch(/^re_/);
      expect(refund.body.amount).toBe(3000);
      const got = await get(`/v1/charges/${charge.body.id}`);
      expect(got.body.refunded).toBe(true);
      expect(refund.body.balance_transaction).toBeNull();
      expect(refund.body.receipt_number).toBeNull();
    });

    it("updates a refund's metadata", async () => {
      const charge = await form("POST", "/v1/charges", { amount: 1000 });
      const refund = await form("POST", "/v1/refunds", { charge: charge.body.id });
      const updated = await form("POST", `/v1/refunds/${refund.body.id}`, {
        metadata: { note: "duplicate" },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.metadata).toEqual({ note: "duplicate" });
    });
  });

  describe("Products & prices", () => {
    it("creates, reads, lists products", async () => {
      const created = await form("POST", "/v1/products", { name: "Gold Plan" });
      expect(created.body.id).toMatch(/^prod_/);
      const got = await get(`/v1/products/${created.body.id}`);
      expect(got.body.name).toBe("Gold Plan");
      const list = await get("/v1/products");
      expect(list.body.object).toBe("list");
    });

    it("rejects product without name", async () => {
      const result = await form("POST", "/v1/products", {});
      expect(result.status).toBe(400);
    });

    it("creates a price linked to a product", async () => {
      const product = await form("POST", "/v1/products", { name: "Gold" });
      const price = await form("POST", "/v1/prices", { product: product.body.id, unit_amount: 1500, currency: "usd" });
      expect(price.body.id).toMatch(/^price_/);
      expect(price.body.unit_amount).toBe(1500);
      expect(price.body.billing_scheme).toBe("per_unit");
      expect(price.body.type).toBe("one_time");
      const list = await get("/v1/prices");
      expect(list.body.object).toBe("list");
    });

    it("marks a recurring price as type=recurring", async () => {
      const product = await form("POST", "/v1/products", { name: "Sub" });
      const price = await form("POST", "/v1/prices", {
        product: product.body.id,
        unit_amount: 999,
        currency: "usd",
        recurring: { interval: "month" },
      });
      expect(price.body.type).toBe("recurring");
      expect(price.body.recurring).toEqual({ interval: "month" });
    });

    it("rejects a price missing required params (currency/product/unit_amount)", async () => {
      const noCurrency = await form("POST", "/v1/prices", { product: "prod_x", unit_amount: 100 });
      expect(noCurrency.status).toBe(400);
      expect(noCurrency.body.error.code).toBe("parameter_missing");
      expect(noCurrency.body.error.param).toBe("currency");

      const noProduct = await form("POST", "/v1/prices", { currency: "usd", unit_amount: 100 });
      expect(noProduct.status).toBe(400);
      expect(noProduct.body.error.param).toBe("product");

      const noAmount = await form("POST", "/v1/prices", { currency: "usd", product: "prod_x" });
      expect(noAmount.status).toBe(400);
      expect(noAmount.body.error.param).toBe("unit_amount");
    });
  });

  describe("Balance", () => {
    it("returns the balance object", async () => {
      const result = await get("/v1/balance");
      expect(result.status).toBe(200);
      expect(result.body.object).toBe("balance");
      expect(Array.isArray(result.body.available)).toBe(true);
    });
  });

  describe("Checkout sessions", () => {
    it("creates and retrieves a checkout session", async () => {
      const created = await form("POST", "/v1/checkout/sessions", {
        mode: "payment",
        success_url: "https://parlel.dev/ok",
        cancel_url: "https://parlel.dev/no",
      });
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(/^cs_/);
      expect(created.body.object).toBe("checkout.session");
      expect(created.body.url).toContain("checkout.stripe.com");
      const got = await get(`/v1/checkout/sessions/${created.body.id}`);
      expect(got.body.id).toBe(created.body.id);
      const list = await get("/v1/checkout/sessions");
      expect(list.body.object).toBe("list");
    });
  });

  describe("Routing & error shapes", () => {
    it("returns 404 (not 405) for an unsupported method on a collection, matching real Stripe", async () => {
      const result = await form("DELETE", "/v1/charges", {});
      expect(result.status).toBe(404);
      expect(result.body.error.type).toBe("invalid_request_error");
    });

    it("returns 404 for an unknown endpoint", async () => {
      const result = await get("/v1/nonexistent");
      expect(result.status).toBe(404);
      expect(result.body.error.message).toContain("Unrecognized request URL");
    });
  });

  describe("Control endpoints", () => {
    it("resets state via /__parlel/reset", async () => {
      await form("POST", "/v1/customers", { email: "a@parlel.dev" });
      const reset = await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      expect(reset.status).toBe(200);
      const list = await get("/v1/customers");
      expect(list.body.data.length).toBe(0);
    });
  });
});
