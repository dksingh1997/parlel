# Cloudflare

Lightweight, dependency-free, in-memory Cloudflare API v4 fake for testing code that uses the `cloudflare` Node SDK or the raw Cloudflare REST API.

Default port: `4772`

## Quick start

```js
import { CloudflareServer } from "./services/cloudflare/src/server.js";

const server = new CloudflareServer(4772);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const res = await fetch("http://127.0.0.1:4772/client/v4/user", {
  headers: { Authorization: "Bearer cf_parlel" },
});
const { result } = await res.json();
// result.email => "parlel-user@parlel.dev"
```

## Access via MCP / preview URL

- REST base URL: `http://127.0.0.1:4772/client/v4`
- Set `CLOUDFLARE_API_TOKEN=cf_parlel` and `CLOUDFLARE_API_URL=http://127.0.0.1:4772/client/v4`.

Auth: `Authorization: Bearer <token>` **or** the legacy `X-Auth-Key` + `X-Auth-Email` header pair.

## Implemented operations

Every response uses the Cloudflare envelope `{ success, errors, messages, result, result_info? }`. State is in-memory and ephemeral.

- `GET /client/v4/user` — current user.
- `GET /client/v4/zones` — list zones (with `result_info`).
- `POST /client/v4/zones` — create zone (requires `name`).
- `GET /client/v4/zones/:id` — retrieve a zone.
- `PATCH /client/v4/zones/:id` — pause/unpause.
- `DELETE /client/v4/zones/:id` — delete (returns `{ id }`).
- `GET /client/v4/zones/:id/dns_records` — list DNS records (with `result_info`).
- `POST /client/v4/zones/:id/dns_records` — create record (requires `type`, `name`, `content`).
- `GET /client/v4/zones/:id/dns_records/:rid` — retrieve.
- `PUT/PATCH /client/v4/zones/:id/dns_records/:rid` — update.
- `DELETE /client/v4/zones/:id/dns_records/:rid` — delete (returns `{ id }`).

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/zones` — list zone ids.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /user` | ✅ Supported |
| Zones list / create / get / patch / delete | ✅ Supported |
| DNS records CRUD | ✅ Supported |
| `{ success, errors, messages, result, result_info }` envelope | ✅ Supported |
| Bearer or `X-Auth-Key`/`X-Auth-Email` auth | ✅ Required |
| Workers / R2 / KV / Pages / Firewall | ⟳ Roadmap |
| Real DNS resolution / zone activation | ⟳ Roadmap — Zones are instantly `active` |
| Token scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Cloudflare failure envelope: `{ "success": false, "errors": [{ "code", "message" }], "messages": [], "result": null }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid authentication |
| `400` | validation failed (missing `name`/record fields) |
| `404` | unknown zone/record |
| `405` | method not allowed |

## Manifest

See `services/cloudflare/manifest.json`:

- name: `cloudflare`, image: `parlel/cloudflare:1`
- port: `4772`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CLOUDFLARE_API_TOKEN=cf_parlel
CLOUDFLARE_API_URL=http://localhost:4772/client/v4
```

<!-- parlel:testenv:end -->
