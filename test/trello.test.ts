import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TrelloServer } from "../services/trello/src/server.js";

const PORT = 14792;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CREDS = "key=trello_parlel&token=trello_token_parlel";

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE_URL}${path}${sep}${CREDS}`;
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const HEX24 = /^[0-9a-f]{24}$/;

describe("Trello Service", () => {
  let server: TrelloServer;

  beforeAll(async () => {
    server = new TrelloServer(PORT);
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
      expect(root.name).toBe("trello");
      expect(health).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing key/token with 401", async () => {
      const response = await fetch(`${BASE_URL}/1/members/me`);
      expect(response.status).toBe(401);
    });

    it("accepts key+token query params", async () => {
      const me = await api("GET", "/1/members/me");
      expect(me.status).toBe(200);
      expect(me.body.id).toMatch(HEX24);
    });
  });

  describe("Boards", () => {
    it("creates a board with 24-hex id", async () => {
      const created = await api("POST", "/1/boards", { name: "Sprint" });
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(HEX24);
      expect(created.body.name).toBe("Sprint");
    });

    it("rejects board without name", async () => {
      const created = await api("POST", "/1/boards", {});
      expect(created.status).toBe(400);
    });

    it("lists and retrieves boards", async () => {
      const list = await api("GET", "/1/boards");
      expect(list.body.length).toBeGreaterThanOrEqual(1);
      const got = await api("GET", `/1/boards/${list.body[0].id}`);
      expect(got.status).toBe(200);
    });
  });

  describe("Cards CRUD", () => {
    it("creates a card with idBoard/idList", async () => {
      const idList = server.defaultList;
      const created = await api("POST", "/1/cards", { name: "Card A", idList });
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(HEX24);
      expect(created.body.idList).toBe(idList);
      expect(created.body.idBoard).toMatch(HEX24);
    });

    it("rejects card without idList", async () => {
      const created = await api("POST", "/1/cards", { name: "X" });
      expect(created.status).toBe(400);
    });

    it("retrieves, updates and deletes a card", async () => {
      const created = await api("POST", "/1/cards", { name: "Before", idList: server.defaultList });
      const id = created.body.id;
      const got = await api("GET", `/1/cards/${id}`);
      expect(got.body.name).toBe("Before");
      const updated = await api("PUT", `/1/cards/${id}`, { name: "After" });
      expect(updated.body.name).toBe("After");
      const deleted = await api("DELETE", `/1/cards/${id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/1/cards/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Lists", () => {
    it("creates and lists lists", async () => {
      const created = await api("POST", "/1/lists", { name: "Doing", idBoard: server.defaultBoard });
      expect(created.status).toBe(200);
      expect(created.body.idBoard).toBe(server.defaultBoard);
      const list = await api("GET", "/1/lists");
      expect(list.body.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await api("POST", "/1/cards", { name: "x", idList: server.defaultList });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await api("GET", "/1/cards");
      expect(list.body).toEqual([]);
    });
  });
});
