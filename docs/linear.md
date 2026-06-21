# Linear

Lightweight, dependency-free, in-memory fake of the **Linear GraphQL API** for testing code that uses the real `@linear/sdk` client or raw GraphQL requests against `https://api.linear.app/graphql`.

Default port: `4788`

The fake includes a **minimal but real GraphQL parser**: the query string is tokenised, the operation type (`query`/`mutation`) and top-level fields + arguments are extracted, `$variables` are substituted from the request `variables` map, and each field is dispatched to an in-memory resolver.

## Quick start

```js
import { LinearServer } from "./services/linear/src/server.js";

const server = new LinearServer(4788);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const res = await fetch("http://127.0.0.1:4788/graphql", {
  method: "POST",
  headers: { Authorization: "lin_api_xxx", "Content-Type": "application/json" },
  body: JSON.stringify({
    query: `mutation { issueCreate(input: { title: "Hello" }) { success lastSyncId issue { id identifier title } } }`,
  }),
});
// => 200 { data: { issueCreate: { success: true, lastSyncId: 1, issue: { id, identifier: "PAR-1", title } } } }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4788`). Set `LINEAR_BASE_URL` to that URL
and provide any non-empty `LINEAR_API_KEY` — like real Linear, the fake accepts a

OAuth `Bearer` token. Only `POST /graphql` is served.

## Implemented operations

`POST /graphql` is the only API endpoint and requires a non-empty `Authorization` header.

### Queries
- `viewer { id name email displayName }` — the authenticated user.
- `issues { nodes { ... } pageInfo }` — all issues (Relay connection shape).
- `issue(id: String) { ... }` — a single issue by id (returns `null` if not found).
- `teams { nodes { id name key } pageInfo }` — all teams.
- `comment(id: String) { id body createdAt updatedAt issue { id } user { id } }` — a single comment by id.

### Mutations
- `issueCreate(input: { title, description?, priority?, teamId?, assigneeId? }) { success lastSyncId issue { ... } }` — create an issue. Requires `title`. The returned issue carries `id`, `identifier`, `number`, `title`, `description`, `priority`, `priorityLabel`, `url`, `branchName`, `createdAt`, `updatedAt`, and nested `team { id }` / `creator { id }` / `assignee { id }` / `state { id name type }`.
- `issueUpdate(id, input) { success lastSyncId issue }` — update fields. An unknown `id` returns a GraphQL **entity-not-found** error (not a silent `success: false`).
- `issueDelete(id) { success lastSyncId }` — archive/delete an issue (Linear's `issueDelete` returns an `IssueArchivePayload`). An unknown `id` returns a GraphQL error.
- `commentCreate(input: { issueId, body }) { success lastSyncId comment { id body issue { id } } }` — create a comment on an existing issue. Requires `body` and a valid `issueId`.

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `viewer`, `teams`, `issues`, `issue`, `comment` queries | ✅ Supported |
| `issueCreate` / `issueUpdate` / `issueDelete` / `commentCreate` mutations | ✅ Supported |
| Mutation payloads return `success` + `lastSyncId` + entity | ✅ Supported |
| Issue fields `number`, `priorityLabel`, `updatedAt`, `branchName`, nested `team`/`creator`/`assignee` | ✅ Supported |
| Relay `pageInfo` (`startCursor`, `endCursor`, `hasPreviousPage`, `hasNextPage`) | ✅ Supported |
| GraphQL parsing (variables, args, aliases, nested selections) | ✅ Supported (minimal real parser) |

| Missing/invalid auth → HTTP `400` + GraphQL `errors` (`extensions.type: "authentication error"`) | ✅ Supported |
| `issueUpdate` / `issueDelete` on unknown id → GraphQL entity-not-found error | ✅ Supported |
| List args (`first`, `after`, `filter`, `orderBy`) | ◐ Accepted-not-enforced |
| Field-level selection pruning (returning only requested fields) | ◐ Returns full resolver objects |
| Fragments, directives, introspection | ⟳ Roadmap |
| Projects, cycles, labels CRUD, workflow-state transitions | ⟳ Roadmap |
| Webhooks / file upload / OAuth actor authorization | ⟳ Roadmap |

## Error codes & shapes

Like the real Linear API, errors use the GraphQL `{ "errors": [ { "message", "extensions", "path" } ] }` envelope:

- **Missing / invalid `Authorization`** → HTTP **`400`** (Linear does *not* use `401`) with
  `{ "errors": [ { "message": "Authentication required - not authenticated", "extensions": { "type": "authentication error", "userError": true, "userPresentableMessage": "..." } } ] }`.
- **Missing `query` attribute** → HTTP **`400`** with an `errors` array.
- **Resolver errors** (validation such as missing `title`/`body`, or **entity-not-found** on `issueUpdate`/`issueDelete`/`commentCreate`) → HTTP **`200`** with an `errors` array (`extensions.type: "invalid input"`) and the corresponding `data.<field>` set to `null`, per the GraphQL spec.
- **Malformed JSON body** → HTTP **`400`** with `errors`.

## Manifest

See `services/linear/manifest.json`:

- name: `linear`, image: `parlel/linear:1`
- port: `4788`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `LINEAR_API_KEY`, `LINEAR_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
LINEAR_API_KEY=lin_api_parlel
LINEAR_BASE_URL=http://localhost:4788
```

<!-- parlel:testenv:end -->
