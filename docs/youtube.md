# YouTube (Data API v3)

Lightweight, dependency-free, in-memory fake of the [YouTube Data API v3](https://developers.google.com/youtube/v3) for testing code that reads channels/videos, searches, and manages playlists.

Default port: `4803`

## Quick start

```js
import { YoutubeServer } from "./services/youtube/src/server.js";

const server = new YoutubeServer(4803);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const channels = await fetch(
  "http://127.0.0.1:4803/youtube/v3/channels?part=snippet,statistics&mine=true&key=parlel"
).then((r) => r.json());
// channels.items[0].snippet.title
```

## Implemented operations

Routes are under `/youtube/v3/...`. Auth via `?key=` query OR `Authorization: Bearer <token>`. Responses use the `{ kind, etag, items: [], pageInfo: { totalResults, resultsPerPage } }` shape. State is in-memory and ephemeral.

- `GET /youtube/v3/channels?part=...&mine=true` — list channels (`youtube#channelListResponse`).
- `GET /youtube/v3/videos?part=...&id=...` — list videos by id (`youtube#videoListResponse`).
- `GET /youtube/v3/search?q=...` — search (`youtube#searchListResponse`, items carry `id.videoId`).
- `POST /youtube/v3/playlists` — create a playlist (`youtube#playlist`). Requires `snippet.title`.
- `GET /youtube/v3/playlistItems?playlistId=...` — list playlist items (`youtube#playlistItemListResponse`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/playlists` — list created playlists.

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Channels list (`mine=true`) | ✅ Supported |
| Videos list (by `id`) | ✅ Supported |
| Search | ✅ Supported (returns seeded videos) |
| Playlists create | ✅ Supported |
| PlaylistItems list | ✅ Supported |
| `?key=` and Bearer auth | ✅ Supported |
| Key/token validity / quota enforcement | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| Video upload (`videos.insert`) | ⟳ Roadmap |
| Real search ranking / pagination tokens | ◐ Single page; seeded results |
| Comments / captions / live streaming | ⟳ Roadmap |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
YOUTUBE_API_KEY=parlel
YOUTUBE_ACCESS_TOKEN=parlel
YOUTUBE_BASE_URL=http://localhost:4803
```

<!-- parlel:testenv:end -->
