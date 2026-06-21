# Postmark

Lightweight, dependency-free, in-memory Postmark API fake for testing code that uses the real `postmark` Node SDK (or the language-agnostic Postmark REST API).

Default port: `4827`

## Quick start

Start the server:

```js
import { PostmarkServer } from "./services/postmark/src/server.js";

const server = new PostmarkServer(4827);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `postmark` client at it:

```js
import { ServerClient } from "postmark";

const client = new ServerClient("parlel-server-token", {
  // The SDK is configured via Configuration; or fetch directly against the base URL:
});

await fetch("http://127.0.0.1:4827/email", {
  method: "POST",
  headers: {
    "X-Postmark-Server-Token": "parlel-server-token",
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    From: "sender@parlel.dev",
    To: "recipient@parlel.dev",
    Subject: "Hello",
    HtmlBody: "<b>Hi</b>",
    TextBody: "Hi",
  }),
});
// => { To, SubmittedAt, MessageID, ErrorCode: 0, Message: "OK" }
```

Every send is captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4827`. Use `POSTMARK_BASE_URL` to point
clients/agents at it. Captured mail lives at `GET /__parlel/messages` so you can
assert sends without delivering real email.

## Implemented operations

All routes require the `X-Postmark-Server-Token` (or `X-Postmark-Account-Token`) header. JSON bodies use PascalCase fields. State is in-memory and ephemeral.

- `POST /email` — send a single message (`From, To, Subject, HtmlBody, TextBody`). Captures and returns `{ To, SubmittedAt, MessageID, ErrorCode: 0, Message: "OK" }`.
- `POST /email/batch` — send an array of messages, returns an array of per-message results.
- `POST /email/withTemplate` — send using `TemplateId`/`TemplateAlias` + `TemplateModel`.
- `GET /messages/outbound` — list outbound messages (`{ TotalCount, Messages }`).
- `GET /server` — server metadata.

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
| `sendEmail` (`POST /email`) | ✅ Supported |
| `sendEmailBatch` (`POST /email/batch`) | ✅ Supported |
| `sendEmailWithTemplate` | ✅ Supported |
| Outbound message listing | ✅ Supported |
| Server info | ✅ Supported |
| Captured-mail inspection | ✅ Supported (parlel extension) |
| Actual email delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Real template rendering | ◐ Accepted; not rendered |
| Bounces / stats / inbound / triggers | ⟳ Roadmap |
| Real token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Errors use the Postmark envelope `{ "ErrorCode": <n>, "Message": "..." }`.

| Status | `ErrorCode` | When |
| --- | --- | --- |
| `401` | `10` | missing server/account token |
| `422` | `300` | invalid `From`/`To` or malformed body |
| `422` | `1101` | invalid/missing template on `withTemplate` |
| `404` | `404` | unknown endpoint or captured message |

## Manifest

See `services/postmark/manifest.json`:

- name: `postmark`, image: `parlel/postmark:1.0`
- port: `4827`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `POSTMARK_SERVER_TOKEN`, `POSTMARK_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
POSTMARK_SERVER_TOKEN=parlel-server-token
POSTMARK_BASE_URL=http://localhost:4827
```

<!-- parlel:testenv:end -->
