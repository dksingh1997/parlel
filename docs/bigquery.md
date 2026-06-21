# BigQuery

Lightweight, dependency-free fake of Google Cloud BigQuery that speaks the real **BigQuery v2 REST API** (`https://bigquery.googleapis.com/bigquery/v2`), so application code using `@google-cloud/bigquery` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4583 |
| Protocol | BigQuery v2 REST API (HTTP/1.1 + JSON) |
| Compatible client | `@google-cloud/bigquery` (v8) |
| Size | ~80 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { BigqueryServer } from "./services/bigquery/src/server.js";

const server = new BigqueryServer(4583);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real BigQuery client. Two things route it to the parlel fake:

1. Set `BIGQUERY_EMULATOR_HOST` **before** constructing the client — its value becomes the client's `baseUrl`.
2. Inject an offline auth client so the common layer does not attempt a real OAuth
   token exchange against Google. The fake never validates tokens.

```js
process.env.BIGQUERY_EMULATOR_HOST = "http://127.0.0.1:4583";

import { BigQuery } from "@google-cloud/bigquery";
import { GoogleAuth } from "google-auth-library";

// A no-network auth client: authorizeRequest is a no-op that injects a fake
// bearer token. The fake never checks it.
const auth = new GoogleAuth({ projectId: "parlel" });
auth.authorizeRequest = async (opts = {}) => {
  opts.headers = opts.headers || {};
  opts.headers.Authorization = "Bearer parlel-fake-token";
  return opts;
};
auth.getProjectId = async () => "parlel";

const bq = new BigQuery({ projectId: "parlel", authClient: auth });

// Create a dataset + table
const [dataset] = await bq.createDataset("analytics");
const [table] = await dataset.createTable("events", {
  schema: [
    { name: "id", type: "INTEGER" },
    { name: "name", type: "STRING" },
    { name: "ts", type: "TIMESTAMP" },
  ],
});

// Stream rows in
await table.insert([
  { id: 1, name: "signup", ts: "2024-01-01T00:00:00Z" },
  { id: 2, name: "purchase", ts: "2024-01-02T00:00:00Z" },
]);

// Query
const [rows] = await bq.query("SELECT name FROM analytics.events WHERE id = @id", {
  params: { id: 1 },
});
console.log(rows); // [{ name: "signup" }]

// Parameterised / job-based query
const [job] = await bq.createQueryJob({ query: "SELECT COUNT(*) AS c FROM analytics.events" });
const [results] = await job.getQueryResults();
console.log(results); // [{ c: 2 }]
```

> The endpoint URL the client composes is `{BIGQUERY_EMULATOR_HOST}/projects/{projectId}/{uri}` — this server implements the full BigQuery v2 resource tree under `/projects/{projectId}/…`.

## Implemented operations

### Datasets
| Operation | Method + path |
|-----------|---------------|
| `datasets.insert` (createDataset) | `POST /projects/{p}/datasets` |
| `datasets.list` (getDatasets) | `GET /projects/{p}/datasets` |
| `datasets.get` (getMetadata / exists) | `GET /projects/{p}/datasets/{d}` |
| `datasets.patch` (setMetadata) | `PATCH /projects/{p}/datasets/{d}` |
| `datasets.delete` (delete, `deleteContents`) | `DELETE /projects/{p}/datasets/{d}` |

### Tables
| Operation | Method + path |
|-----------|---------------|
| `tables.insert` (createTable) | `POST /projects/{p}/datasets/{d}/tables` |
| `tables.list` (getTables) | `GET /projects/{p}/datasets/{d}/tables` |
| `tables.get` (getMetadata / exists) | `GET /projects/{p}/datasets/{d}/tables/{t}` |
| `tables.patch` (setMetadata) | `PATCH /projects/{p}/datasets/{d}/tables/{t}` |
| `tables.delete` (delete) | `DELETE /projects/{p}/datasets/{d}/tables/{t}` |
| `tabledata.list` (getRows) | `GET /projects/{p}/datasets/{d}/tables/{t}/data` |
| `tabledata.insertAll` (insert) | `POST /projects/{p}/datasets/{d}/tables/{t}/insertAll` |
| `tables.getIamPolicy` | `POST …/tables/{t}:getIamPolicy` |
| `tables.setIamPolicy` | `POST …/tables/{t}:setIamPolicy` |
| `tables.testIamPermissions` | `POST …/tables/{t}:testIamPermissions` |

### Jobs & Queries
| Operation | Method + path |
|-----------|---------------|
| `jobs.insert` (createJob / createQueryJob / createLoadJob / createCopyJob / extract) | `POST /projects/{p}/jobs` |
| `jobs.list` (getJobs) | `GET /projects/{p}/jobs` |
| `jobs.get` (getMetadata) | `GET /projects/{p}/jobs/{j}` |
| `jobs.cancel` (cancel) | `POST /projects/{p}/jobs/{j}/cancel` |
| `jobs.delete` (delete) | `DELETE /projects/{p}/jobs/{j}/delete` |
| `jobs.query` (query) | `POST /projects/{p}/queries` |
| `jobs.getQueryResults` (getQueryResults) | `GET /projects/{p}/queries/{j}` |

### Routines
| Operation | Method + path |
|-----------|---------------|
| `routines.insert` (createRoutine) | `POST /projects/{p}/datasets/{d}/routines` |
| `routines.list` (getRoutines) | `GET /projects/{p}/datasets/{d}/routines` |
| `routines.get` (getMetadata / exists) | `GET /projects/{p}/datasets/{d}/routines/{r}` |
| `routines.update` (setMetadata) | `PUT /projects/{p}/datasets/{d}/routines/{r}` |
| `routines.delete` (delete) | `DELETE /projects/{p}/datasets/{d}/routines/{r}` |

### Models
| Operation | Method + path |
|-----------|---------------|
| `models.list` (getModels) | `GET /projects/{p}/datasets/{d}/models` |
| `models.get` (getMetadata / exists) | `GET /projects/{p}/datasets/{d}/models/{m}` |
| `models.patch` (setMetadata) | `PATCH /projects/{p}/datasets/{d}/models/{m}` |
| `models.delete` (delete) | `DELETE /projects/{p}/datasets/{d}/models/{m}` |

### Internal parlel endpoints (not part of BigQuery)
| Endpoint | Purpose |
|----------|---------|
| `GET /_parlel/health` | Liveness + counts (`datasets`, `jobs`) |
| `POST /_parlel/reset` | Drop all in-memory state |
| `GET /_parlel/dump` | List dataset + job ids |

## SQL engine

Queries (`jobs.query` and query jobs) run through a small, pragmatic SQL subset
sufficient for testing application logic:

- `SELECT <literals>` with no `FROM` (e.g. `SELECT 1 AS one, 'hi' AS greeting`)
- `SELECT * | col, col AS alias FROM [project.]dataset.table`
- `WHERE` with `=, !=, <>, >, <, >=, <=`, `IS [NOT] NULL`, and `AND`-joined predicates
- `ORDER BY col [ASC|DESC]` (multiple keys)
- `LIMIT n`
- `SELECT COUNT(*) [AS alias] FROM …`
- Named (`@name`) and positional (`?`) query parameters
- DDL/DML statements (`CREATE`/`INSERT`/`UPDATE`/`DELETE`/`MERGE`/`DROP`) are
  accepted and reported with the correct `statementType` but produce no rows.

Rows are returned in BigQuery's wire shape — `{ f: [{ v }, …] }` paired with a
`schema.fields` array — and the client merges them back into plain objects.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Dataset CRUD | ✅ Supported |
| Table CRUD (incl. views) | ✅ Supported |
| Streaming inserts (`insertAll`) | ✅ Supported |
| Table data listing + pagination (`maxResults`, `startIndex`, `pageToken`) | ✅ Supported |
| Query (`jobs.query` fast path + query jobs) | ✅ Supported (SQL subset) |
| Query parameters (named + positional) | ✅ Supported |
| `getQueryResults` (with pagination) | ✅ Supported |
| Job lifecycle (insert/get/list/cancel/delete) — completes instantly as `DONE` | ✅ Supported |
| Copy jobs (incl. `WRITE_TRUNCATE`/`WRITE_EMPTY`) | ✅ Supported |
| Load jobs (metadata + destination-table creation) | ✅ Accepted; source bytes via resumable upload are not hosted |
| Extract jobs | ✅ Accepted as no-op (no object storage) |
| Routines CRUD | ✅ Supported |
| Models (list/get/patch/delete) | ✅ Supported (no `models.insert` — created via `CREATE MODEL`, which is a no-op) |
| Table IAM policy (get/set/test) | ✅ Supported (test grants all) |
| `SELECT` with `WHERE` (typed comparisons), `ORDER BY`, `LIMIT`, `COUNT(*)`, projection, parameters | ✅ Supported |
| JOINs / multi-column `GROUP BY` / window functions / UDFs | ⟳ Roadmap — **rejected with a `400 invalidQuery` error, never silently wrong rows** |
| Resumable/multipart upload endpoint for `load` from local files | ⟳ Roadmap — Not hosted |
| Real query cost / bytes-billed accounting | ⟳ Roadmap — Always reports `0` |
| Authentication / token validation | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Asynchronous long-running jobs | ⟳ Roadmap — All jobs complete synchronously (`DONE`) |

## Error codes & shapes

Errors follow the Google-API JSON envelope the client expects:

```json
{
  "error": {
    "code": 404,
    "message": "Not found: Dataset parlel:missing",
    "status": "NOT_FOUND",
    "errors": [
      { "message": "Not found: Dataset parlel:missing", "domain": "global", "reason": "notFound" }
    ]
  }
}
```

The HTTP status equals `error.code`. Common codes:

| HTTP | status | reason | When |
|------|--------|--------|------|
| 400 | `INVALID_ARGUMENT` | `required` / `invalid` / `parseError` / `resourceInUse` | Missing id, bad SQL, invalid JSON, deleting a non-empty dataset without `deleteContents` |
| 404 | `NOT_FOUND` | `notFound` | Missing dataset / table / job / routine / model, or query referencing a missing table |
| 409 | `ALREADY_EXISTS` | `duplicate` | Creating a dataset/table/routine that already exists |
| 405 | `UNIMPLEMENTED` | `notImplemented` | Unsupported method on a known resource |

Streaming insert validation errors are returned **inside** a `200` response as
`insertErrors: [{ index, errors: [{ reason, message }] }]`, matching
`tabledata.insertAll`; the client raises a `PartialFailureError` from them.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
BIGQUERY_EMULATOR_HOST=http://localhost:4583
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
