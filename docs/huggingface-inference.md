# Hugging Face Inference

Lightweight, dependency-free, in-memory Hugging Face Inference API fake for testing code that uses the real `@huggingface/inference` SDK (and the language-agnostic Inference API / router). All generated content is **deterministic** — text and embedding vectors are derived from a hash of the input.

Default port: `4756`

## Quick start

```js
import { HuggingfaceInferenceServer } from "./services/huggingface-inference/src/server.js";

const server = new HuggingfaceInferenceServer(4756);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `@huggingface/inference` client at it via `endpointUrl` (per-model) or use the OpenAI-compatible router at `/v1`:

```js
import { HfInference } from "@huggingface/inference";

const hf = new HfInference("hf_parlel");

const out = await hf.textGeneration({
  model: "meta-llama/Llama-3.1-8B-Instruct",
  inputs: "Once upon a time",
}, { endpointUrl: "http://127.0.0.1:4756/models/meta-llama/Llama-3.1-8B-Instruct" });
// out.generated_text => deterministic text
```

## Implemented operations

All routes require an `Authorization: Bearer <token>` header (any non-empty bearer token is accepted). State is in-memory and ephemeral.

- `POST /models/{model}` — pipeline inference. The task is inferred from the model id (overridable via `?task=` or a `task` body field):
  - **text-generation** — returns `[{ generated_text }]`. Honors `parameters.return_full_text`.
  - **feature-extraction** — returns a single 384-dim embedding vector for a string input, or an array of vectors for an array input. Triggered by model names containing `sentence-transformers`, `embed`, `feature`, `bge`, or `e5`.
- `POST /v1/chat/completions` — the OpenAI-compatible router. Supports `stream: true` (SSE ending with `data: [DONE]`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured requests.
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
from openai import OpenAI

# HF router is OpenAI-compatible
client = OpenAI(api_key="hf_parlel", base_url="http://127.0.0.1:4756/v1")
resp = client.chat.completions.create(
    model="meta-llama/Llama-3.1-8B-Instruct",
    messages=[{"role": "user", "content": "Hello HF"}],
)
print(resp.choices[0].message.content)
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `text-generation` (`/models/{model}`) | ✅ Supported |
| `feature-extraction` (`/models/{model}`) | ✅ Supported |
| OpenAI-compatible router `/v1/chat/completions` (+stream) | ✅ Supported |
| `?task=` / body `task` override | ✅ Supported |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / quality | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| Other pipeline tasks (classification, NER, ASR, image) | ◐ Not implemented; default to text-generation |
| Model auto-loading / `503` warmup | ⟳ Roadmap — Always "warm" |
| Token / billing accounting | ◐ Approximate word-based |
| Bearer-token validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/huggingface-inference/manifest.json`:

- name: `huggingface-inference`, image: `parlel/huggingface-inference:1`
- port: `4756`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `HF_TOKEN`, `HUGGINGFACE_API_KEY`, `HF_INFERENCE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
HF_TOKEN=hf_parlel
HUGGINGFACE_API_KEY=hf_parlel
HF_INFERENCE_BASE_URL=http://localhost:4756
```

<!-- parlel:testenv:end -->
