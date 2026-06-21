# WhatsApp

Lightweight, dependency-free, in-memory **WhatsApp Cloud API** fake for testing code that talks to the Meta Graph API with `axios`.

Default port: `4657`

It speaks the exact wire protocol an `axios`-based WhatsApp Cloud API integration uses: Bearer-token auth (`Authorization: Bearer <ACCESS_TOKEN>`), JSON request bodies (and `multipart/form-data` for media upload), and JSON responses with the Cloud API envelopes (`{ messaging_product, contacts, messages }` for sends, `{ id }` for uploads, Graph-style `{ error: { … } }` on failure). Everything sent is captured in memory for assertions and can be reset. Zero cost, zero side effects.

The Graph version prefix (e.g. `v21.0`) in the path is accepted but optional — `/{version}/{id}/...` and `/{id}/...` both route the same way.

## Implemented Operations

### Send messages (`POST /{PHONE_NUMBER_ID}/messages`)

A single endpoint that dispatches on the `type` field. Always requires `messaging_product: "whatsapp"`. On success returns `200` with `{ messaging_product, contacts: [{ input, wa_id }], messages: [{ id: "wamid.…", message_status: "accepted" }] }`.

- `type: "text"` — `text.body` required. Supports `preview_url` and reply `context.message_id`.
- `type: "template"` — `template.name` + `template.language.code` required; the template must exist (seeded `hello_world`) and supports `components`.
- `type: "image" | "audio" | "video" | "document" | "sticker"` — the media object requires either `id` (uploaded media) or `link`.
- `type: "location"` — requires `location.latitude` and `location.longitude`.
- `type: "contacts"` — requires a non-empty `contacts` array.
- `type: "interactive"` — requires `interactive.type` (e.g. `button`, `list`, `cta_url`).
- `type: "reaction"` — requires `reaction.message_id` (and `emoji`).

### Mark as read & typing (`POST /{PHONE_NUMBER_ID}/messages`)

- `{ status: "read", message_id }` — marks an inbound message read; returns `{ success: true }`.
- Add `typing_indicator: { type: "text" }` to also emit a typing indicator.

### Media

- `POST /{PHONE_NUMBER_ID}/media` — upload media (multipart `messaging_product` + `type` + `file`, or JSON). Returns `{ id }`.
- `GET /{MEDIA_ID}` — retrieve media metadata: `{ messaging_product, url, mime_type, sha256, file_size, id }`. The `url` points at the local `/__media/{id}` download route.
- `DELETE /{MEDIA_ID}` — delete uploaded media (`{ success: true }`).
- `GET /__media/{MEDIA_ID}` — download the raw bytes (requires the Bearer token), mirroring Cloud API media downloads.

### Phone number & WhatsApp Business Account

- `GET /{PHONE_NUMBER_ID}` — phone number info (`display_phone_number`, `verified_name`, `quality_rating`, `code_verification_status`, …). Supports `?fields=` projection.
- `GET /{WABA_ID}/phone_numbers` — list phone numbers on the WABA (`{ data, paging }`).
- `GET /{WABA_ID}` — WABA info (`name`, `currency`, `timezone_id`, `account_review_status`, …). Supports `?fields=`.

### Business profile

- `GET /{PHONE_NUMBER_ID}/whatsapp_business_profile` — get the profile (`{ data: [ { messaging_product, about, address, … } ] }`). Supports `?fields=`.
- `POST /{PHONE_NUMBER_ID}/whatsapp_business_profile` — update editable fields (`about`, `address`, `description`, `email`, `profile_picture_url`, `websites`, `vertical`). Requires `messaging_product`.

### Message templates (management)

- `GET /{WABA_ID}/message_templates` — list templates (`{ data, paging }`). Seeded with `hello_world` (`APPROVED`).
- `POST /{WABA_ID}/message_templates` — create a template (`name`, `category`, `language` required); returns `{ id, status: "PENDING", category }`.
- `DELETE /{WABA_ID}/message_templates?name=…` — delete a template by name (`{ success: true }`).

### Registration & verification

- `POST /{PHONE_NUMBER_ID}/register` — register a number with a 6-digit `pin`.
- `POST /{PHONE_NUMBER_ID}/deregister` — deregister the number.
- `POST /{PHONE_NUMBER_ID}/request_code` — request a verification code (`code_method` ∈ `SMS|VOICE`).
- `POST /{PHONE_NUMBER_ID}/verify_code` — verify the code (deterministic test code is `123456`). Must follow `request_code`.

### Webhook verification

- `GET /{any-path}?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` — Meta-style verification handshake. Echoes `hub.challenge` as `text/plain` `200` when the token matches `WHATSAPP_VERIFY_TOKEN`, else `403`.

### Service & inspection operations (parlel-only, not part of the Cloud API)

- `GET /` — service metadata.
- `GET /health` — `{ "status": "ok" }`.
- `OPTIONS *` — `204` (CORS preflight).
- `POST /__parlel/reset` — clear all ephemeral state and re-seed defaults.
- `GET /__parlel/messages` — every captured outbound message (`{ messages, count }`).
- `GET /__parlel/read-receipts` — captured read receipts.
- `GET /__parlel/typing` — captured typing indicators.
- `GET /__parlel/media` — uploaded media metadata (without raw bytes).
- `GET /__parlel/templates` — current templates.
- `POST /__parlel/inbound` — build & queue an inbound message webhook event (`{ from, text, name }`); returns the Meta webhook payload.
- `POST /__parlel/status` — build & queue a message-status webhook event (`{ message_id, status, recipient_id }`).
- `GET /__parlel/inbound` — list queued webhook events.

## Quick Start

```js
import { WhatsappServer } from "./services/whatsapp/src/server.js";
import axios from "axios";

const server = new WhatsappServer(4657);
await server.start();

const ACCESS_TOKEN = "parlel-test-access-token";
const PHONE_NUMBER_ID = "100000000000001";

const wa = axios.create({
  baseURL: "http://127.0.0.1:4657/v21.0",
  headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
});

// Send a text message
const { data } = await wa.post(`/${PHONE_NUMBER_ID}/messages`, {
  messaging_product: "whatsapp",
  recipient_type: "individual",
  to: "15551230000",
  type: "text",
  text: { body: "Hello from parlel!" },
});
console.log(data.messages[0].id); // "wamid.…"

// Send an approved template
await wa.post(`/${PHONE_NUMBER_ID}/messages`, {
  messaging_product: "whatsapp",
  to: "15551230000",
  type: "template",
  template: { name: "hello_world", language: { code: "en_US" } },
});

await server.stop();
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported |
| --- | --- |
| Send text / template / media / location / contacts / interactive / reaction | ✅ |
| Reply context & `preview_url` | ✅ |
| Mark message as read + typing indicator | ✅ |
| Media upload / metadata / download / delete | ✅ |
| Phone number info & WABA `phone_numbers` | ✅ |
| Business profile get/update | ✅ |
| Message template list/create/delete | ✅ |
| Number register / deregister / request_code / verify_code | ✅ |
| Webhook verification handshake (`hub.challenge`) | ✅ |
| Inbound message & status webhook simulation (control plane) | ✅ |
| Bearer-token auth enforcement | ✅ |
| Real OTP/SMS delivery (deterministic `123456` instead) | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| Actual message delivery to a phone | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Template approval workflow (created templates stay `PENDING`) | ⟳ Roadmap — (simplified) |
| Webhook *delivery* to your endpoint (build payloads via `/__parlel/inbound`) | ⟳ Roadmap — (inspect-only) |
| Flows, calling API, billing, analytics, conversation pricing | ⟳ Roadmap |

## Error Codes / Shapes

Failures use the Graph API error envelope:

```json
{
  "error": {
    "message": "(#100) The parameter to is required.",
    "type": "GraphMethodException",
    "code": 100,
    "error_subcode": 33,
    "fbtrace_id": "…",
    "error_data": { "messaging_product": "whatsapp", "details": "to is required" }
  }
}
```

| HTTP | `code` | When |
| --- | --- | --- |
| 401 | `190` | Missing or invalid Bearer access token (`OAuthException`). |
| 400 | `100` | Missing/invalid parameter (`messaging_product`, `to`, message body, media `id`/`link`, etc.). |
| 404 | `100` | Unknown object id (phone number, media, WABA) or unknown template on delete. |
| 404 | `132001` | Sending a template whose name does not exist. |
| 400 | `136024` | Incorrect verification code in `verify_code`. |
| 400 | `136025` | `verify_code` called before `request_code`. |
| 403 | — | Webhook verification with a non-matching `hub.verify_token` (`text/plain` body). |
| 405 | `100` | Method not allowed on a known resource. |

## Environment Variables

| Var | Default |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | `parlel-test-access-token` |
| `WHATSAPP_PHONE_NUMBER_ID` | `100000000000001` |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | `200000000000001` |
| `WHATSAPP_API_VERSION` | `v21.0` |
| `WHATSAPP_VERIFY_TOKEN` | `parlel-verify-token` |
| `WHATSAPP_BASE_URL` | `http://127.0.0.1:4657` |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
WHATSAPP_ACCESS_TOKEN=parlel-test-access-token
WHATSAPP_PHONE_NUMBER_ID=100000000000001
WHATSAPP_BUSINESS_ACCOUNT_ID=200000000000001
WHATSAPP_API_VERSION=v21.0
WHATSAPP_VERIFY_TOKEN=parlel-verify-token
WHATSAPP_BASE_URL=http://localhost:4657
```

<!-- parlel:testenv:end -->
