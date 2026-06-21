import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MeilisearchServer } from "../services/meilisearch/src/server.js";

const PORT = 17700;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

async function createIndex(uid: string, primaryKey = "id") {
  return request("POST", "/indexes", { uid, primaryKey });
}

async function addMovies(uid = "movies") {
  await createIndex(uid);
  return request("POST", `/indexes/${uid}/documents`, [
    { id: 1, title: "Interstellar", genre: "sci-fi", rating: 9, tags: ["space", "drama"] },
    { id: 2, title: "Arrival", genre: "sci-fi", rating: 8, tags: ["aliens", "drama"] },
    { id: 3, title: "Ratatouille", genre: "animation", rating: 7, tags: ["food"] },
  ]);
}

describe("Meilisearch Service", () => {
  let server: MeilisearchServer;

  beforeAll(async () => {
    server = new MeilisearchServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("should start on port", () => {
      expect(server.port).toBe(PORT);
    });

    it("should have empty indexes after reset", () => {
      server.reset();
      expect(server.indexes.size).toBe(0);
    });
  });

  describe("Discovery", () => {
    it("GET / returns Meilisearch root metadata", async () => {
      const result = await request("GET", "/");
      expect(result.status).toBe(200);
      expect(result.body.status).toBe("Meilisearch is running");
      expect(result.body.version.pkgVersion).toBe("1.12.0");
      expect(result.headers.get("x-meilisearch-version")).toBe("1.12.0");
    });

    it("GET /health", async () => {
      const result = await request("GET", "/health");
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ status: "available" });
    });

    it("GET /version", async () => {
      const result = await request("GET", "/version");
      expect(result.status).toBe(200);
      expect(result.body.pkgVersion).toBe("1.12.0");
    });

    it("returns Meilisearch-style errors", async () => {
      const result = await request("GET", "/missing");
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ code: "not_found", type: "invalid_request" });
      expect(result.body.link).toContain("https://docs.meilisearch.com/errors#not_found");
    });
  });

  describe("Indexes", () => {
    it("creates, lists, gets, updates, and deletes an index", async () => {
      server.reset();
      const create = await createIndex("books", "book_id");
      expect(create.status).toBe(202);
      expect(create.body).toMatchObject({ indexUid: "books", status: "succeeded", type: "indexCreation" });

      const list = await request("GET", "/indexes");
      expect(list.body.results).toHaveLength(1);
      expect(list.body.results[0]).toMatchObject({ uid: "books", primaryKey: "book_id" });

      const get = await request("GET", "/indexes/books");
      expect(get.status).toBe(200);
      expect(get.body.uid).toBe("books");

      const update = await request("PATCH", "/indexes/books", { primaryKey: "id" });
      expect(update.status).toBe(202);
      expect(server.indexes.get("books")?.primaryKey).toBe("id");

      const duplicate = await createIndex("books");
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.code).toBe("index_already_exists");

      const del = await request("DELETE", "/indexes/books");
      expect(del.status).toBe(202);
      expect(server.indexes.has("books")).toBe(false);

      const missing = await request("GET", "/indexes/books");
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("index_not_found");
    });

    it("rejects index creation without uid", async () => {
      server.reset();
      const result = await request("POST", "/indexes", { primaryKey: "id" });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe("missing_index_uid");
    });

    it("swaps indexes", async () => {
      server.reset();
      await createIndex("a");
      await createIndex("b");
      await request("POST", "/indexes/a/documents", [{ id: 1, name: "A" }]);
      await request("POST", "/indexes/b/documents", [{ id: 2, name: "B" }]);

      const result = await request("POST", "/swap-indexes", [{ indexes: ["a", "b"] }]);
      expect(result.status).toBe(202);
      expect([...server.indexes.get("a")!.documents.values()][0].name).toBe("B");
      expect([...server.indexes.get("b")!.documents.values()][0].name).toBe("A");
    });
  });

  describe("Documents", () => {
    it("adds, lists, gets with fields, updates, deletes one, deletes batch, and deletes all documents", async () => {
      server.reset();
      const add = await addMovies();
      expect(add.status).toBe(202);
      expect(add.body.type).toBe("documentAdditionOrUpdate");

      const list = await request("GET", "/indexes/movies/documents?limit=2&offset=1&fields=id,title");
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(3);
      expect(list.body.results).toEqual([{ id: 2, title: "Arrival" }, { id: 3, title: "Ratatouille" }]);

      const get = await request("GET", "/indexes/movies/documents/1?fields=title");
      expect(get.status).toBe(200);
      expect(get.body).toEqual({ title: "Interstellar" });

      const fetchDocs = await request("POST", "/indexes/movies/documents/fetch", { filter: "genre = sci-fi", limit: 10, fields: ["id"] });
      expect(fetchDocs.status).toBe(200);
      expect(fetchDocs.body.results).toEqual([{ id: 1 }, { id: 2 }]);

      const update = await request("PUT", "/indexes/movies/documents", [{ id: 1, rating: 10 }]);
      expect(update.status).toBe(202);
      expect((await request("GET", "/indexes/movies/documents/1")).body.rating).toBe(10);
      expect((await request("GET", "/indexes/movies/documents/1")).body.title).toBe("Interstellar");

      const delOne = await request("DELETE", "/indexes/movies/documents/3");
      expect(delOne.status).toBe(202);
      expect((await request("GET", "/indexes/movies/documents/3")).status).toBe(404);

      const delBatch = await request("POST", "/indexes/movies/documents/delete-batch", [2]);
      expect(delBatch.status).toBe(202);
      expect(server.indexes.get("movies")?.documents.size).toBe(1);

      await request("POST", "/indexes/movies/documents", [{ id: 4, title: "Wall-E", genre: "animation" }]);
      const delByFilter = await request("POST", "/indexes/movies/documents/delete", { filter: "genre = animation" });
      expect(delByFilter.status).toBe(202);
      expect([...server.indexes.get("movies")!.documents.values()].some((doc) => doc.genre === "animation")).toBe(false);

      const edit = await request("POST", "/indexes/movies/documents/edit", { function: "doc.title = doc.title" });
      expect(edit.status).toBe(202);
      expect(edit.body.type).toBe("documentEdition");

      const delAll = await request("DELETE", "/indexes/movies/documents");
      expect(delAll.status).toBe(202);
      expect(server.indexes.get("movies")?.documents.size).toBe(0);
    });

    it("ingests NDJSON and CSV document payloads", async () => {
      server.reset();
      await createIndex("formats");

      const ndjson = await request("POST", "/indexes/formats/documents", '{"id":1,"name":"ndjson"}\n', { "content-type": "application/x-ndjson" });
      expect(ndjson.status).toBe(202);

      const csv = await request("POST", "/indexes/formats/documents", "id,name\n2,csv\n", { "content-type": "text/csv" });
      expect(csv.status).toBe(202);

      const list = await request("GET", "/indexes/formats/documents");
      expect(list.body.results.map((doc: { name: string }) => doc.name)).toEqual(["ndjson", "csv"]);
    });

    it("rejects documents without a primary key candidate", async () => {
      server.reset();
      await request("POST", "/indexes", { uid: "noid" });
      const result = await request("POST", "/indexes/noid/documents", [{ title: "No ID" }]);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe("index_primary_key_no_candidate_found");
    });
  });

  describe("Search", () => {
    it("searches with POST, filters, sorts, projects fields, and returns facets", async () => {
      server.reset();
      await addMovies();
      const result = await request("POST", "/indexes/movies/search", {
        q: "a",
        filter: "rating >= 8 AND genre = sci-fi",
        sort: ["rating:desc"],
        attributesToRetrieve: ["id", "title", "rating"],
        facets: ["genre", "tags"],
      });

      expect(result.status).toBe(200);
      expect(result.body.hits).toEqual([
        { id: 1, title: "Interstellar", rating: 9 },
        { id: 2, title: "Arrival", rating: 8 },
      ]);
      expect(result.body.estimatedTotalHits).toBe(2);
      expect(result.body.facetDistribution.genre).toEqual({ "sci-fi": 2 });
      expect(result.body.facetDistribution.tags.drama).toBe(2);
    });

    it("searches with GET query parameters", async () => {
      server.reset();
      await addMovies();
      const result = await request("GET", "/indexes/movies/search?q=rat&limit=1");
      expect(result.status).toBe(200);
      expect(result.body.hits).toEqual([{ id: 3, title: "Ratatouille", genre: "animation", rating: 7, tags: ["food"] }]);
    });

    it("runs multi-search", async () => {
      server.reset();
      await addMovies("movies");
      await addMovies("archive");
      const result = await request("POST", "/multi-search", { queries: [{ indexUid: "movies", q: "Arrival" }, { indexUid: "archive", q: "Interstellar" }] });
      expect(result.status).toBe(200);
      expect(result.body.results).toHaveLength(2);
      expect(result.body.results[0].hits[0].title).toBe("Arrival");
      expect(result.body.results[1].hits[0].title).toBe("Interstellar");
    });

    it("runs facet search and similar documents", async () => {
      server.reset();
      await addMovies();

      const facets = await request("POST", "/indexes/movies/facet-search", { facetName: "genre", facetQuery: "sci" });
      expect(facets.status).toBe(200);
      expect(facets.body.facetHits).toEqual([{ value: "sci-fi", count: 2 }]);

      const similar = await request("POST", "/indexes/movies/similar", { id: 1, limit: 2 });
      expect(similar.status).toBe(200);
      expect(similar.body.hits).toHaveLength(2);
      expect(similar.body.hits.map((hit: { id: number }) => hit.id)).not.toContain(1);
    });
  });

  describe("Settings", () => {
    const endpoints = [
      ["displayed-attributes", ["title", "genre"]],
      ["searchable-attributes", ["title"]],
      ["filterable-attributes", ["genre"]],
      ["sortable-attributes", ["rating"]],
      ["ranking-rules", ["words", "sort"]],
      ["stop-words", ["the"]],
      ["synonyms", { movie: ["film"] }],
      ["distinct-attribute", "title"],
      ["typo-tolerance", { enabled: false }],
      ["faceting", { maxValuesPerFacet: 12 }],
      ["pagination", { maxTotalHits: 50 }],
      ["proximity-precision", "byAttribute"],
      ["separator-tokens", ["|"]],
      ["non-separator-tokens", ["#"]],
      ["dictionary", ["parlel"]],
      ["embedders", { default: { source: "userProvided", dimensions: 3 } }],
      ["search-cutoff-ms", 20],
      ["localized-attributes", [{ locales: ["en"], attributePatterns: ["title"] }]],
      ["facet-search", false],
      ["prefix-search", "disabled"],
      ["chat", { description: "Movie chat", documentTemplate: "{{doc.title}}" }],
    ] as const;

    it("gets, updates, and resets full settings", async () => {
      server.reset();
      await createIndex("settings");

      const initial = await request("GET", "/indexes/settings/settings");
      expect(initial.status).toBe(200);
      expect(initial.body.displayedAttributes).toEqual(["*"]);

      const update = await request("PATCH", "/indexes/settings/settings", { displayedAttributes: ["title"], filterableAttributes: ["genre"] });
      expect(update.status).toBe(202);
      expect((await request("GET", "/indexes/settings/settings")).body.displayedAttributes).toEqual(["title"]);

      const reset = await request("DELETE", "/indexes/settings/settings");
      expect(reset.status).toBe(202);
      expect((await request("GET", "/indexes/settings/settings")).body.displayedAttributes).toEqual(["*"]);
    });

    it.each(endpoints)("supports %s setting endpoint", async (endpoint, value) => {
      server.reset();
      await createIndex("settings");
      const update = await request("PATCH", `/indexes/settings/settings/${endpoint}`, value);
      expect(update.status).toBe(202);

      const get = await request("GET", `/indexes/settings/settings/${endpoint}`);
      expect(get.status).toBe(200);
      expect(get.body).toEqual(value);

      const reset = await request("DELETE", `/indexes/settings/settings/${endpoint}`);
      expect(reset.status).toBe(202);
    });
  });

  describe("Tasks and batches", () => {
    it("gets task lists, individual tasks, cancellation tasks, deletion tasks, and batches", async () => {
      server.reset();
      const create = await createIndex("tasks");
      const taskUid = create.body.taskUid;

      const task = await request("GET", `/tasks/${taskUid}`);
      expect(task.status).toBe(200);
      expect(task.body).toMatchObject({ uid: taskUid, status: "succeeded", type: "indexCreation" });

      const tasks = await request("GET", "/tasks?limit=10&statuses=succeeded&indexUids=tasks");
      expect(tasks.status).toBe(200);
      expect(tasks.body.results.some((entry: { uid: number }) => entry.uid === taskUid)).toBe(true);

      const cancel = await request("POST", "/tasks/cancel?uids=1");
      expect(cancel.status).toBe(202);
      expect(cancel.body.type).toBe("taskCancelation");

      const del = await request("DELETE", "/tasks?uids=1");
      expect(del.status).toBe(202);
      expect(del.body.type).toBe("taskDeletion");

      const batches = await request("GET", "/batches");
      expect(batches.status).toBe(200);
      expect(batches.body.results.length).toBeGreaterThan(0);

      const batch = await request("GET", `/batches/${batches.body.results[0].uid}`);
      expect(batch.status).toBe(200);
      expect(batch.body.uid).toBe(batches.body.results[0].uid);

      const missing = await request("GET", "/tasks/999999");
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("task_not_found");
    });
  });

  describe("Stats", () => {
    it("returns index and global stats", async () => {
      server.reset();
      await addMovies();

      const indexStats = await request("GET", "/indexes/movies/stats");
      expect(indexStats.status).toBe(200);
      expect(indexStats.body.numberOfDocuments).toBe(3);
      expect(indexStats.body.fieldDistribution.title).toBe(3);

      const stats = await request("GET", "/stats");
      expect(stats.status).toBe(200);
      expect(stats.body.indexes.movies.numberOfDocuments).toBe(3);
      expect(stats.body.databaseSize).toBeGreaterThan(0);
    });
  });

  describe("Fields", () => {
    it("lists index fields and capabilities", async () => {
      server.reset();
      await addMovies();
      await request("PATCH", "/indexes/movies/settings", { filterableAttributes: ["genre"], sortableAttributes: ["rating"] });

      const result = await request("POST", "/indexes/movies/fields", { limit: 10 });
      expect(result.status).toBe(200);
      expect(result.body.results).toContainEqual(expect.objectContaining({ field: "genre", filterable: true }));
      expect(result.body.results).toContainEqual(expect.objectContaining({ field: "rating", sortable: true }));
    });
  });

  describe("Keys", () => {
    it("lists, creates, gets, updates, and deletes keys", async () => {
      server.reset();
      const initial = await request("GET", "/keys");
      expect(initial.status).toBe(200);
      expect(initial.body.results[0].key).toBe("masterKey");

      const created = await request("POST", "/keys", { name: "Search", actions: ["search"], indexes: ["movies"], expiresAt: null });
      expect(created.status).toBe(201);
      expect(created.body.key).toBeTruthy();

      const got = await request("GET", `/keys/${created.body.key}`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("Search");

      const updated = await request("PATCH", `/keys/${created.body.uid}`, { description: "read-only" });
      expect(updated.status).toBe(200);
      expect(updated.body.description).toBe("read-only");

      const deleted = await request("DELETE", `/keys/${created.body.key}`);
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBeNull();

      const missing = await request("GET", `/keys/${created.body.key}`);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("api_key_not_found");
    });

    it("rejects keys without names", async () => {
      server.reset();
      const result = await request("POST", "/keys", { actions: ["search"] });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe("missing_api_key_name");
    });
  });

  describe("Dumps, snapshots, and experimental features", () => {
    it("creates dumps and reads dump status", async () => {
      server.reset();
      const dump = await request("POST", "/dumps");
      expect(dump.status).toBe(202);
      expect(dump.body.type).toBe("dumpCreation");

      const status = await request("GET", `/dumps/${dump.body.uid}/status`);
      expect(status.status).toBe(404);

      const storedStatus = await request("GET", `/dumps/${dump.body.dumpUid}/status`);
      expect(storedStatus.status).toBe(200);
      expect(storedStatus.body.uid).toBe(dump.body.dumpUid);
    });

    it("creates snapshots", async () => {
      server.reset();
      const snapshot = await request("POST", "/snapshots");
      expect(snapshot.status).toBe(202);
      expect(snapshot.body.type).toBe("snapshotCreation");
      expect(server.snapshots).toHaveLength(1);
    });

    it("gets and updates experimental features", async () => {
      server.reset();
      const initial = await request("GET", "/experimental-features");
      expect(initial.status).toBe(200);
      expect(initial.body.vectorStore).toBe(false);

      const update = await request("PATCH", "/experimental-features", { vectorStore: true, metrics: true });
      expect(update.status).toBe(200);
      expect(update.body.vectorStore).toBe(true);
      expect(update.body.metrics).toBe(true);
    });
  });

  describe("Dynamic search rules, webhooks, network, and chats", () => {
    it("creates, lists, gets, updates, and deletes dynamic search rules", async () => {
      server.reset();
      const updated = await request("PATCH", "/dynamic-search-rules/rule-a", { query: "sci-fi", indexUid: "movies" });
      expect(updated.status).toBe(200);
      expect(updated.body.uid).toBe("rule-a");

      const list = await request("POST", "/dynamic-search-rules", { limit: 10 });
      expect(list.status).toBe(200);
      expect(list.body.results).toHaveLength(1);

      const get = await request("GET", "/dynamic-search-rules/rule-a");
      expect(get.status).toBe(200);
      expect(get.body.query).toBe("sci-fi");

      const del = await request("DELETE", "/dynamic-search-rules/rule-a");
      expect(del.status).toBe(204);
      expect((await request("GET", "/dynamic-search-rules/rule-a")).status).toBe(404);
    });

    it("creates, lists, gets, updates, and deletes webhooks", async () => {
      server.reset();
      const created = await request("POST", "/webhooks", { url: "https://example.test/hook", events: ["task.succeeded"] });
      expect(created.status).toBe(201);

      const list = await request("GET", "/webhooks");
      expect(list.body.results).toHaveLength(1);

      const updated = await request("PATCH", `/webhooks/${created.body.uuid}`, { events: ["task.failed"] });
      expect(updated.status).toBe(200);
      expect(updated.body.events).toEqual(["task.failed"]);

      const get = await request("GET", `/webhooks/${created.body.uuid}`);
      expect(get.status).toBe(200);
      expect(get.body.url).toBe("https://example.test/hook");

      const del = await request("DELETE", `/webhooks/${created.body.uuid}`);
      expect(del.status).toBe(204);
    });

    it("gets and updates network configuration through task-returning patch", async () => {
      server.reset();
      const patch = await request("PATCH", "/network", { self: "local", remotes: { remoteA: { url: "http://remote" } }, shards: { shardA: { remotes: ["remoteA"] } } });
      expect(patch.status).toBe(202);
      expect(patch.body.type).toBe("networkUpdate");

      const network = await request("GET", "/network");
      expect(network.status).toBe(200);
      expect(network.body.self).toBe("local");
      expect(network.body.remotes.remoteA.url).toBe("http://remote");
    });

    it("lists chat workspaces, manages workspace settings, and streams completions", async () => {
      server.reset();
      const settings = await request("GET", "/chats/default/settings");
      expect(settings.status).toBe(200);

      const update = await request("PATCH", "/chats/default/settings", { source: "openAi", prompts: { system: "Be terse" } });
      expect(update.status).toBe(200);
      expect(update.body.prompts.system).toBe("Be terse");

      const list = await request("GET", "/chats");
      expect(list.status).toBe(200);
      expect(list.body.results).toEqual([{ uid: "default" }]);

      const completion = await fetch(`${BASE_URL}/chats/default/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(completion.status).toBe(200);
      expect(completion.headers.get("content-type")).toContain("text/event-stream");
      expect(await completion.text()).toContain("[DONE]");

      const reset = await request("DELETE", "/chats/default/settings");
      expect(reset.status).toBe(204);
    });
  });
});
