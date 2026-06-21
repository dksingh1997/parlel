# Facebook Pages (Graph API)

Lightweight, dependency-free, in-memory fake of the [Facebook Graph API](https://developers.facebook.com/docs/graph-api) for Pages. For testing code that publishes posts to a Page feed and reads Page metadata.

Default port: `4801`

## Quick start

```js
import { FacebookPagesServer } from "./services/facebook-pages/src/server.js";

const server = new FacebookPagesServer(4801);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your Graph client (or raw `fetch`) at `http://127.0.0.1:4801`. The access token may be passed as a `?access_token=` query parameter or as `Authorization: Bearer <token>`:

```js
const res = await fetch("http://127.0.0.1:4801/v18.0/2000000000000002/feed", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-test-token", "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Hello world from parlel" }),
});
const { id } = await res.json(); // <pageId>_<postId>
```

## Implemented operations

Routes are versioned (`/v18.0/...`). Auth via `?access_token=` query OR `Authorization: Bearer <token>` (any non-empty token accepted). State is in-memory and ephemeral.

- `GET /v18.0/me` — the user behind the token (`{ id, name }`).
- `GET /v18.0/me/accounts` — Pages the user manages (`{ data: [{ id, name, access_token, ... }], paging }`).
- `GET /v18.0/:pageId` — Page metadata (`{ id, name, category }`).
- `POST /v18.0/:pageId/feed` — publish a post. Returns `{ id }`. Requires `message` or `link`.
- `GET /v18.0/:pageId/posts` — list published posts (`{ data: [...], paging }`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/posts` — list captured posts.

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `me` / `me/accounts` | ✅ Supported |
| Page lookup | ✅ Supported |
| Feed publish (`message` / `link`) | ✅ Supported |
| Posts listing | ✅ Supported |
| `?access_token=` query and Bearer auth | ✅ Supported |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Photo / video / scheduled posts | ⟳ Roadmap |
| Insights / comments / reactions | ⟳ Roadmap |
| Real publishing to Facebook | ✓ By design — Intentionally unsupported (fake only) |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FACEBOOK_PAGES_ACCESS_TOKEN=parlel
FACEBOOK_PAGES_BASE_URL=http://localhost:4801
```

<!-- parlel:testenv:end -->
