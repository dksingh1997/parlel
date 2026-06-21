# Instagram (Graph API)

Lightweight, dependency-free, in-memory fake of the [Instagram Graph API](https://developers.facebook.com/docs/instagram-api) for testing code that publishes media (the two-step container → publish flow) and reads an IG account's media.

Default port: `4802`

## Quick start

```js
import { InstagramServer } from "./services/instagram/src/server.js";

const server = new InstagramServer(4802);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your Graph client (or raw `fetch`) at `http://127.0.0.1:4802`. The access token may be passed as a `?access_token=` query parameter or as `Authorization: Bearer <token>`:

```js
const igUserId = "17841400000000001";

// 1. Create a media container
const container = await fetch(`http://127.0.0.1:4802/v18.0/${igUserId}/media`, {
  method: "POST",
  headers: { Authorization: "Bearer parlel-test-token", "Content-Type": "application/json" },
  body: JSON.stringify({ image_url: "https://example.com/photo.jpg", caption: "Hello!" }),
}).then((r) => r.json());

// 2. Publish it
const published = await fetch(`http://127.0.0.1:4802/v18.0/${igUserId}/media_publish`, {
  method: "POST",
  headers: { Authorization: "Bearer parlel-test-token", "Content-Type": "application/json" },
  body: JSON.stringify({ creation_id: container.id }),
}).then((r) => r.json());
// published.id => the new media id
```

## Implemented operations

Routes are versioned (`/v18.0/...`). Auth via `?access_token=` query OR `Authorization: Bearer <token>` (any non-empty token accepted). State is in-memory and ephemeral.

- `GET /v18.0/:igUserId` — IG account node (`{ id, username, name, followers_count, media_count }`).
- `GET /v18.0/:igUserId/media` — list published media (`{ data: [{ id }], paging }`).
- `POST /v18.0/:igUserId/media` — create a media container (`{ id }`). Requires `image_url` or `video_url`.
- `POST /v18.0/:igUserId/media_publish` — publish a container (`{ id }`). Requires a valid `creation_id`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/media` — list published media.
- `GET /__parlel/containers` — list created containers.

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| IG user node lookup | ✅ Supported |
| Media listing | ✅ Supported |
| Container create → publish flow | ✅ Supported |
| `?access_token=` query and Bearer auth | ✅ Supported |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Carousel / Reels / Stories specifics | ◐ Containers accepted, not fully modeled |
| Insights / comments / hashtag search | ⟳ Roadmap |
| Real media hosting / publishing to Instagram | ✓ By design — Intentionally unsupported (fake only) |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
INSTAGRAM_ACCESS_TOKEN=parlel
INSTAGRAM_BASE_URL=http://localhost:4802
```

<!-- parlel:testenv:end -->
