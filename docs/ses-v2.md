# ses-v2 (parlel)

A zero-dependency, in-process fake of Amazon SES v2 (SESv2). Speaks the SESv2
REST/JSON API. This is the standalone "extend SES with the v2 REST surface"
deliverable. Sent emails are captured in memory for test assertions.

| Field | Value |
| --- | --- |
| Service | `ses-v2` |
| Port | `4746` |
| Protocol | REST / JSON |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4746
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation | HTTP |
| --- | --- |
| SendEmail | `POST /v2/email/outbound-emails` (Simple + Raw content) |
| CreateEmailIdentity | `POST /v2/email/identities` |
| ListEmailIdentities | `GET /v2/email/identities` |
| GetEmailIdentity | `GET /v2/email/identities/{id}` |
| DeleteEmailIdentity | `DELETE /v2/email/identities/{id}` |
| PutSuppressedDestination | `PUT /v2/email/suppression/addresses/{email}` |
| ListSuppressedDestinations | `GET /v2/email/suppression/addresses` |
| GetSuppressedDestination | `GET /v2/email/suppression/addresses/{email}` |
| DeleteSuppressedDestination | `DELETE /v2/email/suppression/addresses/{email}` |

Email identities are auto-verified. Domain identities return synthetic DKIM
tokens.

### Test helper

`GET /_parlel/sent` returns all captured outbound emails (`{ sent: [...] }`),
each with `MessageId`, `Subject`, `Body`/`RawData`, and the original request.

## SDK example

```js
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({
  endpoint: "http://127.0.0.1:4746",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await ses.send(new SendEmailCommand({
  FromEmailAddress: "from@example.com",
  Destination: { ToAddresses: ["to@example.com"] },
  Content: { Simple: { Subject: { Data: "Hi" }, Body: { Text: { Data: "Hello" } } } },
}));
```

## Access via MCP / preview URL

Under the parlel pool, reach this service through the MCP gateway and the pool's
preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| Delivery | No email is actually delivered; messages are captured in memory. |
| Verification | Identities are auto-verified; no DNS/DKIM checks. |
| Raw content | Stored verbatim (base64); not parsed/validated. |
| Templates | `Content.Template` accepted but not rendered. |
| Config sets / events | Not implemented. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4746
```

<!-- parlel:testenv:end -->
