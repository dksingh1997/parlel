# Constant Contact

Lightweight, dependency-free, in-memory Constant Contact v3 API fake for testing code that uses the language-agnostic Constant Contact v3 REST API.

Default port: `4832`

## Quick start

Start the server:

```js
import { ConstantContactServer } from "./services/constant-contact/src/server.js";

const server = new ConstantContactServer(4832);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it (Bearer auth):

```js
await fetch("http://127.0.0.1:4832/v3/contacts", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-cc-token", "Content-Type": "application/json" },
  body: JSON.stringify({
    email_address: { address: "contact@parlel.dev", permission_to_send: "implicit" },
    first_name: "Contact",
    create_source: "Account",
  }),
});
// => { contact_id, email_address, first_name, ... }
```

Email campaign creation is captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4832`. Use `CONSTANT_CONTACT_BASE_URL` to
point clients/agents at it. Captured campaigns live at `GET /__parlel/messages`.

## Implemented operations

All `/v3/*` routes require Bearer auth. State is in-memory and ephemeral.

- `GET /v3/contacts` — list contacts (`{ contacts, contacts_count }`).
- `POST /v3/contacts` — create a contact (`email_address.address` required).
- `GET /v3/contacts/:contact_id` — get a contact.
- `PUT /v3/contacts/:contact_id` — update a contact.
- `DELETE /v3/contacts/:contact_id` — delete a contact (`204`).
- `GET /v3/contact_lists` — list contact lists (`{ lists, lists_count }`).
- `POST /v3/contact_lists` — create a contact list (`name` required).
- `POST /v3/emails` — create an email campaign (`name` required); captured.
- `GET /v3/account/summary` — account summary.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/messages` — list captured campaigns (`{ messages, count }`).
- `GET /__parlel/messages/:id` — fetch a single captured campaign.
- `DELETE /__parlel/messages` — clear only the captured mailbox.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Contacts CRUD (create/list/get/update/delete) | ✅ Supported |
| Contact lists (create/list) | ✅ Supported |
| Email campaign creation | ✅ Supported |
| Account summary | ✅ Supported |
| Captured campaign inspection | ✅ Supported (parlel extension) |
| Actual campaign delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| OAuth2 token exchange / refresh | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Campaign scheduling / sending / activities lifecycle | ◐ Created as `Draft`; not advanced |
| Segments / tags / bulk activities / reporting | ⟳ Roadmap |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Errors use the Constant Contact envelope `[{ "error_key": "...", "error_message": "..." }]`.

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer auth |
| `400` | invalid/missing field (e.g. `email_address.address`, `name`) |
| `409` | contact already exists |
| `404` | unknown contact / endpoint |

## Manifest

See `services/constant-contact/manifest.json`:

- name: `constant-contact`, image: `parlel/constant-contact:1.0`
- port: `4832`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CONSTANT_CONTACT_ACCESS_TOKEN`, `CONSTANT_CONTACT_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CONSTANT_CONTACT_ACCESS_TOKEN=parlel-cc-token
CONSTANT_CONTACT_BASE_URL=http://localhost:4832
```

<!-- parlel:testenv:end -->
