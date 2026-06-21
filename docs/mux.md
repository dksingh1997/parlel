# Mux

Lightweight, dependency-free, in-memory fake of the **Mux Video API** for testing code that uses the real `@mux/mux-node` SDK.

Default port: `4839`

## Quick start

```js
import { MuxServer } from "./services/mux/src/server.js";

const server = new MuxServer(4839);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real SDK at it (override `baseUrl` to `http://127.0.0.1:4839`) or drive the REST API directly:

```js
const auth = "Basic " + Buffer.from("tokenId:tokenSecret").toString("base64");
await fetch("http://127.0.0.1:4839/video/v1/assets", {
  method: "POST",
  headers: { Authorization: auth, "Content-Type": "application/json" },
  body: JSON.stringify({ input: [{ url: "https://example.com/video.mp4" }], playback_policy: ["public"] }),
});
```

## Access via MCP / preview URL

When run inside a parlel pool, reachable at its mapped preview URL (e.g.
`http://127.0.0.1:4839`). MCP clients drive the Video surface (assets, uploads,
playback-ids) using `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET` for Basic auth.

## Implemented operations

State is in-memory and ephemeral. All routes require Basic auth (`token id:secret`). Created assets are immediately `status: "ready"`.

### Assets

- `POST /video/v1/assets` — create an asset (`201 { data: { id, status:"ready", playback_ids, ... } }`).
- `GET /video/v1/assets` — list assets.
- `GET /video/v1/assets/:id` — fetch an asset.
- `DELETE /video/v1/assets/:id` — delete an asset (`204`).
- `GET /video/v1/assets/:id/playback-ids` — list playback ids.
- `POST /video/v1/assets/:id/playback-ids` — add a playback id (`{ policy }`).

### Direct uploads

- `POST /video/v1/uploads` — create a direct-upload URL (`201 { data: { id, url, status:"waiting", ... } }`).
- `GET /video/v1/uploads` / `GET /video/v1/uploads/:id` — list / fetch uploads.
- `PUT /video/v1/uploads/:id/cancel` — cancel an upload.

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Asset create/list/get/delete + `data` envelope | ✅ Supported |
| Playback id list/add | ✅ Supported |
| Direct uploads create/get/cancel | ✅ Supported |
| Basic auth (token id:secret) | ◐ Presence checked, not verified |
| Real ingest / encoding / live streaming | ⟳ Roadmap — Not performed (assets are instantly "ready") |
| Mux Data (`/data/v1/...`) | ⟳ Roadmap |
| Signed playback token verification | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Mux uses `{ error: { type, messages } }`:

| Status | When |
| --- | --- |
| `401` | missing/invalid Basic auth |
| `404` | unknown asset/upload |

## Manifest

See `services/mux/manifest.json` — name `mux`, port `4839`, protocol `http`,
healthcheck `/health`, env `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MUX_TOKEN_ID=parlel
MUX_TOKEN_SECRET=parlel
MUX_BASE_URL=http://localhost:4839
```

<!-- parlel:testenv:end -->
