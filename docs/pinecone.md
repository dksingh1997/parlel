# Pinecone

Lightweight, dependency-free, in-memory Pinecone-compatible REST service for local parlel tests.

Default port: `5081`

## Quick Start

Start the server in process:

```js
import { PineconeServer } from "./services/pinecone/src/server.js";

const server = new PineconeServer(5081);
await server.start();
```

Connect with the real `@pinecone-database/pinecone` client by pointing control-plane and index hosts at the local server. The fake returns local `http://127.0.0.1:5081/indexes/<name>` hosts from `describeIndex`.

```js
import { Pinecone } from "@pinecone-database/pinecone";

const pc = new Pinecone({
  apiKey: "parlel",
  controllerHostUrl: "http://127.0.0.1:5081",
});

await pc.createIndex({
  name: "movies",
  dimension: 3,
  metric: "cosine",
  spec: { serverless: { cloud: "aws", region: "us-east-1" } },
});

const description = await pc.describeIndex("movies");
const index = pc.index("movies", description.host);
await index.upsert([{ id: "a", values: [1, 0, 0], metadata: { genre: "sci-fi" } }]);
const results = await index.query({ vector: [1, 0, 0], topK: 1, includeMetadata: true });
```

Stop it when finished:

```js
await server.stop();
```

## Implemented Operations

### Server

| Operation | Endpoint |
| --- | --- |
| Root metadata | `GET /` |
| Healthcheck | `GET /health` |
| Project identity | `GET /actions/whoami` |
| Reset state | `server.reset()` |

### Index Control Plane

| Operation | Endpoint |
| --- | --- |
| Create index / create index for model | `POST /indexes` |
| Create index for model SDK route | `POST /indexes/create-for-model` |
| List indexes | `GET /indexes` |
| Describe index | `GET /indexes/:name` |
| Configure index | `PATCH /indexes/:name` |
| Delete index | `DELETE /indexes/:name` |

### Vector Data Plane

All data-plane routes are available below `/indexes/:name`. If exactly one index exists, root data-plane paths such as `/vectors/upsert` also route to it.

| Operation | Endpoint |
| --- | --- |
| Upsert vectors | `POST /indexes/:name/vectors/upsert` |
| Fetch vectors | `POST /indexes/:name/vectors/fetch` |
| Fetch vectors by query string | `GET /indexes/:name/vectors/fetch?ids=<id>&namespace=<namespace>` |
| Fetch vectors by metadata | `POST /indexes/:name/vectors/fetch_by_metadata` |
| Update vector | `POST /indexes/:name/vectors/update` |
| Delete by ids, filter, or deleteAll | `POST /indexes/:name/vectors/delete` |
| Query by vector or id | `POST /indexes/:name/query` |
| List vector ids with prefix pagination | `GET /indexes/:name/vectors/list` |
| Describe index stats | `POST /indexes/:name/describe_index_stats` |

### Integrated Records

| Operation | Endpoint |
| --- | --- |
| Upsert records | `POST /indexes/:name/records/namespaces/:namespace/upsert` |
| Search records | `POST /indexes/:name/records/namespaces/:namespace/search` |
| Upsert records compatibility route | `POST /indexes/:name/vectors/upsert_records` |

### Namespaces

| Operation | Endpoint |
| --- | --- |
| List namespaces | `GET /indexes/:name/namespaces` |
| Create namespace | `POST /indexes/:name/namespaces` |
| Describe namespace | `GET /indexes/:name/namespaces/:namespace` |
| Delete namespace | `DELETE /indexes/:name/namespaces/:namespace` |

### Collections

| Operation | Endpoint |
| --- | --- |
| Create collection | `POST /collections` |
| List collections | `GET /collections` |
| Describe collection | `GET /collections/:name` |
| Delete collection | `DELETE /collections/:name` |

### Backups

| Operation | Endpoint |
| --- | --- |
| Create backup | `POST /indexes/:name/backups` |
| List backups for index | `GET /indexes/:name/backups` |
| List backups | `GET /backups` |
| Describe backup | `GET /backups/:backup_id` |
| Delete backup | `DELETE /backups/:backup_id` |
| Create index from backup | `POST /backups/:backup_id/create-index`, `POST /indexes/create-index-from-backup` |
| List restore jobs | `GET /restore-jobs` |
| Describe restore job | `GET /restore-jobs/:restore_job_id` |

### Bulk Imports

| Operation | Endpoint |
| --- | --- |
| Start import | `POST /indexes/:name/bulk/imports` |
| List imports | `GET /indexes/:name/bulk/imports` |
| Describe import | `GET /indexes/:name/bulk/imports/:id` |
| Cancel import | `DELETE /indexes/:name/bulk/imports/:id` |

### Inference

| Operation | Endpoint |
| --- | --- |
| Embed | `POST /embed`, `POST /inference/embed` |
| Rerank | `POST /rerank`, `POST /inference/rerank` |
| List models | `GET /models` |
| Describe model | `GET /models/:model_name` |

## Supported Features

| Feature | Status | Notes |
| --- | --- | --- |
| Pinecone HTTP REST shape | Supported | JSON responses, Pinecone-style error envelope, local host in index descriptions. |
| `@pinecone-database/pinecone` common control-plane calls | Supported | Create, list, describe, configure, delete, whoami. |
| Dense vectors | Supported | Dimension validation is enforced. |
| Sparse vector score contribution | Supported | Sparse dot product is added to dense scores. |
| Namespaces | Supported | Namespace state is in memory and ephemeral. |
| Metadata filters | Supported | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$and`, `$or`. |
| Integrated records | Supported | Text embeddings are deterministic local hashes, not ML embeddings. |
| Collections | Supported | Metadata snapshot only; no durable storage. |
| Backups | Supported | Metadata snapshot and restore configuration only; no durable storage. |
| Bulk imports | Supported | Job lifecycle is faked; no object storage is read. |
| Inference embed/rerank | Supported | Deterministic local fake outputs. |
| Inference models | Supported | Returns local fake model metadata. |
| Authentication and authorization | Intentionally unsupported | API keys are accepted but not checked. |
| Real Pinecone scaling, pods, serverless provisioning | Intentionally unsupported | All state is in-process memory. |
| Durability | Intentionally unsupported | Use `server.reset()` or process restart to clear state. |
| Real ML embeddings or reranking | Intentionally unsupported | Returned vectors/scores are deterministic fakes for testing. |

## Error Shapes

Errors use a Pinecone-style JSON envelope:

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Index name is required"
  },
  "status": 400
}
```

Common codes:

| HTTP status | Code | When returned |
| --- | --- | --- |
| `400` | `INVALID_ARGUMENT` | Missing names, malformed vector/record payloads, dimension mismatch. |
| `400` | `FAILED_PRECONDITION` | Deleting an index with deletion protection enabled. |
| `404` | `NOT_FOUND` | Missing index, vector, namespace, collection, backup, or route. |
| `405` | `METHOD_NOT_ALLOWED` | Known resource with unsupported method. |
| `409` | `ALREADY_EXISTS` | Duplicate index or collection. |
| `500` | `INTERNAL` | Unhandled server error. |

## State Model

All indexes, namespaces, vectors, collections, backups, and inference outputs are held in memory. State is ephemeral and can be cleared with `server.reset()`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PINECONE_API_KEY=parlel
PINECONE_ENVIRONMENT=local
PINECONE_CONTROLLER_HOST=http://localhost:5081
```

<!-- parlel:testenv:end -->
