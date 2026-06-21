# Dropbox

Lightweight, dependency-free, in-memory fake of the **Dropbox API v2** for testing code that uses the real `dropbox` Node SDK (or the language-agnostic Dropbox HTTP API).

Default port: `4836`

## Quick start

```js
import { DropboxServer } from "./services/dropbox/src/server.js";

const server = new DropboxServer(4836);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `dropbox` client at it via `fetchOptions`/custom domain, or just set `DROPBOX_BASE_URL` and drive the HTTP API directly:

```js
// Upload (args travel in the Dropbox-API-Arg header, body is raw content)
await fetch("http://127.0.0.1:4836/2/files/upload", {
  method: "POST",
  headers: {
    Authorization: "Bearer parlel",
    "Dropbox-API-Arg": JSON.stringify({ path: "/hello.txt", mode: "overwrite" }),
    "Content-Type": "application/octet-stream",
  },
  body: "hello world",
});
```

## Access via MCP / preview URL

When run inside a parlel pool, the service is reachable at its mapped preview URL
(e.g. `http://127.0.0.1:4836`). MCP clients drive it with the standard Dropbox tool
surface — `files/upload`, `files/download`, `files/list_folder`, etc. — using the
`DROPBOX_ACCESS_TOKEN` and `DROPBOX_BASE_URL` env vars from the manifest. Any non-empty
Bearer token is accepted.

## Implemented operations

All API routes require `Authorization: Bearer <token>` (any non-empty token). State is in-memory and ephemeral.

### Files

- `POST /2/files/upload` — upload content. Args in `Dropbox-API-Arg` header, raw body is stored. Returns `{".tag":"file", name, path_display, id, size, content_hash, rev, ...}`.
- `POST /2/files/download` — download content. Args in `Dropbox-API-Arg` header. Returns raw body + `Dropbox-API-Result` header with metadata.
- `POST /2/files/list_folder` — list entries directly under a path (`""` = root).
- `POST /2/files/list_folder/continue` — returns an empty page (no pagination needed for the fake).
- `POST /2/files/get_metadata` — fetch a single file's metadata.
- `POST /2/files/delete_v2` — delete a file, returns `{ metadata }`.
- `POST /2/files/create_folder_v2` — create a folder placeholder.

### Users

- `POST /2/users/get_current_account` — returns a deterministic account object.
- `POST /2/users/get_space_usage` — returns used/allocated bytes.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `files/upload` / `download` round-trip (bytes stored in memory) | ✅ Supported |
| `files/list_folder` (single level) | ✅ Supported |
| `files/get_metadata` / `delete_v2` / `create_folder_v2` | ✅ Supported |
| `users/get_current_account` / `get_space_usage` | ✅ Supported |
| Bearer token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Recursive listing, cursors, `has_more` pagination | ⟳ Roadmap — Single page only |
| Sharing, paper, file_requests, batch endpoints | ⟳ Roadmap |
| Real persistence / quotas | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Dropbox uses `{ error_summary, error: { ".tag": ... } }`:

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer token |
| `400` | malformed args |
| `409` | endpoint-specific error (e.g. `path/not_found`) |

## Manifest

See `services/dropbox/manifest.json` — name `dropbox`, port `4836`, protocol `http`,
healthcheck `/health`, env `DROPBOX_ACCESS_TOKEN`, `DROPBOX_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
DROPBOX_ACCESS_TOKEN=parlel
DROPBOX_BASE_URL=http://localhost:4836
```

<!-- parlel:testenv:end -->
