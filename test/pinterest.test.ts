import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PinterestServer } from "../services/pinterest/src/server.js";

const PORT = 14805;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.pintoken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
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

describe("Pinterest Service", () => {
  let server: PinterestServer;
  let boardId: string;

  beforeAll(async () => {
    server = new PinterestServer(PORT);
    await server.start();
    boardId = server._defaultBoardId;
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
    boardId = server._defaultBoardId;
  });

  describe("Server lifecycle", () => {
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("pinterest");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing token with 401", async () => {
      const res = await api("GET", "/v5/user_account", undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.code).toBe(401);
    });
  });

  describe("User account", () => {
    it("GET /v5/user_account returns the account", async () => {
      const res = await api("GET", "/v5/user_account");
      expect(res.status).toBe(200);
      expect(res.body.username).toBe("parlel");
    });
  });

  describe("Boards", () => {
    it("lists boards with { items, bookmark } shape", async () => {
      const res = await api("GET", "/v5/boards");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body).toHaveProperty("bookmark");
    });

    it("creates, gets and deletes a board", async () => {
      const created = await api("POST", "/v5/boards", { name: "New Board", description: "d" });
      expect(created.status).toBe(201);
      const id = created.body.id;
      const got = await api("GET", `/v5/boards/${id}`);
      expect(got.body.name).toBe("New Board");
      const deleted = await api("DELETE", `/v5/boards/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/v5/boards/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects board without name", async () => {
      const res = await api("POST", "/v5/boards", {});
      expect(res.status).toBe(400);
    });
  });

  describe("Pins", () => {
    it("creates a pin on a board, lists and gets it", async () => {
      const created = await api("POST", "/v5/pins", {
        board_id: boardId,
        title: "My Pin",
        description: "desc",
        media_source: { source_type: "image_url", url: "https://example.com/x.jpg" },
      });
      expect(created.status).toBe(201);
      expect(created.body.id).toBeTruthy();
      expect(created.body.board_id).toBe(boardId);

      const list = await api("GET", "/v5/pins");
      expect(list.body.items.length).toBe(1);

      const got = await api("GET", `/v5/pins/${created.body.id}`);
      expect(got.body.title).toBe("My Pin");
    });

    it("rejects pin without board_id", async () => {
      const res = await api("POST", "/v5/pins", { title: "x" });
      expect(res.status).toBe(400);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/v5/pins", { board_id: boardId, title: "x" });
      await api("POST", "/__parlel/reset");
      const res = await api("GET", "/__parlel/pins");
      expect(res.body.count).toBe(0);
    });
  });
});
