# MongoDB

Lightweight, dependency-free MongoDB implementation speaking the real wire
protocol (OP_MSG + BSON), so the official `mongodb` driver connects with zero
config.

| Key | Value |
|-----|-------|
| Port | 27017 |
| Protocol | Wire protocol / BSON (TCP) |
| Size | ~90 KB |
| Startup | < 300ms |

## Default Connection

```
mongodb://localhost:27017
```

No auth required. Default database: `parlel`.

## Supported Commands

### Handshake / connection

`hello`, `ismaster`, `ping`, `buildInfo`, `hostInfo`, `getParameter`,
`whatsmyuri`, `connectionStatus`, `saslStart`/`saslContinue` (accepted),
`logout`, `getLog`, `endSessions`, `refreshSessions`.

### Write

| Command | Notes |
|---------|-------|
| `insert` | Insert one or many documents (auto `_id` if absent) |
| `update` | `q`/`u` updates, `$set`/`$inc`/etc., `multi`, `upsert` |
| `delete` | Delete by filter, `limit` |
| `findAndModify` | Atomic find + update/remove |

### Read

| Command | Notes |
|---------|-------|
| `find` | Filter, projection, sort, skip, limit |
| `getMore` | Cursor pagination |
| `count` | Count documents |
| `distinct` | Distinct field values |
| `aggregate` | Pipeline: `$match`, `$group`, `$sort`, `$project`, `$limit`, ... |

### Collections / databases / indexes

`create`, `drop`, `dropDatabase`, `listCollections`, `listDatabases`,
`listIndexes`, `createIndexes`, `dropIndexes`, `renameCollection`,
`collStats`, `dbStats`, `validate`.

## Usage

`localhost:27017` and your app connects with the **unmodified** official
`mongodb` driver — no Parlel code in the app.

```bash

```

```typescript
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://localhost:27017");
await client.connect();
const db = client.db("parlel");

await db.collection("users").insertMany([{ name: "Ada" }, { name: "Bob" }]);
const users = await db.collection("users").find({}).toArray();
await db.collection("users").updateOne({ name: "Ada" }, { $set: { role: "admin" } });
```

## Access via MCP (Parlel Sandbox)

When MongoDB runs inside a Parlel sandbox, drive it through the sandbox's MCP
endpoint with `parlel_execute`. The `command` is a JSON string — either a raw
Mongo command document or wrapped with an explicit `db`:

Insert:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "parlel_execute",
    "arguments": {
      "service": "mongodb",
      "command": "{\"db\":\"parlel\",\"command\":{\"insert\":\"users\",\"documents\":[{\"name\":\"Ada\"},{\"name\":\"Bob\"}]}}"
    }
  }
}
```

Find:

```json
{ "service": "mongodb", "command": "{\"db\":\"parlel\",\"command\":{\"find\":\"users\",\"filter\":{}}}" }
```

`ObjectId` values are rendered as hex strings and `Date` values as ISO strings
in the JSON result.

## Error codes & shapes

Errors use the real MongoDB envelope so driver/ODM error handling works unmodified.

Command-level errors return `{ ok: 0, errmsg, code, codeName }`:

```json
{ "ok": 0, "errmsg": "no such command: 'totallyBogusCommand'", "code": 59, "codeName": "CommandNotFound" }
```

Codes emitted match the real server (`code` ↔ `codeName`):

| Code | codeName | When |
|------|----------|------|
| 26 | `NamespaceNotFound` | `drop` / `dropIndexes` / `listIndexes` / `renameCollection` on a missing collection |
| 43 | `CursorNotFound` | `getMore` / `killCursors` on an unknown cursor id |
| 48 | `NamespaceExists` | `renameCollection` when the target already exists |
| 59 | `CommandNotFound` | unknown command name or unsupported opcode |
| 11000 | `DuplicateKey` | duplicate `_id` (see write errors below) |
| 1 | `InternalError` | unexpected handler failure |

Write commands (`insert`, `update`, `delete`) return `{ ok: 1, n, ... }` even
when individual documents fail; per-document failures appear in `writeErrors`.
A duplicate-key (`E11000`) write error matches MongoDB 4.2+ and includes
`keyPattern` and `keyValue` (which Mongoose surfaces as `err.keyPattern` /
`err.keyValue`):

```json
{
  "ok": 1, "n": 0,
  "writeErrors": [
    {
      "index": 0,
      "code": 11000,
      "keyPattern": { "_id": 1 },
      "keyValue": { "_id": 1 },
      "errmsg": "E11000 duplicate key error collection: parlel.users index: _id_ dup key: { _id: 1 }"
    }
  ]
}
```

## Access via Parlel Sandbox

WebSocket. The MongoDB driver connects to `mongodb://localhost:27017`

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| CRUD (`insert`/`find`/`update`/`delete`) | ✅ |
| Query operators (`$gt`, `$in`, `$regex`, `$elemMatch`, `$all`, `$size`, `$type`, `$not`, ...) | ✅ |
| Update operators (`$set`, `$inc`, `$push`, `$addToSet`, `$pull`, `$rename`, `$min`/`$max`, ...) | ✅ |
| `findAndModify` (update / remove / upsert, `new`) | ✅ |
| Cursors (`find` / `getMore` / `killCursors`, `batchSize`) | ✅ |
| Aggregation (`$match`, `$group`, `$sort`, `$project`, `$limit`, `$skip`, `$count`, `$unwind`, `$addFields`) | ✅ |
| Aggregation `$lookup` (cross-collection joins) | ⟳ |
| Indexes (`createIndexes` / `listIndexes` / `dropIndexes`) | ✅ stored; `_id` uniqueness enforced |
| Uniqueness for non-`_id` unique indexes | ◐ stored, not enforced |
| Error envelope (`code` + `codeName`; `E11000` `keyPattern`/`keyValue`) | ✅ |
| Collection / DB admin (`create`/`drop`/`listCollections`/`listDatabases`/`renameCollection`/`dropDatabase`) | ✅ |
| Stats (`collStats` / `dbStats`) | ◐ synthetic values, correct shape |
| Authentication (SCRAM) | ✓ by design (handshake accepted, not enforced) |
| Transactions / sessions | ✓ by design (accepted, not isolated) |
| Change streams | ⟳ |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MONGO_INITDB_ROOT_USERNAME=parlel
MONGO_INITDB_ROOT_PASSWORD=parlel
MONGO_INITDB_DATABASE=parlel
```

<!-- parlel:testenv:end -->
