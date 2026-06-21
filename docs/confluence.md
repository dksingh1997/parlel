# Confluence

Lightweight, dependency-free, in-memory fake of the **Confluence Cloud REST API** for testing code that talks to the Confluence `/wiki/rest/api` surface.

Default port: `4795`

Auth is Basic (email + API token) or Bearer. Content objects carry `{ id, type: "page", status, title, space, body, ... }`; collections carry `{ results, size, _links }`.

## Quick start

```js
import { ConfluenceServer } from "./services/confluence/src/server.js";

const server = new ConfluenceServer(4795);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const res = await fetch("http://127.0.0.1:4795/wiki/rest/api/content", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from("you@example.com:token").toString("base64"),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    type: "page",
    title: "My page",
    space: { key: "PARLEL" },
    body: { storage: { value: "<p>hi</p>", representation: "storage" } },
  }),
});
// => 200 { id, type: "page", status: "current", title, space, body, ... }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4795`). Set `CONFLUENCE_BASE_URL` to that
URL and supply any non-empty `CONFLUENCE_API_TOKEN` / `CONFLUENCE_EMAIL`; the
fake accepts any Basic or Bearer credential.

## Implemented operations

All `/wiki/rest/api/*` routes require an `Authorization` header (Basic or Bearer).

### Content
- `GET /wiki/rest/api/content` — list content (filters: `?spaceKey=`, `?type=`). Returns `{ results, size, _links }`.
- `POST /wiki/rest/api/content` — create (requires `title`). Returns the content object.
- `GET /wiki/rest/api/content/:id` — retrieve.
- `PUT /wiki/rest/api/content/:id` — update (`title`, `body`, `status`, `version.number`).
- `DELETE /wiki/rest/api/content/:id` — delete (`204`).

### Spaces
- `GET /wiki/rest/api/space` — list spaces (a default `PARLEL` space exists).
- `GET /wiki/rest/api/space/:key` — retrieve.

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Content create / get / update / delete / list | ✅ Supported |
| Space list / get | ✅ Supported |
| `spaceKey` / `type` filtering, version bump on update | ✅ Supported |
| List envelope (`results`, `size`, `_links`) | ✅ Supported |
| Attachments, comments, labels, child pages | ⟳ Roadmap |
| CQL search (`/content/search`) | ⟳ Roadmap |
| `expand` parameter (body, ancestors, version) | ◐ Body always present |
| Space create | ◐ Default space only |
| Auth validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error shapes

Errors use the Confluence envelope `{ statusCode, message }`.

| Status | When |
| --- | --- |
| `400` | missing required field (content `title`) |
| `401` | no `Authorization` header |
| `404` | unknown content / space / endpoint |
| `405` | method not allowed |

## Manifest

See `services/confluence/manifest.json`:

- name: `confluence`, image: `parlel/confluence:1`
- port: `4795`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CONFLUENCE_API_TOKEN`, `CONFLUENCE_EMAIL`, `CONFLUENCE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CONFLUENCE_API_TOKEN=confluence_parlel
CONFLUENCE_EMAIL=parlel@example.com
CONFLUENCE_BASE_URL=http://localhost:4795
```

<!-- parlel:testenv:end -->
