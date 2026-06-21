# DocuSign

Lightweight, dependency-free, in-memory DocuSign eSignature REST API v2.1 fake for testing code that uses the real `docusign-esign` SDK (and the language-agnostic eSignature REST API).

Default port: `4814`

## Quick start

```js
import { DocusignServer } from "./services/docusign/src/server.js";

const server = new DocusignServer(4814);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `docusign-esign` `ApiClient` at it via `setBasePath`:

```js
import docusign from "docusign-esign";

const client = new docusign.ApiClient();
client.setBasePath("http://127.0.0.1:4814/restapi");
client.addDefaultHeader("Authorization", "Bearer parlel");
const envelopesApi = new docusign.EnvelopesApi(client);
const result = await envelopesApi.createEnvelope("parlel-account", { envelopeDefinition });
// result.envelopeId, result.status === "sent"
```

State is in-memory and ephemeral.

## Implemented operations

All routes require `Authorization: Bearer <token>`; any non-empty bearer token is accepted. Routes are under `/restapi/v2.1/accounts/:accountId`.

### Envelopes

- `POST /envelopes` — create/send an envelope. Returns the summary `{ envelopeId, status, statusDateTime, uri }`. `status: "created"` makes a draft; otherwise `sent`.
- `GET /envelopes` — list envelopes.
- `GET /envelopes/:envelopeId` — retrieve the full envelope.
- `PUT /envelopes/:envelopeId` — update status (e.g. `voided`, or send a draft). Returns `{ envelopeId, status, statusDateTime }`.

### Recipients

- `GET /envelopes/:envelopeId/recipients` — list recipients (`{ signers, recipientCount, carbonCopies }`).
- `POST /envelopes/:envelopeId/recipients` — add signers.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state.
- `GET /__parlel/envelopes` — list all envelopes.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool, the service is reachable at its preview URL (host/port shown by the pool); set the SDK base path to `<preview-url>/restapi`. Through the parlel MCP server, the envelope/recipient routes are exposed as a tool surface so an AI agent can create envelopes and inspect their status without a DocuSign account.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `createEnvelope` (sent/draft) | ✅ Supported |
| `getEnvelope` / list | ✅ Supported |
| Recipients list/add | ✅ Supported |
| Envelope status update (void / send) | ✅ Supported |
| Real signing ceremony / recipient view URLs | ⟳ Roadmap |
| Document rendering / PDF generation | ⟳ Roadmap — Documents stored, not rendered |
| Templates / Tabs / Webhooks (Connect) | ⟳ Roadmap |
| JWT / OAuth token exchange | ✓ By design — Out of scope (any bearer accepted) |
| Bearer-token validity check | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Manifest

See `services/docusign/manifest.json`:

- name: `docusign`, image: `parlel/docusign:1.0`
- port: `4814`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `DOCUSIGN_TOKEN`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
DOCUSIGN_TOKEN=parlel
DOCUSIGN_ACCOUNT_ID=parlel-account
DOCUSIGN_HOST=http://localhost:4814
DOCUSIGN_BASE_URL=http://localhost:4814
```

<!-- parlel:testenv:end -->
