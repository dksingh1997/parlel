# Cosmos DB

Lightweight, dependency-free fake of **Azure Cosmos DB** that speaks the real Cosmos DB **SQL (Core) REST API**, so application code using the `@azure/cosmos` client can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4591 |
| Protocol | Azure Cosmos DB SQL (Core) REST API (HTTP/1.1 + JSON) |
| Compatible client | `@azure/cosmos` (v4) |
| Size | ~80 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { CosmosdbServer } from "./services/cosmosdb/src/server.js";

const server = new CosmosdbServer(4591);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real Cosmos DB client. The fake never validates the `authorization`
header, so any key works — the well-known Cosmos emulator key is convenient. Disable
endpoint discovery so all traffic is routed to the single parlel endpoint.

```js
import { CosmosClient } from "@azure/cosmos";

const client = new CosmosClient({
  endpoint: "http://127.0.0.1:4591/",
  key: "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==",
  // Single-region fake: skip multi-region endpoint discovery.
  connectionPolicy: { enableEndpointDiscovery: false },
});

// Create a database + container
const { database } = await client.databases.createIfNotExists({ id: "appdb" });
const { container } = await database.containers.createIfNotExists({
  id: "users",
  partitionKey: { paths: ["/pk"] },
});

// Write
await container.items.create({ id: "alice", pk: "tenant-1", name: "Alice", age: 30 });

// Read (id + partition key)
const { resource } = await container.item("alice", "tenant-1").read();
console.log(resource.name); // "Alice"

// Query (cross-partition by default)
const { resources } = await container.items
  .query("SELECT * FROM c WHERE c.age >= 18 ORDER BY c.age DESC")
  .fetchAll();

// Parameterized query
const { resources: bobs } = await container.items
  .query({
    query: "SELECT * FROM c WHERE c.name = @name",
    parameters: [{ name: "@name", value: "Bob" }],
  })
  .fetchAll();

// Patch
await container.item("alice", "tenant-1").patch([{ op: "incr", path: "/age", value: 1 }]);
```

Reset all state between tests:

```js
await fetch("http://127.0.0.1:4591/_parlel/reset", { method: "POST" });
```

## Environment variables

The manifest exposes:

| Variable | Value |
|----------|-------|
| `COSMOS_ENDPOINT` | `http://127.0.0.1:4591/` |
| `COSMOS_KEY` | well-known emulator key (see Quick Start) |
| `COSMOS_CONNECTION_STRING` | `AccountEndpoint=http://127.0.0.1:4591/;AccountKey=...;` |

## Implemented operations

All paths are resource-link addressed exactly like the real service.

### Database account
- `GET /` — database account (consistency policy, read/write locations, query engine config). Powers `client.getDatabaseAccount()`, `getReadEndpoints()`, `getWriteEndpoints()`.

### Databases (`client.databases` / `client.database(id)`)
- `create`, `createIfNotExists`
- `read`, `delete`
- `readAll` (list), `query`
- `readOffer` (database-level shared throughput)

### Containers (`database.containers` / `database.container(id)`)
- `create`, `createIfNotExists`
- `read`, `replace`, `delete`
- `readAll` (list), `query`
- `readOffer`, `getFeedRanges` / `readPartitionKeyRanges`
- `deleteAllItemsForPartitionKey`

### Items (`container.items` / `container.item(id, pk)`)
- `create`, `upsert`
- `read`, `replace`, `delete`, `patch`
- `readAll` (list)
- `query` (with query-plan negotiation, partition-key range routing, paging)
- `changeFeed` (incremental, partition-scoped, continuation-aware)
- `batch` (transactional batch, atomic with rollback)
- `bulk` (grouped per-partition operations)

### Query language (subset)
- `SELECT *`, `SELECT VALUE expr`, `SELECT a, b [AS alias]`
- `WHERE` with `AND` / `OR` / `NOT`, comparisons (`= != <> < > <= >=`), `IN (...)`
- `ORDER BY expr [ASC|DESC]` (multi-column)
- `TOP n`, `OFFSET n LIMIT m`, `DISTINCT`
- Aggregates: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`
- Built-in functions: `CONTAINS`, `STARTSWITH`, `ENDSWITH`, `UPPER`, `LOWER`,
  `LENGTH`/`STRLEN`, `CONCAT`, `ABS`, `FLOOR`, `CEILING`, `ROUND`, `IS_DEFINED`,
  `IS_NULL`, `IS_STRING`, `IS_NUMBER`, `IS_BOOL`, `IS_ARRAY`, `IS_OBJECT`,
  `ARRAY_CONTAINS`, `ARRAY_LENGTH`, `TOSTRING`
- Parameterized queries (`@param`)

### Stored procedures / triggers / UDFs (`container.scripts`)
- StoredProcedures: `create`, `read`, `replace`, `delete`, `readAll`, `query`, `execute`
  (a constrained JS runtime provides `getContext()`, `getResponse().setBody()`, and a
  `getCollection()` shim supporting `createDocument` / `replaceDocument` / `queryDocuments`)
- Triggers: `create`, `read`, `replace`, `delete`, `readAll`, `query`
- UserDefinedFunctions: `create`, `read`, `replace`, `delete`, `readAll`, `query`

### Users & permissions (`database.users` / `database.user(id)`)
- Users: `create`, `upsert`, `read`, `replace`, `delete`, `readAll`, `query`
- Permissions: `create`, `upsert`, `read`, `replace`, `delete`, `readAll`, `query`
  (returns a synthetic `_token` resource token)

### Offers / throughput (`client.offers` / `client.offer(id)`)
- `readAll`, `query` (by resource link)
- `read`, `replace` (change provisioned throughput)

### Conflicts (`container.conflicts`)
- `readAll`, `query`, single `read`, `delete` (empty by default — the fake has no
  multi-master replication, so conflicts never arise organically)

### Control plane (parlel-only)
- `GET /_parlel/health` — `{ status, service, databases }`
- `POST /_parlel/reset` — wipe all state

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Databases / containers / items CRUD | ✅ Supported |
| Partition keys (single & hierarchical paths) | ✅ Supported |
| Upsert, replace, delete, patch (add/set/replace/remove/incr) | ✅ Supported |
| SQL queries (filter, order, top, offset/limit, distinct, aggregates, functions) | ✅ Supported |
| Parameterized queries | ✅ Supported |
| Query plan negotiation + partition key ranges | ✅ Supported |
| Pagination (`maxItemCount` + continuation token) | ✅ Supported |
| Change feed (incremental, continuation-aware) | ✅ Supported |
| Transactional batch (atomic, rollback on failure) | ✅ Supported |
| Bulk operations | ✅ Supported |
| Stored procedures (with a JS execution shim) | ✅ Supported |
| Triggers & UDFs (CRUD; not executed during writes) | ✅ Supported (storage only) |
| Users, permissions, resource tokens (synthetic) | ✅ Supported |
| Offers / provisioned throughput (read + replace) | ✅ Supported |
| Optimistic concurrency (`If-Match` / ETag → 412) | ✅ Supported |
| Conflicts feed | ✅ Supported (always empty) |
| HMAC auth signature verification | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| TLS / HTTPS | ✓ By design — Plain in-memory storage — transport/at-rest crypto is unnecessary locally |
| Multi-region replication & endpoint discovery | ⟳ Roadmap — Single endpoint (disable discovery) |
| Indexing policy enforcement | ✓ By design — Stored, not enforced (full scans) |
| TTL expiry | ✓ By design — `defaultTtl` stored, not enforced |
| Server-side trigger execution / UDF evaluation in queries | ⟳ Roadmap — Not executed |
| Vector / full-text / hybrid search | ⟳ Roadmap |
| Continuation-token opaqueness | ⚠️ Simplified (numeric offsets / LSNs) |

## Error codes & shapes

Errors are returned as JSON `{ "code": "<string>", "message": "<string>" }` with the
matching HTTP status and Cosmos headers (`x-ms-activity-id`, `x-ms-request-charge`,
`x-ms-session-token`, and `x-ms-substatus` where relevant). The `@azure/cosmos` client
surfaces `error.code` as the **HTTP status number**.

| HTTP | `code` | When |
|------|--------|------|
| 400 | `BadRequest` | invalid id / body / malformed SQL |
| 404 | `NotFound` (substatus `0`) | missing database / container / item / script |
| 409 | `Conflict` | creating a resource whose id already exists |
| 412 | `PreconditionFailed` | `If-Match` ETag mismatch on replace/delete/patch |
| 207 | (per-op statuses) | transactional batch where an operation failed (others → `424`) |
| 304 | (empty) | change feed with no new changes since the continuation |
| 500 | `InternalServerError` | unexpected server error |

Per-operation batch/bulk results carry `{ statusCode, requestCharge, resourceBody?, eTag? }`.
A failed atomic batch returns each subsequent operation as `424` (Failed Dependency) and
rolls back all applied mutations.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
COSMOS_ENDPOINT=http://localhost:4591/
COSMOS_KEY=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==
COSMOS_CONNECTION_STRING=AccountEndpoint=http://127.0.0.1:4591/;AccountKey=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==;
```

<!-- parlel:testenv:end -->
