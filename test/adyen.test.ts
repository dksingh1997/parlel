import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AdyenServer } from "../services/adyen/src/server.js";

const PORT = 14869;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { "X-API-Key": "parlel-key" };

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

const MERCHANT = "ParlelECOM";

describe("Adyen Service", () => {
  let server: AdyenServer;

  beforeAll(async () => {
    server = new AdyenServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named AdyenServer on the right port", () => {
    expect(server.constructor.name).toBe("AdyenServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("adyen");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("requires X-API-Key", async () => {
    const result = await api("POST", "/v71/payments", {
      amount: { currency: "EUR", value: 1000 },
      paymentMethod: { type: "scheme" },
      merchantAccount: MERCHANT,
    }, {});
    expect(result.status).toBe(401);
    expect(result.body.errorCode).toBe("000");
    expect(result.body.errorType).toBe("security");
  });

  it("authorises a payment", async () => {
    const result = await api("POST", "/v71/payments", {
      amount: { currency: "EUR", value: 1000 },
      reference: "order-123",
      returnUrl: "https://example.com/return",
      paymentMethod: { type: "scheme", encryptedCardNumber: "test" },
      merchantAccount: MERCHANT,
    });
    expect(result.status).toBe(200);
    expect(result.body.resultCode).toBe("Authorised");
    expect(result.body).toHaveProperty("pspReference");
    expect(result.body.merchantReference).toBe("order-123");
    expect(result.body.amount.value).toBe(1000);
  });

  it("rejects a payment missing required fields", async () => {
    const result = await api("POST", "/v71/payments", { amount: { currency: "EUR", value: 1000 } });
    expect(result.status).toBe(422);
    expect(result.body).toHaveProperty("errorCode");
  });

  it("rejects a payment missing reference", async () => {
    const result = await api("POST", "/v71/payments", {
      amount: { currency: "EUR", value: 1000 },
      paymentMethod: { type: "scheme" },
      merchantAccount: MERCHANT,
      returnUrl: "https://example.com/return",
    });
    expect(result.status).toBe(422);
    expect(result.body.errorCode).toBe("130");
  });

  it("rejects a payment missing returnUrl", async () => {
    const result = await api("POST", "/v71/payments", {
      amount: { currency: "EUR", value: 1000 },
      paymentMethod: { type: "scheme" },
      merchantAccount: MERCHANT,
      reference: "order-123",
    });
    expect(result.status).toBe(422);
    expect(result.body.errorCode).toBe("14_030");
  });

  it("handles payments/details", async () => {
    const result = await api("POST", "/v71/payments/details", {
      details: { redirectResult: "abc" },
      merchantReference: "order-123",
    });
    expect(result.status).toBe(200);
    expect(result.body.resultCode).toBe("Authorised");
  });

  it("lists payment methods", async () => {
    const result = await api("POST", "/v71/paymentMethods", { merchantAccount: MERCHANT, countryCode: "NL" });
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.paymentMethods)).toBe(true);
    expect(result.body.paymentMethods.length).toBeGreaterThan(0);
  });

  it("cancels a payment by pspReference", async () => {
    const payment = await api("POST", "/v71/payments", {
      amount: { currency: "EUR", value: 500 },
      paymentMethod: { type: "scheme" },
      merchantAccount: MERCHANT,
    });
    const psp = payment.body.pspReference;
    const cancel = await api("POST", `/v71/payments/${psp}/cancels`, { merchantAccount: MERCHANT });
    expect(cancel.status).toBe(201);
    expect(cancel.body.paymentPspReference).toBe(psp);
    expect(cancel.body.status).toBe("received");
  });

  it("returns 404 for unknown endpoint", async () => {
    const result = await api("POST", "/v71/nope", { merchantAccount: MERCHANT });
    expect(result.status).toBe(404);
  });

  it("captures a payment", async () => {
    const payment = await api("POST", "/v71/payments", {
      amount: { currency: "EUR", value: 500 },
      reference: "cap-order",
      returnUrl: "https://example.com/return",
      paymentMethod: { type: "scheme" },
      merchantAccount: MERCHANT,
    });
    const psp = payment.body.pspReference;
    const capture = await api("POST", `/v71/payments/${psp}/captures`, {
      amount: { currency: "EUR", value: 500 },
      merchantAccount: MERCHANT,
    });
    expect(capture.status).toBe(201);
    expect(capture.body.paymentPspReference).toBe(psp);
    expect(capture.body.status).toBe("received");
    expect(capture.body.amount.value).toBe(500);
    expect(capture.body.merchantAccount).toBe(MERCHANT);
  });

  it("rejects capture missing amount", async () => {
    const result = await api("POST", "/v71/payments/FAKEPSP/captures", { merchantAccount: MERCHANT });
    expect(result.status).toBe(422);
  });

  it("refunds a payment", async () => {
    const payment = await api("POST", "/v71/payments", {
      amount: { currency: "EUR", value: 500 },
      reference: "ref-order",
      returnUrl: "https://example.com/return",
      paymentMethod: { type: "scheme" },
      merchantAccount: MERCHANT,
    });
    const psp = payment.body.pspReference;
    const refund = await api("POST", `/v71/payments/${psp}/refunds`, {
      amount: { currency: "EUR", value: 500 },
      merchantAccount: MERCHANT,
      merchantRefundReason: "customer request",
    });
    expect(refund.status).toBe(201);
    expect(refund.body.paymentPspReference).toBe(psp);
    expect(refund.body.status).toBe("received");
    expect(refund.body.amount.value).toBe(500);
    expect(refund.body.merchantRefundReason).toBe("customer request");
  });

  it("rejects refund missing amount", async () => {
    const result = await api("POST", "/v71/payments/FAKEPSP/refunds", { merchantAccount: MERCHANT });
    expect(result.status).toBe(422);
  });

  it("rejects cancel missing merchantAccount", async () => {
    const payment = await api("POST", "/v71/payments", {
      amount: { currency: "EUR", value: 500 },
      reference: "cancel-order",
      returnUrl: "https://example.com/return",
      paymentMethod: { type: "scheme" },
      merchantAccount: MERCHANT,
    });
    const psp = payment.body.pspReference;
    const result = await api("POST", `/v71/payments/${psp}/cancels`, {});
    expect(result.status).toBe(422);
  });

  it("rejects malformed JSON", async () => {
    const response = await fetch(`${BASE_URL}/v71/payments`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: "{bad json",
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.errorCode).toBe("702");
    expect(body.errorType).toBe("validation");
  });
});
