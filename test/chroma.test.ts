import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ChromaServer } from "../services/chroma/src/server.js";

const PORT = 14860;
const BASE_URL = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Chroma Service", () => {
  let server: ChromaServer;

  beforeAll(async () => {
    server = new ChromaServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("chroma");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("responds to heartbeat", async () => {
      const r = await api("GET", "/api/v1/heartbeat");
      expect(r.status).toBe(200);
      expect(typeof r.body["nanosecond heartbeat"]).toBe("number");
    });
  });

  describe("Collections", () => {
    it("creates, lists, retrieves and deletes a collection", async () => {
      const created = await api("POST", "/api/v1/collections", { name: "docs", metadata: { hnsw: "cosine" } });
      expect(created.status).toBe(200);
      expect(created.body.name).toBe("docs");
      const id = created.body.id;

      const list = await api("GET", "/api/v1/collections");
      expect(list.body.length).toBe(1);

      const got = await api("GET", "/api/v1/collections/docs");
      expect(got.body.id).toBe(id);

      const del = await api("DELETE", "/api/v1/collections/docs");
      expect(del.status).toBe(200);
      const gone = await api("GET", "/api/v1/collections/docs");
      expect(gone.status).toBe(404);
    });

    it("rejects collection without name", async () => {
      const r = await api("POST", "/api/v1/collections", {});
      expect(r.status).toBe(400);
    });
  });

  describe("Add + nearest-neighbor query (real L2)", () => {
    let id = "";
    beforeEach(async () => {
      const created = await api("POST", "/api/v1/collections", { name: "vecs" });
      id = created.body.id;
      await api("POST", `/api/v1/collections/${id}/add`, {
        ids: ["a", "b", "c"],
        embeddings: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        documents: ["doc a", "doc b", "doc c"],
        metadatas: [{ k: "a" }, { k: "b" }, { k: "c" }],
      });
    });

    it("returns nearest neighbor first by L2 distance", async () => {
      const r = await api("POST", `/api/v1/collections/${id}/query`, {
        query_embeddings: [[0.9, 0.1, 0]],
        n_results: 3,
      });
      expect(r.status).toBe(200);
      expect(r.body.ids[0][0]).toBe("a");
      // distances ascending
      const d = r.body.distances[0];
      expect(d[0]).toBeLessThanOrEqual(d[1]);
      expect(d[1]).toBeLessThanOrEqual(d[2]);
      // shape: documents + metadatas returned
      expect(r.body.documents[0][0]).toBe("doc a");
      expect(r.body.metadatas[0][0]).toEqual({ k: "a" });
    });

    it("respects n_results", async () => {
      const r = await api("POST", `/api/v1/collections/${id}/query`, {
        query_embeddings: [[0, 1, 0]],
        n_results: 1,
      });
      expect(r.body.ids[0].length).toBe(1);
      expect(r.body.ids[0][0]).toBe("b");
    });

    it("supports multiple query embeddings", async () => {
      const r = await api("POST", `/api/v1/collections/${id}/query`, {
        query_embeddings: [[1, 0, 0], [0, 0, 1]],
        n_results: 1,
      });
      expect(r.body.ids.length).toBe(2);
      expect(r.body.ids[0][0]).toBe("a");
      expect(r.body.ids[1][0]).toBe("c");
    });

    it("counts records", async () => {
      const r = await api("GET", `/api/v1/collections/${id}/count`);
      expect(r.body).toBe(3);
    });

    it("applies a `where` metadata equality filter to query results", async () => {
      const r = await api("POST", `/api/v1/collections/${id}/query`, {
        query_embeddings: [[0.9, 0.1, 0]],
        n_results: 3,
        where: { k: "c" },
      });
      expect(r.status).toBe(200);
      expect(r.body.ids[0]).toEqual(["c"]);
    });

    it("supports `where` operators ($in)", async () => {
      const r = await api("POST", `/api/v1/collections/${id}/query`, {
        query_embeddings: [[1, 0, 0]],
        n_results: 5,
        where: { k: { $in: ["a", "b"] } },
      });
      expect(new Set(r.body.ids[0])).toEqual(new Set(["a", "b"]));
    });

    it("applies a `where_document` $contains filter", async () => {
      const r = await api("POST", `/api/v1/collections/${id}/query`, {
        query_embeddings: [[0, 1, 0]],
        n_results: 5,
        where_document: { $contains: "doc b" },
      });
      expect(r.body.ids[0]).toEqual(["b"]);
    });

    it("filters + paginates on get", async () => {
      const r = await api("POST", `/api/v1/collections/${id}/get`, {
        where: { k: { $nin: ["a"] } },
      });
      expect(new Set(r.body.ids)).toEqual(new Set(["b", "c"]));
      const paged = await api("POST", `/api/v1/collections/${id}/get`, { limit: 1, offset: 1 });
      expect(paged.body.ids.length).toBe(1);
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/api/v1/collections", { name: "x" });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/collections");
      expect(list.body.count).toBe(0);
    });
  });
});
