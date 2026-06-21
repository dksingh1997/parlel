# OpenAI

Lightweight, dependency-free, in-memory OpenAI REST API fake for testing code that uses the real `openai` Node.js/Python SDK (and the language-agnostic OpenAI REST API). All generated content is **deterministic** — text and embedding vectors are derived from a hash of the input so tests are repeatable.

Default port: `4747`

## Quick start

Start the server:

```js
import { OpenaiServer } from "./services/openai/src/server.js";

const server = new OpenaiServer(4747);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `openai` client at it via `baseURL`:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-parlel",
  baseURL: "http://127.0.0.1:4747/v1",
});

const completion = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
// completion.choices[0].message.content => deterministic text for that prompt
```

## Implemented operations

All `/v1/*` routes require an `Authorization: Bearer <key>` header (any non-empty bearer token is accepted, matching how a local test key behaves). State is in-memory and ephemeral.

- `POST /v1/chat/completions` — chat completion. Supports `stream: true` (SSE chunks ending with `data: [DONE]`). Returns the `chat.completion` shape with `choices[].message` (incl. `refusal: null`), `finish_reason`, `system_fingerprint`, and a `usage` object that includes `prompt_tokens_details` and `completion_tokens_details` (matching the real API).
- `POST /v1/completions` — legacy text completion (`text_completion`). `usage` includes the token-detail sub-objects.
- `POST /v1/embeddings` — deterministic fixed-length embedding vectors (default 1536 dims, `dimensions` override supported). Accepts a string or array of strings.
- `GET /v1/models` — list models (`{ object: "list", data: [...] }`).
- `GET /v1/models/{id}` — retrieve one model. Unknown model ids return `404` with `code: "model_not_found"`.
- `POST /v1/images/generations` — image generation. Returns `url` or `b64_json` depending on `response_format`, plus `revised_prompt`.
- `POST /v1/moderations` — content moderation. Returns `flagged`, `categories`, `category_scores`, and `category_applied_input_types` across the full 13-category `omni-moderation-latest` set (including `illicit` and `illicit/violent`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list every captured request (`{ requests, count }`).
- `DELETE /__parlel/requests` — clear the captured request log.
- `OPTIONS *` — CORS preflight (`204`).

## SDK usage example

```python
from openai import OpenAI

client = OpenAI(api_key="sk-parlel", base_url="http://127.0.0.1:4747/v1")

stream = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Stream me"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

## Access via MCP / preview URL

## Error codes & shapes

Every error uses the real OpenAI envelope: `{ "error": { "message", "type", "param", "code" } }` (all four keys always present; `param` and `code` may be `null`).

| Scenario | Status | `type` | `code` | `param` |
| --- | --- | --- | --- | --- |
| Missing `Authorization` header | `401` | `invalid_request_error` | `null` | `null` |
| Malformed credential (not a Bearer token) | `401` | `invalid_request_error` | `invalid_api_key` | `null` |
| Missing required field (`messages`, `model`, `input`, `prompt`) | `400` | `invalid_request_error` | `null` | the field name |
| Retrieve unknown model | `404` | `invalid_request_error` | `model_not_found` | `null` |
| Unknown `/v1` route (or non-`/v1` path) | `404` | `invalid_request_error` | `unknown_url` | `null` |
| Malformed JSON body | `400` | `invalid_request_error` | `null` | `null` |

Any non-empty Bearer token is accepted (the emulator does not validate real secrets), so a missing/malformed `Authorization` header is the only auth failure you will see.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `chat.completions` (+ streaming SSE) | ✅ Supported |
| `chat.completions` usage token details (`prompt_tokens_details`, `completion_tokens_details`) | ✅ Supported |
| `completions` (legacy) | ✅ Supported |
| `embeddings` (deterministic vectors, custom dims) | ✅ Supported |
| `models` list | ✅ Supported |
| `models` retrieve (`404 model_not_found` for unknown ids) | ✅ Supported |
| `images.generations` (url / b64_json, `revised_prompt`) | ✅ Supported |
| `moderations` (13 categories, `category_applied_input_types`, `omni-moderation-latest` default) | ✅ Supported |
| Error envelope (`{ error: { message, type, param, code } }`) incl. missing-key vs invalid-key 401 | ✅ Supported |
| Unknown-route 404 (`code: "unknown_url"`) | ✅ Supported |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / quality | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| `tools` / function calling execution | ◐ Accepted, not executed (returns text) |
| Vision / audio / file uploads | ⟳ Roadmap |
| List stored chat completions (`GET /v1/chat/completions`) | ⟳ Roadmap |
| Token counts | ◐ Approximate word-based, not real BPE |
| Bearer-token validity / org scoping | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| HTTP `405` on method mismatch | ✓ By design — Falls through to a valid JSON `404` envelope |
| Rate limiting (`429`) / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/openai/manifest.json`:

- name: `openai`, image: `parlel/openai:1`
- port: `4747`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
OPENAI_API_KEY=sk-parlel
OPENAI_BASE_URL=http://localhost:4747/v1
```

<!-- parlel:testenv:end -->
