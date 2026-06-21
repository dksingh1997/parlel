# Zoom

Lightweight, dependency-free, in-memory fake of the [Zoom API v2](https://developers.zoom.us/docs/api/) for testing code that creates meetings and looks up users.

Default port: `4797`

## Quick start

```js
import { ZoomServer } from "./services/zoom/src/server.js";

const server = new ZoomServer(4797);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point any Zoom client at `http://127.0.0.1:4797`. Obtain a token first (any value works as a bearer token), or call the OAuth endpoint:

```js
const tokenRes = await fetch("http://127.0.0.1:4797/oauth/token", {
  method: "POST",
  headers: { Authorization: "Basic " + Buffer.from("clientId:clientSecret").toString("base64") },
});
const { access_token } = await tokenRes.json();

const meeting = await fetch("http://127.0.0.1:4797/v2/users/me/meetings", {
  method: "POST",
  headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ topic: "Standup", type: 2, duration: 30 }),
}).then((r) => r.json());
// meeting.id, meeting.join_url, meeting.start_url
```

## Implemented operations

All `/v2/*` routes require `Authorization: Bearer <token>` (any non-empty token accepted). State is in-memory and ephemeral.

- `POST /oauth/token` — issue an access token (`{ access_token, token_type, expires_in, scope }`). No auth required.
- `GET /v2/users/me` — current user.
- `GET /v2/users` — list users (`{ page_count, page_number, page_size, total_records, users: [] }`).
- `GET /v2/users/:userId` — retrieve a user.
- `GET /v2/users/:userId/meetings` — list a user's meetings (`{ page_count, ..., total_records, meetings: [] }`).
- `POST /v2/users/:userId/meetings` — create a meeting (`201`). Returns `{ id, uuid, host_id, topic, join_url, start_url, ... }`.
- `GET /v2/meetings/:meetingId` — retrieve a meeting.
- `PATCH /v2/meetings/:meetingId` — update a meeting (`204 No Content`).
- `DELETE /v2/meetings/:meetingId` — delete a meeting (`204`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/meetings` — list captured meetings.
- `GET /__parlel/users` — list users.

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| OAuth token issuance | ✅ Issues opaque tokens (not validated) |
| Meeting CRUD (create/list/get/update/delete) | ✅ Supported |
| User lookup (`me`, by id, list) | ✅ Supported |
| Deterministic meeting ids / urls | ✅ Supported |
| Bearer token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Webinars, recordings, registrants, reports | ⟳ Roadmap |
| Real meeting hosting / join | ✓ By design — Intentionally unsupported (fake only) |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ZOOM_ACCESS_TOKEN=parlel
ZOOM_BASE_URL=http://localhost:4797
```

<!-- parlel:testenv:end -->
