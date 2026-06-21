# WordPress

Lightweight, dependency-free, in-memory fake of the **WordPress REST API v2** for testing code that talks to `/wp-json/wp/v2/...`.

Default port: `4844`

## Quick start

```js
import { WordpressServer } from "./services/wordpress/src/server.js";

const server = new WordpressServer(4844);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Create a post (writes require Basic auth with an application password):

```js
const auth = "Basic " + Buffer.from("parlel:app-password").toString("base64");
await fetch("http://127.0.0.1:4844/wp-json/wp/v2/posts", {
  method: "POST",
  headers: { Authorization: auth, "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Hello World", content: "Body", status: "publish" }),
});
```

## Access via MCP / preview URL

When run inside a parlel pool, reachable at its mapped preview URL (e.g.
`http://127.0.0.1:4844`). MCP clients drive posts, pages, categories, and users using
`WORDPRESS_USERNAME` / `WORDPRESS_APP_PASSWORD` for Basic auth. Reads are public; writes
require Basic auth.

## Implemented operations

State is in-memory and ephemeral. Routes live under `/wp-json/wp/v2/...`. An `Uncategorized` category (id 1) is seeded.

### Posts / Pages

- `GET /wp-json/wp/v2/posts` — list posts (supports `status`, `search`). Sets `X-WP-Total`/`X-WP-TotalPages` headers.
- `POST /wp-json/wp/v2/posts` — create a post (`201`). Shape `{ id, date, status, title:{rendered}, content:{rendered}, slug, categories, ... }`.
- `GET /wp-json/wp/v2/posts/:id` — fetch a post.
- `POST /wp-json/wp/v2/posts/:id` — update a post.
- `DELETE /wp-json/wp/v2/posts/:id` — trash a post; `?force=true` deletes permanently (`{ deleted: true, previous }`).
- `GET|POST /wp-json/wp/v2/pages` (+/:id) — same surface for pages.

### Categories

- `GET /wp-json/wp/v2/categories` — list categories.
- `POST /wp-json/wp/v2/categories` — create a category (auth required).
- `GET /wp-json/wp/v2/categories/:id` — fetch a category.

### Users

- `GET /wp-json/wp/v2/users/me` — current user (auth required).

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Posts/pages list / create / get / update / delete | ✅ Supported |
| Categories list / create / get | ✅ Supported |
| `users/me` (Basic / application password) | ✅ Supported |
| `rendered` title/content/excerpt envelopes, `X-WP-Total` headers | ✅ Supported |
| Basic auth validity / capabilities | ✓ By design — Intentional for a local, zero-cost test emulator |
| Media uploads, comments, tags, taxonomies, custom post types | ⟳ Roadmap |
| Block rendering, revisions, autosaves | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

WordPress uses `{ code, message, data:{ status } }`:

| Status | When |
| --- | --- |
| `401` | write/`users/me` without Basic auth |
| `400` | missing required param (e.g. category `name`) |
| `404` | unknown post/page/category id, or unknown route |

## Manifest

See `services/wordpress/manifest.json` — name `wordpress`, port `4844`, protocol
`http`, healthcheck `/health`, env `WORDPRESS_USERNAME`, `WORDPRESS_APP_PASSWORD`,
`WORDPRESS_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
WORDPRESS_USERNAME=parlel
WORDPRESS_APP_PASSWORD=parlel
WORDPRESS_BASE_URL=http://localhost:4844
```

<!-- parlel:testenv:end -->
