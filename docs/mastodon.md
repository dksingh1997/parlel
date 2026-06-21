# Mastodon

Lightweight, dependency-free, in-memory fake of the [Mastodon API](https://docs.joinmastodon.org/api/) for testing code that posts statuses, reads the home timeline, and verifies credentials.

Default port: `4806`

## Quick start

```js
import { MastodonServer } from "./services/mastodon/src/server.js";

const server = new MastodonServer(4806);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your client (or raw `fetch`) at `http://127.0.0.1:4806`:

```js
const status = await fetch("http://127.0.0.1:4806/api/v1/statuses", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-test-token", "Content-Type": "application/json" },
  body: JSON.stringify({ status: "Hello from parlel!", visibility: "public" }),
}).then((r) => r.json());
// status.id, status.content, status.account
```

## Implemented operations

All `/api/v1/*` routes require `Authorization: Bearer <token>` (any non-empty token accepted). State is in-memory and ephemeral.

- `POST /api/v1/statuses` — publish a status. Returns the full `Status` (`{ id, created_at, content, account: {...}, ... }`). Empty text → `422`.
- `GET /api/v1/statuses/:id` — retrieve a status.
- `DELETE /api/v1/statuses/:id` — delete a status (returns the deleted status).
- `GET /api/v1/accounts/verify_credentials` — the authenticated `Account`.
- `GET /api/v1/timelines/home` — home timeline (array of `Status`, newest first; honours `?limit=`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/statuses` — list captured statuses.

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Status create / get / delete | ✅ Supported |
| Verify credentials | ✅ Supported |
| Home timeline | ✅ Supported (honours `limit`) |
| `Status` / `Account` shapes | ✅ Supported |
| Bearer token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Media attachments / polls | ⟳ Roadmap |
| Boost / favourite / bookmark actions | ⟳ Roadmap |
| Public / local / tag timelines, streaming | ◐ Home timeline only |
| Real federation / delivery | ✓ By design — Intentionally unsupported (fake only) |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MASTODON_ACCESS_TOKEN=parlel
MASTODON_BASE_URL=http://localhost:4806
```

<!-- parlel:testenv:end -->
