# ClickUp

Lightweight, dependency-free, in-memory fake of the **ClickUp API v2** for testing code that talks to the ClickUp REST API.

Default port: `4790`

ClickUp authenticates with a **raw token** in the `Authorization` header (no `Bearer` prefix), e.g. `Authorization: pk_12345_ABC`.

## Quick start

```js
import { ClickupServer } from "./services/clickup/src/server.js";

const server = new ClickupServer(4790);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const res = await fetch("http://127.0.0.1:4790/api/v2/list/901/task", {
  method: "POST",
  headers: { Authorization: "pk_xxx", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "My task" }),
});
// => 200 { id, name, status: { status: "to do", ... }, ... }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4790`). Set `CLICKUP_BASE_URL` to that URL
and supply any non-empty `CLICKUP_API_TOKEN`; the fake accepts any raw token.

## Implemented operations

All `/api/v2/*` routes require a non-empty `Authorization` header (raw token).

### Tasks
- `GET /api/v2/list/:list_id/task` — list tasks in a list (`{ tasks: [...] }`).
- `POST /api/v2/list/:list_id/task` — create a task (requires `name`). Returns the task object.
- `GET /api/v2/task/:task_id` — retrieve. Shape `{ id, name, status: { status, color, type }, ... }`.
- `PUT /api/v2/task/:task_id` — update (`name`, `description`, `status`).
- `DELETE /api/v2/task/:task_id` — delete (returns `{}`).

### Team & User
- `GET /api/v2/team` — list authorized teams (`{ teams: [...] }`).
- `GET /api/v2/user` — the authenticated user (`{ user: {...} }`).

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Task create / get / update / delete / list-by-list | ✅ Supported |
| Team list / user | ✅ Supported |
| Status object shape | ✅ Supported |
| Spaces, folders, custom fields, comments, time tracking | ⟳ Roadmap |
| Webhooks, attachments, guests | ⟳ Roadmap |
| Pagination (`page`) | ◐ Returns all tasks |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error shapes

Errors use the ClickUp envelope `{ err, ECODE }`.

| Status | When |
| --- | --- |
| `400` | missing required field (e.g. task `name`) |
| `401` | no `Authorization` header |
| `404` | unknown task / route |
| `405` | method not allowed |

## Manifest

See `services/clickup/manifest.json`:

- name: `clickup`, image: `parlel/clickup:1`
- port: `4790`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CLICKUP_API_TOKEN`, `CLICKUP_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CLICKUP_API_TOKEN=pk_parlel
CLICKUP_BASE_URL=http://localhost:4790
```

<!-- parlel:testenv:end -->
