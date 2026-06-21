# AssemblyAI

Lightweight, dependency-free, in-memory AssemblyAI API fake for testing code that uses the real `assemblyai` Node.js SDK (and the language-agnostic AssemblyAI REST API).

Default port: `4858`

## Quick start

```js
import { AssemblyaiServer } from "./services/assemblyai/src/server.js";

const server = new AssemblyaiServer(4858);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `assemblyai` client at it via `baseUrl`:

```js
import { AssemblyAI } from "assemblyai";

const client = new AssemblyAI({ apiKey: "parlel_assemblyai", baseUrl: "http://127.0.0.1:4858" });

const transcript = await client.transcripts.transcribe({ audio_url: "https://x/a.wav" });
// transcript.status === "completed", transcript.text => deterministic text
```

Transcripts, uploads, and LeMUR responses are **deterministic**: derived from a hash of the input. Transcripts **complete on the first GET**.

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4858`
- Health: `GET /health` → `{ "status": "ok" }`
- Auth header: `Authorization: <key>` (raw key, no scheme — any non-empty value accepted).

## Implemented operations

- `POST /v2/upload` — upload raw audio bytes (`application/octet-stream`) → `{ upload_url }`.
- `POST /v2/transcript` — create a transcript from `{ audio_url }` → `{ id, status: "queued", ... }`.
- `GET /v2/transcript` — list transcripts with pagination → `{ transcripts: [...], page_details: { limit, result_count, current_url, prev_url, next_url } }`.
- `GET /v2/transcript/:id` — poll; **completes on first GET** → `{ status: "completed", text, words: [...] }`.
- `DELETE /v2/transcript/:id` — delete a transcript → returns the deleted transcript object.
- `POST /lemur/v3/generate/task` — LeMUR custom task from `{ prompt, transcript_ids }` → `{ request_id, response, usage }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/transcripts` — list captured transcripts.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `transcripts.create` / `get` | ✅ Supported |
| `transcripts.list` (`GET /v2/transcript`) | ✅ Supported |
| `transcripts.delete` (`DELETE /v2/transcript/:id`) | ✅ Supported |
| `files.upload` (`/v2/upload`) | ✅ Supported |
| LeMUR `generate/task` | ◐ Accepted — deprecated endpoint, emulated for backward compat |
| Deterministic transcripts/responses | ✅ Supported |
| Full transcript response fields (speech_model, language_model, etc.) | ✅ Supported |
| Real speech recognition | ✓ By design — Intentionally unsupported (hash-derived) |
| Realtime/streaming transcription | ⟳ Roadmap |
| Polling delay (queued→processing→completed) | ◐ Completes immediately on first GET |
| Key validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ "error": "<message>" }` — matching the real AssemblyAI API exactly.

| Status | When |
| --- | --- |
| `401` | missing/empty `Authorization` |
| `400` | missing `audio_url`/`prompt` or bad JSON |
| `404` | unknown transcript or endpoint |
| `500` | internal server error |

## Manifest

See `services/assemblyai/manifest.json`:

- name: `assemblyai`, image: `parlel/assemblyai:1.0`
- port: `4858`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ASSEMBLYAI_API_KEY=parlel_assemblyai
ASSEMBLYAI_BASE_URL=http://localhost:4858
```

<!-- parlel:testenv:end -->
