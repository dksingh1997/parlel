import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ElasticsearchServer } from "../services/elasticsearch/src/server.js";

const PORT = 19200;

describe("Elasticsearch Service", () => {
  let server: ElasticsearchServer;

  beforeAll(async () => {
    server = new ElasticsearchServer(PORT);
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

    it("should have empty indices", () => {
      expect(server.indices.size).toBe(0);
    });
  });

  describe("Indices", () => {
    it("should create an index", () => {
      server.indices.set("test-index", { docs: new Map(), mappings: {} });
      expect(server.indices.has("test-index")).toBe(true);
    });

    it("should delete an index", () => {
      server.indices.set("test-index", { docs: new Map(), mappings: {} });
      server.indices.delete("test-index");
      expect(server.indices.has("test-index")).toBe(false);
    });
  });

  describe("Documents", () => {
    it("should index a document", () => {
      server.indices.set("test", { docs: new Map(), mappings: {} });
      const idx = server.indices.get("test");
      idx.docs.set("doc1", { title: "Test", body: "Hello" });
      expect(idx.docs.size).toBe(1);
      expect(idx.docs.get("doc1").title).toBe("Test");
    });

    it("should get a document", () => {
      server.indices.set("test", { docs: new Map(), mappings: {} });
      const idx = server.indices.get("test");
      idx.docs.set("doc1", { title: "Test" });
      const doc = idx.docs.get("doc1");
      expect(doc.title).toBe("Test");
    });

    it("should delete a document", () => {
      server.indices.set("test", { docs: new Map(), mappings: {} });
      const idx = server.indices.get("test");
      idx.docs.set("doc1", { title: "Test" });
      idx.docs.delete("doc1");
      expect(idx.docs.size).toBe(0);
    });

    it("should search documents", () => {
      server.indices.set("test", { docs: new Map(), mappings: {} });
      const idx = server.indices.get("test");
      idx.docs.set("doc1", { title: "Test 1" });
      idx.docs.set("doc2", { title: "Test 2" });
      const hits = [];
      for (const [id, doc] of idx.docs) {
        hits.push({ _id: id, _source: doc });
      }
      expect(hits.length).toBe(2);
    });
  });
});
