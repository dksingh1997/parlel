# Cloudinary

Lightweight, dependency-free, in-memory fake of the **Cloudinary API** (upload + admin) for testing code that uses the real `cloudinary` Node SDK.

Default port: `4838`

## Quick start

```js
import { CloudinaryServer } from "./services/cloudinary/src/server.js";

const server = new CloudinaryServer(4838);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real SDK at it (override the `upload`/`api` base URLs to `http://127.0.0.1:4838`),
or drive the REST API directly:

```js
await fetch("http://127.0.0.1:4838/v1_1/parlel/image/upload", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ file: "https://example.com/cat.jpg", upload_preset: "ml_default" }),
});
```

## Access via MCP / preview URL

When run inside a parlel pool, reachable at its mapped preview URL (e.g.
`http://127.0.0.1:4838`). MCP clients drive uploads, admin listing, and destroy
using the `CLOUDINARY_*` env vars. Any non-empty credentials are accepted.

## Implemented operations

State is in-memory and ephemeral. All routes are under `/v1_1/:cloud_name/...`.

### Upload

- `POST /v1_1/:cloud_name/image/upload` — upload an image. Accepts `multipart/form-data` or `application/x-www-form-urlencoded`. Requires an `upload_preset` (unsigned), a `signature`, or Basic/`api_key` auth. Returns `{ public_id, version, url, secure_url, format, width, height, bytes, asset_id, etag, ... }`.

### Admin

- `GET /v1_1/:cloud_name/resources/image` — list uploaded resources (`{ resources: [...], rate_limit_* }`). Requires Basic auth.
- `GET /v1_1/:cloud_name/resources/image/upload/:public_id` — fetch one resource.
- `POST /v1_1/:cloud_name/image/destroy` — delete a resource (`{ result: "ok" | "not found" }`). Requires Basic/`api_key` auth.

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `image/upload` (multipart or urlencoded) | ✅ Supported |
| `resources/image` list + single fetch | ✅ Supported |
| `image/destroy` | ✅ Supported |
| Auth (Basic for admin; preset/signature/api_key for upload) | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| Real image processing / transformations / format conversion | ⟳ Roadmap — Not performed (width/height/format synthesized) |
| Signature verification | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| Video/raw resource types, eager transforms, tags filtering | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Cloudinary uses `{ error: { message } }`:

| Status | When |
| --- | --- |
| `401` | upload without preset/signature/auth, or admin without Basic auth |
| `400` | destroy without `public_id` |
| `404` | unknown resource |

## Manifest

See `services/cloudinary/manifest.json` — name `cloudinary`, port `4838`, protocol
`http`, healthcheck `/health`, env `CLOUDINARY_URL`, `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CLOUDINARY_URL=cloudinary://parlel:parlel@parlel
CLOUDINARY_CLOUD_NAME=parlel
CLOUDINARY_API_KEY=parlel
CLOUDINARY_API_SECRET=parlel
CLOUDINARY_BASE_URL=http://localhost:4838
```

<!-- parlel:testenv:end -->
