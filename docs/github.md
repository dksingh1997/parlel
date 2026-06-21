# GitHub

Lightweight, dependency-free, in-memory GitHub REST v3 + GraphQL API fake for testing code that uses `@octokit/rest`, the `gh` CLI, or the raw GitHub REST/GraphQL API.

Default port: `4767`

## Quick start

Start the server:

```js
import { GithubServer } from "./services/github/src/server.js";

const server = new GithubServer(4767);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point Octokit at it via `baseUrl`:

```js
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({
  auth: "ghp_parlel",
  baseUrl: "http://127.0.0.1:4767",
});

const { data } = await octokit.rest.users.getAuthenticated();
// data.login => "parlel-user"
```

## Access via MCP / preview URL

Expose the running fake through the parlel pool and address it like the real API:

- REST base URL: `http://127.0.0.1:4767`
- GraphQL endpoint: `http://127.0.0.1:4767/graphql`
- Set `GITHUB_TOKEN=ghp_parlel` and `GITHUB_API_URL=http://127.0.0.1:4767` in your environment.

Any MCP server or agent that reads `GITHUB_API_URL` / `GITHUB_TOKEN` will transparently use the fake.

## Implemented operations

All routes require an `Authorization: Bearer <token>` or `Authorization: token <token>` header (any non-empty token is accepted). State is in-memory and ephemeral.

### REST v3

- `GET /user` — the authenticated user (`id`, `node_id`, `login`, `html_url`, ...).
- `GET /user/repos` — list repositories owned by the authenticated user.
- `POST /user/repos` — create a repository (`201`); rejects missing/duplicate `name` with `422`.
- `GET /repos/:owner/:repo` — retrieve a repository. (There is no create-by-path endpoint: like real GitHub, `POST /repos/:owner/:repo` returns `404`; create repos via `POST /user/repos`.)
- `PATCH /repos/:owner/:repo` — update description/visibility/default branch.
- `GET /repos/:owner/:repo/issues` — list issues.
- `POST /repos/:owner/:repo/issues` — create issue (`201`); requires `title`. Returns the full issue shape (`repository_url`, `comments_url`, `events_url`, `labels_url`, `timeline_url`, `author_association`, `state_reason`, `active_lock_reason`, `reactions`).
- `GET /repos/:owner/:repo/issues/:number` — retrieve.
- `PATCH /repos/:owner/:repo/issues/:number` — update title/body/state (open/closed). Closing sets `closed_at`/`state_reason` and decrements `open_issues_count`; reopening reverses it.
- `GET /repos/:owner/:repo/pulls` — list pull requests.
- `POST /repos/:owner/:repo/pulls` — create PR (`201`); requires `title`.
- `GET /repos/:owner/:repo/pulls/:number` — retrieve / `PATCH` update.
- `GET /repos/:owner/:repo/contents/:path` — get file contents (base64).
- `PUT /repos/:owner/:repo/contents/:path` — create/update a file (`201`/`200`). Requires **both** `message` and `content` (`422` otherwise). Returns `{ content, commit }` where `content` carries `git_url` + `_links {self, git, html}` and `commit` is the full object (`node_id`, `url`, `html_url`, `author`, `committer`, `tree`, `parents`, `verification`).

### GraphQL

- `POST /graphql` — minimal but real handler. `query { viewer { login id name email } }` returns `{ data: { viewer: { login: "parlel-user", ... } } }`. `repository(owner, name) { name nameWithOwner isPrivate description url }` resolves against in-memory repos.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/repos` — list captured repo keys.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /user` | ✅ Supported |
| Repos create (`POST /user/repos`) / get / patch / list | ✅ Supported |
| `POST /repos/:owner/:repo` returns `404` (no create-by-path endpoint) | ✅ Supported (matches real API) |
| Issues create / get / list / patch (full shape incl. `reactions`, `author_association`, `state_reason`) | ✅ Supported |
| `open_issues_count` tracked on issue close / reopen | ✅ Supported |
| Pull requests create / get / list / patch | ✅ Supported |
| Contents get / put (base64, requires `message` + `content`; `content._links` + rich `commit`) | ✅ Supported |
| GraphQL `viewer` + `repository` | ✅ Supported (subset) |
| Bearer / token auth | ✅ Required (any non-empty token) |
| Repo/user `*_url` template fields (`language`, `size`, `topics`) | ◐ Partial — core fields present; some template URLs omitted |
| List pagination / `state` filter query params (`per_page`, `page`, `state`) | ◐ Accepted-not-enforced — accepted, full dataset returned |
| Full GraphQL schema (mutations, connections, pagination) | ⟳ Roadmap — Only `viewer` + `repository` basics |
| Webhooks / Actions / Checks / Releases | ⟳ Roadmap |
| Real OAuth / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`403`/`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the GitHub envelope:

```json
{ "message": "Validation Failed", "documentation_url": "https://docs.github.com/rest", "errors": [ ... ] }
```

| Status | When |
| --- | --- |
| `400` | malformed JSON body (`{ "message": "Problems parsing JSON" }`) |
| `401` | missing/invalid authorization (`{ "message": "Requires authentication" }`) |
| `404` | unknown resource, or `POST /repos/:owner/:repo` (no such endpoint) |
| `405` | method not allowed (issues/pulls/contents sub-routes) |
| `422` | validation failed — missing `name`/`title`, duplicate repo, or `PUT contents` missing `message`/`content`. Carries an `errors` array of `{ resource, field, code }` for repo/issue validation. |

## Manifest

See `services/github/manifest.json`:

- name: `github`, image: `parlel/github:1`
- port: `4767`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `GITHUB_TOKEN`, `GITHUB_API_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GITHUB_TOKEN=ghp_parlel
GITHUB_API_URL=http://localhost:4767
```

<!-- parlel:testenv:end -->
