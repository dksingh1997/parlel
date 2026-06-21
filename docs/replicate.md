# Replicate

Lightweight, dependency-free, in-memory Replicate HTTP API fake for testing code that uses the real `replicate` Node.js SDK (and the language-agnostic Replicate REST API).

Default port: `4856`

## Quick start

```js
import { ReplicateServer } from "./services/replicate/src/server.js";

const server = new ReplicateServer(4856);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `replicate` client at it via `baseUrl`:

```js
import Replicate from "replicate";

const replicate = new Replicate({
  auth: "r8_parlel",
  baseUrl: "http://127.0.0.1:4856",
});

const output = await replicate.run("stability-ai/sdxl:version", {
  input: { prompt: "a cat" },
});
// output => deterministic array derived from the input hash
```

All generated output is **deterministic**: prediction outputs are derived from a hash of the input so tests are repeatable.

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4856`
- Health: `GET /health` → `{ "status": "ok" }`
- Root metadata: `GET /` → `{ name, version, protocol, documentation }`
- MCP / agent tooling can target the base URL directly; auth via `Authorization: Token r8_...` (any non-empty token accepted).

## Implemented operations

All `/v1/*` routes require `Authorization: Token <key>` (or `Bearer`). Any non-empty token is accepted.

- `POST /v1/predictions` — create a prediction. Returns `201` with `{ id, status: "starting", urls, ... }`.
- `GET /v1/predictions/:id` — poll a prediction. Resolves to `status: "succeeded"` with a deterministic `output` array on the **first** GET.
- `POST /v1/predictions/:id/cancel` — cancel a running prediction (`status: "canceled"`).
- `GET /v1/models/:owner/:name` — retrieve model metadata including a deterministic `latest_version`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/predictions` — list captured predictions.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `predictions.create` / `get` / `cancel` | ✅ Supported |
| `models.get` | ✅ Supported |
| Deterministic, reproducible output | ✅ Supported |
| Real model inference / GPU compute | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| Webhooks / streaming output URLs | ⟳ Roadmap — poll-only |
| Training / fine-tunes / deployments | ⟳ Roadmap |
| Token validity / quota enforcement | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the Replicate envelope: `{ "detail": "...", "status": <code> }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid `Authorization` |
| `404` | unknown prediction or endpoint |
| `422` | malformed request body |

## Manifest

See `services/replicate/manifest.json`:

- name: `replicate`, image: `parlel/replicate:1.0`
- port: `4856`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `REPLICATE_API_TOKEN`, `REPLICATE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
REPLICATE_API_TOKEN=r8_parlel
REPLICATE_BASE_URL=http://localhost:4856
```

<!-- parlel:testenv:end -->
