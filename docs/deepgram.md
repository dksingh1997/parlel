# Deepgram

Lightweight, dependency-free, in-memory Deepgram HTTP API fake for testing code that uses the real `@deepgram/sdk` (and the language-agnostic Deepgram REST API).

Default port: `4857`

## Quick start

```js
import { DeepgramServer } from "./services/deepgram/src/server.js";

const server = new DeepgramServer(4857);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `@deepgram/sdk` client at it:

```js
import { createClient } from "@deepgram/sdk";

const deepgram = createClient("parlel_deepgram", { global: { url: "http://127.0.0.1:4857" } });

const { result } = await deepgram.listen.prerecorded.transcribeUrl(
  { url: "https://example.com/audio.wav" },
  { model: "nova-2" },
);
// result.results.channels[0].alternatives[0].transcript => deterministic text
```

Transcripts and TTS audio are **deterministic**: derived from a hash of the input audio/url/text.

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4857`
- Health: `GET /health` → `{ "status": "ok" }`
- Auth header: `Authorization: Token <key>` (any non-empty key accepted).

## Implemented operations

All `/v1/*` routes require `Authorization: Token <key>` (or `Bearer`).

- `POST /v1/listen` — transcribe audio. Accepts raw audio bytes (any non-JSON `Content-Type`) or `{ "url": "..." }` JSON. Returns the Deepgram pre-recorded shape `{ metadata, results: { channels: [{ alternatives: [{ transcript, confidence, words: [] }] }] } }`.
- `POST /v1/speak` — text-to-speech from `{ "text": "..." }`. Returns deterministic `audio/mpeg` bytes.
- `GET /v1/projects` — list projects.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/requests` — list captured requests.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `listen` (pre-recorded, url or bytes) | ✅ Supported |
| `speak` (TTS bytes) | ✅ Supported |
| `projects` list | ✅ Supported |
| Deterministic transcripts/audio | ✅ Supported |
| Real speech recognition / synthesis | ✓ By design — Intentionally unsupported (hash-derived) |
| Live/streaming websocket transcription | ⟳ Roadmap — pre-recorded only |
| Diarization / language detection accuracy | ✓ By design — Intentional for a local, zero-cost test emulator |
| Token validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ "err_code": "...", "err_msg": "..." }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid `Authorization` |
| `400` | missing url/audio/text or bad JSON |
| `404` | unknown endpoint |

## Manifest

See `services/deepgram/manifest.json`:

- name: `deepgram`, image: `parlel/deepgram:1.0`
- port: `4857`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `DEEPGRAM_API_KEY`, `DEEPGRAM_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
DEEPGRAM_API_KEY=parlel_deepgram
DEEPGRAM_BASE_URL=http://localhost:4857
```

<!-- parlel:testenv:end -->
