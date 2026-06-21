import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CosmosdbServer } from "../services/cosmosdb/src/server.js";

// A lightweight, dependency-free fake of Azure Cosmos DB (SQL/Core API)
// exercised through the real `@azure/cosmos` client over its HTTP REST
// transport. Mirrors the structure/style of tests/redis.test.ts and
// tests/postgres.test.ts.

const PORT = 14591;
const ENDPOINT = `http://127.0.0.1:${PORT}/`;
// The well-known Cosmos DB emulator key. The parlel fake never validates it.
const KEY =
  "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

// Imported lazily so the env is settled before construction.
let CosmosClient: any;

let server: CosmosdbServer;
let client: any;

function makeClient(): any {
  return new CosmosClient({
    endpoint: ENDPOINT,
    key: KEY,
    // Single-region: skip endpoint discovery so all traffic hits our port.
    connectionPolicy: { enableEndpointDiscovery: false },
  });
}

async function resetServer(): Promise<void> {
  await fetch(`${ENDPOINT}_parlel/reset`, { method: "POST" });
}

// Convenience: create a fresh db + container for a test.
async function freshContainer(
  dbId = "testdb",
  collId = "items",
  partitionKey: any = { paths: ["/pk"] },
): Promise<{ database: any; container: any }> {
  const { database } = await client.databases.createIfNotExists({ id: dbId });
  const { container } = await database.containers.createIfNotExists({
    id: collId,
    partitionKey,
  });
  return { database, container };
}

describe("Cosmos DB Service", () => {
  beforeAll(async () => {
    const mod: any = await import("@azure/cosmos");
    CosmosClient = mod.CosmosClient;
    server = new CosmosdbServer(PORT);
    await server.start();
    client = makeClient();
  }, 30000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await resetServer();
  });

  // -------------------------------------------------------------------------
  describe("Server", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("exposes an in-memory, resettable state", () => {
      expect(server.databases).toBeInstanceOf(Map);
    });

    it("serves the parlel health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}_parlel/health`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("cosmosdb");
    });

    it("resets state via the control endpoint", async () => {
      await client.databases.create({ id: "to-be-wiped" });
      await resetServer();
      expect(server.databases.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Database account", () => {
    it("returns the database account on GET /", async () => {
      const res = await fetch(ENDPOINT);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.id).toBe("parlel");
      expect(Array.isArray(body.writableLocations)).toBe(true);
      expect(Array.isArray(body.readableLocations)).toBe(true);
    });

    it("getDatabaseAccount via client returns consistency policy", async () => {
      const { resource } = await client.getDatabaseAccount();
      expect(resource).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("Databases", () => {
    it("creates a database", async () => {
      const { resource } = await client.databases.create({ id: "db-create" });
      expect(resource.id).toBe("db-create");
      expect(resource._rid).toBeTruthy();
      expect(resource._self).toContain("dbs/");
    });

    it("createIfNotExists is idempotent", async () => {
      const a = await client.databases.createIfNotExists({ id: "db-idem" });
      const b = await client.databases.createIfNotExists({ id: "db-idem" });
      expect(a.database.id).toBe("db-idem");
      expect(b.database.id).toBe("db-idem");
      expect(server.databases.size).toBe(1);
    });

    it("rejects duplicate create with 409", async () => {
      await client.databases.create({ id: "db-dup" });
      await expect(client.databases.create({ id: "db-dup" })).rejects.toMatchObject({
        code: 409,
      });
    });

    it("reads a database", async () => {
      await client.databases.create({ id: "db-read" });
      const { resource } = await client.database("db-read").read();
      expect(resource.id).toBe("db-read");
    });

    it("read of missing database returns 404", async () => {
      await expect(client.database("ghost").read()).rejects.toMatchObject({ code: 404 });
    });

    it("lists databases", async () => {
      await client.databases.create({ id: "db-a" });
      await client.databases.create({ id: "db-b" });
      const { resources } = await client.databases.readAll().fetchAll();
      const ids = resources.map((d: any) => d.id).sort();
      expect(ids).toEqual(["db-a", "db-b"]);
    });

    it("queries databases", async () => {
      await client.databases.create({ id: "db-q1" });
      await client.databases.create({ id: "db-q2" });
      const { resources } = await client.databases
        .query("SELECT * FROM root r WHERE r.id = 'db-q1'")
        .fetchAll();
      expect(resources.length).toBeGreaterThanOrEqual(1);
    });

    it("deletes a database", async () => {
      await client.databases.create({ id: "db-del" });
      await client.database("db-del").delete();
      await expect(client.database("db-del").read()).rejects.toMatchObject({ code: 404 });
    });

    it("creates a database with provisioned throughput", async () => {
      const { database } = await client.databases.createIfNotExists({
        id: "db-tp",
        throughput: 1000,
      });
      const { resource } = await database.readOffer();
      expect(resource.content.offerThroughput).toBe(1000);
    });
  });

  // -------------------------------------------------------------------------
  describe("Containers", () => {
    it("creates a container with a partition key", async () => {
      const { database } = await client.databases.createIfNotExists({ id: "cdb" });
      const { resource } = await database.containers.create({
        id: "c1",
        partitionKey: { paths: ["/pk"] },
      });
      expect(resource.id).toBe("c1");
      expect(resource.partitionKey.paths).toEqual(["/pk"]);
    });

    it("createIfNotExists is idempotent", async () => {
      const { database } = await client.databases.createIfNotExists({ id: "cdb2" });
      await database.containers.createIfNotExists({ id: "c", partitionKey: { paths: ["/pk"] } });
      await database.containers.createIfNotExists({ id: "c", partitionKey: { paths: ["/pk"] } });
      const { resources } = await database.containers.readAll().fetchAll();
      expect(resources.length).toBe(1);
    });

    it("reads a container with default indexing policy", async () => {
      const { container } = await freshContainer("cdb3", "c");
      const { resource } = await container.read();
      expect(resource.indexingPolicy).toBeDefined();
      expect(resource.indexingPolicy.indexingMode).toBe("consistent");
    });

    it("lists containers", async () => {
      const { database } = await client.databases.createIfNotExists({ id: "cdb4" });
      await database.containers.create({ id: "ca", partitionKey: { paths: ["/pk"] } });
      await database.containers.create({ id: "cb", partitionKey: { paths: ["/pk"] } });
      const { resources } = await database.containers.readAll().fetchAll();
      expect(resources.map((c: any) => c.id).sort()).toEqual(["ca", "cb"]);
    });

    it("replaces a container's indexing policy", async () => {
      const { container } = await freshContainer("cdb5", "c");
      const { resource: def } = await container.read();
      def.defaultTtl = 60;
      const { resource } = await container.replace(def);
      expect(resource.defaultTtl).toBe(60);
    });

    it("deletes a container", async () => {
      const { database, container } = await freshContainer("cdb6", "c");
      await container.delete();
      const { resources } = await database.containers.readAll().fetchAll();
      expect(resources.length).toBe(0);
    });

    it("reports container throughput offer", async () => {
      const { container } = await freshContainer("cdb7", "c");
      const { resource } = await container.readOffer();
      expect(resource.content.offerThroughput).toBeGreaterThan(0);
    });

    it("exposes feed ranges (partition key ranges)", async () => {
      const { container } = await freshContainer("cdb8", "c");
      const ranges = await container.getFeedRanges();
      expect(Array.isArray(ranges)).toBe(true);
      expect(ranges.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("Items - CRUD", () => {
    it("creates an item and assigns system properties", async () => {
      const { container } = await freshContainer();
      const { resource } = await container.items.create({ id: "i1", pk: "p1", name: "alice" });
      expect(resource.id).toBe("i1");
      expect(resource._rid).toBeTruthy();
      expect(resource._etag).toBeTruthy();
      expect(typeof resource._ts).toBe("number");
    });

    it("auto-generates an id when missing", async () => {
      const { container } = await freshContainer();
      const { resource } = await container.items.create({ pk: "p1" });
      expect(resource.id).toBeTruthy();
    });

    it("reads an item by id + partition key", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "i1", pk: "p1", v: 42 });
      const { resource } = await container.item("i1", "p1").read();
      expect(resource.v).toBe(42);
    });

    it("returns 404 reading a missing item", async () => {
      const { container } = await freshContainer();
      const { statusCode, resource } = await container.item("nope", "p1").read();
      expect(statusCode).toBe(404);
      expect(resource).toBeUndefined();
    });

    it("rejects duplicate create with 409", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "dup", pk: "p1" });
      await expect(container.items.create({ id: "dup", pk: "p1" })).rejects.toMatchObject({
        code: 409,
      });
    });

    it("upserts (insert then update)", async () => {
      const { container } = await freshContainer();
      const first = await container.items.upsert({ id: "u1", pk: "p1", v: 1 });
      expect(first.statusCode).toBe(201);
      const second = await container.items.upsert({ id: "u1", pk: "p1", v: 2 });
      expect(second.statusCode).toBe(200);
      const { resource } = await container.item("u1", "p1").read();
      expect(resource.v).toBe(2);
    });

    it("replaces an item", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "r1", pk: "p1", v: 1 });
      const { resource } = await container.item("r1", "p1").replace({ id: "r1", pk: "p1", v: 99 });
      expect(resource.v).toBe(99);
    });

    it("deletes an item", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "d1", pk: "p1" });
      const { statusCode } = await container.item("d1", "p1").delete();
      expect(statusCode).toBe(204);
      const res = await container.item("d1", "p1").read();
      expect(res.statusCode).toBe(404);
    });

    it("reads all items", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "a", pk: "p1" });
      await container.items.create({ id: "b", pk: "p2" });
      const { resources } = await container.items.readAll().fetchAll();
      expect(resources.length).toBe(2);
    });

    it("deletes all items for a partition key", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "a", pk: "p1" });
      await container.items.create({ id: "b", pk: "p1" });
      await container.items.create({ id: "c", pk: "p2" });
      await container.deleteAllItemsForPartitionKey("p1");
      const { resources } = await container.items.readAll().fetchAll();
      expect(resources.map((d: any) => d.id)).toEqual(["c"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("Items - optimistic concurrency", () => {
    it("replace fails with 412 on etag mismatch", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "e1", pk: "p1", v: 1 });
      await expect(
        container.item("e1", "p1").replace(
          { id: "e1", pk: "p1", v: 2 },
          { accessCondition: { type: "IfMatch", condition: '"bogus"' } },
        ),
      ).rejects.toMatchObject({ code: 412 });
    });

    it("replace succeeds with matching etag", async () => {
      const { container } = await freshContainer();
      const { resource } = await container.items.create({ id: "e2", pk: "p1", v: 1 });
      const { resource: updated } = await container.item("e2", "p1").replace(
        { id: "e2", pk: "p1", v: 2 },
        { accessCondition: { type: "IfMatch", condition: resource._etag } },
      );
      expect(updated.v).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe("Items - patch", () => {
    it("applies add/set/replace/remove/incr operations", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "pt", pk: "p1", count: 1, gone: true, nested: {} });
      const { resource } = await container.item("pt", "p1").patch([
        { op: "add", path: "/added", value: "x" },
        { op: "set", path: "/nested/inner", value: 5 },
        { op: "replace", path: "/count", value: 10 },
        { op: "remove", path: "/gone" },
        { op: "incr", path: "/count", value: 2 },
      ]);
      expect(resource.added).toBe("x");
      expect(resource.nested.inner).toBe(5);
      expect(resource.count).toBe(12);
      expect(resource.gone).toBeUndefined();
    });

    it("patch on a missing item returns 404", async () => {
      const { container } = await freshContainer();
      await expect(
        container.item("ghost", "p1").patch([{ op: "add", path: "/x", value: 1 }]),
      ).rejects.toMatchObject({ code: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Queries", () => {
    async function seed(container: any) {
      await container.items.create({ id: "1", pk: "p1", name: "alice", age: 30, cat: "a" });
      await container.items.create({ id: "2", pk: "p1", name: "bob", age: 25, cat: "a" });
      await container.items.create({ id: "3", pk: "p2", name: "carol", age: 40, cat: "b" });
      await container.items.create({ id: "4", pk: "p2", name: "dave", age: 35, cat: "b" });
    }

    it("SELECT * cross-partition", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items.query("SELECT * FROM c").fetchAll();
      expect(resources.length).toBe(4);
    });

    it("WHERE with numeric comparison", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items
        .query("SELECT * FROM c WHERE c.age > 30")
        .fetchAll();
      expect(resources.map((d: any) => d.id).sort()).toEqual(["3", "4"]);
    });

    it("parameterized query", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items
        .query({
          query: "SELECT * FROM c WHERE c.name = @name",
          parameters: [{ name: "@name", value: "bob" }],
        })
        .fetchAll();
      expect(resources.length).toBe(1);
      expect(resources[0].id).toBe("2");
    });

    it("AND / OR predicates", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items
        .query("SELECT * FROM c WHERE c.age > 30 AND c.cat = 'b'")
        .fetchAll();
      expect(resources.length).toBe(2);
      const { resources: ored } = await container.items
        .query("SELECT * FROM c WHERE c.name = 'alice' OR c.name = 'bob'")
        .fetchAll();
      expect(ored.length).toBe(2);
    });

    it("ORDER BY ascending and descending", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources: asc } = await container.items
        .query("SELECT * FROM c ORDER BY c.age ASC")
        .fetchAll();
      expect(asc.map((d: any) => d.age)).toEqual([25, 30, 35, 40]);
      const { resources: desc } = await container.items
        .query("SELECT * FROM c ORDER BY c.age DESC")
        .fetchAll();
      expect(desc.map((d: any) => d.age)).toEqual([40, 35, 30, 25]);
    });

    it("TOP and OFFSET/LIMIT", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources: top } = await container.items.query("SELECT TOP 2 * FROM c").fetchAll();
      expect(top.length).toBe(2);
      const { resources: page } = await container.items
        .query("SELECT * FROM c ORDER BY c.age ASC OFFSET 1 LIMIT 2")
        .fetchAll();
      expect(page.map((d: any) => d.age)).toEqual([30, 35]);
    });

    it("projection of specific fields", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items
        .query("SELECT c.id, c.name FROM c WHERE c.id = '1'")
        .fetchAll();
      expect(resources[0]).toEqual({ id: "1", name: "alice" });
    });

    it("DISTINCT VALUE", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items
        .query("SELECT DISTINCT VALUE c.cat FROM c")
        .fetchAll();
      expect(resources.sort()).toEqual(["a", "b"]);
    });

    it("aggregate COUNT", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items
        .query("SELECT VALUE COUNT(1) FROM c")
        .fetchAll();
      expect(resources[0]).toBe(4);
    });

    it("aggregate SUM / AVG / MIN / MAX", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const sum = (await container.items.query("SELECT VALUE SUM(c.age) FROM c").fetchAll()).resources[0];
      const avg = (await container.items.query("SELECT VALUE AVG(c.age) FROM c").fetchAll()).resources[0];
      const min = (await container.items.query("SELECT VALUE MIN(c.age) FROM c").fetchAll()).resources[0];
      const max = (await container.items.query("SELECT VALUE MAX(c.age) FROM c").fetchAll()).resources[0];
      expect(sum).toBe(130);
      expect(avg).toBe(32.5);
      expect(min).toBe(25);
      expect(max).toBe(40);
    });

    it("string functions CONTAINS / STARTSWITH / ENDSWITH", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const c = (await container.items.query("SELECT * FROM c WHERE CONTAINS(c.name, 'ar')").fetchAll()).resources;
      expect(c.map((d: any) => d.id)).toEqual(["3"]);
      const s = (await container.items.query("SELECT * FROM c WHERE STARTSWITH(c.name, 'a')").fetchAll()).resources;
      expect(s.map((d: any) => d.id)).toEqual(["1"]);
    });

    it("IN clause", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items
        .query("SELECT * FROM c WHERE c.id IN ('1', '3')")
        .fetchAll();
      expect(resources.map((d: any) => d.id).sort()).toEqual(["1", "3"]);
    });

    it("IS_DEFINED predicate", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "x1", pk: "p1", extra: 1 });
      await container.items.create({ id: "x2", pk: "p1" });
      const { resources } = await container.items
        .query("SELECT * FROM c WHERE IS_DEFINED(c.extra)")
        .fetchAll();
      expect(resources.map((d: any) => d.id)).toEqual(["x1"]);
    });

    it("partition-scoped query", async () => {
      const { container } = await freshContainer();
      await seed(container);
      const { resources } = await container.items
        .query("SELECT * FROM c", { partitionKey: "p1" })
        .fetchAll();
      expect(resources.length).toBe(2);
    });

    it("paginates with maxItemCount", async () => {
      const { container } = await freshContainer();
      for (let i = 0; i < 5; i++) await container.items.create({ id: `pg${i}`, pk: "pg" });
      const iter = container.items.query("SELECT * FROM c WHERE c.pk = 'pg'", { maxItemCount: 2 });
      let pages = 0;
      let total = 0;
      while (true) {
        const { resources } = await iter.fetchNext();
        if (!resources || resources.length === 0) break;
        pages++;
        total += resources.length;
        if (!iter.hasMoreResults()) break;
      }
      expect(total).toBe(5);
      expect(pages).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe("Transactional batch", () => {
    it("executes a mixed atomic batch", async () => {
      const { container } = await freshContainer();
      const response = await container.items.batch(
        [
          { operationType: "Create", resourceBody: { id: "b1", pk: "k", v: 1 } },
          { operationType: "Upsert", resourceBody: { id: "b2", pk: "k", v: 2 } },
          { operationType: "Read", id: "b1" },
        ],
        "k",
      );
      expect(response.code).toBe(200);
      expect(response.result.map((r: any) => r.statusCode)).toEqual([201, 201, 200]);
    });

    it("rolls back the whole batch on failure (atomic)", async () => {
      const { container } = await freshContainer();
      await container.items.create({ id: "exists", pk: "k" });
      const response = await container.items.batch(
        [
          { operationType: "Create", resourceBody: { id: "new1", pk: "k" } },
          { operationType: "Create", resourceBody: { id: "exists", pk: "k" } }, // 409
        ],
        "k",
      );
      // multi-status; failed op is 409, follow-ups become 424
      expect(response.code).toBe(207);
      const res = await container.item("new1", "k").read();
      expect(res.statusCode).toBe(404); // rolled back
    });
  });

  // -------------------------------------------------------------------------
  describe("Bulk operations", () => {
    it("executes a bulk of creates and reads", async () => {
      const { container } = await freshContainer();
      const operations = [
        { operationType: "Create", resourceBody: { id: "bk1", pk: "p1" } },
        { operationType: "Create", resourceBody: { id: "bk2", pk: "p2" } },
        { operationType: "Read", id: "bk1", partitionKey: "p1" },
      ];
      const results = await container.items.bulk(operations as any);
      expect(results.map((r: any) => r.statusCode)).toEqual([201, 201, 200]);
    });
  });

  // -------------------------------------------------------------------------
  describe("Stored procedures", () => {
    it("creates, lists, reads and deletes a stored procedure", async () => {
      const { container } = await freshContainer();
      await container.scripts.storedProcedures.create({
        id: "sp",
        body: "function(){ var c = getContext(); c.getResponse().setBody('ok'); }",
      });
      const { resources } = await container.scripts.storedProcedures.readAll().fetchAll();
      expect(resources.map((s: any) => s.id)).toContain("sp");
      const { resource } = await container.scripts.storedProcedure("sp").read();
      expect(resource.id).toBe("sp");
      await container.scripts.storedProcedure("sp").delete();
      const after = await container.scripts.storedProcedures.readAll().fetchAll();
      expect(after.resources.length).toBe(0);
    });

    it("executes a stored procedure with arguments", async () => {
      const { container } = await freshContainer();
      await container.scripts.storedProcedures.create({
        id: "double",
        body: "function(x){ getContext().getResponse().setBody(x * 2); }",
      });
      const { resource } = await container.scripts.storedProcedure("double").execute("p1", [21]);
      expect(resource).toBe(42);
    });

    it("a sproc can create a document via the collection API", async () => {
      const { container } = await freshContainer();
      await container.scripts.storedProcedures.create({
        id: "insert",
        body: `function(doc){
          var c = getContext();
          var coll = c.getCollection();
          coll.createDocument(coll.getSelfLink(), doc, function(err, created){
            c.getResponse().setBody(created.id);
          });
        }`,
      });
      const { resource } = await container.scripts.storedProcedure("insert").execute("p1", [{ id: "spdoc", pk: "p1" }]);
      expect(resource).toBe("spdoc");
      const { resource: read } = await container.item("spdoc", "p1").read();
      expect(read.id).toBe("spdoc");
    });
  });

  // -------------------------------------------------------------------------
  describe("Triggers and UDFs", () => {
    it("creates and lists a trigger", async () => {
      const { container } = await freshContainer();
      await container.scripts.triggers.create({
        id: "tr",
        body: "function(){}",
        triggerType: "Pre",
        triggerOperation: "All",
      });
      const { resources } = await container.scripts.triggers.readAll().fetchAll();
      expect(resources.map((t: any) => t.id)).toContain("tr");
    });

    it("creates, reads and deletes a UDF", async () => {
      const { container } = await freshContainer();
      await container.scripts.userDefinedFunctions.create({ id: "udf", body: "function(x){ return x; }" });
      const { resource } = await container.scripts.userDefinedFunction("udf").read();
      expect(resource.id).toBe("udf");
      await container.scripts.userDefinedFunction("udf").delete();
      const { resources } = await container.scripts.userDefinedFunctions.readAll().fetchAll();
      expect(resources.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Users and permissions", () => {
    it("creates, reads, lists and deletes users", async () => {
      const { database } = await freshContainer("udb", "c");
      await database.users.create({ id: "user1" });
      const { resource } = await database.user("user1").read();
      expect(resource.id).toBe("user1");
      const { resources } = await database.users.readAll().fetchAll();
      expect(resources.map((u: any) => u.id)).toContain("user1");
      await database.user("user1").delete();
      const after = await database.users.readAll().fetchAll();
      expect(after.resources.length).toBe(0);
    });

    it("upserts a user (insert then idempotent update)", async () => {
      const { database } = await freshContainer("udb2", "c");
      const first = await database.users.upsert({ id: "u" });
      expect(first.statusCode).toBe(201);
      const second = await database.users.upsert({ id: "u" });
      expect(second.statusCode).toBe(200);
      const { resource } = await database.user("u").read();
      expect(resource.id).toBe("u");
    });

    it("upserts a permission", async () => {
      const { database, container } = await freshContainer("udb5", "c");
      await database.users.create({ id: "pu" });
      const first = await database.user("pu").permissions.upsert({
        id: "perm",
        permissionMode: "Read",
        resource: container.url,
      });
      expect(first.statusCode).toBe(201);
      const second = await database.user("pu").permissions.upsert({
        id: "perm",
        permissionMode: "All",
        resource: container.url,
      });
      expect(second.statusCode).toBe(200);
      const { resource } = await database.user("pu").permission("perm").read();
      expect(resource.permissionMode).toBe("All");
    });

    it("creates a permission and returns a resource token", async () => {
      const { database, container } = await freshContainer("udb3", "c");
      await database.users.create({ id: "puser" });
      const { resource } = await database.user("puser").permissions.create({
        id: "perm",
        permissionMode: "Read",
        resource: container.url,
      });
      expect(resource.id).toBe("perm");
      expect(resource._token).toBeTruthy();
      expect(resource.permissionMode).toBe("Read");
    });

    it("lists and deletes permissions", async () => {
      const { database } = await freshContainer("udb4", "c");
      await database.users.create({ id: "puser" });
      await database.user("puser").permissions.create({
        id: "perm",
        permissionMode: "All",
        resource: "dbs/udb4/colls/c",
      });
      const { resources } = await database.user("puser").permissions.readAll().fetchAll();
      expect(resources.length).toBe(1);
      await database.user("puser").permission("perm").delete();
      const after = await database.user("puser").permissions.readAll().fetchAll();
      expect(after.resources.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Offers / throughput", () => {
    it("reads all offers", async () => {
      await freshContainer("odb", "c");
      const { resources } = await client.offers.readAll().fetchAll();
      expect(resources.length).toBeGreaterThan(0);
    });

    it("replaces container throughput via the offer", async () => {
      const { container } = await freshContainer("odb2", "c");
      const { resource: offer } = await container.readOffer();
      await client.offer(offer.id).replace({ ...offer, content: { offerThroughput: 800 } });
      const { resource: updated } = await container.readOffer();
      expect(updated.content.offerThroughput).toBe(800);
    });
  });

  // -------------------------------------------------------------------------
  describe("Conflicts", () => {
    it("lists conflicts (empty by default)", async () => {
      const { container } = await freshContainer("conflictdb", "c");
      const { resources } = await container.conflicts.readAll().fetchAll();
      expect(resources).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("Partition key ranges", () => {
    it("exposes a single partition key range", async () => {
      const { database, container } = await freshContainer("pkdb", "c");
      const res = await fetch(
        `${ENDPOINT}dbs/${database.id}/colls/${container.id}/pkranges`,
        { headers: { "x-ms-version": "2020-07-15" } },
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.PartitionKeyRanges.length).toBe(1);
      expect(body.PartitionKeyRanges[0].minInclusive).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  describe("Change feed", () => {
    it("reads all changes from the beginning", async () => {
      const { container } = await freshContainer("cfdb", "c");
      await container.items.create({ id: "cf1", pk: "p1" });
      await container.items.create({ id: "cf2", pk: "p1" });
      const iterator = container.items.changeFeed("p1", { startFromBeginning: true });
      const { result } = await iterator.fetchNext();
      expect(result.length).toBe(2);
    });

    it("returns only new items on subsequent polls (incremental)", async () => {
      const { container } = await freshContainer("cfdb2", "c");
      await container.items.create({ id: "a", pk: "p1" });
      await container.items.create({ id: "b", pk: "p1" });
      const iterator = container.items.changeFeed("p1", { startFromBeginning: true });
      const first = await iterator.fetchNext();
      expect(first.result.length).toBe(2);
      // drained
      const drained = await iterator.fetchNext();
      expect(drained.statusCode).toBe(304);
      // insert and poll again
      await container.items.create({ id: "c", pk: "p1" });
      const third = await iterator.fetchNext();
      expect(third.result.map((d: any) => d.id)).toEqual(["c"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("Validation / errors", () => {
    it("rejects an id containing illegal characters (server-side 400)", async () => {
      const { database, container } = await freshContainer("vdb", "c");
      // The client validates ids locally, so hit the REST surface directly to
      // assert the server's own 400 for an illegal document id.
      const res = await fetch(
        `${ENDPOINT}dbs/${database.id}/colls/${container.id}/docs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ms-version": "2020-07-15",
            "x-ms-documentdb-partitionkey": '["p1"]',
          },
          body: JSON.stringify({ id: "bad#id", pk: "p1" }),
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("BadRequest");
    });

    it("returns 404 for items in a missing container", async () => {
      const { database } = await client.databases.createIfNotExists({ id: "vdb2" });
      const ghost = database.container("ghost-coll");
      const res = await ghost.item("x", "p1").read();
      expect(res.statusCode).toBe(404);
    });

    it("malformed SQL yields a 400", async () => {
      const { container } = await freshContainer("vdb3", "c");
      await container.items.create({ id: "1", pk: "p1" });
      await expect(
        container.items.query("THIS IS NOT SQL").fetchAll(),
      ).rejects.toMatchObject({ code: 400 });
    });
  });
});
