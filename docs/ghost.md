# Ghost

Lightweight, dependency-free, in-memory fake of the **Ghost Content + Admin APIs** for testing code that uses the real `@tryghost/content-api` / `@tryghost/admin-api` SDKs.

Default port: `4845`

## Quick start

```js
import { GhostServer } from "./services/ghost/src/server.js";

const server = new GhostServer(4845);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Create a post via the Admin API (Bearer / Ghost JWT), then read it via the Content API (`?key=`):

```js
await fetch("http://127.0.0.1:4845/ghost/api/admin/posts/", {
  method: "POST",
  headers: { Authorization: "Ghost <jwt>", "Content-Type": "application/json" },
  body: JSON.stringify({ posts: [{ title: "Hello", html: "<p>Body</p>", status: "published" }] }),
});

await fetch("http://127.0.0.1:4845/ghost/api/content/posts/?key=parlel");
```

## Access via MCP / preview URL

When run inside a parlel pool, reachable at its mapped preview URL (e.g.
`http://127.0.0.1:4845`). MCP clients drive content and admin posts using
`GHOST_CONTENT_API_KEY` (Content API `?key=`) and `GHOST_ADMIN_API_KEY` (Admin API Bearer/Ghost JWT).

## Implemented operations

State is in-memory and ephemeral.

### Content API (`?key=<key>`)

- `GET /ghost/api/content/posts/` — list **published** posts (`{ posts:[], meta:{ pagination } }`).
- `GET /ghost/api/content/posts/:id` — fetch a published post (by id or slug).
- `GET /ghost/api/content/settings/` — public site settings.

### Admin API (`Authorization: Ghost <jwt>` or `Bearer <jwt>`)

- `GET /ghost/api/admin/posts/` — list all posts (drafts included).
- `POST /ghost/api/admin/posts/` — create a post (`201 { posts:[{ id, uuid, title, slug, html, status, ... }] }`). `title` required.
- `GET /ghost/api/admin/posts/:id` — fetch any post.
- `PUT /ghost/api/admin/posts/:id` — update title/html/slug/status/feature_image.
- `DELETE /ghost/api/admin/posts/:id` — delete a post (`204`).
- `GET /ghost/api/admin/site/` — admin site info.

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Admin posts create / list / get / update / delete | ✅ Supported |
| Content posts list (published only) / get by id or slug | ✅ Supported |
| `{ posts, meta:{ pagination } }` wrappers | ✅ Supported |
| Content `?key=` + Admin Bearer/Ghost auth | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| `title` validation on create | ✅ Supported |
| mobiledoc/lexical → html rendering | ◐ `html` is stored as-provided; not rendered from mobiledoc |
| Pages, tags, members, images, themes, webhooks | ⟳ Roadmap |
| Real pagination / filtering (`filter`, `include`, `fields`) | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Ghost uses `{ errors: [{ message, type, id, ... }] }`:

| Status | When |
| --- | --- |
| `401` | Content API without `?key=`, or Admin API without Bearer/Ghost auth |
| `422` | post create without a `title` (`ValidationError`) |
| `404` | unknown post, or draft requested via Content API |

## Manifest

See `services/ghost/manifest.json` — name `ghost`, port `4845`, protocol `http`,
healthcheck `/health`, env `GHOST_CONTENT_API_KEY`, `GHOST_ADMIN_API_KEY`, `GHOST_URL`,
`GHOST_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GHOST_CONTENT_API_KEY=parlel
GHOST_ADMIN_API_KEY=parlel:parlel
GHOST_URL=http://localhost:4845
GHOST_BASE_URL=http://localhost:4845
```

<!-- parlel:testenv:end -->
