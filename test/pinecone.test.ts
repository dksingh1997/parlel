import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PineconeServer } from "../services/pinecone/src/server.js";

const PORT = 15081;
const BASE = `http://127.0.0.1:${PORT}`;

async function request(method: string, path: string, body?: unknown, expectedStatus = 200) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  expect(response.status).toBe(expectedStatus);
  return json;
}

async function createIndex(name = "movies", dimension = 3) {
  return request("POST", "/indexes", {
    name,
    dimension,
    metric: "cosine",
    spec: { serverless: { cloud: "aws", region: "us-east-1" } },
  }, 201);
}

describe("Pinecone Service", () => {
  let server: PineconeServer;

  beforeAll(async () => {
    server = new PineconeServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  beforeEach(() => {
    server.reset();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
      expect(server.indexes.size).toBe(0);
    });

    it("returns root metadata, health, and whoami", async () => {
      const root = await request("GET", "/");
      expect(root.name).toBe("pinecone");
      const health = await request("GET", "/health");
      expect(health.status).toBe("ok");
      const whoami = await request("GET", "/actions/whoami");
      expect(whoami.project_name).toBe("parlel");
    });

    it("can reset ephemeral state", async () => {
      await createIndex("reset-me");
      expect(server.indexes.size).toBe(1);
      server.reset();
      expect(server.indexes.size).toBe(0);
    });
  });

  describe("Index Operations", () => {
    it("creates, lists, and describes indexes", async () => {
      const created = await createIndex();
      expect(created.name).toBe("movies");
      expect(created.dimension).toBe(3);
      expect(created.host).toContain(`/indexes/movies`);

      const list = await request("GET", "/indexes");
      expect(list.indexes).toHaveLength(1);

      const described = await request("GET", "/indexes/movies");
      expect(described.status.ready).toBe(true);
    });

    it("rejects duplicate and malformed index creation", async () => {
      await createIndex();
      const duplicate = await request("POST", "/indexes", { name: "movies", dimension: 3 }, 409);
      expect(duplicate.error.code).toBe("ALREADY_EXISTS");
      const malformed = await request("POST", "/indexes", { dimension: 3 }, 400);
      expect(malformed.error.code).toBe("INVALID_ARGUMENT");
    });

    it("configures deletion protection, tags, and deletes indexes", async () => {
      await createIndex();
      const configured = await request("PATCH", "/indexes/movies", { deletion_protection: "enabled", tags: { env: "test" } });
      expect(configured.deletion_protection).toBe("enabled");
      expect(configured.tags.env).toBe("test");

      const blocked = await request("DELETE", "/indexes/movies", {}, 400);
      expect(blocked.error.code).toBe("FAILED_PRECONDITION");

      await request("PATCH", "/indexes/movies", { deletion_protection: "disabled" });
      await request("DELETE", "/indexes/movies", {}, 202);
      await request("GET", "/indexes/movies", undefined, 404);
    });
  });

  describe("Vector Operations", () => {
    it("upserts and fetches dense vectors", async () => {
      await createIndex();
      const upsert = await request("POST", "/indexes/movies/vectors/upsert", {
        namespace: "catalog",
        vectors: [
          { id: "a", values: [1, 0, 0], metadata: { genre: "sci-fi", year: 1979 } },
          { id: "b", values: [0, 1, 0], metadata: { genre: "drama", year: 1984 } },
        ],
      });
      expect(upsert.upsertedCount).toBe(2);

      const fetched = await request("POST", "/indexes/movies/vectors/fetch", { namespace: "catalog", ids: ["a", "missing"] });
      expect(fetched.vectors.a.values).toEqual([1, 0, 0]);
      expect(fetched.vectors.a.metadata.genre).toBe("sci-fi");
      expect(fetched.vectors.missing).toBeUndefined();

      const fetchedByGet = await request("GET", "/indexes/movies/vectors/fetch?namespace=catalog&ids=a");
      expect(fetchedByGet.vectors.a.id).toBe("a");
    });

    it("validates vector dimensions", async () => {
      await createIndex();
      const error = await request("POST", "/indexes/movies/vectors/upsert", {
        vectors: [{ id: "bad", values: [1, 2] }],
      }, 400);
      expect(error.error.message).toContain("does not match index dimension");
    });

    it("updates vectors and queries by vector and by id", async () => {
      await createIndex();
      await request("POST", "/indexes/movies/vectors/upsert", {
        vectors: [
          { id: "a", values: [1, 0, 0], metadata: { genre: "sci-fi", year: 1979 } },
          { id: "b", values: [0, 1, 0], metadata: { genre: "drama", year: 1984 } },
        ],
      });
      await request("POST", "/indexes/movies/vectors/update", { id: "b", values: [1, 0, 0], setMetadata: { genre: "sci-fi", year: 1982 } });

      const query = await request("POST", "/indexes/movies/query", {
        vector: [1, 0, 0],
        topK: 2,
        includeValues: true,
        includeMetadata: true,
        filter: { genre: { $eq: "sci-fi" } },
      });
      expect(query.matches.map((match: { id: string }) => match.id)).toEqual(["a", "b"]);
      expect(query.matches[0].values).toEqual([1, 0, 0]);

      const byId = await request("POST", "/indexes/movies/query", { id: "a", topK: 1 });
      expect(byId.matches[0].id).toBe("a");
    });

    it("lists vectors with prefix pagination", async () => {
      await createIndex();
      await request("POST", "/indexes/movies/vectors/upsert", {
        vectors: [
          { id: "doc-1", values: [1, 0, 0] },
          { id: "doc-2", values: [0, 1, 0] },
          { id: "other", values: [0, 0, 1] },
        ],
      });

      const page1 = await request("GET", "/indexes/movies/vectors/list?prefix=doc-&limit=1");
      expect(page1.vectors).toEqual([{ id: "doc-1" }]);
      expect(page1.pagination.next).toBe("1");

      const page2 = await request("GET", "/indexes/movies/vectors/list?prefix=doc-&limit=1&paginationToken=1");
      expect(page2.vectors).toEqual([{ id: "doc-2" }]);
    });

    it("describes stats and deletes by ids, filter, and deleteAll", async () => {
      await createIndex();
      await request("POST", "/indexes/movies/vectors/upsert", {
        namespace: "catalog",
        vectors: [
          { id: "a", values: [1, 0, 0], metadata: { genre: "sci-fi" } },
          { id: "b", values: [0, 1, 0], metadata: { genre: "drama" } },
          { id: "c", values: [0, 0, 1], metadata: { genre: "sci-fi" } },
        ],
      });

      const stats = await request("POST", "/indexes/movies/describe_index_stats", { filter: { genre: "sci-fi" } });
      expect(stats.dimension).toBe(3);
      expect(stats.totalVectorCount).toBe(2);

      const byMetadata = await request("POST", "/indexes/movies/vectors/fetch_by_metadata", { namespace: "catalog", filter: { genre: "sci-fi" }, limit: 1 });
      expect(Object.keys(byMetadata.vectors)).toHaveLength(1);
      expect(byMetadata.pagination.next).toBe("1");

      expect((await request("POST", "/indexes/movies/vectors/delete", { namespace: "catalog", ids: ["a"] })).deletedCount).toBe(1);
      expect((await request("POST", "/indexes/movies/vectors/delete", { namespace: "catalog", filter: { genre: "sci-fi" } })).deletedCount).toBe(1);
      expect((await request("POST", "/indexes/movies/vectors/delete", { namespace: "catalog", deleteAll: true })).deletedCount).toBe(1);
    });
  });

  describe("Namespace Operations", () => {
    it("lists, describes, and deletes namespaces", async () => {
      await createIndex();
      const created = await request("POST", "/indexes/movies/namespaces", { name: "tenant-a", schema: { fields: { genre: { filterable: true } } } }, 201);
      expect(created.name).toBe("tenant-a");
      await request("POST", "/indexes/movies/vectors/upsert", {
        namespace: "tenant-a",
        vectors: [{ id: "a", values: [1, 0, 0] }],
      });

      const list = await request("GET", "/indexes/movies/namespaces");
      expect(list.namespaces).toEqual([{ name: "tenant-a", record_count: 1 }]);

      const described = await request("GET", "/indexes/movies/namespaces/tenant-a");
      expect(described.record_count).toBe(1);

      await request("DELETE", "/indexes/movies/namespaces/tenant-a", {}, 202);
      await request("GET", "/indexes/movies/namespaces/tenant-a", undefined, 404);
    });
  });

  describe("Record Operations", () => {
    it("upserts records and searches integrated records", async () => {
      await request("POST", "/indexes/create-for-model", {
        name: "integrated",
        metric: "cosine",
        embed: { model: "multilingual-e5-large", field_map: { text: "chunk_text" } },
      }, 201);

      const upsert = await request("POST", "/indexes/integrated/records/namespaces/docs/upsert", {
        records: [
          { _id: "r1", chunk_text: "space opera with androids", category: "sci-fi" },
          { _id: "r2", chunk_text: "family kitchen drama", category: "drama" },
        ],
      });
      expect(upsert.upsertedCount).toBe(2);

      const search = await request("POST", "/indexes/integrated/records/namespaces/docs/search", {
        query: { inputs: { text: "space android" }, topK: 1, filter: { category: "sci-fi" } },
        fields: ["chunk_text", "category"],
      });
      expect(search.result.hits).toHaveLength(1);
      expect(search.result.hits[0]._id).toBe("r1");
      expect(search.result.hits[0].fields.category).toBe("sci-fi");
    });
  });

  describe("Collections and Backups", () => {
    it("creates, lists, describes, and deletes collections", async () => {
      await createIndex();
      const collection = await request("POST", "/collections", { name: "movies-snapshot", source: "movies" }, 201);
      expect(collection.status).toBe("Ready");

      const list = await request("GET", "/collections");
      expect(list.collections[0].name).toBe("movies-snapshot");

      const described = await request("GET", "/collections/movies-snapshot");
      expect(described.source).toBe("movies");

      await request("DELETE", "/collections/movies-snapshot", {}, 202);
      await request("GET", "/collections/movies-snapshot", undefined, 404);
    });

    it("creates, lists, describes, restores, and deletes backups", async () => {
      await createIndex();
      await request("POST", "/indexes/movies/vectors/upsert", { vectors: [{ id: "a", values: [1, 0, 0] }] });
      const backup = await request("POST", "/indexes/movies/backups", { name: "movies-backup", description: "test" }, 201);
      expect(backup.record_count).toBe(1);

      const indexBackups = await request("GET", "/indexes/movies/backups");
      expect(indexBackups.backups[0].backup_id).toBe(backup.backup_id);

      const list = await request("GET", "/backups");
      expect(list.backups).toHaveLength(1);

      const described = await request("GET", `/backups/${backup.backup_id}`);
      expect(described.name).toBe("movies-backup");

      const restored = await request("POST", `/backups/${backup.backup_id}/create-index`, undefined, 202);
      expect(restored.restore_job_id).toContain("restore-");

      const restoreJobs = await request("GET", "/restore-jobs");
      expect(restoreJobs.restore_jobs[0].restore_job_id).toBe(restored.restore_job_id);

      const restoreJob = await request("GET", `/restore-jobs/${restored.restore_job_id}`);
      expect(restoreJob.status).toBe("Completed");

      await request("DELETE", `/backups/${backup.backup_id}`, {}, 202);
      await request("GET", `/backups/${backup.backup_id}`, undefined, 404);
    });
  });

  describe("Inference Operations", () => {
    it("lists models, describes models, embeds text, and reranks documents", async () => {
      const models = await request("GET", "/models?type=embed");
      expect(models.models[0].model).toBe("multilingual-e5-large");

      const model = await request("GET", "/models/bge-reranker-v2-m3");
      expect(model.type).toBe("rerank");

      const embed = await request("POST", "/embed", { model: "test-embed", inputs: ["hello world"], parameters: { dimension: 4 } });
      expect(embed.data[0].values).toHaveLength(4);
      expect(embed.usage.total_tokens).toBe(2);

      const rerank = await request("POST", "/inference/rerank", {
        model: "test-rerank",
        query: "space android",
        documents: ["kitchen drama", "space android story"],
        top_n: 1,
      });
      expect(rerank.data).toHaveLength(1);
      expect(rerank.data[0].index).toBe(1);
      expect(rerank.data[0].document).toBe("space android story");
    });
  });

  describe("Bulk Import Operations", () => {
    it("starts, lists, describes, and cancels import jobs", async () => {
      await createIndex();
      const started = await request("POST", "/indexes/movies/bulk/imports", { uri: "s3://bucket/prefix" }, 201);
      expect(started.id).toContain("import-");

      const list = await request("GET", "/indexes/movies/bulk/imports");
      expect(list.imports[0].id).toBe(started.id);

      const described = await request("GET", `/indexes/movies/bulk/imports/${started.id}`);
      expect(described.status).toBe("Completed");

      await request("DELETE", `/indexes/movies/bulk/imports/${started.id}`);
      const cancelled = await request("GET", `/indexes/movies/bulk/imports/${started.id}`);
      expect(cancelled.status).toBe("Cancelled");
    });
  });
});
