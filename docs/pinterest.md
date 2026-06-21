# Pinterest

Lightweight, dependency-free, in-memory fake of the [Pinterest API v5](https://developers.pinterest.com/docs/api/v5/) for testing code that creates pins/boards and reads the user account.

Default port: `4805`

## Quick start

```js
import { PinterestServer } from "./services/pinterest/src/server.js";

const server = new PinterestServer(4805);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your client (or raw `fetch`) at `http://127.0.0.1:4805`:

```js
const board = await fetch("http://127.0.0.1:4805/v5/boards", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-test-token", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Inspiration", privacy: "PUBLIC" }),
}).then((r) => r.json());

const pin = await fetch("http://127.0.0.1:4805/v5/pins", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-test-token", "Content-Type": "application/json" },
  body: JSON.stringify({
    board_id: board.id,
    title: "My Pin",
    media_source: { source_type: "image_url", url: "https://example.com/x.jpg" },
  }),
}).then((r) => r.json());
```

## Implemented operations

All `/v5/*` routes require `Authorization: Bearer <token>` (any non-empty token accepted). List responses use the `{ items: [], bookmark }` shape. State is in-memory and ephemeral.

- `GET /v5/user_account` — the authenticated user account.
- `GET /v5/pins` — list pins (`{ items, bookmark }`).
- `POST /v5/pins` — create a pin (`201`). Requires `board_id`.
- `GET /v5/pins/:pin_id` — retrieve a pin.
- `DELETE /v5/pins/:pin_id` — delete a pin (`204`).
- `GET /v5/boards` — list boards (`{ items, bookmark }`).
- `POST /v5/boards` — create a board (`201`). Requires `name`.
- `GET /v5/boards/:board_id` — retrieve a board.
- `DELETE /v5/boards/:board_id` — delete a board (`204`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/pins` — list captured pins.
- `GET /__parlel/boards` — list captured boards.

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Pins (list/create/get/delete) | ✅ Supported |
| Boards (list/create/get/delete) | ✅ Supported |
| User account | ✅ Supported |
| `{ items, bookmark }` list shape | ✅ Supported |
| Bearer token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Media upload / real image hosting | ⟳ Roadmap — metadata only |
| Board sections, ads, analytics | ⟳ Roadmap |
| Pagination via `bookmark` | ◐ Always `null` (single page) |
| Real publishing to Pinterest | ✓ By design — Intentionally unsupported (fake only) |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PINTEREST_ACCESS_TOKEN=parlel
PINTEREST_BASE_URL=http://localhost:4805
```

<!-- parlel:testenv:end -->
