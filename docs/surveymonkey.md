# SurveyMonkey

Lightweight, dependency-free, in-memory SurveyMonkey API v3 fake for testing code that talks to the SurveyMonkey REST API.

Default port: `4847`

## Quick start

```js
import { SurveymonkeyServer } from "./services/surveymonkey/src/server.js";

const server = new SurveymonkeyServer(4847);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a SurveyMonkey client at `http://127.0.0.1:4847`. Authenticate with a
Bearer access token (any non-empty token is accepted):

```js
const res = await fetch("http://127.0.0.1:4847/v3/surveys", {
  headers: { Authorization: "Bearer parlel" },
});
const { data, per_page, page, total, links } = await res.json();
```

## List envelope

List endpoints use the documented v3 envelope:

```json
{ "data": [], "per_page": 50, "page": 1, "total": 0, "links": {} }
```

## Implemented operations

All `/v3/*` routes require `Authorization: Bearer <token>`. State is in-memory.

- `GET /v3/users/me` — the authenticated user.
- `GET /v3/surveys` — list surveys (list envelope).
- `POST /v3/surveys` — create a survey (`201`).
- `GET /v3/surveys/:id` — retrieve a survey.
- `PATCH /v3/surveys/:id` — update a survey.
- `DELETE /v3/surveys/:id` — delete a survey.
- `GET /v3/surveys/:id/details` — full survey with `pages`.
- `GET /v3/surveys/:id/responses` — list responses (list envelope).
- `POST /v3/surveys/:id/responses` — create a response (`201`).
- `GET /v3/surveys/:id/responses/:rid` — retrieve a response.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `SURVEYMONKEY_BASE_URL`
(`http://127.0.0.1:4847`). When running in the parlel pool, an MCP tool /
preview URL proxies to this base URL — point your SurveyMonkey client at that
URL with a Bearer token and every `/v3/*` endpoint above works as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `users/me` | ✅ Supported |
| Surveys list/create/get/update/delete/details | ✅ Supported |
| Responses list/create/get | ✅ Supported |
| List envelope `{data,per_page,page,total,links}` | ✅ Supported |
| OAuth token exchange | ✓ By design — Out of scope (any bearer accepted) |
| Collectors / webhooks / contacts | ⟳ Roadmap |
| Pagination cursors beyond echo | ◐ Single-page (`total` reflects all) |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the v3 `{ error: { message, id, name, http_status_code } }` envelope:

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer token |
| `404` | unknown survey or response |
| `405` | method not allowed |

## Manifest

See `services/surveymonkey/manifest.json`:

- name: `surveymonkey`, port: `4847`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `SURVEYMONKEY_API_KEY`, `SURVEYMONKEY_ACCESS_TOKEN`, `SURVEYMONKEY_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SURVEYMONKEY_API_KEY=parlel
SURVEYMONKEY_ACCESS_TOKEN=parlel
SURVEYMONKEY_BASE_URL=http://localhost:4847
```

<!-- parlel:testenv:end -->
