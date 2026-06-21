# Salesforce

Lightweight, dependency-free, in-memory fake of the Salesforce REST API (`v59.0`) for testing code that uses `jsforce` or the Salesforce REST API directly.

Default port: `4778`

## Quick start

```js
import { SalesforceServer } from "./services/salesforce/src/server.js";

const server = new SalesforceServer(4778);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const base = "http://127.0.0.1:4778";
const res = await fetch(`${base}/services/data/v59.0/sobjects/Account`, {
  method: "POST",
  headers: { Authorization: "Bearer pat-parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ Name: "Parlel Inc" }),
});
// => { id, success: true, errors: [] }
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4778`, reachable through the parlel MCP/preview proxy under the slug `salesforce`.

## Implemented operations

All `/services/data/*` routes require `Authorization: Bearer <token>` (any non-empty bearer works). State is in-memory and ephemeral. Record ids are 18 chars with the standard key prefix per object (`001` Account, `003` Contact, `00Q` Lead, `006` Opportunity, `500` Case).

### sObjects — `/services/data/v59.0/sobjects/:Object`

- `POST /services/data/v59.0/sobjects/:Object` — create. Returns `{ id, success: true, errors: [] }`. Standard objects enforce their required fields (e.g. `Account.Name`, `Contact.LastName`, `Lead.{LastName,Company}`, `Opportunity.{Name,StageName,CloseDate}`, `User.{Username,LastName,Email,Alias}`); a missing required field returns `400 REQUIRED_FIELD_MISSING` with a `fields` array, exactly like the real API.
- `GET /services/data/v59.0/sobjects/:Object/:id` — retrieve (includes `attributes`). Supports the `?fields=Field1,Field2` projection — the response is narrowed to `attributes` plus the requested fields.
- `PATCH /services/data/v59.0/sobjects/:Object/:id` — update (`204`, no body).
- `DELETE /services/data/v59.0/sobjects/:Object/:id` — delete (`204`).

### Query — `/services/data/v59.0/query`

- `GET /services/data/v59.0/query?q=<SOQL>` — returns `{ totalSize, done, records: [] }`. Supports `SELECT ... FROM Object [WHERE Field = 'value']`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| sObject create / retrieve / update / delete | ✅ Supported |
| SOQL query (`FROM`, single `WHERE field = 'value'`) | ✅ Supported |
| `{id,success,errors}` create envelope | ✅ Supported |
| Required-field validation (standard objects) | ✅ Supported — `REQUIRED_FIELD_MISSING` |
| Retrieve `?fields=` projection | ✅ Supported |
| Arbitrary / custom object types | ◐ Accepted (no schema, not enforced) |
| Composite / bulk / tree APIs | ⟳ Roadmap |
| Full SOQL (joins, aggregates, ORDER BY, LIMIT, relationships) | ◐ Minimal subset |
| Describe / metadata APIs | ⟳ Roadmap |
| OAuth token validity / org boundaries | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Errors use the Salesforce array envelope `[{ message, errorCode }]`.

| Status | `errorCode` | When |
| --- | --- | --- |
| `400` | `REQUIRED_FIELD_MISSING` | a required field is missing on a standard-object create (includes a `fields` array) |
| `400` | `MALFORMED_QUERY` / `JSON_PARSER_ERROR` | bad SOQL / malformed JSON |
| `401` | `INVALID_SESSION_ID` | no `Authorization: Bearer` header |
| `404` | `NOT_FOUND` | unknown record / endpoint |
| `405` | `METHOD_NOT_ALLOWED` | method not allowed for the path |

## Manifest

See `services/salesforce/manifest.json`: name `salesforce`, port `4778`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `SALESFORCE_ACCESS_TOKEN`, `SALESFORCE_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SALESFORCE_ACCESS_TOKEN=pat-parlel
SALESFORCE_BASE_URL=http://localhost:4778
```

<!-- parlel:testenv:end -->
