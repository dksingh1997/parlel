# ElevenLabs

Lightweight, dependency-free, in-memory ElevenLabs API fake for testing code that uses the real `elevenlabs` SDK (and the language-agnostic REST API). Text-to-speech returns **deterministic** `audio/mpeg` bytes derived from a hash of the text + voice id, so tests are repeatable.

Default port: `4753`

## Quick start

```js
import { ElevenlabsServer } from "./services/elevenlabs/src/server.js";

const server = new ElevenlabsServer(4753);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `elevenlabs` client at it via `baseUrl`:

```js
import { ElevenLabsClient } from "elevenlabs";

const client = new ElevenLabsClient({
  apiKey: "parlel",
  baseUrl: "http://127.0.0.1:4753",
});

const audio = await client.textToSpeech.convert("21m00Tcm4TlvDq8ikWAM", {
  text: "Hello world",
  model_id: "eleven_multilingual_v2",
});
// audio => a deterministic audio/mpeg byte stream
```

## Implemented operations

All `/v1/*` routes require an `xi-api-key` header (any non-empty key is accepted). State is in-memory and ephemeral.

- `POST /v1/text-to-speech/{voice_id}` — synthesize speech, returns `audio/mpeg` bytes (deterministic). The optional `/stream` suffix is also accepted.
- `GET /v1/voices` — list available voices.
- `GET /v1/voices/{voice_id}` — retrieve one voice.
- `GET /v1/models` — list TTS models.
- `GET /v1/user` — user info including `subscription`.
- `GET /v1/user/subscription` — subscription details.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured TTS requests (text + voice).
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
from elevenlabs.client import ElevenLabs

client = ElevenLabs(api_key="parlel", base_url="http://127.0.0.1:4753")
audio = client.text_to_speech.convert(
    voice_id="21m00Tcm4TlvDq8ikWAM",
    text="Hello world",
    model_id="eleven_multilingual_v2",
)
with open("out.mp3", "wb") as f:
    for chunk in audio:
        f.write(chunk)
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `text_to_speech` (deterministic audio/mpeg) | ✅ Supported |
| `voices` list/retrieve | ✅ Supported |
| `models` list | ✅ Supported |
| `user` / `user.subscription` | ✅ Supported |
| `/stream` suffix | ✅ Supported (same bytes) |
| Request inspection | ✅ Supported (parlel extension) |
| Real speech synthesis / playable audio | ✓ By design — Intentional for a local, zero-cost test emulator |
| Speech-to-text / voice cloning / dubbing | ⟳ Roadmap |
| Voice settings application | ◐ Accepted, not applied |
| `xi-api-key` validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/elevenlabs/manifest.json`:

- name: `elevenlabs`, image: `parlel/elevenlabs:1`
- port: `4753`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `ELEVENLABS_API_KEY`, `ELEVENLABS_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ELEVENLABS_API_KEY=parlel
ELEVENLABS_BASE_URL=http://localhost:4753
```

<!-- parlel:testenv:end -->
