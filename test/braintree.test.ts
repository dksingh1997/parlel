import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BraintreeServer } from "../services/braintree/src/server.js";

const PORT = 14868;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-api-key" };

type Json = Record<string, any>;

async function gql(query: string, variables?: Json, headers: Json = AUTH): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE_URL}/graphql`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Braintree-Version": "2019-01-01" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Braintree Service", () => {
  let server: BraintreeServer;

  beforeAll(async () => {
    server = new BraintreeServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named BraintreeServer on the right port", () => {
    expect(server.constructor.name).toBe("BraintreeServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await fetch(`${BASE_URL}/`).then((r) => r.json());
    const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
    expect(root.name).toBe("braintree");
    expect(health).toEqual({ status: "ok" });
  });

  it("requires bearer auth on /graphql", async () => {
    const result = await gql("query { ping }", undefined, {});
    expect(result.status).toBe(401);
    expect(result.body.errors[0].message).toMatch(/credentials/i);
  });

  it("responds to a ping query with data shape", async () => {
    const result = await gql("query { ping }");
    expect(result.status).toBe(200);
    expect(result.body.data.ping).toBe("pong");
  });

  it("chargeCreditCard returns a transaction", async () => {
    const query = `mutation ChargeCreditCard($input: ChargeCreditCardInput!) {
      chargeCreditCard(input: $input) {
        transaction { id status amount { value currencyCode } }
      }
    }`;
    const result = await gql(query, {
      input: { paymentMethodId: "fake-valid-nonce", transaction: { amount: "42.00", currencyCode: "USD" } },
    });
    expect(result.status).toBe(200);
    const tx = result.body.data.chargeCreditCard.transaction;
    expect(tx).toHaveProperty("id");
    expect(tx.status).toBe("SUBMITTED_FOR_SETTLEMENT");
    expect(tx.amount.value).toBe("42.00");
  });

  it("createCustomer then transaction lookup round-trips", async () => {
    const createCustomer = `mutation CreateCustomer($input: CreateCustomerInput!) {
      createCustomer(input: $input) { customer { id email firstName } }
    }`;
    const created = await gql(createCustomer, {
      input: { customer: { firstName: "Ada", email: "ada@parlel.dev" } },
    });
    expect(created.status).toBe(200);
    expect(created.body.data.createCustomer.customer.email).toBe("ada@parlel.dev");
    expect(created.body.data.createCustomer.customer).toHaveProperty("id");

    const charge = await gql(
      `mutation ($input: ChargeCreditCardInput!) { chargeCreditCard(input: $input) { transaction { id } } }`,
      { input: { paymentMethodId: "nonce", transaction: { amount: "5.00" } } }
    );
    const txnId = charge.body.data.chargeCreditCard.transaction.id;

    const lookup = await gql(`query Transaction($id: ID!) { transaction(id: $id) { id status } }`, { id: txnId });
    expect(lookup.status).toBe(200);
    expect(lookup.body.data.transaction.id).toBe(txnId);
  });

  it("returns a GraphQL error for an unknown field", async () => {
    const result = await gql("query { bogusField }");
    expect(result.status).toBe(422);
    expect(result.body.errors[0].message).toMatch(/Cannot query field/);
  });

  it("returns null for unknown transaction id", async () => {
    const result = await gql(`query ($id: ID!) { transaction(id: $id) { id } }`, { id: "missing" });
    expect(result.status).toBe(200);
    expect(result.body.data.transaction).toBeNull();
  });
});
