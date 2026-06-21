# GitLab

Lightweight, dependency-free, in-memory GitLab API v4 fake for testing code that uses `@gitbeaker/rest`, the `glab` CLI, or the raw GitLab REST API.

Default port: `4768`

## Quick start

```js
import { GitlabServer } from "./services/gitlab/src/server.js";

const server = new GitlabServer(4768);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point gitbeaker at it:

```js
import { Gitlab } from "@gitbeaker/rest";

const api = new Gitlab({
  host: "http://127.0.0.1:4768",
  token: "glpat-parlel",
});

const user = await api.Users.showCurrentUser();
// user.username => "parlel-user"
```

## Access via MCP / preview URL

- REST base URL: `http://127.0.0.1:4768/api/v4`
- Set `GITLAB_TOKEN=glpat-parlel`, `GITLAB_API_URL=http://127.0.0.1:4768`, and `CI_API_V4_URL=http://127.0.0.1:4768/api/v4`.

Any MCP server or agent reading these standard env vars uses the fake transparently.

## Implemented operations

All `/api/v4/*` routes require a `PRIVATE-TOKEN: <token>` header **or** `Authorization: Bearer <token>` (any non-empty token accepted). Attributes may be supplied via the JSON/form body **or** the query string (`POST /api/v4/projects?name=demo`), exactly like the real API. State is in-memory and ephemeral.

- `GET /api/v4/user` — current authenticated user.
- `GET /api/v4/projects` — list projects (offset-paginated; honors `page` & `per_page`).
- `POST /api/v4/projects` — create a project (`201`); requires `name` or `path`.
- `GET /api/v4/projects/:id` — retrieve a project.
- `PUT /api/v4/projects/:id` — update name/description/visibility/default branch.
- `DELETE /api/v4/projects/:id` — delete (`202 Accepted`, matching GitLab's scheduled deletion).
- `GET /api/v4/projects/:id/issues` — list issues (offset-paginated).
- `POST /api/v4/projects/:id/issues` — create issue (`201`, requires `title`), returns project-scoped `iid` plus the full GitLab issue shape (`author`, `assignee`, `type`, `references`, `time_stats`, `upvotes`/`downvotes`, `task_completion_status`, …).
- `GET /api/v4/projects/:id/issues/:iid` — retrieve / `PUT` update (`state_event: close|reopen`; `open_issues_count` is kept in sync).
- `GET /api/v4/projects/:id/merge_requests` — list MRs (offset-paginated).
- `POST /api/v4/projects/:id/merge_requests` — create MR (`201`, requires `title`, `source_branch`, `target_branch`); returns the full MR shape (`merge_status`, `detailed_merge_status`, `references`, `author`, …).
- `GET /api/v4/projects/:id/merge_requests/:iid` — retrieve / `PUT` update (`state_event: close|reopen`).

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/projects` — list project ids.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /user` | ✅ Supported |
| Projects CRUD | ✅ Supported |
| Issues create / list / get / update | ✅ Supported |
| Merge requests create / list / get / update | ✅ Supported |
| `PRIVATE-TOKEN` / `Bearer` auth | ✅ Required (any non-empty token) |
| `401` / `400` / `404` / `405` error envelopes | ✅ Match real GitLab shapes |
| Offset pagination (`page`/`per_page` + `X-Total`/`X-Page`/`Link` headers) | ✅ Supported |
| Query-string attributes on create/update | ◐ Accepted — merged with JSON/form body |
| Rich issue/MR fields (`author`, `references`, `time_stats`, `merge_status`) | ✅ Supported |
| Keyset pagination (`pagination=keyset`, cursors) | ⟳ Roadmap |
| Groups / pipelines / jobs / runners | ⟳ Roadmap |
| Real merge / approvals | ⟳ Roadmap — MR `merge_status` static |
| Scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

GitLab's error envelope is `{ "message": "..." }`. For a missing required attribute the message is the literal GitLab string `400 (Bad request) "<field>" not given`.

| Status | When | Body |
| --- | --- | --- |
| `401` | missing/invalid token | `{ "message": "401 Unauthorized" }` |
| `400` | missing required field | `{ "message": "400 (Bad request) \"title\" not given" }` |
| `400` | invalid JSON body | `{ "message": "400 Bad Request", "error": "invalid JSON" }` |
| `404` | unknown resource | `{ "message": "404 Project Not Found" }` / `{ "message": "404 Not Found" }` |
| `405` | method not allowed | `{ "message": "405 Method Not Allowed" }` |

## Manifest

See `services/gitlab/manifest.json`:

- name: `gitlab`, image: `parlel/gitlab:1`
- port: `4768`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `GITLAB_TOKEN`, `GITLAB_API_URL`, `CI_API_V4_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GITLAB_TOKEN=glpat-parlel
GITLAB_API_URL=http://localhost:4768
CI_API_V4_URL=http://localhost:4768/api/v4
```

<!-- parlel:testenv:end -->
