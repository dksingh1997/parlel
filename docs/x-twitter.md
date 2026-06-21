# X / Twitter

Lightweight, dependency-free, in-memory fake of the [X (Twitter) API v2](https://docs.x.com/x-api) for testing code that posts tweets, looks up users, and likes tweets.

Default port: `4800`

## Quick start

```js
import { XTwitterServer } from "./services/x-twitter/src/server.js";

const server = new XTwitterServer(4800);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your X client (or raw `fetch`) at `http://127.0.0.1:4800`:

```js
const res = await fetch("http://127.0.0.1:4800/2/tweets", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-test-token", "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hello from parlel!" }),
});
const { data } = await res.json(); // { id, text, edit_history_tweet_ids }
```

## Implemented operations

All `/2/*` routes require `Authorization: Bearer <token>` (OAuth2 / app-only; any non-empty token accepted). State is in-memory and ephemeral.

- `POST /2/tweets` — create a tweet (`201 { data: { id, text, edit_history_tweet_ids } }`). Empty `text` → `400`.
- `GET /2/tweets/:id` — retrieve a tweet (`{ data: {...} }`, or `{ errors: [...] }` when missing).
- `DELETE /2/tweets/:id` — delete a tweet (`{ data: { deleted: true|false } }`).
- `GET /2/users/me` — the authenticated user (`{ data: { id, name, username } }`).
- `GET /2/users/by/username/:username` — look up a user by handle.
- `POST /2/users/:id/likes` — like a tweet (`{ data: { liked: true } }`). Body `{ tweet_id }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/tweets` — list captured tweets.
- `GET /__parlel/likes` — list captured likes.

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Tweet create / get / delete | ✅ Supported |
| User lookup (`me`, by username) | ✅ Supported |
| Likes | ✅ Supported |
| `{ data: ... }` / `{ errors: [...] }` envelopes | ✅ Supported |
| Bearer (OAuth2) token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Media upload, polls, threads, quote tweets | ⟳ Roadmap |
| Timelines, search, streaming | ⟳ Roadmap |
| Real posting to X | ✓ By design — Intentionally unsupported (fake only) |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
X_TWITTER_ACCESS_TOKEN=parlel
X_TWITTER_BASE_URL=http://localhost:4800
```

<!-- parlel:testenv:end -->
