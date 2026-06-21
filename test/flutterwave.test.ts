import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FlutterwaveServer } from "../services/flutterwave/src/server.js";

const PORT = 14874;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer FLWSECK_TEST-parlel" };

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

describe("Flutterwave Service", () => {
  let server: FlutterwaveServer;

  beforeAll(async () => {
    server = new FlutterwaveServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named FlutterwaveServer on the right port", () => {
    expect(server.constructor.name).toBe("FlutterwaveServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("flutterwave");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("requires bearer auth", async () => {
    const result = await api("POST", "/v3/payments", { tx_ref: "ref-1", amount: 100 }, {});
    expect(result.status).toBe(401);
  });

  it("initiates a payment and returns a hosted link", async () => {
    const result = await api("POST", "/v3/payments", {
      tx_ref: "ref-123",
      amount: 5000,
      currency: "NGN",
      redirect_url: "https://parlel.dev/cb",
      customer: { email: "buyer@parlel.dev" },
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("success");
    expect(result.body.data.link).toMatch(/^https:\/\/checkout\.flutterwave\.com/);
  });

  it("rejects a payment missing tx_ref/amount", async () => {
    const result = await api("POST", "/v3/payments", { amount: 100 });
    expect(result.status).toBe(400);
    expect(result.body.status).toBe("error");
  });

  it("verifies a transaction by id", async () => {
    const payment = await api("POST", "/v3/payments", { tx_ref: "ref-x", amount: 750, customer: { email: "v@parlel.dev" } });
    expect(payment.status).toBe(200);
    // id is internal; recover it from server state by verifying a known id
    const id = server.transactions.keys().next().value;
    const verify = await api("GET", `/v3/transactions/${id}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe("success");
    expect(verify.body.data.status).toBe("successful");
    expect(verify.body.data.amount).toBe(750);
  });

  it("returns an error verifying an unknown transaction", async () => {
    const verify = await api("GET", "/v3/transactions/999999/verify");
    expect(verify.status).toBe(400);
    expect(verify.body.status).toBe("error");
  });

  it("creates and lists transfers", async () => {
    const created = await api("POST", "/v3/transfers", {
      account_bank: "044",
      account_number: "0690000040",
      amount: 1000,
      currency: "NGN",
      narration: "test",
    });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("success");
    expect(created.body.data.status).toBe("NEW");

    const listed = await api("GET", "/v3/transfers");
    expect(listed.body.data.length).toBe(1);

    const got = await api("GET", `/v3/transfers/${created.body.data.id}`);
    expect(got.status).toBe(200);
    expect(got.body.data.id).toBe(created.body.data.id);
  });

  it("lists banks for a country", async () => {
    const result = await api("GET", "/v3/banks/NG");
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("success");
    expect(Array.isArray(result.body.data)).toBe(true);
    expect(result.body.data.length).toBeGreaterThan(0);
  });
});
