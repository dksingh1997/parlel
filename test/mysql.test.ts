import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MySQLServer } from "../services/mysql/src/server.js";
import { MySQLProtocol } from "../services/mysql/src/protocol.js";

const PORT = 14306;

describe("MySQL Service", () => {
  let server: MySQLServer;

  beforeAll(async () => {
    server = new MySQLServer(PORT, { user: "parlel", password: "parlel", database: "parlel" });
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

    it("should have empty tables", () => {
      expect(server.tables.size).toBe(0);
    });
  });

  describe("DDL", () => {
    it("CREATE TABLE", () => {
      server.executeQuery("CREATE TABLE test (id INT, name VARCHAR(100))");
      expect(server.tables.has("test")).toBe(true);
      server.executeQuery("DROP TABLE test");
    });

    it("DROP TABLE", () => {
      server.executeQuery("CREATE TABLE test (id INT)");
      server.executeQuery("DROP TABLE test");
      expect(server.tables.has("test")).toBe(false);
    });
  });

  describe("DML", () => {
    it("INSERT", () => {
      server.executeQuery("CREATE TABLE test (id INT, name VARCHAR(100))");
      server.executeQuery("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      expect(server.tables.get("test")?.rows.length).toBe(1);
      server.executeQuery("DROP TABLE test");
    });

    it("SELECT", () => {
      server.executeQuery("CREATE TABLE test (id INT, name VARCHAR(100))");
      server.executeQuery("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      const result = server.executeQuery("SELECT * FROM test");
      expect(result.rows.length).toBe(1);
      server.executeQuery("DROP TABLE test");
    });

    it("UPDATE", () => {
      server.executeQuery("CREATE TABLE test (id INT, name VARCHAR(100))");
      server.executeQuery("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      server.executeQuery("UPDATE test SET name = 'Bob' WHERE id = 1");
      const result = server.executeQuery("SELECT * FROM test");
      expect(result.rows[0][1]).toBe("Bob");
      server.executeQuery("DROP TABLE test");
    });

    it("DELETE", () => {
      server.executeQuery("CREATE TABLE test (id INT, name VARCHAR(100))");
      server.executeQuery("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      server.executeQuery("DELETE FROM test WHERE id = 1");
      expect(server.tables.get("test")?.rows.length).toBe(0);
      server.executeQuery("DROP TABLE test");
    });
  });

  // Regression tests for silent-wrong-answer bugs (lexical comparison, etc.).
  describe("Query correctness (regression)", () => {
    beforeAll(() => {
      server.executeQuery("CREATE TABLE corr (id INT, name VARCHAR(20), age INT)");
      server.executeQuery("INSERT INTO corr (id, name, age) VALUES (1, 'a', 5)");
      server.executeQuery("INSERT INTO corr (id, name, age) VALUES (2, 'b', 40)");
      server.executeQuery("INSERT INTO corr (id, name, age) VALUES (3, 'c', 100)");
    });
    afterAll(() => server.executeQuery("DROP TABLE corr"));

    it("ORDER BY age ASC sorts numerically", () => {
      const r = server.executeQuery("SELECT id FROM corr ORDER BY age ASC");
      expect(r.rows.map((x: any[]) => x[0])).toEqual([1, 2, 3]);
    });

    it("WHERE age > 9 compares numerically (excludes age 5)", () => {
      const r = server.executeQuery("SELECT id FROM corr WHERE age > 9");
      expect(r.rows.map((x: any[]) => x[0]).sort()).toEqual([2, 3]);
    });

    it("BETWEEN bounds inclusively and numerically", () => {
      const r = server.executeQuery("SELECT id FROM corr WHERE age BETWEEN 10 AND 50");
      expect(r.rows.map((x: any[]) => x[0])).toEqual([2]);
    });

    it("IN list matches numeric values", () => {
      const r = server.executeQuery("SELECT id FROM corr WHERE age IN (5, 100)");
      expect(r.rows.map((x: any[]) => x[0]).sort()).toEqual([1, 3]);
    });

    it("OR combines predicates", () => {
      const r = server.executeQuery("SELECT id FROM corr WHERE age < 10 OR age > 90");
      expect(r.rows.map((x: any[]) => x[0]).sort()).toEqual([1, 3]);
    });

    it("LIKE matches patterns", () => {
      const r = server.executeQuery("SELECT id FROM corr WHERE name LIKE 'b'");
      expect(r.rows.map((x: any[]) => x[0])).toEqual([2]);
    });

    it("unsupported GROUP BY / JOIN error honestly (never wrong rows)", () => {
      expect(server.executeQuery("SELECT grp, COUNT(*) FROM corr GROUP BY grp").error).toBeDefined();
      expect(server.executeQuery("SELECT a.id FROM corr a JOIN corr b ON a.id=b.id").error).toBeDefined();
    });

    it("column-less INSERT maps values positionally", () => {
      server.executeQuery("CREATE TABLE poscols (id INT, v VARCHAR(20))");
      server.executeQuery("INSERT INTO poscols VALUES (1, 'hi')");
      server.executeQuery("INSERT INTO poscols VALUES (2, 'yo')");
      const r = server.executeQuery("SELECT * FROM poscols");
      expect(r.rows).toEqual([[1, "hi"], [2, "yo"]]);
      server.executeQuery("DROP TABLE poscols");
    });

    it("COUNT(*) returns the row count (with and without alias)", () => {
      expect(server.executeQuery("SELECT COUNT(*) FROM corr").rows).toEqual([[3]]);
      const aliased = server.executeQuery("SELECT COUNT(*) AS c FROM corr");
      expect(aliased.rows).toEqual([[3]]);
      expect(aliased.fields[0].name).toBe("c");
    });

    it("unsupported aggregates (SUM/AVG/MIN/MAX) error honestly", () => {
      expect(server.executeQuery("SELECT SUM(age) FROM corr").error).toBeDefined();
      expect(server.executeQuery("SELECT AVG(age) FROM corr").error).toBeDefined();
    });
  });

  // Fidelity: writes must surface affected_rows / last_insert_id, and the wire
  // dispatch must pick OK vs result-set vs ERR packets like real MySQL does.
  describe("Write results (OK packet semantics)", () => {
    beforeAll(() => {
      server.executeQuery("CREATE TABLE wr (id INT, name VARCHAR(20))");
    });
    afterAll(() => server.executeQuery("DROP TABLE wr"));

    it("INSERT reports affectedRows=1 and an auto-increment insertId", () => {
      const r1 = server.executeQuery("INSERT INTO wr (name) VALUES ('a')");
      expect(r1.affectedRows).toBe(1);
      expect(r1.insertId).toBe(1);
      const r2 = server.executeQuery("INSERT INTO wr (name) VALUES ('b')");
      expect(r2.insertId).toBe(2);
    });

    it("UPDATE reports the number of matched rows", () => {
      const r = server.executeQuery("UPDATE wr SET name = 'z' WHERE id = 1");
      expect(r.affectedRows).toBe(1);
    });

    it("DELETE reports the number of removed rows", () => {
      const r = server.executeQuery("DELETE FROM wr WHERE id = 2");
      expect(r.affectedRows).toBe(1);
    });
  });

  // Real MySQL raises ERR 1146 (42S02) for an unknown table — never a silent
  // empty success.
  describe("Failure scenarios (ERR packet semantics)", () => {
    it("SELECT / INSERT / UPDATE / DELETE on a missing table error 1146", () => {
      for (const q of [
        "SELECT * FROM nope",
        "INSERT INTO nope (id) VALUES (1)",
        "UPDATE nope SET id = 1 WHERE id = 1",
        "DELETE FROM nope WHERE id = 1",
      ]) {
        const r = server.executeQuery(q);
        expect(r.error).toBeDefined();
        expect(r.code).toBe(1146);
        expect(r.sqlState).toBe("42S02");
      }
    });
  });

  // Protocol-level packet framing: the leading byte tells the driver which
  // packet type it is (0x00 OK, 0xFF ERR), and OK must be >= 7 bytes so it is
  // not mistaken for a deprecated EOF.
  describe("Wire packet encoding", () => {
    it("encodeOK starts with 0x00, is >= 7 bytes, and carries affected_rows/insert_id", () => {
      const ok = MySQLProtocol.encodeOK(5, 42);
      expect(ok[0]).toBe(0x00);
      expect(ok.length).toBeGreaterThanOrEqual(7);
      expect(ok[1]).toBe(5); // lenenc affected_rows (small value = 1 byte)
      expect(ok[2]).toBe(42); // lenenc last_insert_id
    });

    it("encodeError starts with 0xFF and contains code + '#' + SQLSTATE + message", () => {
      const err = MySQLProtocol.encodeError("Table 'nope' doesn't exist", 1146, "42S02");
      expect(err[0]).toBe(0xff);
      expect(err.readUInt16LE(1)).toBe(1146);
      expect(err[3]).toBe(0x23); // '#'
      expect(err.subarray(4, 9).toString("utf8")).toBe("42S02");
      expect(err.subarray(9).toString("utf8")).toBe("Table 'nope' doesn't exist");
    });

    it("encodeResultSet returns individually-framed packets (real-client safe)", () => {
      const { buffer, nextSeq } = MySQLProtocol.encodeResultSet(
        [{ name: "id", type: 0x03, length: 11 }],
        [[1]],
        1,
      );
      // First packet is the column-count packet: header int<3> len + int<1> seq,
      // then the lenenc column count (1). The body — not byte 0 — is the count.
      const len0 = buffer.readUIntLE(0, 3);
      expect(buffer[3]).toBe(1); // sequence id starts at 1
      expect(buffer[4]).toBe(1); // one column (lenenc, single byte)
      expect(len0).toBe(1); // column-count payload is 1 byte
      // Sequence ids advance per packet: count(1) col(2) eof(3) row(4) eof(5) -> next 6.
      expect(nextSeq).toBe(6);
    });
  });
});
