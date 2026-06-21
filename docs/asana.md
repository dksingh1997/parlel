# Asana

Lightweight, dependency-free, in-memory fake of the **Asana API v1** for testing code that uses the real `node-asana` client or the language-agnostic `/api/1.0` REST surface.

Default port: `4789`

All responses are wrapped in the Asana envelope: `{ data: { ... } }` for a single resource, `{ data: [ ... ] }` for collections. Errors use `{ errors: [{ message }] }`.

## Quick start

```js
import { AsanaServer } from "./services/asana/src/server.js";

const server = new AsanaServer(4789);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const res = await fetch("http://127.0.0.1:4789/api/1.0/tasks", {
  method: "POST",
  headers: { Authorization: "Bearer asana_xxx", "Content-Type": "application/json" },
  body: JSON.stringify({ data: { name: "My task", workspace: "1000001" } }),
});
// => 201 { data: { gid, resource_type: "task", name: "My task", ... } }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4789`). Set `ASANA_BASE_URL` to that URL and
supply any non-empty `ASANA_ACCESS_TOKEN`; the fake accepts any `Bearer` token.

## Implemented operations

All `/api/1.0/*` routes require an `Authorization: Bearer <token>` header.

### Tasks
- `GET /api/1.0/tasks?workspace=:gid` — list tasks (workspace param required).
- `POST /api/1.0/tasks` — create a task (requires `data.name`). Supports `name`, `notes`, `html_notes`, `completed`, `assignee`, `due_on`, `due_at`, `start_on`, `projects`, `workspace`. Returns `201`.
- `GET /api/1.0/tasks/:id` — retrieve.
- `PUT /api/1.0/tasks/:id` — update (`name`, `notes`, `html_notes`, `completed`, `assignee`, `due_on`, `due_at`, `start_on`).
- `DELETE /api/1.0/tasks/:id` — delete (returns `{ data: {} }`).

### Projects
- `GET /api/1.0/projects?workspace=:gid` — list (workspace param required).
- `POST /api/1.0/projects` — create (requires `data.name`).
- `GET /api/1.0/projects/:id` — retrieve.

### Workspaces
- `GET /api/1.0/workspaces` — list.
- `GET /api/1.0/workspaces/:id` — retrieve.

### Users
- `GET /api/1.0/users/me` — the authenticated user.

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Task create / get / update / delete / list | ✅ Supported |
| Project list / create / get | ✅ Supported |
| Workspace list / get | ✅ Supported |
| `users/me` | ✅ Supported |
| `{ data: ... }` request/response wrapping | ✅ Supported |
| Bearer token auth | ✅ Supported |
| `due_at` (datetime) and `due_on` (date) | ✅ Supported |
| `start_on`, `html_notes` task fields | ✅ Supported |
| `workspace` required param on task/project list | ✅ Supported |
| Error envelope `{ errors: [{ message }] }` | ✅ Supported |
| Sections, subtasks, stories, attachments, tags | ⟳ Roadmap |
| `opt_fields` / `opt_expand` field selection | ◐ Returns full resource |
| Pagination (`offset`/`limit`/`next_page`) | ◐ Returns all in one page |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error shapes

Errors use the Asana envelope `{ errors: [{ message }] }`.

| Status | When |
| --- | --- |
| `400` | missing required field (e.g. task/project `name`, `workspace` on list endpoints) |
| `401` | no `Authorization: Bearer` header |
| `404` | unknown resource / endpoint |
| `405` | method not allowed |

## Manifest

See `services/asana/manifest.json`:

- name: `asana`, image: `parlel/asana:1`
- port: `4789`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `ASANA_ACCESS_TOKEN`, `ASANA_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ASANA_ACCESS_TOKEN=asana_parlel
ASANA_BASE_URL=http://localhost:4789
```

<!-- parlel:testenv:end -->
