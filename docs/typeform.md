# Typeform

Lightweight, dependency-free, in-memory Typeform Create & Responses API fake for testing code that uses the real `@typeform/api-client` SDK (and the language-agnostic Typeform REST API).

Default port: `4812`

## Quick start

```js
import { TypeformServer } from "./services/typeform/src/server.js";

const server = new TypeformServer(4812);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real client at it via `apiBaseUrl`:

```js
import { createClient } from "@typeform/api-client";

const typeform = createClient({ token: "parlel", apiBaseUrl: "http://127.0.0.1:4812" });
const forms = await typeform.forms.list();
```

State is in-memory and ephemeral.

## Implemented operations

All routes require `Authorization: Bearer <token>`; any non-empty bearer token is accepted.

### Account

- `GET /me` — retrieve the authenticated account (`{ user_id, email, alias, language }`).

### Forms

- `GET /forms` — list forms (`{ total_items, page_count, items: [...] }`, supports `?page` / `?page_size`).
- `POST /forms` — create a form (`201`). Form shape `{ id, title, fields: [...], settings, _links: { display } }`.
- `GET /forms/:id` — retrieve a form.
- `PUT|PATCH /forms/:id` — update title / fields / settings.
- `DELETE /forms/:id` — delete a form (`204`).

### Responses

- `GET /forms/:id/responses` — list responses (`{ total_items, page_count, items }`).
- `POST /forms/:id/responses` — seed a response for inspection (parlel convenience; real Typeform creates responses through the form runner).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state (re-seeds one default form).
- `GET /__parlel/forms` — list all forms.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool, the service is reachable at its preview URL (host/port shown by the pool); set `apiBaseUrl` to that URL. Through the parlel MCP server, the forms and responses routes are exposed as a tool surface so an AI agent can create forms and read submissions directly.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /me` | ✅ Supported |
| Forms CRUD (list/create/get/update/delete) | ✅ Supported |
| Responses listing | ✅ Supported |
| Response seeding (parlel convenience) | ✅ Supported (parlel extension) |
| Form runner / real submission flow | ⟳ Roadmap — responses are seeded |
| Themes / Images / Workspaces / Webhooks REST resources | ⟳ Roadmap |
| Field-level validation rules enforcement | ◐ Stored, not enforced |
| Bearer-token validity check | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Manifest

See `services/typeform/manifest.json`:

- name: `typeform`, image: `parlel/typeform:1.0`
- port: `4812`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `TYPEFORM_TOKEN`, `TYPEFORM_API_KEY`, `TYPEFORM_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
TYPEFORM_TOKEN=parlel
TYPEFORM_API_KEY=parlel
TYPEFORM_HOST=http://localhost:4812
TYPEFORM_BASE_URL=http://localhost:4812
```

<!-- parlel:testenv:end -->
