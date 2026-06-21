# Jira

Lightweight, dependency-free, in-memory fake of the **Jira Cloud REST API v3** for testing code that uses the real `jira.js` client or the language-agnostic `/rest/api/3` REST surface.

Default port: `4787`

## Quick start

```js
import { JiraServer } from "./services/jira/src/server.js";

const server = new JiraServer(4787);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a Jira client at it (basic auth with email + API token, or a bearer token):

```js
const res = await fetch("http://127.0.0.1:4787/rest/api/3/issue", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from("you@example.com:api-token").toString("base64"),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    fields: { project: { key: "PARLEL" }, summary: "My first issue", issuetype: { name: "Task" } },
  }),
});
// => 201 { id, key: "PARLEL-1", self }
```

## Access via MCP / preview URL

The service is exposed by the parlel pool like every other emulator: point your
MCP server / agent tooling at the preview URL printed by the pool (defaults to
`http://127.0.0.1:4787`). Set `JIRA_BASE_URL` to that URL and supply any
non-empty `JIRA_API_TOKEN` / `JIRA_EMAIL`; the fake accepts any Basic or Bearer
credential. All `/rest/api/3/*` routes are available through the proxy.

## Implemented operations

All `/rest/api/3/*` routes require an `Authorization` header (Basic or Bearer, any non-empty value).

### Issues
- `POST /rest/api/3/issue` — create an issue. Requires `fields.summary`, `fields.project` (`key` or `id`), and `fields.issuetype` (`name` or `id`) — exactly like the real Jira Cloud endpoint. Missing or unknown values return `400` with an `errors` map keying every offending field at once. Returns `201 { id, key, self }`.
- `GET /rest/api/3/issue/:idOrKey` — retrieve by id or key. Returns `{ id, key, self, fields: { summary, status, project, issuetype, ... } }`.
- `PUT /rest/api/3/issue/:idOrKey` — update fields. Returns `204`.
- `DELETE /rest/api/3/issue/:idOrKey` — delete. Returns `204`.

### Transitions
- `GET /rest/api/3/issue/:idOrKey/transitions` — list transitions available from the current status. Returns `{ expand, transitions: [{ id, name, to }] }`.
- `POST /rest/api/3/issue/:idOrKey/transitions` — apply a transition by id (`{ transition: { id } }`). Returns `204`; an invalid transition id returns `400`.

### Search
- `POST /rest/api/3/search` — JQL search. Returns `{ startAt, maxResults, total, issues: [...] }`. Supports `project = KEY` and `status = "X"` filters plus `startAt`/`maxResults` paging.
- `GET /rest/api/3/search?jql=...` — same, via query params.

### Projects
- `GET /rest/api/3/project` — list projects.
- `POST /rest/api/3/project` — create (`201 { id, key, self }`).
- `GET /rest/api/3/project/:idOrKey` — retrieve.

### User
- `GET /rest/api/3/myself` — the authenticated user (`{ accountId, displayName, emailAddress, ... }`).

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Issue create / get / update / delete | ✅ Supported |
| Required `fields.summary` / `project` / `issuetype` on create | ✅ Supported |
| Transitions list / apply (To Do → In Progress → Done) | ✅ Supported |
| JQL search (`project`, `status`, paging) | ✅ Supported (subset) |
| Project list / create / get | ✅ Supported |
| `/myself` | ✅ Supported |
| Basic (email:token) and Bearer auth | ✅ Supported |
| Jira error envelope `{ errorMessages, errors }` | ✅ Supported |
| `description` Atlassian Document Format (ADF) | ◐ Pass-through — stored/returned as sent, not converted from v2 strings |
| Full JQL grammar (ORDER BY, functions, operators) | ◐ Subset only |
| Project create extra fields (`projectTypeKey`, `leadAccountId`) | ◐ Accepted — only `key` enforced |
| Comments / attachments / worklogs | ⟳ Roadmap |
| Webhooks, ADF rendering, permission schemes, `createmeta` | ⟳ Roadmap |
| Auth token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Errors use the Jira envelope `{ errorMessages: [...], errors: {...} }`.

| Status | When |
| --- | --- |
| `400` | missing/invalid required field on create (`summary`, `project`, `issuetype` — all offending fields are returned together in `errors`); invalid transition id; missing project `key` on project create |
| `401` | no `Authorization` header |
| `404` | unknown issue / project / endpoint |
| `405` | method not allowed |

Example: creating an issue with no `summary`, `project`, or `issuetype` returns

```json
{ "errorMessages": [], "errors": {
  "summary": "You must specify a summary of the issue.",
  "project": "Specify a valid project ID or key",
  "issuetype": "Specify an issue type."
} }
```

## Manifest

See `services/jira/manifest.json`:

- name: `jira`, image: `parlel/jira:1`
- port: `4787`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `JIRA_API_TOKEN`, `JIRA_EMAIL`, `JIRA_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
JIRA_API_TOKEN=jira_parlel
JIRA_EMAIL=parlel@example.com
JIRA_BASE_URL=http://localhost:4787
```

<!-- parlel:testenv:end -->
