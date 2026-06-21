# PandaDoc

Lightweight, dependency-free, in-memory PandaDoc API v1 fake for testing e-signature document code.

Default port: `4851`

## Quick start

```js
import { PandadocServer } from "./services/pandadoc/src/server.js";

const server = new PandadocServer(4851);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a PandaDoc client at `http://127.0.0.1:4851`. Authenticate with the
`Authorization: API-Key <key>` header (any non-empty key accepted):

```js
const res = await fetch("http://127.0.0.1:4851/public/v1/documents", {
  headers: { Authorization: "API-Key parlel" },
});
const { results } = await res.json();
```

## Implemented operations

All `/public/v1/*` routes require `Authorization: API-Key <key>`. State is
in-memory. List responses use `{ results: [] }`.

- `GET /public/v1/templates` — list templates.
- `GET /public/v1/documents` — list documents.
- `POST /public/v1/documents` — create a document from a template or content.
  Returns `201 { id, uuid, name, status: "document.uploaded", ... }`. Requires
  `name`, `template_uuid`, or `url`.
- `GET /public/v1/documents/:id` — retrieve document details.
- `GET /public/v1/documents/:id/details` — alias of the above.
- `POST /public/v1/documents/:id/send` — send a document (`status` → `document.sent`).
- `DELETE /public/v1/documents/:id` — remove a document.

Document status follows the real lifecycle:
`document.uploaded` → `document.draft` → `document.sent` → `document.completed`.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `POST /__parlel/complete/:id` — advance a document to `document.completed`.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `PANDADOC_BASE_URL` (`http://127.0.0.1:4851`). When
running in the parlel pool, an MCP tool / preview URL proxies to this base URL —
point your PandaDoc client at that URL with the `API-Key` header and every
`/public/v1/*` endpoint above works as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Documents create/get/list/send/delete | ✅ Supported |
| Templates listing | ✅ Supported |
| `{ results: [] }` list shape | ✅ Supported |
| `Authorization: API-Key` header | ✅ Supported |
| Multipart/file upload create | ◐ Accepted, body parsed loosely |
| Real PDF rendering / e-sign ceremony | ⟳ Roadmap |
| Webhooks / contacts / members | ⟳ Roadmap |
| API-key validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ type, detail }`:

| Status | When |
| --- | --- |
| `400` | document create missing `name`/`template_uuid`/`url` |
| `401` | missing/invalid `API-Key` |
| `404` | unknown document or endpoint |

## Manifest

See `services/pandadoc/manifest.json`:

- name: `pandadoc`, port: `4851`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `PANDADOC_API_KEY`, `PANDADOC_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PANDADOC_API_KEY=parlel
PANDADOC_BASE_URL=http://localhost:4851
```

<!-- parlel:testenv:end -->
