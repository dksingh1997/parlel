import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgresServer } from "../services/postgres/src/server.js";
import { PostgresProtocol } from "../services/postgres/src/protocol.js";
import { getFreePort } from "../src/test-helpers.js";

// Build a Bind ('B') message body (without the leading type byte) carrying a
// single parameter in the given format. Mirrors what a real client sends.
function bindBody(format: 0 | 1, value: Buffer): Buffer {
  const portal = Buffer.from("\0"); // unnamed portal
  const stmt = Buffer.from("\0"); // unnamed statement
  const formats = Buffer.alloc(2 + 2);
  formats.writeInt16BE(1, 0); // one format code
  formats.writeInt16BE(format, 2);
  const params = Buffer.alloc(2 + 4 + value.length);
  params.writeInt16BE(1, 0); // one param
  params.writeInt32BE(value.length, 2);
  value.copy(params, 6);
  const resultFormats = Buffer.alloc(2);
  resultFormats.writeInt16BE(0, 0); // zero result format codes
  const body = Buffer.concat([portal, stmt, formats, params, resultFormats]);
  // parseBind skips a 4-byte length prefix, so prepend a placeholder.
  return Buffer.concat([Buffer.alloc(4), body]);
}

describe("Postgres wire protocol — binary param decoding", () => {
  it("decodes a 4-byte binary int4 param (psycopg default) to its value", () => {
    // 4200 as big-endian int4 — the exact regression: stored bytes 0x00001068
    // must read back as "4200", not the raw bytes 0x10 0x68.
    const v = Buffer.alloc(4);
    v.writeInt32BE(4200, 0);
    const { params } = PostgresProtocol.parseBind(bindBody(1, v));
    expect(params[0]).toBe("4200");
  });

  it("decodes a 2-byte binary int2 param", () => {
    const v = Buffer.alloc(2);
    v.writeInt16BE(300, 0);
    expect(PostgresProtocol.parseBind(bindBody(1, v)).params[0]).toBe("300");
  });

  it("decodes an 8-byte binary int8 param", () => {
    const v = Buffer.alloc(8);
    v.writeBigInt64BE(9007199254740993n, 0);
    expect(PostgresProtocol.parseBind(bindBody(1, v)).params[0]).toBe(
      "9007199254740993",
    );
  });

  it("passes text-format params through as utf8", () => {
    const { params } = PostgresProtocol.parseBind(
      bindBody(0, Buffer.from("hello", "utf8")),
    );
    expect(params[0]).toBe("hello");
  });
});

let PORT = 0;

describe("Postgres Service", () => {
  let server: PostgresServer;

  beforeAll(async () => {
    PORT = await getFreePort();
    server = new PostgresServer(PORT, {
      user: "parlel",
      password: "parlel",
      database: "parlel",
    });
    await server.start();
    await new Promise((r) => setTimeout(r, 500));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("should start on port", () => {
      expect(server.port).toBe(PORT);
    });

    it("should have SQL executor", () => {
      expect(server.executor).toBeDefined();
    });

    it("should have empty tables initially", () => {
      expect(server.executor.tables.size).toBe(0);
    });
  });

  describe("DDL", () => {
    it("CREATE TABLE", () => {
      server.executor.execute("CREATE TABLE ddl_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      expect(server.executor.tables.has("ddl_test")).toBe(true);
      expect(server.executor.tables.get("ddl_test")?.fields.length).toBe(2);
      server.executor.execute("DROP TABLE ddl_test");
    });

    it("CREATE TABLE IF NOT EXISTS", () => {
      server.executor.execute("CREATE TABLE ddl_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("CREATE TABLE IF NOT EXISTS ddl_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      expect(server.executor.tables.has("ddl_test")).toBe(true);
      server.executor.execute("DROP TABLE ddl_test");
    });

    it("CREATE TABLE with multiple types", () => {
      server.executor.execute("CREATE TABLE types_test (id INTEGER, name TEXT, active BOOLEAN, score DECIMAL)");
      const table = server.executor.tables.get("types_test");
      expect(table?.fields.length).toBe(4);
      expect(table?.fields[0].type).toBe(23); // int4
      expect(table?.fields[1].type).toBe(25); // text
      expect(table?.fields[2].type).toBe(16); // bool
      expect(table?.fields[3].type).toBe(1700); // numeric
      server.executor.execute("DROP TABLE types_test");
    });

    it("DROP TABLE", () => {
      server.executor.execute("CREATE TABLE drop_test (id INTEGER)");
      expect(server.executor.tables.has("drop_test")).toBe(true);
      server.executor.execute("DROP TABLE drop_test");
      expect(server.executor.tables.has("drop_test")).toBe(false);
    });

    it("DROP TABLE IF EXISTS", () => {
      server.executor.execute("DROP TABLE IF EXISTS nonexistent");
      // Should not throw
    });

    it("TRUNCATE TABLE", () => {
      server.executor.execute("CREATE TABLE trunc_test (id INTEGER)");
      server.executor.execute("INSERT INTO trunc_test (id) VALUES (1)");
      server.executor.execute("INSERT INTO trunc_test (id) VALUES (2)");
      expect(server.executor.tables.get("trunc_test")?.rows.length).toBe(2);
      server.executor.execute("TRUNCATE TABLE trunc_test");
      expect(server.executor.tables.get("trunc_test")?.rows.length).toBe(0);
      server.executor.execute("DROP TABLE trunc_test");
    });

    it("ALTER TABLE ADD COLUMN", () => {
      server.executor.execute("CREATE TABLE alter_test (id INTEGER)");
      server.executor.execute("ALTER TABLE alter_test ADD COLUMN name VARCHAR(100)");
      expect(server.executor.tables.get("alter_test")?.fields.length).toBe(2);
      server.executor.execute("DROP TABLE alter_test");
    });

    it("ALTER TABLE DROP COLUMN", () => {
      server.executor.execute("CREATE TABLE alter_test (id INTEGER, name VARCHAR(100))");
      server.executor.execute("ALTER TABLE alter_test DROP COLUMN name");
      expect(server.executor.tables.get("alter_test")?.fields.length).toBe(1);
      server.executor.execute("DROP TABLE alter_test");
    });
  });

  describe("DML", () => {
    it("INSERT", () => {
      server.executor.execute("CREATE TABLE dml_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      const result = server.executor.execute("INSERT INTO dml_test (name) VALUES ('Alice')");
      expect(result.tag).toBe("INSERT 0 1");
      expect(server.executor.tables.get("dml_test")?.rows.length).toBe(1);
      server.executor.execute("DROP TABLE dml_test");
    });

    it("INSERT with multiple values", () => {
      server.executor.execute("CREATE TABLE dml_test (id SERIAL PRIMARY KEY, name VARCHAR(100), age INTEGER)");
      server.executor.execute("INSERT INTO dml_test (name, age) VALUES ('Alice', 30)");
      server.executor.execute("INSERT INTO dml_test (name, age) VALUES ('Bob', 25)");
      expect(server.executor.tables.get("dml_test")?.rows.length).toBe(2);
      server.executor.execute("DROP TABLE dml_test");
    });

    it("SELECT", () => {
      server.executor.execute("CREATE TABLE dml_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO dml_test (name) VALUES ('Alice')");
      const result = server.executor.execute("SELECT * FROM dml_test");
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][1]).toBe("Alice");
      server.executor.execute("DROP TABLE dml_test");
    });

    it("SELECT with WHERE", () => {
      server.executor.execute("CREATE TABLE dml_test (id SERIAL PRIMARY KEY, name VARCHAR(100), age INTEGER)");
      server.executor.execute("INSERT INTO dml_test (name, age) VALUES ('Alice', 30)");
      server.executor.execute("INSERT INTO dml_test (name, age) VALUES ('Bob', 25)");
      const result = server.executor.execute("SELECT * FROM dml_test WHERE age > 28");
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][1]).toBe("Alice");
      server.executor.execute("DROP TABLE dml_test");
    });

    it("UPDATE", () => {
      server.executor.execute("CREATE TABLE dml_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO dml_test (name) VALUES ('Alice')");
      server.executor.execute("UPDATE dml_test SET name = 'Alice Updated' WHERE name = 'Alice'");
      const result = server.executor.execute("SELECT * FROM dml_test");
      expect(result.rows[0][1]).toBe("Alice Updated");
      server.executor.execute("DROP TABLE dml_test");
    });

    it("DELETE", () => {
      server.executor.execute("CREATE TABLE dml_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO dml_test (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO dml_test (name) VALUES ('Bob')");
      server.executor.execute("DELETE FROM dml_test WHERE name = 'Bob'");
      expect(server.executor.tables.get("dml_test")?.rows.length).toBe(1);
      server.executor.execute("DROP TABLE dml_test");
    });
  });

  describe("Queries", () => {
    it("SELECT with ORDER BY", () => {
      server.executor.execute("CREATE TABLE q_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Charlie')");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Bob')");
      const result = server.executor.execute("SELECT * FROM q_test ORDER BY name");
      expect(result.rows[0][1]).toBe("Alice");
      expect(result.rows[1][1]).toBe("Bob");
      expect(result.rows[2][1]).toBe("Charlie");
      server.executor.execute("DROP TABLE q_test");
    });

    it("SELECT with LIMIT", () => {
      server.executor.execute("CREATE TABLE q_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Bob')");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Charlie')");
      const result = server.executor.execute("SELECT * FROM q_test LIMIT 2");
      expect(result.rows.length).toBe(2);
      server.executor.execute("DROP TABLE q_test");
    });

    it("SELECT with OFFSET", () => {
      server.executor.execute("CREATE TABLE q_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Bob')");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Charlie')");
      const result = server.executor.execute("SELECT * FROM q_test OFFSET 1");
      expect(result.rows.length).toBe(2);
      server.executor.execute("DROP TABLE q_test");
    });

    it("SELECT with DISTINCT", () => {
      server.executor.execute("CREATE TABLE q_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO q_test (name) VALUES ('Bob')");
      const result = server.executor.execute("SELECT DISTINCT name FROM q_test");
      expect(result.rows.length).toBe(2);
      server.executor.execute("DROP TABLE q_test");
    });

    it("SELECT with JOIN", () => {
      server.executor.execute("CREATE TABLE j_users (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("CREATE TABLE j_posts (id SERIAL PRIMARY KEY, user_id INTEGER, title VARCHAR(100))");
      server.executor.execute("INSERT INTO j_users (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO j_posts (user_id, title) VALUES (1, 'Hello')");
      const result = server.executor.execute("SELECT u.name, p.title FROM j_users u JOIN j_posts p ON u.id = p.user_id");
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBe("Alice");
      expect(result.rows[0][1]).toBe("Hello");
      server.executor.execute("DROP TABLE j_posts");
      server.executor.execute("DROP TABLE j_users");
    });

    it("SELECT with GROUP BY", () => {
      server.executor.execute("CREATE TABLE g_test (id SERIAL PRIMARY KEY, category VARCHAR(100))");
      server.executor.execute("INSERT INTO g_test (category) VALUES ('A')");
      server.executor.execute("INSERT INTO g_test (category) VALUES ('A')");
      server.executor.execute("INSERT INTO g_test (category) VALUES ('B')");
      const result = server.executor.execute("SELECT category, COUNT(*) FROM g_test GROUP BY category");
      expect(result.rows.length).toBe(2);
      server.executor.execute("DROP TABLE g_test");
    });

    it("SELECT with COUNT(*)", () => {
      server.executor.execute("CREATE TABLE agg_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO agg_test (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO agg_test (name) VALUES ('Bob')");
      const result = server.executor.execute("SELECT COUNT(*) FROM agg_test");
      expect(result.rows[0][0]).toBe(2);
      server.executor.execute("DROP TABLE agg_test");
    });

    it("SELECT with SUM", () => {
      server.executor.execute("CREATE TABLE agg_test (id SERIAL PRIMARY KEY, amount INTEGER)");
      server.executor.execute("INSERT INTO agg_test (amount) VALUES (10)");
      server.executor.execute("INSERT INTO agg_test (amount) VALUES (20)");
      const result = server.executor.execute("SELECT SUM(amount) FROM agg_test");
      expect(result.rows[0][0]).toBe(30);
      server.executor.execute("DROP TABLE agg_test");
    });

    it("SELECT with AVG", () => {
      server.executor.execute("CREATE TABLE agg_test (id SERIAL PRIMARY KEY, amount INTEGER)");
      server.executor.execute("INSERT INTO agg_test (amount) VALUES (10)");
      server.executor.execute("INSERT INTO agg_test (amount) VALUES (20)");
      const result = server.executor.execute("SELECT AVG(amount) FROM agg_test");
      expect(result.rows[0][0]).toBe(15);
      server.executor.execute("DROP TABLE agg_test");
    });

    it("SELECT with MIN / MAX", () => {
      server.executor.execute("CREATE TABLE agg_test (id SERIAL PRIMARY KEY, amount INTEGER)");
      server.executor.execute("INSERT INTO agg_test (amount) VALUES (10)");
      server.executor.execute("INSERT INTO agg_test (amount) VALUES (30)");
      server.executor.execute("INSERT INTO agg_test (amount) VALUES (20)");
      const min = server.executor.execute("SELECT MIN(amount) FROM agg_test");
      const max = server.executor.execute("SELECT MAX(amount) FROM agg_test");
      expect(min.rows[0][0]).toBe(10);
      expect(max.rows[0][0]).toBe(30);
      server.executor.execute("DROP TABLE agg_test");
    });

    it("SELECT with UNION", () => {
      server.executor.execute("CREATE TABLE u_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO u_test (name) VALUES ('Alice')");
      server.executor.execute("INSERT INTO u_test (name) VALUES ('Bob')");
      const result = server.executor.execute("SELECT name FROM u_test WHERE name = 'Alice' UNION SELECT name FROM u_test WHERE name = 'Bob'");
      expect(result.rows.length).toBe(2);
      server.executor.execute("DROP TABLE u_test");
    });
  });

  // Regression tests for correctness bugs where the engine previously returned
  // SILENTLY WRONG results (the most dangerous failure mode for a DB emulator).
  describe("Query correctness (regression)", () => {
    beforeAll(() => {
      server.executor.execute("CREATE TABLE corr (id INTEGER, grp VARCHAR(10), age INTEGER)");
      server.executor.execute("INSERT INTO corr (id, grp, age) VALUES (1, 'a', 5)");
      server.executor.execute("INSERT INTO corr (id, grp, age) VALUES (2, 'b', 40)");
      server.executor.execute("INSERT INTO corr (id, grp, age) VALUES (3, 'a', 100)");
    });
    afterAll(() => server.executor.execute("DROP TABLE corr"));

    it("ORDER BY ... DESC sorts numerically, not lexically", () => {
      const r = server.executor.execute("SELECT id FROM corr ORDER BY age DESC");
      expect(r.rows.map((x: any[]) => x[0])).toEqual([3, 2, 1]);
    });

    it("ORDER BY after projection indexes the correct column", () => {
      const r = server.executor.execute("SELECT grp, age FROM corr ORDER BY age ASC LIMIT 2");
      expect(r.rows).toEqual([["a", 5], ["b", 40]]);
    });

    it("numeric comparison: age > 9 excludes age 5", () => {
      const r = server.executor.execute("SELECT id FROM corr WHERE age > 9 ORDER BY id");
      expect(r.rows.map((x: any[]) => x[0])).toEqual([2, 3]);
    });

    it("BETWEEN is applied (and AND inside it is not split)", () => {
      const r = server.executor.execute("SELECT id FROM corr WHERE age BETWEEN 10 AND 50");
      expect(r.rows.map((x: any[]) => x[0])).toEqual([2]);
    });

    it("HAVING filters aggregated groups", () => {
      const r = server.executor.execute("SELECT grp, COUNT(*) FROM corr GROUP BY grp HAVING COUNT(*) > 1");
      expect(r.rows).toEqual([["a", 2]]);
    });

    it("GROUP BY supports SUM / AVG / MIN / MAX", () => {
      const r = server.executor.execute("SELECT grp, SUM(age) FROM corr GROUP BY grp");
      const a = r.rows.find((x: any[]) => x[0] === "a");
      expect(a[1]).toBe(105);
    });

    it("IN (subquery) resolves the inner SELECT", () => {
      const r = server.executor.execute("SELECT id FROM corr WHERE id IN (SELECT id FROM corr WHERE age > 35) ORDER BY id");
      expect(r.rows.map((x: any[]) => x[0])).toEqual([2, 3]);
    });

    it("CTE materializes and the outer projection applies", () => {
      const r = server.executor.execute("WITH old AS (SELECT * FROM corr WHERE age > 35) SELECT grp FROM old ORDER BY grp");
      expect(r.rows).toEqual([["a"], ["b"]]);
    });

    it("window functions error honestly instead of returning wrong rows", () => {
      const r = server.executor.execute("SELECT grp, ROW_NUMBER() OVER (ORDER BY age) FROM corr");
      expect(r.error).toBeDefined();
    });
  });

  describe("Transactions", () => {
    it("BEGIN / COMMIT", () => {
      server.executor.execute("CREATE TABLE tx_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("BEGIN");
      server.executor.execute("INSERT INTO tx_test (name) VALUES ('Alice')");
      server.executor.execute("COMMIT");
      expect(server.executor.tables.get("tx_test")?.rows.length).toBe(1);
      server.executor.execute("DROP TABLE tx_test");
    });

    it("BEGIN / ROLLBACK", () => {
      server.executor.execute("CREATE TABLE tx_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("BEGIN");
      server.executor.execute("INSERT INTO tx_test (name) VALUES ('Alice')");
      server.executor.execute("ROLLBACK");
      // Note: ROLLBACK doesn't actually undo in our implementation
      // but we test that the commands are accepted
      expect(server.executor.tables.has("tx_test")).toBe(true);
      server.executor.execute("DROP TABLE tx_test");
    });
  });

  describe("Sequences", () => {
    it("CREATE SEQUENCE", () => {
      server.executor.execute("CREATE SEQUENCE test_seq START WITH 1 INCREMENT BY 1");
      expect(server.executor.sequences.has("test_seq")).toBe(true);
      expect(server.executor.sequences.get("test_seq")?.current).toBe(0);
    });

    it("NEXTVAL", () => {
      server.executor.execute("CREATE SEQUENCE test_seq2 START WITH 1 INCREMENT BY 1");
      const result = server.executor.execute("SELECT NEXTVAL('test_seq2')");
      expect(result.rows[0][0]).toBe(1);
    });

    it("CURRVAL", () => {
      server.executor.execute("CREATE SEQUENCE test_seq3 START WITH 1 INCREMENT BY 1");
      server.executor.execute("SELECT NEXTVAL('test_seq3')");
      const result = server.executor.execute("SELECT CURRVAL('test_seq3')");
      expect(result.rows[0][0]).toBe(1);
    });
  });

  describe("Views", () => {
    it("CREATE VIEW", () => {
      server.executor.execute("CREATE TABLE v_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("INSERT INTO v_test (name) VALUES ('Alice')");
      server.executor.execute("CREATE VIEW v_view AS SELECT * FROM v_test");
      expect(server.executor.views.has("v_view")).toBe(true);
      server.executor.execute("DROP VIEW v_view");
      server.executor.execute("DROP TABLE v_test");
    });

    it("DROP VIEW", () => {
      server.executor.execute("CREATE TABLE v_test (id SERIAL PRIMARY KEY, name VARCHAR(100))");
      server.executor.execute("CREATE OR REPLACE VIEW v_view AS SELECT * FROM v_test");
      server.executor.execute("DROP VIEW v_view");
      expect(server.executor.views.has("v_view")).toBe(false);
      server.executor.execute("DROP TABLE v_test");
    });
  });

  describe("SHOW", () => {
    it("SHOW server_version", () => {
      const result = server.executor.execute("SHOW server_version");
      expect(result.rows[0][0]).toBe("16.0");
    });

    it("SHOW server_encoding", () => {
      const result = server.executor.execute("SHOW server_encoding");
      expect(result.rows[0][0]).toBe("UTF8");
    });

    it("SHOW client_encoding", () => {
      const result = server.executor.execute("SHOW client_encoding");
      expect(result.rows[0][0]).toBe("UTF8");
    });
  });

  describe("EXPLAIN", () => {
    it("EXPLAIN SELECT", () => {
      server.executor.execute("CREATE TABLE exp_test (id INTEGER)");
      const result = server.executor.execute("EXPLAIN SELECT * FROM exp_test");
      expect(result.rows.length).toBeGreaterThan(0);
      server.executor.execute("DROP TABLE exp_test");
    });
  });

  describe("Error Handling", () => {
    it("table not found", () => {
      const result = server.executor.execute("SELECT * FROM nonexistent");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("does not exist");
    });

    it("syntax error", () => {
      const result = server.executor.execute("INVALID SQL");
      expect(result.error).toBeDefined();
    });
  });

  // FROM-less constant SELECTs (health probes, SELECT 1 AS ok, version(), …).
  describe("Constant SELECT (no FROM)", () => {
    it("SELECT 1 AS ok returns aliased constant", () => {
      const r = server.executor.execute("SELECT 1 AS ok");
      expect(r.error).toBeUndefined();
      expect(r.fields[0].name).toBe("ok");
      expect(r.rows).toEqual([[1]]);
    });

    it("bare SELECT 1 still works", () => {
      expect(server.executor.execute("SELECT 1").rows).toEqual([[1]]);
    });

    it("SELECT string literal with alias", () => {
      const r = server.executor.execute("SELECT 'hi' AS greeting");
      expect(r.fields[0].name).toBe("greeting");
      expect(r.rows).toEqual([["hi"]]);
    });

    it("multiple constants", () => {
      expect(server.executor.execute("SELECT 1, 2").rows).toEqual([[1, 2]]);
    });

    it("version() / now() / current_database() probes", () => {
      expect(server.executor.execute("SELECT version()").rows[0][0]).toContain("PostgreSQL");
      expect(server.executor.execute("SELECT now()").error).toBeUndefined();
      expect(server.executor.execute("SELECT current_database()").rows).toEqual([["parlel"]]);
    });

    it("still errors on genuine garbage", () => {
      expect(server.executor.execute("SELECT foo bar baz").error).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Wire-protocol fidelity: drive the emulator with the REAL node-postgres client
// (`pg`, already a dev-dependency) over a TCP socket — exactly how production
// client code talks to a real Postgres. These tests protect the promise that
// code written against real Postgres works unmodified here: correct row shapes,
// correct CommandComplete row counts, and — most importantly — correct SQLSTATE
// error codes (the thing emulators usually lie about).
// ---------------------------------------------------------------------------
import { Client } from "pg";

describe("Postgres wire protocol (real pg client)", () => {
  let server: PostgresServer;
  let client: InstanceType<typeof Client>;
  let wirePort = 0;

  beforeAll(async () => {
    wirePort = await getFreePort();
    server = new PostgresServer(wirePort, {
      user: "parlel",
      password: "parlel",
      database: "parlel",
    });
    await server.start();
    await new Promise((r) => setTimeout(r, 300));
    client = new Client({
      host: "127.0.0.1",
      port: wirePort,
      user: "parlel",
      password: "parlel",
      database: "parlel",
    });
    await client.connect();
  }, 15000);

  afterAll(async () => {
    await client.end();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("happy path over the wire", () => {
    it("SELECT 1 health probe returns a row", async () => {
      const res = await client.query("SELECT 1");
      expect(res.rows.length).toBe(1);
      expect(Number(Object.values(res.rows[0])[0])).toBe(1);
    });

    it("CREATE TABLE / INSERT / SELECT round-trips with correct values", async () => {
      await client.query("CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT, name TEXT)");
      await client.query("INSERT INTO users (email, name) VALUES ('alice@test.com', 'Alice')");
      const res = await client.query("SELECT name, email FROM users");
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].name).toBe("Alice");
      expect(res.rows[0].email).toBe("alice@test.com");
    });

    it("INSERT reports CommandComplete `INSERT 0 1` (rowCount 1)", async () => {
      await client.query("CREATE TABLE t (id SERIAL PRIMARY KEY, v TEXT)");
      const res = await client.query("INSERT INTO t (v) VALUES ('x')");
      expect(res.command).toBe("INSERT");
      expect(res.rowCount).toBe(1);
    });

    it("parameterized query ($1) binds via the extended protocol", async () => {
      await client.query("CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT)");
      await client.query("INSERT INTO items (name) VALUES ($1)", ["Widget"]);
      const res = await client.query("SELECT name FROM items WHERE name = $1", ["Widget"]);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].name).toBe("Widget");
    });

    it("UPDATE / DELETE report correct rowCount", async () => {
      await client.query("CREATE TABLE t (id SERIAL PRIMARY KEY, name TEXT)");
      await client.query("INSERT INTO t (name) VALUES ('a')");
      await client.query("INSERT INTO t (name) VALUES ('b')");
      const upd = await client.query("UPDATE t SET name = 'z' WHERE name = 'a'");
      expect(upd.command).toBe("UPDATE");
      expect(upd.rowCount).toBe(1);
      const del = await client.query("DELETE FROM t WHERE name = 'z'");
      expect(del.command).toBe("DELETE");
      expect(del.rowCount).toBe(1);
    });

    it("RETURNING surfaces the projected columns to the client", async () => {
      await client.query("CREATE TABLE t (id SERIAL PRIMARY KEY, name TEXT)");
      const res = await client.query("INSERT INTO t (name) VALUES ('Ada') RETURNING id, name");
      expect(res.rows[0].name).toBe("Ada");
      expect(Number(res.rows[0].id)).toBe(1);
    });

    it("information_schema.tables lists created tables", async () => {
      await client.query("CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT)");
      await client.query("CREATE TABLE posts (id SERIAL PRIMARY KEY, title TEXT)");
      const res = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const names = res.rows.map((r) => r.table_name).sort();
      expect(names).toEqual(["posts", "users"]);
    });

    it("information_schema.columns reports column_name + data_type", async () => {
      await client.query("CREATE TABLE users (id INTEGER, email TEXT, active BOOLEAN)");
      const res = await client.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'",
      );
      const map = Object.fromEntries(res.rows.map((r) => [r.column_name, r.data_type]));
      expect(map.id).toBe("integer");
      expect(map.email).toBe("text");
      expect(map.active).toBe("boolean");
    });
  });

  // Failure scenarios: the SQLSTATE code in err.code is what real client code
  // branches on. A wrong code is a silent lie — these assertions protect trust.
  describe("failure scenarios (error envelope + SQLSTATE)", () => {
    it("missing relation -> 42P01 undefined_table", async () => {
      await expect(client.query("SELECT * FROM does_not_exist")).rejects.toMatchObject({
        code: "42P01",
        severity: "ERROR",
      });
    });

    it("syntax error -> 42601 (NOT mislabeled as 42P01)", async () => {
      let code: string | undefined;
      try {
        await client.query("INVALID SQL HERE");
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("42601");
    });

    it("window function -> 0A000 feature_not_supported (honest, never wrong rows)", async () => {
      await client.query("CREATE TABLE w (id INTEGER, age INTEGER)");
      await client.query("INSERT INTO w (id, age) VALUES (1, 10)");
      await expect(
        client.query("SELECT id, ROW_NUMBER() OVER (ORDER BY age) FROM w"),
      ).rejects.toMatchObject({ code: "0A000" });
    });

    it("ErrorResponse carries a non-localized severity (V field)", async () => {
      try {
        await client.query("SELECT * FROM definitely_missing");
        throw new Error("should have thrown");
      } catch (e) {
        // node-postgres populates err.severity from the V field.
        expect((e as { severity?: string }).severity).toBe("ERROR");
      }
    });
  });

  describe("reset()", () => {
    it("clears the catalog so a fresh session starts empty", async () => {
      await client.query("CREATE TABLE keep_me (id INTEGER)");
      expect(server.executor.tables.has("keep_me")).toBe(true);
      server.reset();
      expect(server.executor.tables.size).toBe(0);
      // After reset the table is gone — querying it errors as undefined.
      await expect(client.query("SELECT * FROM keep_me")).rejects.toMatchObject({
        code: "42P01",
      });
    });
  });
});
