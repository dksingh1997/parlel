import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MercuryServer } from "../services/mercury/src/server.js";

const PORT = 14875;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer secret-token-parlel" };

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

describe("Mercury Service", () => {
  let server: MercuryServer;

  beforeAll(async () => {
    server = new MercuryServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named MercuryServer on the right port", () => {
    expect(server.constructor.name).toBe("MercuryServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("mercury");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("requires bearer auth", async () => {
    const result = await api("GET", "/api/v1/accounts", undefined, {});
    expect(result.status).toBe(401);
  });

  it("lists accounts with the documented shape", async () => {
    const result = await api("GET", "/api/v1/accounts");
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.accounts)).toBe(true);
    const acc = result.body.accounts[0];
    expect(acc).toHaveProperty("id");
    expect(acc).toHaveProperty("name");
    expect(acc).toHaveProperty("accountNumber");
    expect(acc).toHaveProperty("routingNumber");
    expect(acc).toHaveProperty("availableBalance");
    expect(acc).toHaveProperty("currentBalance");
    expect(acc).toHaveProperty("kind");
  });

  it("retrieves a single account", async () => {
    const list = await api("GET", "/api/v1/accounts");
    const id = list.body.accounts[0].id;
    const got = await api("GET", `/api/v1/accounts/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(id);
  });

  it("lists transactions for an account", async () => {
    const list = await api("GET", "/api/v1/accounts");
    const id = list.body.accounts[0].id;
    const txns = await api("GET", `/api/v1/account/${id}/transactions`);
    expect(txns.status).toBe(200);
    expect(Array.isArray(txns.body.transactions)).toBe(true);
    expect(txns.body.total).toBe(txns.body.transactions.length);
  });

  it("lists recipients", async () => {
    const result = await api("GET", "/api/v1/recipients");
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.recipients)).toBe(true);
    expect(result.body.recipients.length).toBeGreaterThanOrEqual(1);
  });

  it("sends money and debits the available balance", async () => {
    const list = await api("GET", "/api/v1/accounts");
    const account = list.body.accounts[0];
    const recipients = await api("GET", "/api/v1/recipients");
    const recipientId = recipients.body.recipients[0].id;
    const before = account.availableBalance;

    const sent = await api("POST", `/api/v1/account/${account.id}/request-send-money`, {
      recipientId,
      amount: 250,
      paymentMethod: "ach",
      note: "vendor payment",
    });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("pending");
    expect(sent.body.amount).toBe(-250);

    const after = await api("GET", `/api/v1/accounts/${account.id}`);
    expect(after.body.availableBalance).toBe(before - 250);

    const txns = await api("GET", `/api/v1/account/${account.id}/transactions`);
    expect(txns.body.transactions[0].id).toBe(sent.body.id);
  });

  it("rejects send-money without amount/recipient", async () => {
    const list = await api("GET", "/api/v1/accounts");
    const id = list.body.accounts[0].id;
    const result = await api("POST", `/api/v1/account/${id}/request-send-money`, { note: "x" });
    expect(result.status).toBe(400);
  });

  it("returns 404 for unknown account", async () => {
    const result = await api("GET", "/api/v1/accounts/00000000-0000-0000-0000-000000000000");
    expect(result.status).toBe(404);
  });
});
