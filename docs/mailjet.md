# Mailjet

Lightweight, dependency-free, in-memory Mailjet API v3.1 (send) + v3 (REST) fake for testing code that uses the real `node-mailjet` SDK (or the language-agnostic Mailjet REST API).

Default port: `4829`

## Quick start

Start the server:

```js
import { MailjetServer } from "./services/mailjet/src/server.js";

const server = new MailjetServer(4829);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
await fetch("http://127.0.0.1:4829/v3.1/send", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from("parlel-key:parlel-secret").toString("base64"),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    Messages: [{
      From: { Email: "sender@parlel.dev", Name: "Parlel" },
      To: [{ Email: "recipient@parlel.dev" }],
      Subject: "Hello",
      TextPart: "Hi",
      HTMLPart: "<b>Hi</b>",
    }],
  }),
});
// => { Messages: [{ Status: "success", To: [{ Email, MessageID, MessageUUID, MessageHref }] }] }
```

Every send is captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4829`. Use `MAILJET_BASE_URL` to point
clients/agents at it. Captured mail lives at `GET /__parlel/messages`.

## Implemented operations

The send endpoint uses v3.1; CRUD uses v3 REST. All routes require HTTP Basic auth. State is in-memory and ephemeral.

- `POST /v3.1/send` — send a batch of messages (`Messages[]` with `From, To, Subject, TextPart, HTMLPart`). Captures and returns `{ Messages: [{ Status: "success", To: [{ Email, MessageID, MessageUUID, MessageHref }] }] }`.
- `GET /v3/REST/contact` — list contacts (`{ Count, Data, Total }`).
- `POST /v3/REST/contact` — create a contact (`Email` required).
- `GET /v3/REST/contact/:id` — get a contact by id or email.
- `PUT /v3/REST/contact/:id` — update a contact.
- `GET /v3/REST/contactslist` — list contact lists (a seeded default exists).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/messages` — list captured messages (`{ messages, count }`).
- `GET /__parlel/messages/:id` — fetch a single captured message.
- `DELETE /__parlel/messages` — clear only the captured mailbox.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `send` (`POST /v3.1/send`, batched) | ✅ Supported |
| Contacts (create/list/get/update) | ✅ Supported |
| Contact lists listing | ✅ Supported |
| Captured-mail inspection | ✅ Supported (parlel extension) |
| Actual email delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Templates / segmentation / statistics | ⟳ Roadmap |
| Contact deletion (async job semantics) | ⟳ Roadmap |
| Real key validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Send-level errors are reported per-message in `Messages[].Status: "error"` with an `Errors[]` array. Request-level errors use the Mailjet envelope `{ ErrorIdentifier, ErrorCode, StatusCode, ErrorMessage }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid Basic auth |
| `400` | missing `Messages`, missing `From`/`To`, invalid contact email, malformed body |
| `404` | unknown contact / endpoint |

## Manifest

See `services/mailjet/manifest.json`:

- name: `mailjet`, image: `parlel/mailjet:1.0`
- port: `4829`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `MAILJET_API_KEY`, `MAILJET_SECRET_KEY`, `MAILJET_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MAILJET_API_KEY=parlel-key
MAILJET_SECRET_KEY=parlel-secret
MAILJET_BASE_URL=http://localhost:4829
```

<!-- parlel:testenv:end -->
