import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { RecurlyServer } from "../services/recurly/src/server.js";

const PORT = 14870;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const basic = Buffer.from("parlel-key:").toString("base64");
const AUTH = { Authorization: `Basic ${basic}` };

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

describe("Recurly Service", () => {
  let server: RecurlyServer;

  beforeAll(async () => {
    server = new RecurlyServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named RecurlyServer on the right port", () => {
    expect(server.constructor.name).toBe("RecurlyServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("recurly");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("requires basic auth", async () => {
    const result = await api("GET", "/accounts", undefined, {});
    expect(result.status).toBe(401);
  });

  it("creates, lists, gets and updates an account", async () => {
    const created = await api("POST", "/accounts", { code: "alice", email: "alice@parlel.dev", first_name: "Alice" });
    expect(created.status).toBe(201);
    expect(created.body.object).toBe("account");
    expect(created.body.code).toBe("alice");
    const id = created.body.id;

    const listed = await api("GET", "/accounts");
    expect(listed.body.object).toBe("list");
    expect(listed.body.has_more).toBe(false);
    expect(listed.body.data.length).toBe(1);

    const got = await api("GET", `/accounts/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(id);

    const byCode = await api("GET", `/accounts/code-alice`);
    expect(byCode.status).toBe(200);
    expect(byCode.body.code).toBe("alice");

    const updated = await api("PUT", `/accounts/${id}`, { email: "new@parlel.dev" });
    expect(updated.body.email).toBe("new@parlel.dev");
  });

  it("rejects an account without a code", async () => {
    const result = await api("POST", "/accounts", { email: "x@parlel.dev" });
    expect(result.status).toBe(422);
  });

  it("lists and creates plans", async () => {
    const plans = await api("GET", "/plans");
    expect(plans.body.object).toBe("list");
    expect(plans.body.data.length).toBeGreaterThanOrEqual(1);

    const created = await api("POST", "/plans", { code: "pro", name: "Pro", currencies: [{ currency: "USD", unit_amount: 25 }] });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe("pro");
  });

  it("creates a subscription on an account", async () => {
    const account = await api("POST", "/accounts", { code: "bob" });
    const id = account.body.id;
    const sub = await api("POST", `/accounts/${id}/subscriptions`, { plan_code: "basic", currency: "USD" });
    expect(sub.status).toBe(201);
    expect(sub.body.object).toBe("subscription");
    expect(sub.body.state).toBe("active");

    const subs = await api("GET", `/accounts/${id}/subscriptions`);
    expect(subs.body.object).toBe("list");
    expect(subs.body.data.length).toBe(1);
  });

  it("rejects a subscription with an unknown plan", async () => {
    const account = await api("POST", "/accounts", { code: "carol" });
    const sub = await api("POST", `/accounts/${account.body.id}/subscriptions`, { plan_code: "ghost" });
    expect(sub.status).toBe(422);
  });

  it("creates a purchase", async () => {
    await api("POST", "/accounts", { code: "dave" });
    const purchase = await api("POST", "/purchases", { currency: "USD", account: { code: "dave" } });
    expect(purchase.status).toBe(201);
    expect(purchase.body.charge_invoice.state).toBe("paid");
  });

  it("returns 404 for unknown account", async () => {
    const result = await api("GET", "/accounts/does-not-exist");
    expect(result.status).toBe(404);
  });
});
