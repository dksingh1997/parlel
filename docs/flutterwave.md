# Flutterwave

Lightweight, dependency-free, in-memory Flutterwave **API v3** fake for testing
code that uses the Flutterwave payments API.

Default port: `4874`

## Quick start

```js
import { FlutterwaveServer } from "./services/flutterwave/src/server.js";

const server = new FlutterwaveServer(4874);
await server.start();
// ... run your app/tests ...
await server.stop();
```

All API routes require an `Authorization: Bearer <secret-key>` header (any
non-empty value accepted):

```js
const res = await fetch("http://127.0.0.1:4874/v3/payments", {
  method: "POST",
  headers: { Authorization: "Bearer FLWSECK_TEST-parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ tx_ref: "ref-123", amount: 5000, currency: "NGN", customer: { email: "buyer@parlel.dev" } }),
});
// => { status: "success", message: "Hosted Link", data: { link } }
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4874`) and through the parlel MCP
server as the `flutterwave` tool. Set `FLUTTERWAVE_BASE_URL=http://127.0.0.1:4874`
and any non-empty `FLUTTERWAVE_SECRET_KEY`.

## Implemented operations

- `POST /v3/payments` — initiate a payment → `{ status: "success", message, data: { link } }`.
- `GET /v3/transactions/:id/verify` — verify a transaction → `{ status, message, data: { status: "successful", amount, ... } }`.
- `POST /v3/transfers` / `GET /v3/transfers` / `GET /v3/transfers/:id` — manage transfers.
- `GET /v3/banks/:country` — list banks for a country code.
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

## Response envelope

```json
{ "status": "success", "message": "...", "data": { ... } }
```

Errors use `{ "status": "error", "message": "...", "data": null }`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Payment initiation (hosted link) | ✅ Supported |
| Transaction verification | ✅ Supported (always `successful`) |
| Transfers create / list / get | ✅ Supported |
| Banks list | ✅ Supported |
| Bearer auth | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Real charge / settlement / payout processing | ✓ By design — Always succeeds deterministically — no real funds move |
| Webhooks / encryption (3DES) / OTP charge flow | ✓ By design — Always succeeds deterministically — no real funds move |

## Manifest

See `services/flutterwave/manifest.json` — name `flutterwave`, port `4874`,
protocol `http`, healthcheck `/health`, env `FLUTTERWAVE_SECRET_KEY`,
`FLUTTERWAVE_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FLUTTERWAVE_SECRET_KEY=parlel
FLUTTERWAVE_BASE_URL=http://localhost:4874
```

<!-- parlel:testenv:end -->
