# monday.com

Lightweight, dependency-free, in-memory fake of the **monday.com GraphQL API** for testing code that talks to the monday.com GraphQL endpoint.

Default port: `4791`

`POST /v2` is the only API endpoint. The fake includes a **minimal but real GraphQL parser**: the query string is tokenised, the operation type (`query`/`mutation`) and top-level fields + arguments are extracted, `$variables` are substituted, and each field is dispatched to an in-memory resolver.

## Quick start

```js
import { MondayServer } from "./services/monday/src/server.js";

const server = new MondayServer(4791);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const res = await fetch("http://127.0.0.1:4791/v2", {
  method: "POST",
  headers: { Authorization: "monday_xxx", "Content-Type": "application/json" },
  body: JSON.stringify({
    query: `mutation { create_item(board_id: 123, item_name: "Hello") { id } }`,
  }),
});
// => 200 { data: { create_item: { id } }, account_id }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4791`). Set `MONDAY_BASE_URL` to that URL and
provide any non-empty `MONDAY_API_TOKEN` — the fake accepts any token. Only
`POST /v2` is served.

## Implemented operations

`POST /v2` requires a non-empty `Authorization` header.

### Queries
- `me { id name email }` — the authenticated user.
- `boards { id name state board_kind }` — all boards (optional `ids` filter).
- `items { id name board group }` — all items (optional `ids` filter).

### Mutations
- `create_item(board_id, item_name, group_id?) { id name }` — create an item. Requires `item_name`.
- `create_board(board_name, board_kind?) { id name }` — create a board.
- `delete_item(item_id) { id }` — delete an item.

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `me`, `boards`, `items` queries | ✅ Supported |
| `create_item` / `create_board` / `delete_item` | ✅ Supported |
| GraphQL parsing (variables, args, aliases, nested selections) | ✅ Supported (minimal real parser) |
| `{ data, account_id }` response envelope | ✅ Supported |
| Column values, groups, subitems, updates | ◐ Stubbed |
| Field-level selection pruning | ◐ Returns full resolver objects |
| Complexity budget / rate limiting | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error shapes

GraphQL errors are returned with HTTP `200` and an `errors: [{ message }]` array plus `account_id`. A missing `Authorization` header returns HTTP `401`.

## Manifest

See `services/monday/manifest.json`:

- name: `monday`, image: `parlel/monday:1`
- port: `4791`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `MONDAY_API_TOKEN`, `MONDAY_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MONDAY_API_TOKEN=monday_parlel
MONDAY_BASE_URL=http://localhost:4791
```

<!-- parlel:testenv:end -->
