# Todoist

Lightweight, dependency-free, in-memory fake of the **Todoist REST API v2** for testing code that uses the real `@doist/todoist-api-typescript` client or the language-agnostic `/rest/v2` surface.

Default port: `4793`

## Quick start

```js
import { TodoistServer } from "./services/todoist/src/server.js";

const server = new TodoistServer(4793);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const res = await fetch("http://127.0.0.1:4793/rest/v2/tasks", {
  method: "POST",
  headers: { Authorization: "Bearer todoist_xxx", "Content-Type": "application/json" },
  body: JSON.stringify({ content: "Buy milk" }),
});
// => 200 { id, content: "Buy milk", project_id, is_completed: false, ... }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4793`). Set `TODOIST_BASE_URL` to that URL
and supply any non-empty `TODOIST_API_TOKEN`; the fake accepts any `Bearer`
token.

## Implemented operations

All `/rest/v2/*` routes require an `Authorization: Bearer <token>` header.

### Tasks
- `GET /rest/v2/tasks` — list active (uncompleted) tasks. Supports `?project_id=`.
- `POST /rest/v2/tasks` — create a task (requires `content`). Shape `{ id, content, project_id, is_completed, ... }`.
- `GET /rest/v2/tasks/:id` — retrieve.
- `POST /rest/v2/tasks/:id` — update (`content`, `description`, `priority`, `labels`).
- `POST /rest/v2/tasks/:id/close` — complete a task (`204`).
- `POST /rest/v2/tasks/:id/reopen` — re-open a task (`204`).
- `DELETE /rest/v2/tasks/:id` — delete (`204`).

### Projects
- `GET /rest/v2/projects` — list (a default **Inbox** always exists).
- `POST /rest/v2/projects` — create (requires `name`).
- `GET /rest/v2/projects/:id` — retrieve.

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Task create / get / update / close / reopen / delete / list | ✅ Supported |
| Project list / create / get | ✅ Supported |
| `project_id` filtering on task list | ✅ Supported |
| Sections, labels (resource), comments, reminders | ◐ Labels stored on tasks only |
| Natural-language `due_string` parsing | ◐ Stored verbatim, not parsed |
| Sync API (`/sync/v9`) | ⟳ Roadmap — REST v2 only |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error shapes

Errors return a JSON `{ error }` body.

| Status | When |
| --- | --- |
| `400` | missing required field (task `content`, project `name`) |
| `401` | no `Authorization: Bearer` header |
| `404` | unknown task / project |
| `405` | method not allowed |

## Manifest

See `services/todoist/manifest.json`:

- name: `todoist`, image: `parlel/todoist:1`
- port: `4793`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `TODOIST_API_TOKEN`, `TODOIST_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
TODOIST_API_TOKEN=todoist_parlel
TODOIST_BASE_URL=http://localhost:4793
```

<!-- parlel:testenv:end -->
