import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CassandraServer } from "../services/cassandra/src/server.js";

const PORT = 19042;

describe("Cassandra Service", () => {
  let server: CassandraServer;

  beforeAll(async () => {
    server = new CassandraServer(PORT);
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

    it("should have empty keyspaces", () => {
      expect(server.keyspaces.size).toBe(0);
    });
  });

  describe("Keyspaces", () => {
    it("should create a keyspace", () => {
      server.keyspaces.set("test_ks", { tables: new Map() });
      expect(server.keyspaces.has("test_ks")).toBe(true);
    });
  });

  describe("Tables", () => {
    it("should create a table", () => {
      server.tables.set("test_ks.users", { columns: [{ name: "id", type: "int" }, { name: "name", type: "text" }], rows: [] });
      expect(server.tables.has("test_ks.users")).toBe(true);
    });

    it("should insert data", () => {
      server.tables.set("test_ks.data", { columns: [{ name: "id", type: "int" }, { name: "value", type: "text" }], rows: [] });
      const table = server.tables.get("test_ks.data");
      table.rows.push({ id: 1, value: "test" });
      expect(table.rows.length).toBe(1);
    });

    it("should query data", () => {
      server.tables.set("test_ks.query", { columns: [{ name: "id", type: "int" }, { name: "name", type: "text" }], rows: [] });
      const table = server.tables.get("test_ks.query");
      table.rows.push({ id: 1, name: "Alice" });
      table.rows.push({ id: 2, name: "Bob" });
      expect(table.rows.length).toBe(2);
      expect(table.rows[0].name).toBe("Alice");
    });
  });
});
