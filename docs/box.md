# Box

Lightweight, dependency-free, in-memory fake of the **Box Content API v2** for testing code that uses the real `box-node-sdk` (or the Box REST API directly).

Default port: `4837`

## Quick start

```js
import { BoxServer } from "./services/box/src/server.js";

const server = new BoxServer(4837);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Upload a file via multipart (Box's `files/content` endpoint):

```js
const form = new FormData();
form.append("attributes", JSON.stringify({ name: "hello.txt", parent: { id: "0" } }));
form.append("file", new Blob(["hello world"]), "hello.txt");
await fetch("http://127.0.0.1:4837/2.0/files/content", {
  method: "POST",
  headers: { Authorization: "Bearer parlel" },
  body: form,
});
```

## Access via MCP / preview URL

When run inside a parlel pool, the service is reachable at its mapped preview URL
(e.g. `http://127.0.0.1:4837`). MCP clients drive the Box surface — folders, files,
upload/download, users/me — using the `BOX_ACCESS_TOKEN`, `BOX_BASE_URL`, and
`BOX_UPLOAD_URL` env vars. Any non-empty Bearer token is accepted.

## Implemented operations

All `/2.0/*` routes require `Authorization: Bearer <token>` (any non-empty token). State is in-memory and ephemeral.

### Folders

- `POST /2.0/folders` — create folder (`201`, `{type:"folder", id, name, ...}`).
- `GET /2.0/folders/:id` — fetch folder. Root folder is `0`.
- `GET /2.0/folders/:id/items` — list child folders + files (`{ total_count, entries }`).
- `PUT /2.0/folders/:id` — rename folder.
- `DELETE /2.0/folders/:id` — remove folder (`204`).

### Files

- `POST /2.0/files/content` — upload (multipart `attributes` + `file`, or JSON convenience). Returns `{ total_count: 1, entries: [fileMeta] }`. Bytes stored in memory.
- `GET /2.0/files/:id` — file metadata (`{type:"file", id, name, size, sha1, ...}`).
- `GET /2.0/files/:id/content` — download the stored bytes.
- `PUT /2.0/files/:id` — rename/update metadata.
- `DELETE /2.0/files/:id` — remove file (`204`).

### Users

- `GET /2.0/users/me` — current user (`{type:"user", id, name, login, ...}`).

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Folder CRUD + `items` listing | ✅ Supported |
| File upload (multipart) / download round-trip | ✅ Supported |
| File metadata get / rename / delete | ✅ Supported |
| `users/me` | ✅ Supported |
| Bearer token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Chunked / preflight upload sessions | ⟳ Roadmap — Single-shot `files/content` only |
| Versions, collaborations, shared links, webhooks | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Box uses `{ type:"error", status, code, message, request_id }`:

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer token |
| `400` | bad request (e.g. missing folder `name`) |
| `404` | unknown folder/file id |

## Manifest

See `services/box/manifest.json` — name `box`, port `4837`, protocol `http`,
healthcheck `/health`, env `BOX_ACCESS_TOKEN`, `BOX_BASE_URL`, `BOX_UPLOAD_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
BOX_ACCESS_TOKEN=parlel
BOX_BASE_URL=http://localhost:4837
BOX_UPLOAD_URL=http://localhost:4837
```

<!-- parlel:testenv:end -->
