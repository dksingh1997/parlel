# Google Gemini

Lightweight, dependency-free, in-memory Google Gemini (Generative Language) API fake for testing code that uses the real `@google/generative-ai` / `@google/genai` SDKs (and the language-agnostic REST API). All generated content is **deterministic** — text is derived from a hash of the input so tests are repeatable.

Default port: `4749`

## Quick start

```js
import { GoogleGeminiServer } from "./services/google-gemini/src/server.js";

const server = new GoogleGeminiServer(4749);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real SDK at it via a custom base URL:

```js
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI("parlel");
const model = genAI.getGenerativeModel(
  { model: "gemini-1.5-flash" },
  { baseUrl: "http://127.0.0.1:4749" },
);

const result = await model.generateContent("Hello Gemini");
// result.response.text() => deterministic text for that prompt
```

## Implemented operations

Authentication uses either a `?key=` query parameter or the `x-goog-api-key` header (any non-empty key is accepted). State is in-memory and ephemeral.

- `POST /v1beta/models/{model}:generateContent` — generate content. Returns `{ candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason, safetyRatings }], usageMetadata, modelVersion }`.
- `POST /v1beta/models/{model}:streamGenerateContent` — streaming. Default returns a JSON array of incremental chunks; pass `?alt=sse` for the SSE `data:` line format.
- `POST /v1beta/models/{model}:countTokens` — returns `{ totalTokens }`.
- `GET /v1beta/models` — list available models.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured requests.
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
import google.generativeai as genai

genai.configure(api_key="parlel", client_options={"api_endpoint": "127.0.0.1:4749"})
model = genai.GenerativeModel("gemini-1.5-flash")
response = model.generate_content("Hello Gemini")
print(response.text)
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `generateContent` | ✅ Supported |
| `streamGenerateContent` (array + `alt=sse`) | ✅ Supported |
| `countTokens` | ✅ Supported |
| `models` list | ✅ Supported |
| Both `?key=` and `x-goog-api-key` auth | ✅ Supported |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / quality | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| Function calling / tools execution | ◐ Accepted, not executed |
| Vision / inline data / file API | ⟳ Roadmap |
| Token counts | ◐ Approximate word-based |
| Safety rating computation | ◐ Fixed `NEGLIGIBLE` placeholders |

## Manifest

See `services/google-gemini/manifest.json`:

- name: `google-gemini`, image: `parlel/google-gemini:1`
- port: `4749`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GEMINI_API_KEY=parlel
GOOGLE_API_KEY=parlel
GEMINI_BASE_URL=http://localhost:4749
```

<!-- parlel:testenv:end -->
