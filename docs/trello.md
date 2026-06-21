# Trello

Lightweight, dependency-free, in-memory fake of the **Trello REST API** for testing code that talks to the Trello API.

Default port: `4792`

Trello authenticates with `?key=<key>&token=<token>` query parameters. The fake accepts any non-empty key+token pair. Write parameters may arrive as query params, a JSON body, or a form-urlencoded body — all are merged.

## Quick start

```js
import { TrelloServer } from "./services/trello/src/server.js";

const server = new TrelloServer(4792);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const res = await fetch(
  "http://127.0.0.1:4792/1/cards?key=K&token=T",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "My card", idList: "<listId>" }),
  }
);
// => 200 { id: <24-hex>, name, idBoard, idList, url, ... }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4792`). Set `TRELLO_BASE_URL` to that URL
and supply any non-empty `TRELLO_API_KEY` + `TRELLO_TOKEN` (passed as
`?key=&token=`).

## Implemented operations

All `/1/*` routes require non-empty `key` and `token` query parameters. Resource ids are 24-char hex strings.

### Boards
- `GET /1/boards` — list boards.
- `POST /1/boards` — create (requires `name`).
- `GET /1/boards/:id` — retrieve.
- `PUT /1/boards/:id` — update (`name`, `desc`, `closed`).
- `DELETE /1/boards/:id` — delete.

### Lists
- `GET /1/lists` — list lists.
- `POST /1/lists` — create (requires `name`).
- `GET /1/lists/:id` — retrieve.
- `PUT /1/lists/:id` — update.

### Cards
- `GET /1/cards` — list cards.
- `POST /1/cards` — create (requires `idList`). Shape `{ id, name, idBoard, idList, url, ... }`.
- `GET /1/cards/:id` — retrieve.
- `PUT /1/cards/:id` — update (`name`, `desc`, `idList`, `closed`, `dueComplete`).
- `DELETE /1/cards/:id` — delete.

### Members
- `GET /1/members/me` — the authenticated member.

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Board / list / card CRUD | ✅ Supported |
| `members/me` | ✅ Supported |
| 24-hex resource ids | ✅ Supported |
| Query / JSON / form-urlencoded param merging | ✅ Supported |
| Checklists, labels, attachments, actions, webhooks | ⟳ Roadmap |
| Nested expansions (`?cards=all`, `?lists=open`) | ◐ Not modeled |
| key/token validity | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error shapes

Errors return a JSON `{ message }` body.

| Status | When |
| --- | --- |
| `400` | missing required field (e.g. board `name`, card `idList`) |
| `401` | missing `key` or `token` |
| `404` | unknown resource / endpoint |
| `405` | method not allowed |

## Manifest

See `services/trello/manifest.json`:

- name: `trello`, image: `parlel/trello:1`
- port: `4792`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
TRELLO_API_KEY=trello_parlel
TRELLO_TOKEN=trello_token_parlel
TRELLO_BASE_URL=http://localhost:4792
```

<!-- parlel:testenv:end -->
