# SharePoint (Microsoft Graph)

Lightweight, dependency-free, in-memory fake of SharePoint via the [Microsoft Graph API](https://learn.microsoft.com/en-us/graph/api/resources/sharepoint) (`/v1.0`). For testing code that reads sites, manages lists/items, and browses document libraries.

Default port: `4798`

## Quick start

```js
import { SharepointServer } from "./services/sharepoint/src/server.js";

const server = new SharepointServer(4798);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the Microsoft Graph client (or raw `fetch`) at `http://127.0.0.1:4798`:

```js
const site = await fetch("http://127.0.0.1:4798/v1.0/sites/root", {
  headers: { Authorization: "Bearer parlel-test-token" },
}).then((r) => r.json());
// site.id, site.webUrl

const list = await fetch("http://127.0.0.1:4798/v1.0/sites/root/lists", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-test-token", "Content-Type": "application/json" },
  body: JSON.stringify({ displayName: "Tasks", list: { template: "genericList" } }),
}).then((r) => r.json());
```

## Implemented operations

All `/v1.0/*` routes require `Authorization: Bearer <token>` (any non-empty token accepted). Use `root` as a `:siteId` alias for the seeded default site. State is in-memory and ephemeral.

- `GET /v1.0/sites/:siteId` — retrieve a site (`{ id, name, displayName, webUrl, ... }`).
- `GET /v1.0/sites/:siteId/lists` — list lists (`{ "@odata.context", value: [] }`).
- `POST /v1.0/sites/:siteId/lists` — create a list (`201`). Requires `displayName`.
- `GET /v1.0/sites/:siteId/lists/:listId` — retrieve a list.
- `GET /v1.0/sites/:siteId/lists/:listId/items` — list items (`{ value: [] }`).
- `POST /v1.0/sites/:siteId/lists/:listId/items` — create an item (`201`). Body `{ fields: {...} }`.
- `GET /v1.0/sites/:siteId/drive/root/children` — list document library children (`{ value: [] }`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/lists` — list captured lists.

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Sites (get) | ✅ Supported |
| Lists (list/create/get) | ✅ Supported |
| List items (list/create) | ✅ Supported |
| Drive root children | ✅ Supported |
| Graph error envelope `{ error: { code, message, innerError } }` | ✅ Supported |
| `@odata.nextLink` pagination | ◐ Single page returned; `value` always complete |
| Bearer token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| `$select` / `$filter` / `$expand` OData query options | ⟳ Roadmap — Not evaluated |
| File upload / download content | ⟳ Roadmap — metadata only |
| Real SharePoint / OneDrive storage | ✓ By design — Intentionally unsupported (fake only) |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SHAREPOINT_ACCESS_TOKEN=parlel
SHAREPOINT_BASE_URL=http://localhost:4798
```

<!-- parlel:testenv:end -->
