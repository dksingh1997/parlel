# Firestore

Lightweight, dependency-free fake of Google Cloud Firestore (Native mode) that speaks the real Firestore **v1 REST API** (`https://firestore.googleapis.com/v1`), so application code using `@google-cloud/firestore` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4581 |
| Protocol | Firestore v1 REST API (HTTP/1.1 + proto3 JSON) |
| Compatible client | `@google-cloud/firestore` (v7) with `preferRest: true` |
| Size | ~90 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { FirestoreServer } from "./services/firestore/src/server.js";

const server = new FirestoreServer(4581);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real Firestore client. The client talks gRPC by default, so two
things are required to route it to the parlel fake over plain HTTP:

1. Set `FIRESTORE_EMULATOR_HOST` **before** constructing the client.
2. Pass `preferRest: true` so the client uses its HTTP/1.1 REST transport.

```js
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:4581";

import { Firestore, FieldValue } from "@google-cloud/firestore";

const db = new Firestore({
  projectId: "parlel",
  preferRest: true,
  // Any *valid* service-account key works — the fake never verifies the token,
  // but the client signs a JWT locally, so the private_key must be a real PEM.
  credentials: {
    client_email: "parlel@parlel.iam.gserviceaccount.com",
    private_key: PRIVATE_KEY_PEM, // e.g. from crypto.generateKeyPairSync("rsa", ...)
  },
});

// Write
await db.collection("users").doc("alice").set({ name: "Alice", age: 30 });

// Read
const snap = await db.collection("users").doc("alice").get();
console.log(snap.data()); // { name: "Alice", age: 30 }

// Query
const adults = await db.collection("users").where("age", ">=", 18).get();
console.log(adults.size);

// Atomic field update
await db.collection("users").doc("alice").update({ age: FieldValue.increment(1) });
```

> The manifest sets `FIRESTORE_EMULATOR_HOST=127.0.0.1:4581`, `GOOGLE_CLOUD_PROJECT=parlel`
> and `GCLOUD_PROJECT=parlel` for you when the service is launched by the pool.

## Why `preferRest`?

The real `@google-cloud/firestore` client speaks gRPC over HTTP/2 by default.
The parlel fake is a pure-Node, zero-dependency HTTP/1.1 server, so it implements
the Firestore **v1 REST** surface that the client's `preferRest` fallback uses.
The two streaming-only RPCs (`Write`, `Listen`) require gRPC and are intentionally
not supported.

## Implemented operations / endpoints

All Firestore v1 RPCs are transcoded by the client to these REST endpoints:

### Documents (CRUD)

| RPC | HTTP | Path |
|-----|------|------|
| GetDocument | `GET` | `/v1/{name=projects/*/databases/*/documents/*/**}` |
| ListDocuments | `GET` | `/v1/{parent=.../documents}/{collectionId}` |
| CreateDocument | `POST` | `/v1/{parent=.../documents/**}/{collectionId}?documentId=` |
| UpdateDocument | `PATCH` | `/v1/{document.name=.../documents/*/**}` |
| DeleteDocument | `DELETE` | `/v1/{name=.../documents/*/**}` |

### Reads & queries

| RPC | HTTP | Path |
|-----|------|------|
| BatchGetDocuments | `POST` | `/v1/{database}/documents:batchGet` |
| RunQuery | `POST` | `/v1/{parent}/documents:runQuery` |
| RunAggregationQuery | `POST` | `/v1/{parent}/documents:runAggregationQuery` |
| PartitionQuery | `POST` | `/v1/{parent}/documents:partitionQuery` |
| ListCollectionIds | `POST` | `/v1/{parent}/documents:listCollectionIds` |

### Writes & transactions

| RPC | HTTP | Path |
|-----|------|------|
| BeginTransaction | `POST` | `/v1/{database}/documents:beginTransaction` |
| Commit | `POST` | `/v1/{database}/documents:commit` |
| Rollback | `POST` | `/v1/{database}/documents:rollback` |
| BatchWrite | `POST` | `/v1/{database}/documents:batchWrite` |

### Internal (parlel-only, not part of Firestore)

| HTTP | Path | Purpose |
|------|------|---------|
| `GET` | `/_parlel/health` | Liveness + document count |
| `POST` | `/_parlel/reset` | Wipe all in-memory state |
| `GET` | `/_parlel/dump` | Dump raw stored documents (debugging) |

## High-level client features exercised

These map onto the RPCs above and are all covered by `tests/firestore.test.ts`:

- `doc.set()`, `doc.set(..., { merge: true })`, `doc.set(..., { mergeFields })`
- `doc.create()`, `collection.add()` (auto-id)
- `doc.update()` including dotted nested paths
- `doc.delete()` with `{ exists }` preconditions
- `doc.get()` (existent + non-existent snapshots), `createTime`/`updateTime`
- `db.getAll(...)` (BatchGetDocuments), including transactional `getAll`
- `db.batch()` write batches (set/update/delete)
- `db.bulkWriter()` (BatchWrite)
- `db.runTransaction()` — read, write, commit, and rollback-on-throw
- Queries: `where` (`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`,
  `array-contains`, `array-contains-any`), `Filter.or(...)`, `orderBy`
  (asc/desc), `limit`, `offset`, `startAt`/`startAfter`/`endAt`/`endBefore`
  cursors, `select(...)` projections, and `FieldPath.documentId()`
- Aggregations: `count()`, `AggregateField.sum()`, `AggregateField.average()`
- `collection.listDocuments()`, `db.listCollections()`, `doc.listCollections()`
- `db.collectionGroup()` queries and `getPartitions()`
- Field transforms: `FieldValue.serverTimestamp()`, `increment()`,
  `arrayUnion()`, `arrayRemove()`, `delete()`

## Supported value types

All Firestore value types round-trip through proto3 JSON:

`nullValue`, `booleanValue`, `integerValue`, `doubleValue`, `stringValue`,
`bytesValue`, `timestampValue`, `geoPointValue`, `referenceValue`,
`arrayValue`, and `mapValue` (nested maps).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
|---------|--------|-------|
| Document CRUD (get/set/create/update/delete) | ✅ Supported | |
| set merge / mergeFields | ✅ Supported | |
| Field transforms (serverTimestamp, increment, min/max, arrayUnion/Remove, delete) | ✅ Supported | |
| Structured queries (filters, order, limit, offset, cursors, projection) | ✅ Supported | |
| Composite `OR` / `AND` filters | ✅ Supported | |
| Aggregations (count, sum, avg) | ✅ Supported | |
| Transactions (begin/commit/rollback) | ✅ Supported | Best-effort: no read-isolation or optimistic-retry enforcement |
| BatchGet / WriteBatch / BulkWriter | ✅ Supported | |
| Subcollections & collection-group queries | ✅ Supported | `allDescendants` supported |
| PartitionQuery | ✅ Supported | Always returns a single partition (no cursors) |
| ListDocuments / ListCollectionIds | ✅ Supported | Name-ordered, `pageSize`/`pageToken` paging |
| Preconditions (`exists`, `updateTime`) | ✅ Supported | |
| `Write` (streaming) | ⛔ Unsupported | gRPC-streaming only → `501 UNIMPLEMENTED` |
| `Listen` (real-time snapshots) | ⛔ Unsupported | gRPC-streaming only → `501 UNIMPLEMENTED`; `onSnapshot` is not available |
| `FindNearest` / vector search | ⛔ Unsupported | Parsed but not executed |
| Security rules / auth enforcement | ⛔ Unsupported | All requests are treated as admin |
| Indexes / index-error simulation | ⛔ Unsupported | All queries run without index requirements |
| Persistence across restarts | ⛔ Unsupported | State is in-memory and ephemeral |

## Error codes / shapes

Errors use the standard Google error envelope:

```json
{
  "error": {
    "code": 404,
    "message": "Document not found: projects/parlel/databases/(default)/documents/users/ghost",
    "status": "NOT_FOUND"
  }
}
```

The `@google-cloud/firestore` REST transport (google-gax) maps the body `code`
to a canonical gRPC status, which surfaces as `error.code` on the thrown error:

| Condition | gRPC code | gRPC status |
|-----------|-----------|-------------|
| Document not found (`get`/`update` missing) | 5 | `NOT_FOUND` |
| Create on existing doc / failed precondition | 9 | `FAILED_PRECONDITION` |
| Invalid argument / malformed JSON | 3 | `INVALID_ARGUMENT` |
| `Write` / `Listen` streaming RPCs | 12 | `UNIMPLEMENTED` |
| Internal error | 13 | `INTERNAL` |

> Note: because the REST transport maps errors strictly by HTTP status, a
> create-conflict is surfaced as `FAILED_PRECONDITION` (non-retryable) rather
> than `ALREADY_EXISTS` — there is no HTTP status that the client decodes to
> `ALREADY_EXISTS`, and the retryable `ABORTED` mapping (HTTP 409) would cause
> the client's write-batch layer to retry. The operation still rejects, which is
> the behavior callers depend on.

## Resetting state

```js
// Programmatically
server.reset();

// Over HTTP
await fetch("http://127.0.0.1:4581/_parlel/reset", { method: "POST" });
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FIRESTORE_EMULATOR_HOST=localhost:4581
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
