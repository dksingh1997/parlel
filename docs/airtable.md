# Airtable

Lightweight, dependency-free, in-memory Airtable REST API emulator for testing code that uses the real `airtable` npm client or the Airtable REST API directly.

Default port: `4611`

## Quick Start

```js
import Airtable from "airtable";
import { AirtableServer } from "./services/airtable/src/server.js";

const server = new AirtableServer(4611);
await server.start();

const base = new Airtable({
  apiKey: "keyParlel",
  endpointUrl: "http://127.0.0.1:4611",
}).base("appParlel");

const created = await base("Tasks").create({ Name: "Test locally" });
const records = await base("Tasks").select({ pageSize: 10 }).all();

await server.stop();
```

## Implemented Operations

Table records, compatible with the `airtable` npm client's public table methods:

- `GET /v0/:baseId/:tableName` — list/select records with query params (`fields[]`, `filterByFormula`, `maxRecords`, `pageSize`, `offset`, `sort[0][field]`, `sort[0][direction]`, `view`, `cellFormat`, `timeZone`, `userLocale`).
- `POST /v0/:baseId/:tableName/listRecords` — list records with parameters in JSON body (mirrors GET list with long query strings).
- `POST /v0/:baseId/:tableName?method=list` — legacy list alias accepted by older `airtable` client versions.
- `GET /v0/:baseId/:tableName/:recordId` — find one record by ID.
- `POST /v0/:baseId/:tableName` — create one record (`{ "fields": { ... } }`) or up to 10 records (`{ "records": [{ "fields": { ... } }] }`).
- `PATCH /v0/:baseId/:tableName/:recordId` — update one record by merging fields.
- `PUT /v0/:baseId/:tableName/:recordId` — replace one record's fields (destructive).
- `PATCH /v0/:baseId/:tableName` — update up to 10 records in batch.
- `PUT /v0/:baseId/:tableName` — replace up to 10 records in batch (destructive).
- `DELETE /v0/:baseId/:tableName/:recordId` — delete one record.
- `DELETE /v0/:baseId/:tableName?records[]=recA&records[]=recB` — delete up to 10 records by ID.

Service endpoints:

- `GET /` — service metadata.
- `GET /health` — `{ "status": "ok" }`.
- `OPTIONS *` — `204` (CORS preflight).
- `POST /__reset` — clear all in-memory state.
- `server.reset()` — clear all in-memory state when used in-process.

## Access via MCP / preview URL

Not currently exposed via MCP or preview URL. Use the REST endpoint at `http://127.0.0.1:4611`.

## Surface coverage

Legend: ✅ supported · ◐ accepted-not-enforced · ✓ by design · ⟳ roadmap

| Feature | Status | Notes |
| --- | --- | --- |
| Bearer token auth | ✅ | Any non-empty `Authorization: Bearer ...` header accepted. Missing auth returns `401`. |
| Legacy `api_key` query auth | ◐ | Accepted for backward compatibility with older `airtable` client versions. Real Airtable deprecated `api_key` as of Feb 2024. |
| In-memory bases and tables | ✓ | Bases/tables created lazily by writes; cleared by `reset()`. Ephemeral by design. |
| Record ID format | ✅ | Generates `rec` + 14 alphanumeric base62 chars matching real Airtable ID format. |
| Record field values | ✅ | JSON values stored as-is. Airtable-specific processing (attachments, collaborators, computed fields) not applied. |
| List/select with pagination | ✅ | `pageSize` (default 100), `offset` string, `maxRecords`. Response shape: `{ "records": [...], "offset": "..." }`. |
| Field projection | ✅ | `fields[]` and `fields` query params, and `fields` array in POST body. |
| Sorting | ✅ | `sort[N][field]` + `sort[N][direction]` query format. Legacy `sortField`/`sortDirection` also accepted. |
| `filterByFormula` | ✅ | Supports `{Field}`, `{Field} = value`, comparisons, `SEARCH()`, `AND()`, `OR()`. Intended for common client-test formulas, not a complete Airtable formula engine. |
| `POST /listRecords` | ✅ | JSON-body list endpoint for long query strings. |
| Single record CRUD | ✅ | `GET`, `POST`, `PATCH`, `PUT`, `DELETE` on `/v0/:baseId/:tableName/:recordId`. |
| Batch create (up to 10) | ✅ | `POST` with `{ "records": [...] }`. Enforces Airtable's 10-record batch limit. |
| Batch update (up to 10) | ✅ | `PATCH` with `{ "records": [{ "id", "fields" }] }`. |
| Batch replace (up to 10) | ✅ | `PUT` with `{ "records": [{ "id", "fields" }] }`. |
| Batch delete (up to 10) | ✅ | `DELETE` with `records[]` query params. |
| `returnFieldsByFieldId` | ⟳ | Real API returns field objects keyed by field ID. Not yet implemented. |
| `typecast` | ⟳ | Real API performs best-effort data conversion. Not yet implemented. |
| `performUpsert` | ⟳ | Real API supports upserts via `fieldsToMergeOn`. Not yet implemented. |
| `cellFormat` (`json`/`string`) | ⟳ | Real API formats cells as user-facing strings when `string` is set. Not yet implemented. |
| `view` filtering | ⟳ | Real API filters to records in a specific view. Not yet implemented. |
| `recordMetadata` (`commentCount`) | ⟳ | Real API includes comment counts. Not yet implemented. |
| Rate limiting (429) | ✓ | Real API limits to 5 req/sec/base. Not enforced locally by design. |
| Metadata / schema API | ⟳ | Real API has `GET /v0/meta/bases/:baseId/tables`. Not implemented. |
| Persistence | ✓ | State is ephemeral by design. |
| Attachments, collaborators, links | ✓ | Values preserved as plain field JSON. Airtable-specific processing intentionally unsupported. |

## Error codes & shapes

All JSON errors use Airtable-style framing:

```json
{
  "error": {
    "type": "NOT_FOUND",
    "message": "Could not find record"
  }
}
```

| Status | Type | When |
| --- | --- | --- |
| `401` | `AUTHENTICATION_REQUIRED` | Missing `Authorization: Bearer ...` and missing `api_key` query param. |
| `404` | `NOT_FOUND` | Unknown endpoint path or missing record. |
| `405` | `METHOD_NOT_ALLOWED` | HTTP method not supported for the endpoint. |
| `422` | `INVALID_REQUEST_BODY` | Required `fields`, `records`, or record `id` missing or malformed. |
| `422` | `INVALID_REQUEST_UNKNOWN` | More than 10 records in a batch operation. |
| `500` | `SERVER_ERROR` | Unexpected server exception. |

## Manifest

```json
{
  "name": "airtable",
  "version": "0.1",
  "port": 4611,
  "protocol": "http",
  "healthcheck": "/health"
}
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AIRTABLE_API_KEY=parlel
AIRTABLE_ENDPOINT_URL=http://localhost:4611
AIRTABLE_BASE_ID=appParlel
```

<!-- parlel:testenv:end -->
