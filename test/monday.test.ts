import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MondayServer } from "../services/monday/src/server.js";

const PORT = 14791;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "monday_parlelTestKey" };

type Json = Record<string, any>;

async function gql(query: string, variables?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}/v2`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Monday Service", () => {
  let server: MondayServer;

  beforeAll(async () => {
    server = new MondayServer(PORT);
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
      const root = await fetch(`${BASE_URL}/`).then((r) => r.json());
      const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
      expect(root.name).toBe("monday");
      expect(health).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const response = await fetch(`${BASE_URL}/v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ me { id } }" }),
      });
      expect(response.status).toBe(401);
    });

    it("accepts a token and returns data + account_id", async () => {
      const res = await gql("{ me { id name email } }");
      expect(res.status).toBe(200);
      expect(res.body.data.me.email).toBe("parlel@example.com");
      expect(res.body.account_id).toBeTruthy();
    });
  });

  describe("Queries", () => {
    it("resolves boards { id name }", async () => {
      const res = await gql("{ boards { id name } }");
      expect(Array.isArray(res.body.data.boards)).toBe(true);
      expect(res.body.data.boards.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.boards[0].name).toBeTruthy();
    });

    it("resolves items (empty at first)", async () => {
      const res = await gql("{ items { id name } }");
      expect(res.body.data.items).toEqual([]);
    });
  });

  describe("Mutations", () => {
    it("creates an item via create_item(board_id, item_name)", async () => {
      const boardId = server.defaultBoard;
      const res = await gql(
        `mutation Create($boardId: ID!, $name: String!) {
          create_item(board_id: $boardId, item_name: $name) { id }
        }`,
        { boardId, name: "New task" }
      );
      expect(res.status).toBe(200);
      expect(res.body.data.create_item.id).toBeTruthy();
    });

    it("created items appear in items query", async () => {
      await gql(`mutation { create_item(item_name: "Inline") { id } }`);
      const res = await gql("{ items { id name } }");
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].name).toBe("Inline");
    });

    it("returns a GraphQL error when item_name is missing", async () => {
      const res = await gql(`mutation { create_item(board_id: 123) { id } }`);
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeTruthy();
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await gql(`mutation { create_item(item_name: "x") { id } }`);
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const res = await gql("{ items { id } }");
      expect(res.body.data.items).toEqual([]);
    });
  });
});
