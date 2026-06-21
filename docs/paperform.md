# Paperform

Lightweight, dependency-free, in-memory Paperform API v1 fake for testing form code.

Default port: `4855`

## Quick start

```js
import { PaperformServer } from "./services/paperform/src/server.js";

const server = new PaperformServer(4855);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a Paperform client at `http://127.0.0.1:4855`. Authenticate with a Bearer
token (any non-empty token is accepted):

```js
const res = await fetch("http://127.0.0.1:4855/api/v1/forms", {
  headers: { Authorization: "Bearer parlel" },
});
const { results } = await res.json(); // results.forms
```

## Response shape

Paperform wraps payloads in a `results` object. This emulator is consistent:

- List forms: `{ results: { forms: [...] }, total, has_more }`
- Single form: `{ results: { form: {...} } }`
- Fields: `{ results: { fields: [...] }, total }`
- List submissions: `{ results: { submissions: [...] }, total, has_more }`
- Single submission: `{ results: { submission: {...} } }`

## Implemented operations

All `/api/v1/*` routes require `Authorization: Bearer <token>`. State is in-memory.

- `GET /api/v1/forms` — list forms.
- `GET /api/v1/forms/:form_id` — retrieve a form.
- `GET /api/v1/forms/:form_id/fields` — list a form's fields.
- `GET /api/v1/forms/:form_id/submissions` — list a form's submissions.
- `POST /api/v1/forms/:form_id/submissions` — create a submission (`{ data: { key: value } }`).
- `GET /api/v1/submissions/:id` — retrieve a submission.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `PAPERFORM_BASE_URL` (`http://127.0.0.1:4855`). When
running in the parlel pool, an MCP tool / preview URL proxies to this base URL —
point your Paperform client at that URL with a Bearer token and every
`/api/v1/*` endpoint above works as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Forms list/get | ✅ Supported |
| Form fields listing | ✅ Supported |
| Submissions list/create/get | ✅ Supported |
| `results`-wrapper shape | ✅ Supported (documented above) |
| Bearer auth | ✅ Supported |
| Partial submissions / webhooks / coupons | ⟳ Roadmap |
| Real cursor pagination | ◐ Single-page (`has_more` always false) |
| Token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ error: true, message }`:

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer token |
| `404` | unknown form or submission |

## Manifest

See `services/paperform/manifest.json`:

- name: `paperform`, port: `4855`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `PAPERFORM_API_KEY`, `PAPERFORM_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PAPERFORM_API_KEY=parlel
PAPERFORM_BASE_URL=http://localhost:4855
```

<!-- parlel:testenv:end -->
