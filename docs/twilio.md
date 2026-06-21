# Twilio

Lightweight, dependency-free, in-memory Twilio REST API fake for testing code that uses the real `twilio` Node client.

Default port: `4652`

It speaks the exact wire protocol the official `twilio` client uses: HTTP Basic auth (`AccountSid:AuthToken`), `application/x-www-form-urlencoded` request bodies, JSON responses, and the `/2010-04-01/Accounts/{Sid}/…` + Verify `v2` resource trees. Everything created is captured in memory for assertions and can be reset. Zero cost, zero side effects.

## Implemented Operations

### Messages (`/2010-04-01/Accounts/{AccountSid}/Messages`)

- `POST /2010-04-01/Accounts/{Sid}/Messages.json` — send an SMS/MMS/WhatsApp message. Validates `To`, `From`/`MessagingServiceSid`, body/media, and number format; returns `201` with an `SM…` SID, `status: "queued"`, computed `num_segments`/`num_media`. Like the real API, `price`/`price_unit` are `null` until billed, and a default `MG…` `messaging_service_sid` is auto-assigned when none is supplied. Backs `client.messages.create(...)`.
- `GET /2010-04-01/Accounts/{Sid}/Messages.json` — list messages (paging envelope). Supports `To`, `From`, `PageSize` filters. Backs `client.messages.list(...)`.
- `GET /2010-04-01/Accounts/{Sid}/Messages/{MessageSid}.json` — fetch one message. Backs `client.messages(sid).fetch()`.
- `POST /2010-04-01/Accounts/{Sid}/Messages/{MessageSid}.json` — update/redact a message (`Body`, `Status`). Backs `client.messages(sid).update(...)`.
- `DELETE /2010-04-01/Accounts/{Sid}/Messages/{MessageSid}.json` — delete a message (`204`). Backs `client.messages(sid).remove()`.

### Calls (`/2010-04-01/Accounts/{AccountSid}/Calls`)

- `POST /2010-04-01/Accounts/{Sid}/Calls.json` — place an outbound call. Validates `To`, `From`, and one of `Url`/`Twiml`/`ApplicationSid`; returns `201` with a `CA…` SID. Backs `client.calls.create(...)`.
- `GET /2010-04-01/Accounts/{Sid}/Calls.json` — list calls. Supports `To`, `From`, `Status`, `PageSize` filters. Backs `client.calls.list(...)`.
- `GET /2010-04-01/Accounts/{Sid}/Calls/{CallSid}.json` — fetch one call. Backs `client.calls(sid).fetch()`.
- `POST /2010-04-01/Accounts/{Sid}/Calls/{CallSid}.json` — modify a call (`Status`, `Url`) e.g. to hang up. Backs `client.calls(sid).update(...)`.
- `DELETE /2010-04-01/Accounts/{Sid}/Calls/{CallSid}.json` — delete a call record (`204`). Backs `client.calls(sid).remove()`.

### Accounts (`/2010-04-01/Accounts`)

- `GET /2010-04-01/Accounts.json` — list accounts. Backs `client.api.accounts.list()`.
- `GET /2010-04-01/Accounts/{Sid}.json` — fetch the account. Backs `client.api.accounts(sid).fetch()`.

### Verify v2 (`/v2/Services`)

- `POST /v2/Services` — create a Verify service (`VA…` SID). Requires `FriendlyName`. Backs `client.verify.v2.services.create(...)`.
- `GET /v2/Services` — list services. Backs `client.verify.v2.services.list()`.
- `GET /v2/Services/{ServiceSid}` — fetch a service. Backs `client.verify.v2.services(sid).fetch()`.
- `POST /v2/Services/{ServiceSid}` — update a service (`FriendlyName`, `CodeLength`). Backs `client.verify.v2.services(sid).update(...)`.
- `DELETE /v2/Services/{ServiceSid}` — delete a service (`204`). Backs `client.verify.v2.services(sid).remove()`.
- `POST /v2/Services/{ServiceSid}/Verifications` — start a verification (`To`, `Channel` in `sms|call|email|whatsapp|sna`); returns `201`, `status: "pending"`, `VE…` SID, and `sna: null` for non-SNA channels. Backs `client.verify.v2.services(sid).verifications.create(...)`.
- `GET /v2/Services/{ServiceSid}/Verifications/{Sid|To}` — fetch a verification by SID or destination. Backs `client.verify.v2.services(sid).verifications(sid).fetch()`.
- `POST /v2/Services/{ServiceSid}/VerificationCheck` — check a code (`To`+`Code` or `VerificationSid`+`Code`); approves on the correct code. The response echoes the verification's own `VE…` SID and includes `sna_attempts_error_codes: []`. Backs `client.verify.v2.services(sid).verificationChecks.create(...)`.

> Date formats follow the real API exactly: the `2010-04-01` REST surface (Messages, Calls, Accounts) returns **RFC 2822** timestamps (e.g. `Fri, 24 May 2019 17:44:46 +0000`), while the Verify `v2` surface returns **ISO 8601** timestamps (e.g. `2015-07-30T20:00:00Z`).

> Test convenience: the deterministic OTP is `123456` (truncated/padded to the service `code_length`). A `VerificationCheck` with `123456` always approves, so tests need no out-of-band code delivery. The started verification also exposes the code as `_parlel_code` (a parlel-only field, not part of the real payload).

### Service & inspection operations

- `GET /` — service metadata.
- `GET /health` — `{ "status": "ok" }`.
- `OPTIONS *` — `204` (CORS preflight).
- `GET /__parlel/messages` — every captured message (`{ messages, count }`).
- `GET /__parlel/calls` — every captured call (`{ calls, count }`).
- `GET /__parlel/verifications` — every started verification (`{ verifications, count }`).
- `POST /__parlel/reset` — clear all in-memory state.
- `server.reset()` — clear all in-memory state when used in-process.

## Quick Start

```js
import twilio from "twilio";
import { TwilioServer } from "./services/twilio/src/server.js";

const server = new TwilioServer(4652);
await server.start();

const accountSid = "ACparlel00000000000000000000000000";
const authToken = "parlel_test_auth_token";

// Point the real twilio client at the local fake instead of api.twilio.com.
const client = twilio(accountSid, authToken, {
  region: undefined,
  edge: undefined,
});
// Override the base URLs used by the message/verify domains:
client.api.baseUrl = "http://127.0.0.1:4652";
client.verify.baseUrl = "http://127.0.0.1:4652";

const message = await client.messages.create({
  to: "+15558675310",
  from: "+15017122661",
  body: "Sending with parlel is fun",
});
console.log(message.sid, message.status); // SM…  queued

await server.stop();
```

> The `twilio` client reads the base host from the `Domain` configured per
> sub-client. In tests it is simplest to talk to the fake directly over HTTP
> (Basic auth + form-encoded body), which is exactly the wire protocol the
> client emits — see `tests/twilio.test.ts` for a faithful zero-dependency
> client simulation (`TwilioClientSim`).

To assert what was "sent" in a test, read the captured collections:

```js
const res = await fetch("http://127.0.0.1:4652/__parlel/messages");
const { messages, count } = await res.json();
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| `messages.create` / `list` / `fetch` / `update` / `remove` | ✅ | Full Messages CRUD over the `2010-04-01` tree; `price`/`price_unit` `null` until billed, default `MG…` `messaging_service_sid` auto-assigned. |
| `calls.create` / `list` / `fetch` / `update` / `remove` | ✅ | Full Calls CRUD; `update` modifies status/url; `price_unit` `null` until billed. |
| `api.accounts.list` / `accounts(sid).fetch` | ✅ | Account list + fetch (minimal body). |
| `verify.v2.services` CRUD | ✅ | Create/list/fetch/update/delete Verify services; ISO 8601 timestamps. |
| `verify.v2.services(sid).verifications.create` / fetch | ✅ | Start + fetch verifications; `sna: null`, ISO 8601 timestamps. |
| `verify.v2.services(sid).verificationChecks.create` | ✅ | Echoes the verification's `VE…` SID, returns `sna_attempts_error_codes: []`; approves with code `123456` (deterministic test OTP). |
| HTTP Basic auth (`AccountSid:AuthToken`) | ✅ | Any `AC…`/`SK…` username with credentials is accepted. |
| `application/x-www-form-urlencoded` bodies | ✅ | Repeated keys (e.g. `MediaUrl`) become arrays, like the real API. |
| Number / payload validation | ✅ | E.164 checks + Twilio error codes (21211/21212/21602/21603/21604/21205/60200). |
| Flat JSON error envelope (`code`/`message`/`more_info`/`status`) | ✅ | Identical framing across the `2010-04-01` and Verify `v2` surfaces. |
| Message capture / inspection | ✅ | `/__parlel/*` exposes everything created. |
| Auth-token *secret* validation | ◐ | The `AC…`/`SK…` username prefix is checked; the secret is accepted as-is (no real credential validation). |
| Actual SMS / call / OTP delivery | ✓ | Nothing leaves the process — zero side effects by design. |
| Status-callback webhooks | ✓ | No outbound callbacks are made; messages/calls stay `queued` unless updated. |
| `2010-04-01` XML responses (requests without `.json`) | ✓ | JSON-only; the official `twilio` client always appends `.json`. |
| Pricing, carrier lookups, real number provisioning | ✓ | Not needed for application tests. |
| Persistence | ✓ | State is ephemeral by design. |
| Rate limiting / quotas (`429`) | ✓ | Local tests should not pay Twilio costs or hit side effects. |
| Studio, TaskRouter, Conversations, Lookups, Sync, Video, etc. | ⟳ | Outside the messages/calls/verify surface this fake targets. |

## Error Shapes

All JSON errors use the Twilio REST framing — a flat object with `code`,
`message`, `more_info`, and `status`:

```json
{
  "code": 21211,
  "message": "The 'To' number +1234 is not a valid phone number.",
  "more_info": "https://www.twilio.com/docs/errors/21211",
  "status": 400
}
```

Returned status codes:

| Status | When |
| --- | --- |
| `200` | Successful reads / list / update operations. |
| `201` | Resource created (message, call, verify service, verification). |
| `204` | Successful delete / CORS preflight. |
| `400` | Validation failure (missing/invalid `To`/`From`, body/url/channel, etc.). |
| `401` | Missing or unrecognized Basic `Authorization` (code `20003`). |
| `404` | Unknown endpoint or missing resource (code `20404`). |
| `405` | Endpoint exists but the HTTP method is unsupported (code `20004`). |
| `500` | Unexpected server exception (code `20500`). |

Common Twilio error codes emitted:

| Code | Meaning |
| --- | --- |
| `20003` | Authentication error — no/invalid credentials. |
| `20404` | Resource not found. |
| `21205` | Call requires `Url`, `Twiml`, or `ApplicationSid`. |
| `21211` | Invalid `To` phone number. |
| `21212` | Invalid `From` phone number. |
| `21602` | Message body (or media) is required. |
| `21603` | `From` or `MessagingServiceSid` is required. |
| `21604` | `To` number is required. |
| `60200` | Invalid/missing Verify parameter. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
TWILIO_ACCOUNT_SID=ACparlel00000000000000000000000000
TWILIO_AUTH_TOKEN=parlel_test_auth_token
TWILIO_BASE_URL=http://localhost:4652
TWILIO_API_BASE_URL=http://localhost:4652
TWILIO_VERIFY_BASE_URL=http://localhost:4652
```

<!-- parlel:testenv:end -->
