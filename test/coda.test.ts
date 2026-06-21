import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CodaServer } from "../services/coda/src/server.js";

const PORT = 14796;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer coda_parlelTestKey" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Coda Service", () => {
  let server: CodaServer;

  beforeAll(async () => {
    server = new CodaServer(PORT);
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
      expect(root.body.name).toBe("coda");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const response = await fetch(`${BASE_URL}/v1/whoami`);
      expect(response.status).toBe(401);
    });

    it("accepts Bearer auth and returns whoami", async () => {
      const me = await api("GET", "/v1/whoami");
      expect(me.status).toBe(200);
      expect(me.body.loginId).toBe("parlel@example.com");
    });
  });

  describe("Docs", () => {
    it("lists docs with items/href", async () => {
      const list = await api("GET", "/v1/docs");
      expect(Array.isArray(list.body.items)).toBe(true);
      expect(list.body.items.length).toBeGreaterThanOrEqual(1);
      expect(list.body.href).toBeTruthy();
    });

    it("creates a doc", async () => {
      const created = await api("POST", "/v1/docs", { title: "New Doc" });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe("New Doc");
      expect(created.body.id).toBeTruthy();
    });
  });

  describe("Tables & rows", () => {
    it("lists tables for a doc", async () => {
      const list = await api("GET", `/v1/docs/${server.defaultDoc}/tables`);
      expect(list.body.items.length).toBeGreaterThanOrEqual(1);
      expect(list.body.items[0].name).toBe("Tasks");
    });

    it("returns 404 for unknown doc tables", async () => {
      const list = await api("GET", "/v1/docs/nope/tables");
      expect(list.status).toBe(404);
    });

    it("lists rows (empty initially) and inserts rows", async () => {
      const docId = server.defaultDoc;
      const tableId = server.defaultTable;
      const empty = await api("GET", `/v1/docs/${docId}/tables/${tableId}/rows`);
      expect(empty.body.items).toEqual([]);

      const inserted = await api("POST", `/v1/docs/${docId}/tables/${tableId}/rows`, {
        rows: [{ cells: [{ column: "Name", value: "Task 1" }] }],
      });
      expect(inserted.status).toBe(202);
      expect(inserted.body.addedRowIds.length).toBe(1);

      const after = await api("GET", `/v1/docs/${docId}/tables/${tableId}/rows`);
      expect(after.body.items.length).toBe(1);
      expect(after.body.items[0].values.Name).toBe("Task 1");
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      const docId = server.defaultDoc;
      const tableId = server.defaultTable;
      await api("POST", `/v1/docs/${docId}/tables/${tableId}/rows`, {
        rows: [{ cells: [{ column: "Name", value: "x" }] }],
      });
      await api("POST", "/__parlel/reset");
      const after = await api("GET", `/v1/docs/${server.defaultDoc}/tables/${server.defaultTable}/rows`);
      expect(after.body.items).toEqual([]);
    });
  });
});
