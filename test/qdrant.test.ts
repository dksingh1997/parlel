import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QdrantServer } from "../services/qdrant/src/server.js";

const PORT = 16333;
const BASE = `http://127.0.0.1:${PORT}`;

type ApiResponse<T = unknown> = {
  result: T;
  status: "ok" | { error: string };
  time: number;
  usage?: Record<string, number>;
};

async function api<T = unknown>(method: string, path: string, body?: unknown, expectedStatus = 200): Promise<ApiResponse<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json() as Promise<ApiResponse<T>>;
}

async function text(method: string, path: string, expectedStatus = 200): Promise<string> {
  const response = await fetch(`${BASE}${path}`, { method });
  expect(response.status).toBe(expectedStatus);
  return response.text();
}

describe("Qdrant Service", () => {
  let server: QdrantServer;

  beforeAll(async () => {
    server = new QdrantServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 200));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("starts on the configured port and has resettable in-memory state", () => {
      expect(server.port).toBe(PORT);
      expect(server.collections.size).toBe(0);
      server.collections.set("temporary", {} as never);
      server.reset();
      expect(server.collections.size).toBe(0);
    });
  });

  describe("Root, Health, Telemetry, Issues, Cluster", () => {
    it("serves root version info", async () => {
      const result = await api<{ version: string; title: string }>("GET", "/");
      expect(result.status).toBe("ok");
      expect(result.result.version).toBe("1.18.0");
      expect(result.result.title).toContain("qdrant");
    });

    it("serves health endpoints without envelope", async () => {
      for (const path of ["/healthz", "/livez", "/readyz"]) {
        const response = await fetch(`${BASE}${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "ok" });
      }
    });

    it("serves telemetry and metrics", async () => {
      const telemetry = await api<{ app: { name: string }; cluster: { enabled: boolean } }>("GET", "/telemetry");
      expect(telemetry.result.app.name).toBe("qdrant");
      expect(telemetry.result.cluster.enabled).toBe(false);
      expect(await text("GET", "/metrics")).toContain("qdrant_up 1");
    });

    it("gets and clears issues", async () => {
      const issues = await api<{ issues: unknown[] }>("GET", "/issues");
      expect(issues.result.issues).toEqual([]);
      const cleared = await api<boolean>("DELETE", "/issues");
      expect(cleared.result).toBe(true);
    });

    it("serves cluster status, telemetry, recover, and peer removal stubs", async () => {
      const status = await api<{ status: string }>("GET", "/cluster");
      expect(status.result.status).toBe("disabled");
      const telemetry = await api<{ enabled: boolean }>("GET", "/cluster/telemetry");
      expect(telemetry.result.enabled).toBe(false);
      expect((await api<boolean>("POST", "/cluster/recover", {})).result).toBe(true);
      expect((await api<boolean>("DELETE", "/cluster/peer/1?force=true")).result).toBe(true);
    });
  });

  describe("Collections", () => {
    it("lists, creates, detects duplicate, describes, updates, exists, and deletes collections", async () => {
      expect((await api<{ collections: unknown[] }>("GET", "/collections")).result.collections).toEqual([]);

      const created = await api<boolean>("PUT", "/collections/books", {
        vectors: { size: 4, distance: "Cosine" },
        shard_number: 1,
        on_disk_payload: false,
      });
      expect(created.result).toBe(true);
      expect((await api("PUT", "/collections/books", { vectors: { size: 4, distance: "Cosine" } }, 409)).status).toMatchObject({ error: expect.stringContaining("already exists") });

      const collections = await api<{ collections: { name: string }[] }>("GET", "/collections");
      expect(collections.result.collections).toEqual([{ name: "books" }]);

      const exists = await api<{ exists: boolean }>("GET", "/collections/books/exists");
      expect(exists.result.exists).toBe(true);

      const info = await api<{ status: string; config: { params: { vectors: { size: number } } }; points_count: number }>("GET", "/collections/books");
      expect(info.result.status).toBe("green");
      expect(info.result.config.params.vectors.size).toBe(4);
      expect(info.result.points_count).toBe(0);

      expect((await api<boolean>("PATCH", "/collections/books", { strict_mode_config: { enabled: false } })).result).toBe(true);
      expect((await api<boolean>("DELETE", "/collections/books")).result).toBe(true);
      expect((await api("GET", "/collections/books", undefined, 404)).status).toMatchObject({ error: expect.stringContaining("not found") });
    });

    it("manages aliases, payload indexes, named vectors, collection cluster, and optimizations", async () => {
      await api("PUT", "/collections/books", { vectors: { size: 4, distance: "Cosine" } });

      const aliasUpdate = await api<boolean>("POST", "/collections/aliases", {
        actions: [{ create_alias: { collection_name: "books", alias_name: "library" } }],
      });
      expect(aliasUpdate.result).toBe(true);
      expect((await api<{ aliases: { alias_name: string }[] }>("GET", "/aliases")).result.aliases[0].alias_name).toBe("library");
      expect((await api<{ aliases: { collection_name: string }[] }>("GET", "/collections/books/aliases")).result.aliases[0].collection_name).toBe("books");
      expect((await api<{ exists: boolean }>("GET", "/collections/library/exists")).result.exists).toBe(true);
      expect((await api<boolean>("POST", "/collections/aliases", { actions: [{ rename_alias: { old_alias_name: "library", new_alias_name: "archive" } }] })).result).toBe(true);
      expect((await api<{ exists: boolean }>("GET", "/collections/archive/exists")).result.exists).toBe(true);
      expect((await api<boolean>("POST", "/collections/aliases", { actions: [{ delete_alias: { alias_name: "archive" } }] })).result).toBe(true);
      expect((await api<{ aliases: unknown[] }>("GET", "/aliases")).result.aliases).toEqual([]);

      const fieldIndex = await api<{ operation_id: number; status: string }>("PUT", "/collections/books/index", { field_name: "genre", field_schema: "keyword" });
      expect(fieldIndex.result.status).toBe("completed");
      expect((await api("DELETE", "/collections/books/index/genre")).result).toMatchObject({ status: "completed" });

      expect((await api("PUT", "/collections/books/vectors/image", { size: 4, distance: "Dot" })).result).toMatchObject({ status: "completed" });
      expect((await api("DELETE", "/collections/books/vectors/image")).result).toMatchObject({ status: "completed" });

      const cluster = await api<{ local_shards: unknown[] }>("GET", "/collections/books/cluster");
      expect(cluster.result.local_shards.length).toBe(1);
      expect((await api<boolean>("POST", "/collections/books/cluster", { move_shard: { shard_id: 0 } })).result).toBe(true);
      expect((await api<{ status: string }>("GET", "/collections/books/optimizations")).result.status).toBe("ok");
    });
  });

  describe("Points", () => {
    it("upserts points, retrieves by id and ids, scrolls, counts, and filters", async () => {
      await api("PUT", "/collections/books/points", {
        points: [
          { id: 1, vector: [1, 0, 0, 0], payload: { title: "Dune", genre: "sci-fi", rating: 5, tags: ["classic", "space"] } },
          { id: 2, vector: [0.9, 0.1, 0, 0], payload: { title: "Foundation", genre: "sci-fi", rating: 4, tags: ["space"] } },
          { id: 3, vector: [0, 1, 0, 0], payload: { title: "Hamlet", genre: "drama", rating: 3, tags: ["classic"] } },
        ],
      });

      const point = await api<{ id: number; payload: { title: string }; vector: number[] }>("GET", "/collections/books/points/1");
      expect(point.result.payload.title).toBe("Dune");
      expect(point.result.vector).toEqual([1, 0, 0, 0]);

      const retrieved = await api<{ id: number; payload: { title: string } }[]>("POST", "/collections/books/points", { ids: [1, 3], with_payload: ["title"], with_vector: false });
      expect(retrieved.result.map((hit) => hit.payload.title)).toEqual(["Dune", "Hamlet"]);

      const scroll = await api<{ points: { id: number }[]; next_page_offset: number }>("POST", "/collections/books/points/scroll", { limit: 2, with_payload: true });
      expect(scroll.result.points.map((hit) => hit.id)).toEqual([1, 2]);
      expect(scroll.result.next_page_offset).toBe(2);
      expect(scroll.usage?.cpu).toBe(1);

      const filtered = await api<{ count: number }>("POST", "/collections/books/points/count", {
        filter: { must: [{ key: "genre", match: { value: "sci-fi" } }, { key: "rating", range: { gte: 4 } }] },
      });
      expect(filtered.result.count).toBe(2);

      const missing = await api("GET", "/collections/books/points/999", undefined, 404);
      expect(missing.status).toMatchObject({ error: expect.stringContaining("not found") });
    });

    it("sets, overwrites, deletes, and clears payload", async () => {
      expect((await api("POST", "/collections/books/points/payload", { points: [1, 2], payload: { available: true } })).result).toMatchObject({ status: "completed" });
      expect((await api<{ payload: { available: boolean } }>("GET", "/collections/books/points/1")).result.payload.available).toBe(true);

      await api("PUT", "/collections/books/points/payload", { points: [1], payload: { only: "this" } });
      expect((await api<{ payload: { only: string; title?: string } }>("GET", "/collections/books/points/1")).result.payload).toEqual({ only: "this" });

      await api("POST", "/collections/books/points/payload/delete", { points: [2], keys: ["available"] });
      expect((await api<{ payload: { available?: boolean } }>("GET", "/collections/books/points/2")).result.payload.available).toBeUndefined();

      await api("POST", "/collections/books/points/payload/clear", { points: [1] });
      expect((await api<{ payload: Record<string, unknown> }>("GET", "/collections/books/points/1")).result.payload).toEqual({});

      await api("POST", "/collections/books/points/payload", { points: [1], payload: { genre: "sci-fi", title: "Dune", rating: 5, group: "a" } });
    });

    it("updates and deletes vectors", async () => {
      await api("PUT", "/collections/books/vectors/text", { size: 4, distance: "Cosine" });
      await api("PUT", "/collections/books/points/vectors", { points: [{ id: 1, vector: { text: [0.2, 0.8, 0, 0] } }] });
      expect((await api<{ vector: { text: number[] } }>("GET", "/collections/books/points/1")).result.vector.text).toEqual([0.2, 0.8, 0, 0]);
      await api("POST", "/collections/books/points/vectors/delete", { points: [1], vector: ["text"] });
      expect((await api<{ vector: { text?: number[] } }>("GET", "/collections/books/points/1")).result.vector.text).toBeUndefined();
    });

    it("applies batch update operations", async () => {
      const batch = await api("POST", "/collections/books/points/batch", {
        operations: [
          { upsert: { points: [{ id: 4, vector: [0, 0, 1, 0], payload: { title: "Neuromancer", genre: "sci-fi", group: "b" } }] } },
          { set_payload: { points: [4], payload: { rating: 5 } } },
          { delete_payload: { points: [4], keys: ["rating"] } },
          { update_vectors: { points: [{ id: 4, vector: [0, 0, 0.9, 0.1] }] } },
        ],
      });
      expect(batch.result).toMatchObject({ status: "completed" });
      const point = await api<{ payload: { rating?: number }; vector: number[] }>("GET", "/collections/books/points/4");
      expect(point.result.payload.rating).toBeUndefined();
      expect(point.result.vector).toEqual([0, 0, 0.9, 0.1]);
    });
  });

  describe("Search, Recommend, Discover, Query", () => {
    it("searches, batch searches, and groups search results", async () => {
      const search = await api<{ id: number; score: number; payload: { title: string } }[]>("POST", "/collections/books/points/search", {
        vector: [1, 0, 0, 0],
        limit: 2,
        with_payload: true,
      });
      expect(search.result[0].payload.title).toBe("Dune");
      expect(search.result[0].score).toBeGreaterThan(search.result[1].score);

      const batch = await api<{ id: number }[][]>("POST", "/collections/books/points/search/batch", { searches: [{ vector: [1, 0, 0, 0], limit: 1 }, { vector: [0, 1, 0, 0], limit: 1 }] });
      expect(batch.result.length).toBe(2);
      expect(batch.result[0][0].id).toBe(1);

      const groups = await api<{ groups: { id: string; hits: unknown[] }[] }>("POST", "/collections/books/points/search/groups", { vector: [1, 0, 0, 0], group_by: "group", group_size: 2, limit: 2 });
      expect(groups.result.groups.length).toBeGreaterThan(0);
    });

    it("recommends, batch recommends, and groups recommend results", async () => {
      const recommended = await api<{ id: number }[]>("POST", "/collections/books/points/recommend", { positive: [1], negative: [3], limit: 2 });
      expect(recommended.result[0].id).toBe(1);
      const batch = await api<{ id: number }[][]>("POST", "/collections/books/points/recommend/batch", { searches: [{ positive: [1], limit: 1 }] });
      expect(batch.result[0][0].id).toBe(1);
      const groups = await api<{ groups: unknown[] }>("POST", "/collections/books/points/recommend/groups", { positive: [1], group_by: "group" });
      expect(groups.result.groups.length).toBeGreaterThan(0);
    });

    it("discovers and batch discovers points", async () => {
      const discovered = await api<{ id: number }[]>("POST", "/collections/books/points/discover", { target: [0, 1, 0, 0], limit: 1 });
      expect(discovered.result[0].id).toBe(3);
      const batch = await api<{ id: number }[][]>("POST", "/collections/books/points/discover/batch", { searches: [{ target: [0, 1, 0, 0], limit: 1 }] });
      expect(batch.result[0][0].id).toBe(3);
    });

    it("queries, batch queries, query groups, facets, and matrix endpoints", async () => {
      const query = await api<{ points: { id: number }[] }>("POST", "/collections/books/points/query", { query: [1, 0, 0, 0], limit: 1 });
      expect(query.result.points[0].id).toBe(1);

      const batch = await api<{ points: { id: number }[] }[]>("POST", "/collections/books/points/query/batch", { searches: [{ query: [1, 0, 0, 0], limit: 1 }] });
      expect(batch.result[0].points[0].id).toBe(1);

      const groups = await api<{ groups: unknown[] }>("POST", "/collections/books/points/query/groups", { query: [1, 0, 0, 0], group_by: "group" });
      expect(groups.result.groups.length).toBeGreaterThan(0);

      const facet = await api<{ hits: { value: string; count: number }[] }>("POST", "/collections/books/facet", { key: "genre" });
      expect(facet.result.hits.find((hit) => hit.value === "sci-fi")?.count).toBeGreaterThanOrEqual(3);

      const pairs = await api<{ pairs: { a: number; b: number; score: number }[] }>("POST", "/collections/books/points/search/matrix/pairs", { sample: 3 });
      expect(pairs.result.pairs.length).toBeGreaterThan(0);

      const offsets = await api<{ ids: number[]; offsets: number[][]; scores: number[] }>("POST", "/collections/books/points/search/matrix/offsets", { sample: 3 });
      expect(offsets.result.ids.length).toBe(3);
      expect(offsets.result.offsets.length).toBe(offsets.result.scores.length);
    });
  });

  describe("Shards and Snapshots", () => {
    it("manages shard keys and shard snapshots", async () => {
      expect((await api<{ shard_keys: unknown[] }>("GET", "/collections/books/shards")).result.shard_keys).toEqual([]);
      expect((await api<boolean>("PUT", "/collections/books/shards", { shard_key: "tenant-a" })).result).toBe(true);
      expect((await api<{ shard_keys: string[] }>("GET", "/collections/books/shards")).result.shard_keys).toEqual(["tenant-a"]);
      expect((await api<boolean>("POST", "/collections/books/shards/delete", { shard_key: "tenant-a" })).result).toBe(true);

      const snapshot = await api<{ name: string }>("POST", "/collections/books/shards/0/snapshots");
      expect(snapshot.result.name).toContain("books-0");
      expect((await api<{ name: string }[]>("GET", "/collections/books/shards/0/snapshots")).result[0].name).toBe(snapshot.result.name);
      expect(await text("GET", `/collections/books/shards/0/snapshots/${snapshot.result.name}`)).toContain("shard-snapshot");
      expect((await api<boolean>("PUT", "/collections/books/shards/0/snapshots/recover", { location: snapshot.result.name })).result).toBe(true);
      expect((await api<boolean>("POST", "/collections/books/shards/0/snapshots/upload", {})).result).toBe(true);
      expect((await api<boolean>("DELETE", `/collections/books/shards/0/snapshots/${snapshot.result.name}`)).result).toBe(true);
      expect(await text("GET", "/collections/books/shards/0/snapshot")).toContain("shard-snapshot");
    });

    it("manages collection snapshots and full snapshots", async () => {
      const collectionSnapshot = await api<{ name: string }>("POST", "/collections/books/snapshots");
      expect(collectionSnapshot.result.name).toContain("books");
      expect((await api<{ name: string }[]>("GET", "/collections/books/snapshots")).result[0].name).toBe(collectionSnapshot.result.name);
      expect(await text("GET", `/collections/books/snapshots/${collectionSnapshot.result.name}`)).toContain("snapshot");
      expect((await api<boolean>("PUT", "/collections/books/snapshots/recover", { location: collectionSnapshot.result.name })).result).toBe(true);
      expect((await api<boolean>("POST", "/collections/books/snapshots/upload", {})).result).toBe(true);
      expect((await api<boolean>("DELETE", `/collections/books/snapshots/${collectionSnapshot.result.name}`)).result).toBe(true);

      const fullSnapshot = await api<{ name: string }>("POST", "/snapshots");
      expect(fullSnapshot.result.name).toContain("full");
      expect((await api<{ name: string }[]>("GET", "/snapshots")).result[0].name).toBe(fullSnapshot.result.name);
      expect(await text("GET", `/snapshots/${fullSnapshot.result.name}`)).toContain("snapshot");
      expect((await api<boolean>("DELETE", `/snapshots/${fullSnapshot.result.name}`)).result).toBe(true);
    });
  });

  describe("Delete", () => {
    it("deletes points by ids and filter", async () => {
      await api("POST", "/collections/books/points/delete", { points: [4] });
      expect((await api<{ count: number }>("POST", "/collections/books/points/count", {})).result.count).toBe(3);
      await api("POST", "/collections/books/points/delete", { filter: { must: [{ key: "genre", match: { value: "drama" } }] } });
      expect((await api<{ count: number }>("POST", "/collections/books/points/count", {})).result.count).toBe(2);
    });
  });
});
