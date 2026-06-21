# customerio

A tiny, dependency-free fake of the **Customer.io** Journeys REST API (Track API + App API + Pipelines API) that speaks the exact wire protocol of the official [`customerio-node`](https://github.com/customerio/customerio-node) client — like LocalStack, but in-process and zero-cost.

- **Default port:** `4668`
- **Protocol:** HTTP / JSON (Customer.io REST: Track, App, and Pipelines APIs)
- **Compatible client:** `customerio-node` (`TrackClient`, `APIClient`, `PipelinesClient`)
- **Healthcheck:** `GET /health` → `{ "status": "ok" }`
- **State:** in-memory and ephemeral; resettable via `POST /__parlel/reset`

The real product hosts the App API (`api.customer.io`) and Pipelines API (`cdp.customer.io`) on different hosts. This fake serves all three APIs on one port, disambiguated by path prefix. Point every `customerio-node` client at the same base URL via its `url` option.

---

## Quick start

```js
import { CustomerioServer } from "./services/customerio/src/server.js";

const server = new CustomerioServer(4668);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Connect with the real `customerio-node` client (point `url` at the fake):

```js
const { TrackClient, APIClient, PipelinesClient } = require("customerio-node");

// Track API (Basic auth: siteId + apiKey)
const cio = new TrackClient("parlel-site-id", "parlel-api-key", {
  url: "http://127.0.0.1:4668/api/v1",
});
await cio.identify("1", { email: "bob@example.com", plan: "pro" });
await cio.track("1", { name: "signup", data: { source: "web" } });

// App API (Bearer auth: app key)
const api = new APIClient("parlel-app-key", { url: "http://127.0.0.1:4668/v1" });
const { SendEmailRequest } = require("customerio-node");
await api.sendEmail(new SendEmailRequest({
  to: "person@example.com",
  identifiers: { email: "person@example.com" },
  transactional_message_id: "welcome",
}));

// Pipelines API (Basic auth: write key)
const cdp = new PipelinesClient("parlel-write-key", { url: "http://127.0.0.1:4668/v1" });
await cdp.identify({ userId: "1", traits: { email: "bob@example.com" } });
```

> The `TrackClient` derives the Track v2 (batch) base by replacing `/api/v1` with `/api/v2`, so passing `url: ".../api/v1"` routes `batch()` to `.../api/v2/batch` automatically.

Run a standalone instance:

```bash
PORT=4668 node services/customerio/src/server.js
```

---

## Implemented operations

### Track API — `TrackClient` (Basic auth, `/api/v1`)

| Method | HTTP | Path |
| --- | --- | --- |
| `identify(id, data)` | `PUT` | `/api/v1/customers/{id}` |
| `destroy(id)` | `DELETE` | `/api/v1/customers/{id}` |
| `suppress(id)` | `POST` | `/api/v1/customers/{id}/suppress` |
| `unsuppress(id)` | `POST` | `/api/v1/customers/{id}/unsuppress` |
| `track(id, data)` | `POST` | `/api/v1/customers/{id}/events` |
| `trackPageView(id, url)` | `POST` | `/api/v1/customers/{id}/events` (`type: "page"`) |
| `trackAnonymous(anonId, data)` | `POST` | `/api/v1/events` |
| `trackPush(data)` | `POST` | `/api/v1/push/events` |
| `addDevice(id, deviceId, platform, data)` | `PUT` | `/api/v1/customers/{id}/devices` |
| `deleteDevice(id, token)` | `DELETE` | `/api/v1/customers/{id}/devices/{token}` |
| `mergeCustomers(pType, pId, sType, sId)` | `POST` | `/api/v1/merge_customers` |
| `batch(operations)` | `POST` | `/api/v2/batch` |

### App API — `APIClient` (Bearer auth, `/v1`)

| Method | HTTP | Path |
| --- | --- | --- |
| `sendEmail(req)` | `POST` | `/v1/send/email` |
| `sendPush(req)` | `POST` | `/v1/send/push` |
| `sendSMS(req)` | `POST` | `/v1/send/sms` |
| `sendInboxMessage(req)` | `POST` | `/v1/send/inbox_message` |
| `sendInApp(req)` | `POST` | `/v1/send/in_app` |
| `getCustomersByEmail(email)` | `GET` | `/v1/customers?email=` |
| `getAttributes(id, idType)` | `GET` | `/v1/customers/{id}/attributes?id_type=` |
| `triggerBroadcast(id, data, recipients)` | `POST` | `/v1/campaigns/{id}/triggers` |
| `listExports()` | `GET` | `/v1/exports` |
| `getExport(id)` | `GET` | `/v1/exports/{id}` |
| `downloadExport(id)` | `GET` | `/v1/exports/{id}/download` |
| `createCustomersExport(filters)` | `POST` | `/v1/exports/customers` |
| `createDeliveriesExport(newsletterId, options)` | `POST` | `/v1/exports/deliveries` |

### Pipelines API — `PipelinesClient` (Basic auth with write key, `/v1`)

| Method | HTTP | Path |
| --- | --- | --- |
| `identify(payload)` | `POST` | `/v1/identify` |
| `track(payload)` | `POST` | `/v1/track` |
| `page(payload)` | `POST` | `/v1/page` |
| `screen(payload)` | `POST` | `/v1/screen` |
| `group(payload)` | `POST` | `/v1/group` |
| `alias(payload)` | `POST` | `/v1/alias` |
| `batch(items)` | `POST` | `/v1/batch` |

### parlel inspection / control endpoints (not part of Customer.io)

These let tests assert what was captured. No auth required.

| HTTP | Path | Purpose |
| --- | --- | --- |
| `POST` | `/__parlel/reset` | Clear all in-memory state |
| `GET` | `/__parlel/customers` | List all identified people |
| `GET` | `/__parlel/customers/{id}` | Fetch one person |
| `GET` | `/__parlel/events` | All captured Track events (event/page/anonymous/push) |
| `GET` | `/__parlel/deliveries` | All transactional sends |
| `GET` | `/__parlel/deliveries/{id}` | One transactional send |
| `GET` | `/__parlel/devices` | All registered devices |
| `GET` | `/__parlel/suppressed` | Suppressed customer ids |
| `GET` | `/__parlel/broadcasts` | Captured broadcast triggers |
| `GET` | `/__parlel/merges` | Captured merge operations |
| `GET` | `/__parlel/batches` | Captured batch submissions (v2 + pipelines) |
| `GET` | `/__parlel/pipeline-events` | Captured Pipelines API events |

---

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| All `TrackClient` methods | ✅ Supported |
| All `APIClient` methods | ✅ Supported |
| All `PipelinesClient` methods | ✅ Supported |
| Basic / Bearer auth enforcement | ✅ Supported (presence-checked) |
| Customer.io `meta.error` / `meta.errors` error envelopes | ✅ Supported |
| State capture + reset for assertions | ✅ Supported |
| US/EU region selection | ➖ N/A — point `url` at this server directly |
| Real credential validation (verifies site/app/write keys) | ✓ By design — Intentional for a local, zero-cost test emulator |
| Liquid template rendering for transactional messages | ⟳ Roadmap — payload captured verbatim |
| Real campaign execution / journeys / segmentation engine | ⟳ Roadmap |
| Webhooks / reporting metrics / actual delivery | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Client retry/backoff behavior | ➖ Handled entirely client-side; the fake returns deterministic 2xx/4xx |

---

## Error codes & shapes

Errors use the Customer.io envelope that `customerio-node`'s `CustomerIORequestError.composeMessage` understands:

- Single error: `{ "meta": { "error": "message" } }`
- Multiple errors: `{ "meta": { "errors": ["message", ...] } }`

| Status | When |
| --- | --- |
| `200` | Successful Track / App / Pipelines operation |
| `204` | CORS preflight (`OPTIONS`) |
| `400` | Validation failure (missing `name`, missing `device.id`, empty batch, missing `filters`/`newsletter_id`, missing transactional fields, invalid JSON body) |
| `401` | Missing/!malformed `Authorization` header (Basic for Track/Pipelines, Bearer for App) |
| `404` | Unknown path, unknown customer (`getAttributes`), unknown export, unknown delivery |
| `405` | Method not allowed on a known resource |
| `500` | Unexpected internal error |

Successful responses mirror the real API where the client reads them:

- Transactional sends return `{ "delivery_id": "...", "queued": true }`.
- `getCustomersByEmail` returns `{ "results": [...] }`.
- `getAttributes` returns `{ "customer": { ... } }`.
- Exports return `{ "export": { ... } }` (and `listExports` returns `{ "exports": [...] }`).
- Pipelines operations return `{ "success": true }`.
- Track operations return `{}`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CUSTOMERIO_SITE_ID=parlel-site-id
CUSTOMERIO_API_KEY=parlel-api-key
CUSTOMERIO_APP_KEY=parlel-app-key
CUSTOMERIO_TRACK_URL=http://localhost:4668/api/v1
CUSTOMERIO_API_URL=http://localhost:4668/v1
CUSTOMERIO_PIPELINES_URL=http://localhost:4668/v1
```

<!-- parlel:testenv:end -->
