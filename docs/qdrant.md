# Qdrant

Lightweight, dependency-free, in-memory Qdrant HTTP REST fake for local parlel tests.

Default port: `6333`

## Quick Start

```js
import { QdrantServer } from "../services/qdrant/src/server.js";
import { QdrantClient } from "@qdrant/js-client-rest";

const server = new QdrantServer(6333);
await server.start();

const client = new QdrantClient({ url: "http://127.0.0.1:6333", checkCompatibility: false });
await client.createCollection("items", { vectors: { size: 4, distance: "Cosine" } });
await client.upsert("items", {
  wait: true,
  points: [{ id: 1, vector: [1, 0, 0, 0], payload: { name: "demo" } }],
});
const hits = await client.search("items", { vector: [1, 0, 0, 0], limit: 1 });

await server.stop();
```

## Implemented Operations

Service and health:

- `GET /`
- `GET /healthz`
- `GET /livez`
- `GET /readyz`
- `GET /metrics`
- `GET /telemetry`
- `GET /issues`
- `DELETE /issues`

Cluster:

- `GET /cluster`
- `GET /cluster/telemetry`
- `POST /cluster/recover`
- `DELETE /cluster/peer/{peer_id}`

Collections and aliases:

- `GET /collections`
- `PUT /collections/{collection_name}`
- `GET /collections/{collection_name}`
- `PATCH /collections/{collection_name}`
- `DELETE /collections/{collection_name}`
- `GET /collections/{collection_name}/exists`
- `POST /collections/aliases`
- `GET /aliases`
- `GET /collections/{collection_name}/aliases`

Collection schema and vectors:

- `PUT /collections/{collection_name}/index`
- `DELETE /collections/{collection_name}/index/{field_name}`
- `PUT /collections/{collection_name}/vectors/{vector_name}`
- `DELETE /collections/{collection_name}/vectors/{vector_name}`
- `GET /collections/{collection_name}/cluster`
- `POST /collections/{collection_name}/cluster`
- `GET /collections/{collection_name}/optimizations`

Points and payloads:

- `GET /collections/{collection_name}/points/{id}`
- `PUT /collections/{collection_name}/points`
- `POST /collections/{collection_name}/points`
- `POST /collections/{collection_name}/points/delete`
- `PUT /collections/{collection_name}/points/vectors`
- `POST /collections/{collection_name}/points/vectors/delete`
- `PUT /collections/{collection_name}/points/payload`
- `POST /collections/{collection_name}/points/payload`
- `POST /collections/{collection_name}/points/payload/delete`
- `POST /collections/{collection_name}/points/payload/clear`
- `POST /collections/{collection_name}/points/batch`

Read, search, and query:

- `POST /collections/{collection_name}/points/scroll`
- `POST /collections/{collection_name}/points/count`
- `POST /collections/{collection_name}/points/search`
- `POST /collections/{collection_name}/points/search/batch`
- `POST /collections/{collection_name}/points/search/groups`
- `POST /collections/{collection_name}/points/recommend`
- `POST /collections/{collection_name}/points/recommend/batch`
- `POST /collections/{collection_name}/points/recommend/groups`
- `POST /collections/{collection_name}/points/discover`
- `POST /collections/{collection_name}/points/discover/batch`
- `POST /collections/{collection_name}/points/query`
- `POST /collections/{collection_name}/points/query/batch`
- `POST /collections/{collection_name}/points/query/groups`
- `POST /collections/{collection_name}/facet`
- `POST /collections/{collection_name}/points/search/matrix/pairs`
- `POST /collections/{collection_name}/points/search/matrix/offsets`

Snapshots:

- `GET /collections/{collection_name}/snapshots`
- `POST /collections/{collection_name}/snapshots`
- `GET /collections/{collection_name}/snapshots/{snapshot_name}`
- `DELETE /collections/{collection_name}/snapshots/{snapshot_name}`
- `PUT /collections/{collection_name}/snapshots/recover`
- `POST /collections/{collection_name}/snapshots/upload`
- `GET /snapshots`
- `POST /snapshots`
- `GET /snapshots/{snapshot_name}`
- `DELETE /snapshots/{snapshot_name}`

Shards:

- `GET /collections/{collection_name}/shards`
- `PUT /collections/{collection_name}/shards`
- `POST /collections/{collection_name}/shards/delete`
- `GET /collections/{collection_name}/shards/{shard_id}/snapshot`
- `GET /collections/{collection_name}/shards/{shard_id}/snapshots`
- `POST /collections/{collection_name}/shards/{shard_id}/snapshots`
- `GET /collections/{collection_name}/shards/{shard_id}/snapshots/{snapshot_name}`
- `DELETE /collections/{collection_name}/shards/{shard_id}/snapshots/{snapshot_name}`
- `PUT /collections/{collection_name}/shards/{shard_id}/snapshots/recover`
- `POST /collections/{collection_name}/shards/{shard_id}/snapshots/upload`

## Supported Features

| Feature | Support | Notes |
| --- | --- | --- |
| HTTP REST wire shape | Supported | Success responses use Qdrant-style `{ result, status: "ok", time }`. |
| `@qdrant/js-client-rest` high-level methods | Supported | Implemented for collection, point, payload, vector, query, search, recommend, discover, snapshot, shard, cluster telemetry, and alias methods. |
| Generated OpenAPI client endpoints | Supported where local | All generated local control-plane and data-plane routes are implemented or stubbed. |
| In-memory collections and points | Supported | State is process-local and reset with `server.reset()`. |
| Dense vector search | Supported | Cosine, dot, and euclidean scoring are approximated in memory. |
| Named vectors | Supported | Named vector metadata and point vector updates are stored in memory. |
| Payload filtering | Supported | `must`, `should`, `must_not`, `min_should`, `match`, `range`, `values_count`, `has_id`, `is_empty`, and `is_null` are supported. |
| Payload indexes | Supported as metadata | Index declarations are tracked but not used for performance. |
| Aliases | Supported | Create, delete, and rename alias actions are handled. |
| Snapshots | Stubbed | Metadata is stored, downloads return tiny placeholder content, recovery is a no-op success. |
| Shards and cluster | Stubbed | Single-node local responses only. No RAFT, replication, movement, or distributed persistence. |
| Authentication | Intentionally unsupported | `api-key` headers are accepted but not validated. |
| Persistence | Intentionally unsupported | Data is ephemeral and lost on `stop()` or `reset()`. |
| Real HNSW indexes and quantization | Intentionally unsupported | Config is accepted and returned, but search is linear scan. |

## Error Shapes

Common success shape:

```json
{
  "result": {},
  "status": "ok",
  "time": 0.000123
}
```

Point read/search responses also include a lightweight usage object:

```json
{
  "result": [],
  "status": "ok",
  "time": 0.000123,
  "usage": {
    "cpu": 1,
    "payload_io_read": 0,
    "payload_io_write": 0,
    "payload_index_io_read": 0,
    "payload_index_io_write": 0,
    "vector_io_read": 0,
    "vector_io_write": 0
  }
}
```

Common error shape:

```json
{
  "status": {
    "error": "Collection books not found"
  },
  "time": 0.000123
}
```

Returned status codes:

| Status | When |
| --- | --- |
| `200` | Successful REST operation. |
| `204` | `OPTIONS` preflight. |
| `400` | Missing required fields such as `field_name`. |
| `404` | Unknown endpoint, missing collection, or missing point. |
| `405` | Known path with unsupported HTTP method. |
| `409` | Duplicate collection creation. |
| `500` | Unexpected server error. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
QDRANT_URL=http://localhost:6333
QDRANT_HOST=localhost:6333
QDRANT_PORT=6333
QDRANT_API_KEY=parlel
```

<!-- parlel:testenv:end -->
