# Anthropic

Lightweight, dependency-free, in-memory Anthropic Messages API fake for testing code that uses the real `@anthropic-ai/sdk` (and the language-agnostic Anthropic REST API). All generated content is **deterministic** — text is derived from a hash of the input so tests are repeatable.

Default port: `4748`

## Quick start

```js
import { AnthropicServer } from "./services/anthropic/src/server.js";

const server = new AnthropicServer(4748);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `@anthropic-ai/sdk` client at it via `baseURL`:

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "sk-ant-parlel",
  baseURL: "http://127.0.0.1:4748",
});

const message = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 256,
  messages: [{ role: "user", content: "Hello, Claude" }],
});
// message.content[0].text => deterministic text for that prompt
// message.request_id => "req_..." (matches real API)
```

## Implemented operations

Authentication uses the `x-api-key` header (any non-empty key is accepted by design). The `anthropic-version` header is accepted but not enforced. State is in-memory and ephemeral.

- `POST /v1/messages` — create a message. Supports `stream: true` via the Anthropic SSE event format: `message_start`, `content_block_start`, `ping`, `content_block_delta` (`text_delta`), `content_block_stop`, `message_delta`, `message_stop`. Returns `{ id, type: "message", role: "assistant", content: [{ type: "text", text }], model, stop_reason, stop_sequence, usage, request_id }`.
- `POST /v1/messages/count_tokens` — count tokens in a message. Validates `messages` and `model` fields. Returns `{ input_tokens, input_tokens_details: { cache_read, cache_creation }, request_id }`.

### Response metadata

All responses include a `request-id` HTTP header (format: `req_<hex>`) and a `request_id` field in the JSON body, matching the real Anthropic API. Error envelopes follow the real shape: `{ type: "error", error: { type, message }, request_id }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured requests.
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
import anthropic

client = anthropic.Anthropic(api_key="sk-ant-parlel", base_url="http://127.0.0.1:4748")

with client.messages.stream(
    model="claude-3-5-sonnet-20241022",
    max_tokens=256,
    messages=[{"role": "user", "content": "Stream me"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `messages.create` (+ streaming SSE) | ✅ Supported |
| `messages.count_tokens` (with validation) | ✅ Supported |
| System prompts & array content blocks | ✅ Supported |
| `request_id` in responses & `request-id` header | ✅ Supported |
| Error envelope (`{ type, error: { type, message }, request_id }`) | ✅ Supported |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / quality | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| `tools` / tool_use blocks | ◐ Accepted, not executed (returns text) |
| Vision / documents / files | ⟳ Roadmap |
| Token counts | ◐ Approximate word-based |
| `x-api-key` validity | ✓ By design — Intentional for a local, zero-cost test emulator |
| `anthropic-version` header | ✓ By design — Accepted but not enforced |
| Rate limiting (`429`) / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/anthropic/manifest.json`:

- name: `anthropic`, image: `parlel/anthropic:1`
- port: `4748`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ANTHROPIC_API_KEY=sk-ant-parlel
ANTHROPIC_BASE_URL=http://localhost:4748
```

<!-- parlel:testenv:end -->
