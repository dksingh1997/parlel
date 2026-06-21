import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WiseServer } from "../services/wise/src/server.js";

const PORT = 14867;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-token" };

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

describe("Wise Service", () => {
  let server: WiseServer;

  beforeAll(async () => {
    server = new WiseServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named WiseServer on the right port", () => {
    expect(server.constructor.name).toBe("WiseServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("wise");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("requires bearer auth", async () => {
    const result = await api("GET", "/v1/profiles", undefined, {});
    expect(result.status).toBe(401);
  });

  it("lists profiles", async () => {
    const result = await api("GET", "/v1/profiles");
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body)).toBe(true);
    expect(result.body[0]).toHaveProperty("id");
    expect(result.body[0]).toHaveProperty("type");
  });

  it("creates and retrieves a quote", async () => {
    const created = await api("POST", "/v1/quotes", { profile: 1, source: "USD", target: "EUR", sourceAmount: 100 });
    expect(created.status).toBe(200);
    expect(created.body).toHaveProperty("id");
    expect(created.body.source).toBe("USD");
    expect(created.body.target).toBe("EUR");
    expect(created.body).toHaveProperty("rate");
    expect(created.body).toHaveProperty("sourceAmount");
    expect(created.body).toHaveProperty("targetAmount");

    const fetched = await api("GET", `/v1/quotes/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);
  });

  it("rejects a quote missing source/target", async () => {
    const result = await api("POST", "/v1/quotes", { sourceAmount: 100 });
    expect(result.status).toBe(400);
  });

  it("creates and retrieves a transfer", async () => {
    const quote = await api("POST", "/v1/quotes", { profile: 1, source: "USD", target: "EUR", sourceAmount: 100 });
    const created = await api("POST", "/v1/transfers", {
      targetAccount: 4321,
      quoteUuid: String(quote.body.id),
      customerTransactionId: "ctx-1",
      details: { reference: "invoice 1" },
    });
    expect(created.status).toBe(200);
    expect(created.body).toHaveProperty("id");
    expect(created.body.status).toBeTruthy();

    const fetched = await api("GET", `/v1/transfers/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);
  });

  it("lists accounts and borderless accounts filtered by profileId", async () => {
    const accounts = await api("GET", "/v1/accounts");
    expect(accounts.status).toBe(200);
    expect(Array.isArray(accounts.body)).toBe(true);

    const borderless = await api("GET", "/v1/borderless-accounts?profileId=1");
    expect(borderless.status).toBe(200);
    expect(borderless.body[0].profileId).toBe(1);
    expect(Array.isArray(borderless.body[0].balances)).toBe(true);

    const none = await api("GET", "/v1/borderless-accounts?profileId=999");
    expect(none.body.length).toBe(0);
  });

  it("returns 404 for unknown quote", async () => {
    const result = await api("GET", "/v1/quotes/99999");
    expect(result.status).toBe(404);
  });
});
