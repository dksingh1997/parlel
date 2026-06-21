import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PlaidServer } from "../services/plaid/src/server.js";

const PORT = 14866;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CREDS = { client_id: "parlel", secret: "parlel" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Plaid Service", () => {
  let server: PlaidServer;

  beforeAll(async () => {
    server = new PlaidServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => server.reset());

  it("class is named PlaidServer on the right port", () => {
    expect(server.constructor.name).toBe("PlaidServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("plaid");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("rejects requests without client_id/secret", async () => {
    const result = await api("POST", "/link/token/create", { user: { client_user_id: "u" }, client_name: "app" });
    expect(result.status).toBe(400);
    expect(result.body.error_type).toBe("INVALID_INPUT");
    expect(result.body.error_code).toBe("INVALID_API_KEYS");
    expect(result.body).toHaveProperty("request_id");
  });

  it("runs the link -> exchange -> accounts flow", async () => {
    const link = await api("POST", "/link/token/create", {
      ...CREDS,
      user: { client_user_id: "user-1" },
      client_name: "Parlel App",
      products: ["auth"],
      country_codes: ["US"],
      language: "en",
    });
    expect(link.status).toBe(200);
    expect(link.body.link_token).toMatch(/^link-sandbox-/);
    expect(link.body).toHaveProperty("expiration");
    expect(link.body).toHaveProperty("request_id");

    const exchange = await api("POST", "/item/public_token/exchange", {
      ...CREDS,
      public_token: "public-sandbox-token",
    });
    expect(exchange.status).toBe(200);
    expect(exchange.body.access_token).toMatch(/^access-sandbox-/);
    expect(exchange.body).toHaveProperty("item_id");

    const accessToken = exchange.body.access_token;
    const accounts = await api("POST", "/accounts/get", { ...CREDS, access_token: accessToken });
    expect(accounts.status).toBe(200);
    expect(Array.isArray(accounts.body.accounts)).toBe(true);
    expect(accounts.body.accounts.length).toBeGreaterThan(0);
    const acc = accounts.body.accounts[0];
    expect(acc).toHaveProperty("account_id");
    expect(acc.balances).toHaveProperty("available");
    expect(acc.balances).toHaveProperty("current");
    expect(acc).toHaveProperty("name");
    expect(acc).toHaveProperty("type");
    expect(acc).toHaveProperty("subtype");
    expect(accounts.body).toHaveProperty("item");
  });

  it("rejects accounts/get with an unknown access_token", async () => {
    const result = await api("POST", "/accounts/get", { ...CREDS, access_token: "bogus" });
    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe("INVALID_ACCESS_TOKEN");
  });

  it("returns transactions, auth and identity", async () => {
    const exchange = await api("POST", "/item/public_token/exchange", { ...CREDS, public_token: "pt" });
    const access_token = exchange.body.access_token;

    const tx = await api("POST", "/transactions/get", { ...CREDS, access_token });
    expect(tx.status).toBe(200);
    expect(Array.isArray(tx.body.transactions)).toBe(true);
    expect(tx.body.total_transactions).toBeGreaterThan(0);

    const auth = await api("POST", "/auth/get", { ...CREDS, access_token });
    expect(auth.status).toBe(200);
    expect(auth.body.numbers.ach.length).toBeGreaterThan(0);
    expect(auth.body.numbers.ach[0]).toHaveProperty("routing");

    const identity = await api("POST", "/identity/get", { ...CREDS, access_token });
    expect(identity.status).toBe(200);
    expect(identity.body.accounts[0].owners[0].names.length).toBeGreaterThan(0);
  });

  it("returns 404 for unknown endpoints", async () => {
    const result = await api("POST", "/nope", CREDS);
    expect(result.status).toBe(404);
  });

  it("resets state via /__parlel/reset", async () => {
    await api("POST", "/item/public_token/exchange", { ...CREDS, public_token: "pt" });
    const reset = await api("POST", "/__parlel/reset");
    expect(reset.status).toBe(200);
    expect(server.items.size).toBe(0);
  });
});
