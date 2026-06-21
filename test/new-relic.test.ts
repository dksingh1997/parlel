import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NewRelicServer } from "../services/new-relic/src/server.js";

const PORT = 14878;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { "API-Key": "parlelTestKey" };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: any, headers: Json = AUTH): Promise<ApiResult> {
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

function gql(query: string, headers: Json = AUTH) {
  return api("POST", "/graphql", { query }, headers);
}

describe("New Relic Service", () => {
  let server: NewRelicServer;

  beforeAll(async () => {
    server = new NewRelicServer(PORT);
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
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("new-relic");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing API-Key with 401", async () => {
      const res = await fetch(`${BASE_URL}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ actor { user { name } } }" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("NerdGraph (GraphQL)", () => {
    it("resolves actor { user { name } }", async () => {
      const result = await gql("{ actor { user { name } } }");
      expect(result.status).toBe(200);
      expect(result.body.data.actor.user.name).toBeTruthy();
    });

    it("resolves only requested user subfields", async () => {
      const result = await gql("{ actor { user { id name email } } }");
      expect(result.body.data.actor.user).toHaveProperty("id");
      expect(result.body.data.actor.user).toHaveProperty("name");
      expect(result.body.data.actor.user).toHaveProperty("email");
    });

    it("resolves NRQL via actor { account(id:1) { nrql(query:...) { results } } }", async () => {
      const result = await gql(
        '{ actor { account(id: 1) { nrql(query: "SELECT count(*) FROM Transaction") { results } } } }'
      );
      expect(result.status).toBe(200);
      const nrql = result.body.data.actor.account.nrql;
      expect(Array.isArray(nrql.results)).toBe(true);
      expect(nrql.results[0]).toHaveProperty("count");
    });

    it("reflects inserted events in NRQL count", async () => {
      await api("POST", "/v1/accounts/1/events", [
        { eventType: "Parlel", value: 1 },
        { eventType: "Parlel", value: 2 },
      ]);
      const result = await gql(
        '{ actor { account(id: 1) { nrql(query: "SELECT count(*) FROM Parlel") { results } } } }'
      );
      expect(result.body.data.actor.account.nrql.results[0].count).toBe(2);
    });

    it("supports a mutation/query keyword prefix", async () => {
      const result = await gql("query Foo { actor { user { name } } }");
      expect(result.body.data.actor.user.name).toBeTruthy();
    });
  });

  describe("Insights event insert", () => {
    it("inserts events returning {success:true}", async () => {
      const result = await api("POST", "/v1/accounts/1/events", { eventType: "Parlel", a: 1 });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ success: true });
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/v1/accounts/1/events", { eventType: "Parlel" });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const result = await gql(
        '{ actor { account(id: 1) { nrql(query: "SELECT count(*) FROM Parlel") { results } } } }'
      );
      expect(result.body.data.actor.account.nrql.results[0].count).toBe(0);
    });
  });
});
