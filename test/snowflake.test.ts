import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SnowflakeServer } from "../services/snowflake/src/server.js";

const PORT = 14811;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Bearer parlelTestToken` };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
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

function exec(statement: string) {
  return api("POST", "/api/v2/statements", { statement });
}

describe("Snowflake Service", () => {
  let server: SnowflakeServer;

  beforeAll(async () => {
    server = new SnowflakeServer(PORT);
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
      expect(root.body.name).toBe("snowflake");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/api/v2/statements`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer token", async () => {
      const response = await fetch(`${BASE_URL}/api/v2/statements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statement: "SELECT 1" }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("SQL engine round-trip", () => {
    it("CREATE TABLE returns the Snowflake response shape", async () => {
      const result = await exec("CREATE TABLE users (id NUMBER, name TEXT, active BOOLEAN)");
      expect(result.status).toBe(200);
      expect(result.body.resultSetMetaData).toBeDefined();
      expect(Array.isArray(result.body.resultSetMetaData.rowType)).toBe(true);
      expect(Array.isArray(result.body.data)).toBe(true);
      expect(typeof result.body.statementHandle).toBe("string");
      expect(result.body.code).toBeDefined();
    });

    it("CREATE + INSERT + SELECT round-trips the inserted rows", async () => {
      await exec("CREATE TABLE users (id NUMBER, name TEXT, active BOOLEAN)");
      const ins = await exec("INSERT INTO users (id, name, active) VALUES (1, 'Alice', TRUE), (2, 'Bob', FALSE)");
      expect(ins.status).toBe(200);
      expect(ins.body.data).toEqual([["2"]]); // 2 rows inserted

      const sel = await exec("SELECT * FROM users");
      expect(sel.status).toBe(200);
      // data is an array-of-arrays with all values stringified.
      expect(sel.body.data).toEqual([
        ["1", "Alice", "true"],
        ["2", "Bob", "false"],
      ]);
      // rowType reflects the table columns.
      const colNames = sel.body.resultSetMetaData.rowType.map((c: Json) => c.name);
      expect(colNames).toEqual(["ID", "NAME", "ACTIVE"]);
      expect(sel.body.resultSetMetaData.numRows).toBe(2);
    });

    it("INSERT without explicit columns fills by position", async () => {
      await exec("CREATE TABLE nums (a NUMBER, b NUMBER)");
      await exec("INSERT INTO nums VALUES (10, 20)");
      const sel = await exec("SELECT * FROM nums");
      expect(sel.body.data).toEqual([["10", "20"]]);
    });

    it("retrieves a prior statement by handle", async () => {
      await exec("CREATE TABLE t (x NUMBER)");
      await exec("INSERT INTO t VALUES (42)");
      const sel = await exec("SELECT * FROM t");
      const handle = sel.body.statementHandle;
      const fetched = await api("GET", `/api/v2/statements/${handle}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.data).toEqual([["42"]]);
    });

    it("returns 422 for SELECT on a missing table", async () => {
      const result = await exec("SELECT * FROM nonexistent");
      expect(result.status).toBe(422);
      expect(result.body.message).toMatch(/does not exist/i);
    });

    it("rejects an empty statement", async () => {
      const result = await api("POST", "/api/v2/statements", { statement: "" });
      expect(result.status).toBe(400);
    });

    it("handles string literals with embedded commas", async () => {
      await exec("CREATE TABLE notes (id NUMBER, body TEXT)");
      await exec("INSERT INTO notes (id, body) VALUES (1, 'hello, world')");
      const sel = await exec("SELECT * FROM notes");
      expect(sel.body.data).toEqual([["1", "hello, world"]]);
    });
  });

  describe("Control endpoints", () => {
    it("tracks table state and resets", async () => {
      await exec("CREATE TABLE t (x NUMBER)");
      const tables = await api("GET", "/__parlel/tables");
      expect(tables.body.tables.T).toBeDefined();
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/tables");
      expect(after.body.tables.T).toBeUndefined();
    });
  });
});
