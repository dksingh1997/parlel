# Sanity

Lightweight, dependency-free, in-memory fake of the **Sanity content API** for testing code that uses the real `@sanity/client`.

Default port: `4842`

## Quick start

```js
import { SanityServer } from "./services/sanity/src/server.js";

const server = new SanityServer(4842);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real client at it (override the API host) or drive the HTTP API directly:

```js
const res = await fetch(
  "http://127.0.0.1:4842/v2021-10-21/data/query/production?query=" + encodeURIComponent('*[_type == "post"]'),
  { headers: { Authorization: "Bearer parlel" } },
);
// { ms, query, result: [...] }
```

## Access via MCP / preview URL

When run inside a parlel pool, reachable at its mapped preview URL (e.g.
`http://127.0.0.1:4842`). MCP clients drive GROQ queries and mutations using
`SANITY_TOKEN`, `SANITY_PROJECT_ID`, and `SANITY_DATASET`. Any non-empty Bearer
token is accepted.

## Implemented operations

State is in-memory and ephemeral. All routes require `Authorization: Bearer <token>`.

### Query

- `GET /v2021-10-21/data/query/:dataset?query=<GROQ>` — run a GROQ query. Returns `{ ms, query, result }`.

Supported (minimal) GROQ:

| Query | Meaning |
| --- | --- |
| `*` | all documents |
| `*[_type == "x"]` | documents whose `_type` equals `x` |
| `*[_id == "x"]` | document(s) by id |
| `...[0]` | trailing `[0]` picks the first match |

### Mutations

- `POST /v2021-10-21/data/mutate/:dataset` — apply mutations `[{create},{createIfNotExists},{createOrReplace},{patch},{delete}]`. Returns `{ transactionId, results:[{id,operation}] }`. `?returnDocuments=true` / `?returnIds=true` include extra fields.

### Documents

- `GET /v2021-10-21/data/doc/:dataset/:id` — fetch a document by id (`{ documents: [...] }`).

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Document mutations: create / createIfNotExists / createOrReplace / patch (set/unset/inc) / delete | ✅ Supported |
| GROQ: `*`, `*[_type == "x"]`, `*[_id == "x"]`, trailing `[0]` | ✅ Supported |
| `GET /data/doc/:dataset/:id` | ✅ Supported |
| Bearer token validity / dataset ACLs | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Full GROQ (projections, joins, ordering, functions, params) | ⟳ Roadmap |
| Assets API, listen (live) endpoint, history | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Sanity uses `{ error: { description, type, statusCode } }`:

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer token |
| `400` | unsupported GROQ query/filter |
| `404` | unknown route |

## Manifest

See `services/sanity/manifest.json` — name `sanity`, port `4842`, protocol `http`,
healthcheck `/health`, env `SANITY_TOKEN`, `SANITY_PROJECT_ID`, `SANITY_DATASET`,
`SANITY_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SANITY_TOKEN=parlel
SANITY_PROJECT_ID=parlel
SANITY_DATASET=production
SANITY_BASE_URL=http://localhost:4842
```

<!-- parlel:testenv:end -->
