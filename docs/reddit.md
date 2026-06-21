# Reddit

Lightweight, dependency-free, in-memory fake of the [Reddit API](https://www.reddit.com/dev/api/) for testing code that authenticates, reads listings, and submits posts.

Default port: `4804`

## Quick start

```js
import { RedditServer } from "./services/reddit/src/server.js";

const server = new RedditServer(4804);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your client (or raw `fetch`) at `http://127.0.0.1:4804`. First obtain a token, then call OAuth endpoints with a `Bearer` token **and** a unique `User-Agent` header (Reddit enforces this):

```js
const token = await fetch("http://127.0.0.1:4804/api/v1/access_token", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from("clientId:secret").toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
}).then((r) => r.json());

const me = await fetch("http://127.0.0.1:4804/api/v1/me", {
  headers: { Authorization: `Bearer ${token.access_token}`, "User-Agent": "myapp/1.0 (by /u/me)" },
}).then((r) => r.json());
```

## Implemented operations

`POST /api/v1/access_token` is unauthenticated (client-credentials). Every other route requires `Authorization: Bearer <token>` **and** a `User-Agent` header (missing UA → `429`). State is in-memory and ephemeral.

- `POST /api/v1/access_token` — issue an access token (`{ access_token, token_type, expires_in, scope }`).
- `GET /api/v1/me` — the authenticated account (a `t2` thing).
- `GET /r/:subreddit/hot.json` — hot listing (`{ kind: "Listing", data: { children: [{ kind: "t3", data }], after, before } }`).
- `GET /r/:subreddit/about.json` — subreddit info (`{ kind: "t5", data }`).
- `POST /api/submit` — submit a post. Returns `{ json: { errors: [], data: { id, name, url } } }`.

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
| OAuth token issuance | ✅ Issues opaque tokens (not validated) |
| Identity (`/api/v1/me`) | ✅ Supported |
| Hot listing / subreddit about | ✅ Supported |
| Submit post | ✅ Supported |
| `Listing` / `t2` / `t3` / `t5` thing shapes | ✅ Supported |
| `User-Agent` requirement | ✅ Enforced (missing → `429`) |
| Bearer token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Comments / voting / messaging | ⟳ Roadmap |
| `new`/`top`/`rising` sorts, pagination cursors | ◐ `hot` only; single page |
| Real posting to Reddit | ✓ By design — Intentionally unsupported (fake only) |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
REDDIT_ACCESS_TOKEN=parlel
REDDIT_USER_AGENT=parlel/1.0 (by /u/parlel)
REDDIT_BASE_URL=http://localhost:4804
```

<!-- parlel:testenv:end -->
