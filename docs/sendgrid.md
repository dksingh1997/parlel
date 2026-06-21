# SendGrid

Lightweight, dependency-free, in-memory SendGrid v3 Web API fake for testing code that uses the real `@sendgrid/mail` client.

Default port: `4650`

## Implemented Operations

### Mail (the surface `@sendgrid/mail` actually calls)

- `POST /v3/mail/send` — accepts a SendGrid v3 mail payload, validates it like the real API, captures it in memory, and returns `202 Accepted` with an empty body and an `X-Message-Id` response header. This is the single endpoint that `@sendgrid/mail`'s `send()`, `send([...])`, and `sendMultiple()` hit.
- `POST /v3/mail/batch` — creates a `batch_id` for scheduled/batched sends (`201`, `{ batch_id }`).
- `GET /v3/mail/batch/:batch_id` — validates a batch id (`200`, `{ batch_id }`).

### Account / key management (broader `@sendgrid/client` surface)

- `GET /v3/scopes` — lists the scopes available to the authenticated key.
- `GET /v3/api_keys` — lists API keys (`{ result: [...] }`).

### Unsubscribe groups & suppressions (ASM)

- `GET /v3/asm/groups` — lists unsubscribe groups (each `{ id, name, description, is_default, unsubscribes }`).
- `POST /v3/asm/groups` — creates a group (`201`).
- `GET /v3/asm/groups/:id` — retrieves a group (`{ id, name, description, is_default, unsubscribes }`).
- `PATCH|PUT /v3/asm/groups/:id` — updates a group.
- `DELETE /v3/asm/groups/:id` — deletes a group (`204`).
- `POST /v3/asm/suppressions/global` — adds global unsubscribes (`{ recipient_emails: [...] }`, `201`).
- `GET /v3/asm/suppressions/global/:email` — checks a global unsubscribe (`{ recipient_email }` or `{}`).
- `DELETE /v3/asm/suppressions/global/:email` — removes a global unsubscribe (`204`).

### Sender verification

- `GET /v3/verified_senders` — lists verified senders (`{ results: [...] }`).
- `POST /v3/verified_senders` — registers a verified sender (`201`, auto-`verified: true`).

### Service & inspection operations

- `GET /` — returns service metadata.
- `GET /health` — returns `{ "status": "ok" }`.
- `OPTIONS *` — returns `204` (CORS preflight).
- `GET /__parlel/messages` — lists every captured outbound message (`{ messages, count }`).
- `GET /__parlel/messages/:message_id` — returns one captured message.
- `DELETE /__parlel/messages` — clears the captured mailbox only.
- `POST /__parlel/reset` — clears all in-memory state.
- `server.reset()` — clears all in-memory state when used in-process.

## Quick Start

The fake speaks the exact wire protocol of the real client. Point `@sendgrid/mail`
at the local server by overriding the client base URL:

```js
import sgMail from "@sendgrid/mail";
import { SendgridServer } from "./services/sendgrid/src/server.js";

const server = new SendgridServer(4650);
await server.start();

sgMail.setApiKey("SG.parlel");
// Route the client to the local fake instead of api.sendgrid.com:
sgMail.client.setDefaultRequest("baseUrl", "http://127.0.0.1:4650");

const [response] = await sgMail.send({
  to: "test@example.com",
  from: "verified@parlel.dev",
  subject: "Sending with parlel is fun",
  text: "and easy to do anywhere, even with Node.js",
  html: "<strong>and easy to do anywhere, even with Node.js</strong>",
});

console.log(response.statusCode); // 202
console.log(response.headers["x-message-id"]);

await server.stop();
```

To assert what was "sent" in a test, read the captured mailbox:

```js
const res = await fetch("http://127.0.0.1:4650/__parlel/messages");
const { messages, count } = await res.json();
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ supported · ◐ accepted (stored, not enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| `@sendgrid/mail` `send` / `sendMultiple` / `send([...])` | ✅ | All route through `POST /v3/mail/send`; `202` + empty body + `X-Message-Id`. |
| `setApiKey` (Bearer auth) | ✅ | Any non-empty Bearer token is accepted; missing/malformed → `401`. |
| `setTwilioEmailAuth` (Basic auth) | ✅ | Any non-empty Basic credential is accepted. |
| Mail payload validation | ✅ | Validates `personalizations`, `to`, `from`, `subject`, and `content` with real SendGrid error envelopes and help URLs. |
| Template sends (`template_id`) | ✅ | `subject` and `content` become optional when a template is used. |
| `cc` / `bcc` / `reply_to` / attachments / categories / `custom_args` / `asm` / settings | ◐ | Preserved verbatim in the captured message; not interpreted. |
| API keys CRUD (`/v3/api_keys`) | ✅ | List/create/get/update/delete; `api_key` secret returned once on create. |
| ASM unsubscribe groups (`/v3/asm/groups`) | ✅ | CRUD; group objects include `unsubscribes`. |
| Global suppressions (`/v3/asm/suppressions/global`) | ✅ | Add/check/delete; check returns `{ recipient_email }` or `{}`. |
| Verified senders (`/v3/verified_senders`) | ✅ | List/create; `{ results: [...] }`. |
| Scopes (`/v3/scopes`) | ✅ | `{ scopes: [...] }`. |
| Mail batch (`/v3/mail/batch`) | ✅ | Create `{ batch_id }` (`201`); validate `{ batch_id }` (`200`). |
| Message capture / inspection | ✅ | `/__parlel/messages` exposes everything that was sent. |
| Actual email delivery | ✓ | Nothing leaves the process — zero side effects by design. |
| Unverified-sender `403` enforcement | ✓ | No real sender verification; any valid `from` is accepted. |
| Event/Inbound Parse webhooks | ✓ | No outbound callbacks are made. |
| Rate limiting / quotas | ✓ | Local tests should not pay SendGrid costs or hit side effects. |
| Persistence | ✓ | State is ephemeral by design. |
| Stats, Marketing Campaigns, Contacts, Templates CRUD | ⟳ | Outside the `@sendgrid/mail` surface; not required for app tests. |

## Error Shapes

All JSON errors use SendGrid v3 framing — an `errors` array where each entry has
`message`, `field`, and `help`:

```json
{
  "errors": [
    {
      "message": "The subject is required. You can get around this requirement if you use a template with a subject defined or if every personalization has a subject defined.",
      "field": "subject",
      "help": "http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.subject"
    }
  ]
}
```

Returned status codes:

| Status | When |
| --- | --- |
| `202` | `POST /v3/mail/send` accepted (empty body, `X-Message-Id` header). |
| `200` | Successful reads / list operations. |

| `204` | Successful delete / CORS preflight. |
| `400` | Validation failure (invalid/missing mail fields, missing required `name`, malformed JSON body). |
| `401` | Missing or unrecognized `Authorization` header. |
| `404` | Unknown endpoint or missing resource. |
| `405` | Endpoint exists but the HTTP method is unsupported. |
| `500` | Unexpected server exception. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SENDGRID_API_KEY=SG.parlel
SENDGRID_BASE_URL=http://localhost:4650
SENDGRID_HOST=http://localhost:4650
```

<!-- parlel:testenv:end -->
