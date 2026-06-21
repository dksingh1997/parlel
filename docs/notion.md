# Notion

Lightweight, dependency-free, in-memory fake of the **Notion API** for testing code that uses the real `@notionhq/client` SDK or the language-agnostic `/v1` REST surface.

Default port: `4794`

Notion requires an `Authorization: Bearer <token>` header **and** a `Notion-Version` header — a request to any `/v1/*` route without `Notion-Version` returns `400 missing_version`, exactly like the real API. Objects carry the documented `{ object, id, ... }` shape; collections carry `{ object: "list", results, next_cursor, has_more }`.

## Quick start

```js
import { NotionServer } from "./services/notion/src/server.js";

const server = new NotionServer(4794);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
import { Client } from "@notionhq/client";
const notion = new Client({ auth: "secret_xxx", baseUrl: "http://127.0.0.1:4794" });

const page = await notion.pages.create({
  parent: { database_id: "<dbId>" },
  properties: { Name: { title: [{ text: { content: "Hello" } }] } },
});
// => { object: "page", id, properties, ... }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4794`). Set `NOTION_BASE_URL` to that URL
and supply any non-empty `NOTION_API_KEY`; the fake accepts any `Bearer` token
and any `Notion-Version` value — but the `Notion-Version` header must be present
(the official `@notionhq/client` always sends it).

## Implemented operations

All `/v1/*` routes require an `Authorization: Bearer <token>` header **and** a `Notion-Version` header.

### Pages
- `POST /v1/pages` — create a page (requires `parent`). Returns the full page object: `{ object: "page", id, created_time, last_edited_time, created_by, last_edited_by, cover, icon, archived, in_trash, parent, properties, url, public_url }`. When `parent` is a `database_id` the page's properties are validated against the database schema (title required, property names must exist, value shape must match each property's type). The echoed `parent` carries an explicit `type` discriminator (e.g. `{ "type": "database_id", "database_id": "..." }`).
- `GET /v1/pages/:id` — retrieve the full page object.
- `PATCH /v1/pages/:id` — update `properties`, and trash/restore via `archived` or `in_trash` (the two stay mirrored, matching the real API where `archived` is a deprecated alias for `in_trash`).

### Databases
- `GET /v1/databases/:id` — retrieve a database (a default DB always exists).
- `POST /v1/databases/:id/query` — query rows. Returns a `{ object: "list", results, next_cursor, has_more }` of pages parented to that database.

### Search
- `POST /v1/search` — search pages + databases (optional `query` and `filter.value` of `page`/`database`). Returns a list object.

### Users
- `GET /v1/users/me` — the integration's bot user, including `bot.owner`, `bot.workspace_id`, `bot.workspace_limits`, and `bot.workspace_name`.

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Page create / get / update (full object shape) | ✅ Supported |
| `Notion-Version` header required (`missing_version`) | ✅ Supported |
| `parent.type` normalization (`database_id` / `page_id` / `workspace`) | ✅ Supported |
| DB-parent property schema validation (title required, type/name checks) | ✅ Supported |
| Database get / query | ✅ Supported |
| Search (pages + databases, query + type filter) | ✅ Supported |
| `users/me` (bot owner, workspace_id, workspace_limits) | ✅ Supported |
| List envelope (`object:"list"`, `next_cursor`, `has_more`) | ✅ Supported |
| Error envelope (`object:"error"`, `invalid_json` / `validation_error` / `object_not_found`) | ✅ Supported |
| Block children (`/v1/blocks/:id/children`) | ⟳ Roadmap |
| Database create | ⟳ Roadmap — a default DB always exists |
| Rich filter / sort grammar on query | ◐ Returns all rows |
| Search relevance ranking | ◐ Substring match |
| Pagination cursors | ◐ Single page (`has_more:false`) |
| Token validity / capability enforcement (403) / rate limit (429) | ✓ By design — any non-empty credential is accepted — no real secrets needed |

## Error shapes

Errors use the Notion envelope `{ object: "error", status, code, message }`.

| Status | `code` | When |
| --- | --- | --- |
| `400` | `invalid_json` | request body could not be parsed as JSON (`"Error parsing JSON body."`) |
| `400` | `missing_version` | `Notion-Version` header absent on a `/v1/*` request |
| `400` | `validation_error` | missing required field / property not in schema / type mismatch |
| `401` | `unauthorized` | no `Authorization: Bearer` header (`"API token is invalid."`) |
| `404` | `object_not_found` | unknown page / database / endpoint |
| `405` | `invalid_request` | method not allowed |

## Manifest

See `services/notion/manifest.json`:

- name: `notion`, image: `parlel/notion:1`
- port: `4794`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `NOTION_API_KEY`, `NOTION_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
NOTION_API_KEY=secret_parlel
NOTION_BASE_URL=http://localhost:4794
```

<!-- parlel:testenv:end -->
