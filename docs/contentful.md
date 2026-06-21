# Contentful

Lightweight, dependency-free, in-memory fake of the **Contentful Content Delivery API (CDA)** and **Content Management API (CMA)** for testing code that uses the real `contentful` / `contentful-management` SDKs.

Default port: `4841`

## Quick start

```js
import { ContentfulServer } from "./services/contentful/src/server.js";

const server = new ContentfulServer(4841);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real client at it via `host: "127.0.0.1:4841"` (and `insecure: true`), or drive the REST API directly:

```js
await fetch("http://127.0.0.1:4841/spaces/parlel/environments/master/entries", {
  headers: { Authorization: "Bearer parlel" },
});
```

## Access via MCP / preview URL

When run inside a parlel pool, reachable at its mapped preview URL (e.g.
`http://127.0.0.1:4841`). MCP clients drive entries and content types using
`CONTENTFUL_ACCESS_TOKEN` / `CONTENTFUL_MANAGEMENT_TOKEN`, `CONTENTFUL_SPACE_ID`,
and `CONTENTFUL_ENVIRONMENT`. Any non-empty Bearer token is accepted.

## Implemented operations

State is in-memory and ephemeral. All routes require `Authorization: Bearer <token>`. Routes live under `/spaces/:spaceId/environments/:env/...` (the `/spaces/:spaceId/...` shorthand is also accepted for `entries`/`content_types`).

### Entries

- `GET /entries` — list entries. Supports `content_type`, `skip`, `limit` query params. Returns `{ sys:{type:"Array"}, total, skip, limit, items:[] }`.
- `GET /entries/:id` — fetch a single entry (`{ sys:{id,type:"Entry",...}, fields:{} }`).
- `POST /entries` — create an entry with a generated id (CMA). Content type via `X-Contentful-Content-Type` header.
- `PUT /entries/:id` — create-or-update an entry with an explicit id (CMA).
- `DELETE /entries/:id` — delete an entry (`204`).

### Content types

- `GET /content_types` — list content types (`Array` envelope). A `blogPost` type is seeded.
- `GET /content_types/:id` — fetch a single content type.

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Entry list (with `content_type`/`skip`/`limit`) / get / create / update / delete | ✅ Supported |
| Content type list / get (seeded `blogPost`) | ✅ Supported |
| `sys`/`fields` envelopes + `Array` collections | ✅ Supported |
| Bearer token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rich GROQ-like query operators, `include` link resolution, ordering | ⟳ Roadmap |
| Assets, locales, tags, publishing workflow (`/published`) | ⟳ Roadmap |
| Sync API, GraphQL endpoint | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Contentful uses `{ sys:{type:"Error", id}, message, requestId }`:

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer (`AccessTokenInvalid`) |
| `404` | unknown entry/content type (`NotFound`) |

## Manifest

See `services/contentful/manifest.json` — name `contentful`, port `4841`, protocol
`http`, healthcheck `/health`, env `CONTENTFUL_ACCESS_TOKEN`,
`CONTENTFUL_MANAGEMENT_TOKEN`, `CONTENTFUL_SPACE_ID`, `CONTENTFUL_ENVIRONMENT`,
`CONTENTFUL_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CONTENTFUL_ACCESS_TOKEN=parlel
CONTENTFUL_MANAGEMENT_TOKEN=parlel
CONTENTFUL_SPACE_ID=parlel
CONTENTFUL_ENVIRONMENT=master
CONTENTFUL_BASE_URL=http://localhost:4841
```

<!-- parlel:testenv:end -->
