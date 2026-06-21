# Gravity Forms

Lightweight, dependency-free, in-memory Gravity Forms REST API v2 (WordPress) fake for testing form code.

Default port: `4854`

## Quick start

```js
import { GravityFormsServer } from "./services/gravity-forms/src/server.js";

const server = new GravityFormsServer(4854);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a Gravity Forms client at `http://127.0.0.1:4854`. Authenticate with HTTP
Basic auth using a consumer key/secret (any non-empty Basic credentials
accepted). Routes live under `/wp-json/gf/v2`:

```js
const basic = Buffer.from("ck_xxx:cs_yyy").toString("base64");
const res = await fetch("http://127.0.0.1:4854/wp-json/gf/v2/forms", {
  headers: { Authorization: `Basic ${basic}` },
});
```

## Implemented operations

All `/wp-json/gf/v2/*` routes require Basic (or Bearer) auth. State is in-memory.
Form shape: `{ id, title, fields: [] }`.

- `GET /wp-json/gf/v2/forms` — list forms as an **object keyed by id** (GF convention).
- `POST /wp-json/gf/v2/forms` — create a form (`201`).
- `GET /wp-json/gf/v2/forms/:id` — retrieve a form (full `fields`).
- `GET /wp-json/gf/v2/forms/:id/entries` — list a form's entries (`{ total_count, entries }`).
- `POST /wp-json/gf/v2/forms/:id/entries` — create an entry (numeric field-id keys, e.g. `{ "1": "Alice" }`).
- `GET /wp-json/gf/v2/entries` — list all entries.
- `GET /wp-json/gf/v2/entries/:id` — retrieve an entry.
- `DELETE /wp-json/gf/v2/entries/:id` — delete an entry.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `GRAVITY_FORMS_BASE_URL` (`http://127.0.0.1:4854`).
When running in the parlel pool, an MCP tool / preview URL proxies to this base
URL — point your Gravity Forms client at that URL with Basic consumer
credentials and every `/wp-json/gf/v2/*` endpoint above works as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Forms list (keyed object) / create / get | ✅ Supported |
| Entries list/create/get/delete | ✅ Supported |
| Basic auth (consumer key/secret) | ✅ Supported |
| Form shape `{id,title,fields}` | ✅ Supported |
| OAuth 1.0a signature verification | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| Field validation / conditional logic | ⟳ Roadmap |
| Feeds / notifications / results | ⟳ Roadmap |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the WordPress REST `{ code, message, data: { status } }` envelope:

| Status | When |
| --- | --- |
| `401` | missing Basic/Bearer credentials (`rest_forbidden`) |
| `404` | unknown form or entry |

## Manifest

See `services/gravity-forms/manifest.json`:

- name: `gravity-forms`, port: `4854`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `GRAVITY_FORMS_CONSUMER_KEY`, `GRAVITY_FORMS_CONSUMER_SECRET`, `GRAVITY_FORMS_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GRAVITY_FORMS_CONSUMER_KEY=parlel
GRAVITY_FORMS_CONSUMER_SECRET=parlel
GRAVITY_FORMS_BASE_URL=http://localhost:4854
```

<!-- parlel:testenv:end -->
