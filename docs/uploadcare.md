# Uploadcare

Lightweight, dependency-free, in-memory fake of the **Uploadcare Upload + REST APIs** for testing code that uses the real `@uploadcare/upload-client` / `@uploadcare/rest-client`.

Default port: `4840` (both the upload host and the REST host are collapsed onto this single port).

## Quick start

```js
import { UploadcareServer } from "./services/uploadcare/src/server.js";

const server = new UploadcareServer(4840);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Upload a file (multipart, public key in the body):

```js
const form = new FormData();
form.append("UPLOADCARE_PUB_KEY", "parlel");
form.append("file", new Blob(["hello"]), "hello.txt");
const { file } = await (await fetch("http://127.0.0.1:4840/base/", { method: "POST", body: form })).json();
// file => "<uuid>"
```

## Access via MCP / preview URL

When run inside a parlel pool, reachable at its mapped preview URL (e.g.
`http://127.0.0.1:4840`). MCP clients drive uploads and REST file management using
`UPLOADCARE_PUBLIC_KEY` / `UPLOADCARE_SECRET_KEY`. The REST API expects
`Authorization: Uploadcare.Simple pub:secret`; uploads pass `UPLOADCARE_PUB_KEY` in the body.

## Implemented operations

State is in-memory and ephemeral.

### Upload API

- `POST /base/` — upload a file (multipart, `UPLOADCARE_PUB_KEY` field). Returns `{ file: "<uuid>" }`. Bytes are stored in memory.

### REST API (`Authorization: Uploadcare.Simple pub:secret`)

- `GET /files/` — list files (`{ results: [...], next, previous, total, per_page }`).
- `GET /files/:uuid/` — fetch a single file's metadata.
- `DELETE /files/:uuid/` — delete a file.
- `DELETE /files/:uuid/storage/` — remove a file from storage (returns the file object).

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `POST /base/` single-file upload | ✅ Supported |
| REST `files` list / get / delete / storage-delete | ✅ Supported |
| Upload pub-key (body) + REST `Uploadcare.Simple` header auth | ◐ Presence checked, not verified |
| Multipart / chunked uploads, `from_url`, groups | ⟳ Roadmap |
| Real CDN delivery / image transformations | ⟳ Roadmap — Not performed |
| Webhooks, projects, conversions | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Uploadcare uses `{ detail: "..." }`:

| Status | When |
| --- | --- |
| `401` | upload without pub key, or REST without `Uploadcare.Simple` auth |
| `404` | unknown file uuid |

## Manifest

See `services/uploadcare/manifest.json` — name `uploadcare`, port `4840`, protocol
`http`, healthcheck `/health`, env `UPLOADCARE_PUBLIC_KEY`, `UPLOADCARE_SECRET_KEY`,
`UPLOADCARE_BASE_URL`, `UPLOADCARE_UPLOAD_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
UPLOADCARE_PUBLIC_KEY=parlel
UPLOADCARE_SECRET_KEY=parlel
UPLOADCARE_BASE_URL=http://localhost:4840
UPLOADCARE_UPLOAD_URL=http://localhost:4840
```

<!-- parlel:testenv:end -->
