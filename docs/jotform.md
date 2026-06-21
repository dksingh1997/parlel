# JotForm

Lightweight, dependency-free, in-memory JotForm API fake for testing code that talks to the JotForm REST API.

Default port: `4846`

## Quick start

```js
import { JotformServer } from "./services/jotform/src/server.js";

const server = new JotformServer(4846);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a JotForm client at `http://127.0.0.1:4846`. Authenticate with either the
`APIKEY` header or the `?apiKey=` query parameter (any non-empty value is accepted).

```js
const res = await fetch("http://127.0.0.1:4846/user/forms", {
  headers: { APIKEY: "parlel" },
});
const { responseCode, message, content } = await res.json();
```

## Response envelope

Every JotForm response is wrapped:

```json
{ "responseCode": 200, "message": "success", "content": ... }
```

List endpoints additionally include a `result-set` block.

## Implemented operations

All routes require auth via the `APIKEY` header **or** `?apiKey=` query param.
State is in-memory and ephemeral; ids are deterministic.

- `GET /user` — the authenticated account profile.
- `GET /user/forms` — list forms (`content` is an array, plus `result-set`).
- `GET /user/submissions` — list every submission across forms.
- `GET /form/:id` — retrieve a single form.
- `GET /form/:id/questions` — questions keyed by `qid`.
- `POST /form/:id/questions` — add a question (`{ question: { type, text, name } }`).
- `GET /form/:id/question/:qid` — retrieve one question.
- `GET /form/:id/submissions` — list submissions for a form.
- `POST /form/:id/submissions` — create a submission. Accepts `{ answers: { qid: { answer } } }` or `submission[qid]=value` form fields. Returns `{ submissionID, URL }`.
- `GET /submission/:id` — retrieve a submission.
- `DELETE /submission/:id` — delete a submission.

### Service & inspection operations (parlel extensions, not part of JotForm)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/submissions` — list all captured submissions (`{ submissions, count }`).
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at its base URL (`JOTFORM_BASE_URL`,
`http://127.0.0.1:4846`). When running inside the parlel pool, an MCP tool /
preview URL is exposed that proxies to this base URL — point your JotForm client
or agent at that URL and pass the `APIKEY` header (or `?apiKey=`). All endpoints
above are reachable through the preview URL exactly as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /user` | ✅ Supported |
| `GET /user/forms`, `GET /user/submissions` | ✅ Supported |
| `GET /form/:id`, questions get/add | ✅ Supported |
| Submissions create/get/list/delete | ✅ Supported |
| `APIKEY` header **and** `?apiKey=` auth | ✅ Supported |
| Response envelope + `result-set` | ✅ Supported |
| Real form rendering / HTML | ⟳ Roadmap |
| Webhooks / reports / folders | ⟳ Roadmap |
| File uploads to submissions | ◐ Accepted as values, not stored as files |
| API-key validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the same envelope with a non-200 `responseCode`:

| Status | When |
| --- | --- |
| `401` | missing/empty `APIKEY` header and `?apiKey=` query |
| `404` | unknown form, question, or submission |

## Manifest

See `services/jotform/manifest.json`:

- name: `jotform`, port: `4846`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `JOTFORM_API_KEY`, `JOTFORM_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
JOTFORM_API_KEY=parlel
JOTFORM_BASE_URL=http://localhost:4846
```

<!-- parlel:testenv:end -->
