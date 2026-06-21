# Wise (TransferWise)

Lightweight, dependency-free, in-memory Wise API fake for testing code that uses the Wise REST API.

Default port: `4867`

## Quick start

```js
import { WiseServer } from "./services/wise/src/server.js";

const server = new WiseServer(4867);
await server.start();
// ... run your app/tests ...
await server.stop();
```

All API routes require an `Authorization: Bearer <token>` header (any non-empty
token is accepted).

```js
const res = await fetch("http://127.0.0.1:4867/v1/quotes", {
  method: "POST",
  headers: { Authorization: "Bearer parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ profile: 1, source: "USD", target: "EUR", sourceAmount: 100 }),
});
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4867`) and through the parlel MCP
server as the `wise` tool. Set `WISE_BASE_URL=http://127.0.0.1:4867` and any
non-empty `WISE_API_TOKEN`.

## Implemented operations

- `GET /v1/profiles` — list personal + business profiles.
- `POST /v1/quotes` — create a quote → `{ id, source, target, rate, sourceAmount, targetAmount, ... }`.
- `GET /v1/quotes/:id` — retrieve a quote.
- `POST /v1/transfers` — create a transfer (requires `targetAccount` + quote).
- `GET /v1/transfers` / `GET /v1/transfers/:id` — list / retrieve transfers.
- `GET /v1/accounts` — list recipient accounts.
- `GET /v1/borderless-accounts?profileId=` — multi-currency balances per profile.
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Profiles / quotes / transfers / accounts / balances | ✅ Supported |
| Bearer auth | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Funding a transfer / actual money movement | ✓ By design — Always succeeds deterministically — no real funds move |
| Live FX rates | ✓ By design — Intentional for a local, zero-cost test emulator |
| Webhooks / SCA | ✓ By design — Always succeeds deterministically — no real funds move |

## Manifest

See `services/wise/manifest.json` — name `wise`, port `4867`, protocol `http`,
healthcheck `/health`, env `WISE_API_TOKEN`, `WISE_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
WISE_API_TOKEN=parlel
WISE_BASE_URL=http://localhost:4867
```

<!-- parlel:testenv:end -->
