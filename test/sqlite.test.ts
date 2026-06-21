import { describe, it, expect } from "vitest";
import { SQLiteDatabase } from "../services/sqlite/src/sqlite.js";

describe("SQLite Service", () => {
  let db: SQLiteDatabase;

  beforeEach(() => {
    db = new SQLiteDatabase();
  });

  describe("DDL", () => {
    it("CREATE TABLE", () => {
      db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
      expect(db.tables.has("test")).toBe(true);
    });

    it("DROP TABLE", () => {
      db.exec("CREATE TABLE test (id INTEGER)");
      db.exec("DROP TABLE test");
      expect(db.tables.has("test")).toBe(false);
    });
  });

  describe("DML", () => {
    it("INSERT", () => {
      db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
      db.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      expect(db.tables.get("test")?.rows.length).toBe(1);
    });

    it("SELECT", () => {
      db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
      db.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      const result = db.exec("SELECT * FROM test");
      expect(result.length).toBe(1);
      expect(result[0].name).toBe("Alice");
    });

    it("SELECT with WHERE", () => {
      db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
      db.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      db.exec("INSERT INTO test (id, name) VALUES (2, 'Bob')");
      const result = db.exec("SELECT * FROM test WHERE id = 1");
      expect(result.length).toBe(1);
      expect(result[0].name).toBe("Alice");
    });

    it("UPDATE", () => {
      db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
      db.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      db.exec("UPDATE test SET name = 'Bob' WHERE id = 1");
      const result = db.exec("SELECT * FROM test");
      expect(result[0].name).toBe("Bob");
    });

    it("DELETE", () => {
      db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
      db.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      db.exec("DELETE FROM test WHERE id = 1");
      const result = db.exec("SELECT * FROM test");
      expect(result.length).toBe(0);
    });
  });

  describe("Prepared Statements", () => {
    it("prepare.all", () => {
      db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
      db.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      const stmt = db.prepare("SELECT * FROM test WHERE id = ?");
      const result = stmt.all(1);
      expect(result.length).toBe(1);
    });

    it("prepare.run", () => {
      db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
      const stmt = db.prepare("INSERT INTO test (id, name) VALUES (?, ?)");
      const result = stmt.run(1, "Alice");
      expect(result.changes).toBe(1);
    });
  });
});
