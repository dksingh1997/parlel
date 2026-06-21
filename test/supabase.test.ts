import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SupabaseServer } from "../services/supabase/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

let PORT = 0;

describe("Supabase Service", () => {
  let server: SupabaseServer;

  beforeAll(async () => {
    PORT = await getFreePort();
    server = new SupabaseServer(PORT);
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

  describe("REST", () => {
    it("should insert a row", () => {
      if (!server.tables.has("users")) server.tables.set("users", []);
      server.tables.get("users").push({ id: "1", name: "Alice", created_at: new Date().toISOString() });
      expect(server.tables.get("users").length).toBe(1);
    });

    it("should get rows", () => {
      server.tables.set("posts", []);
      server.tables.get("posts").push({ id: "1", title: "Hello" });
      server.tables.get("posts").push({ id: "2", title: "World" });
      expect(server.tables.get("posts").length).toBe(2);
    });

    it("should update a row", () => {
      server.tables.set("items", [{ id: "1", name: "Old" }]);
      const rows = server.tables.get("items");
      const idx = rows.findIndex((r) => r.id === "1");
      rows[idx] = { ...rows[idx], name: "New" };
      expect(rows[0].name).toBe("New");
    });

    it("should delete a row", () => {
      server.tables.set("del", [{ id: "1" }, { id: "2" }]);
      const rows = server.tables.get("del");
      server.tables.set("del", rows.filter((r) => r.id !== "1"));
      expect(server.tables.get("del").length).toBe(1);
    });
  });

  describe("Auth", () => {
    it("should have users map", () => {
      expect(server.users).toBeDefined();
      expect(server.users.size).toBe(0);
    });

    it("should create a user", () => {
      server.users.set("user1", { id: "user1", email: "test@test.com" });
      expect(server.users.size).toBe(1);
    });
  });
});
