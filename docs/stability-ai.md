# Stability AI

Lightweight, dependency-free, in-memory Stability AI API fake (v1 generation + v2beta stable-image). Images are **deterministic** tiny PNGs derived from the prompt hash.

Default port: `4862`

## Quick start

```js
import { StabilityAiServer } from "./services/stability-ai/src/server.js";

const server = new StabilityAiServer(4862);
await server.start();
// ... run your app/tests ...
await server.stop();
```

REST usage:

```js
const res = await fetch("http://127.0.0.1:4862/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
  method: "POST",
  headers: { Authorization: "Bearer sk-parlel-stability", "Content-Type": "application/json" },
  body: JSON.stringify({ text_prompts: [{ text: "a cat" }] }),
});
// => { artifacts: [{ base64, seed, finishReason: "SUCCESS" }] }
```

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4862`
- Health: `GET /health` → `{ "status": "ok" }`
- Auth: `Authorization: Bearer <key>` (any non-empty token).

## Implemented operations

- `POST /v1/generation/:engine_id/text-to-image` — returns `{ artifacts: [{ base64, seed, finishReason: "SUCCESS" }] }`. Respects `samples`.
- `POST /v2beta/stable-image/generate/core` (also `sd3`, `ultra`) — returns raw image bytes by default, or `{ image, seed, finish_reason }` JSON when `Accept: application/json`. Accepts JSON or multipart bodies.
- `GET /v1/engines/list` — list engines.
- `GET /v1/user/account` — account info.

### Service & inspection operations (parlel extensions)

- `GET /` / `GET /health` / `POST /__parlel/reset` / `GET /__parlel/requests`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| v1 `text-to-image` | ✅ Supported |
| v2beta `stable-image/generate/core` (json + bytes) | ✅ Supported |
| `engines/list`, `user/account` | ✅ Supported |
| Deterministic tiny PNG output | ✅ Supported |
| Real diffusion image generation | ✓ By design — Intentionally unsupported (hash-derived PNG) |
| image-to-image / upscale / inpaint / control | ⟳ Roadmap |
| Real credit balance / billing | ◐ Static account info |
| CLIP guidance / sampler params | ◐ Accepted, not applied |

## Error codes & shapes

Errors use `{ "id", "name", "errors": ["..."] }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid `Authorization` |
| `400` | missing `text_prompts` or bad JSON |
| `404` | unknown endpoint |

## Manifest

See `services/stability-ai/manifest.json`:

- name: `stability-ai`, port: `4862`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `STABILITY_API_KEY`, `STABILITY_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
STABILITY_API_KEY=sk-parlel-stability
STABILITY_BASE_URL=http://localhost:4862
```

<!-- parlel:testenv:end -->
