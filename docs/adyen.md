# Adyen

Lightweight, dependency-free, in-memory Adyen **Checkout API v71** fake for testing
code that uses the Adyen Checkout API.

Default port: `4869`

## Quick start

```js
import { AdyenServer } from "./services/adyen/src/server.js";

const server = new AdyenServer(4869);
await server.start();
// ... run your app/tests ...
await server.stop();
```

All API routes require an `X-API-Key` header (any non-empty value accepted):

```js
const res = await fetch("http://127.0.0.1:4869/v71/payments", {
  method: "POST",
  headers: { "X-API-Key": "parlel", "Content-Type": "application/json" },
  body: JSON.stringify({
    amount: { currency: "EUR", value: 1000 },
    reference: "order-123",
    paymentMethod: { type: "scheme" },
    merchantAccount: "ParlelECOM",
  }),
});
// => { resultCode: "Authorised", pspReference, merchantReference, amount }
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4869`) and through the parlel MCP
server as the `adyen` tool. Set `ADYEN_BASE_URL=http://127.0.0.1:4869`,
`ADYEN_MERCHANT_ACCOUNT`, and any non-empty `ADYEN_API_KEY`.

## Implemented operations

- `POST /v71/payments` → `{ resultCode: "Authorised", pspReference, merchantReference, amount, ... }`.
- `POST /v71/payments/details` → finalise a redirect/3DS flow → `{ resultCode, pspReference }`.
- `POST /v71/paymentMethods` → list available payment methods for a merchant.
- `POST /v71/payments/:pspReference/cancels` → `201 { paymentPspReference, pspReference, status: "received" }`.
- `POST /v71/payments/:pspReference/captures` → `201 { amount, merchantAccount, paymentPspReference, pspReference, status: "received" }`.
- `POST /v71/payments/:pspReference/refunds` → `201 { amount, merchantAccount, paymentPspReference, pspReference, status: "received" }`.
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

## Error envelope

```json
{ "status": 422, "errorCode": "702", "message": "...", "errorType": "validation", "pspReference": "..." }
```

Missing `X-API-Key` returns `401 { status: 401, errorCode: "000", message: "HTTP Status Response - Unauthorized", errorType: "security" }`.

Per-field validation codes: `130` (reference missing), `14_030` (return URL missing).
Malformed JSON body returns `400 { errorCode: "702", errorType: "validation" }`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `/payments` authorise | ✅ Supported (always `Authorised`) |
| `/payments/details` | ✅ Supported |
| `/paymentMethods` | ✅ Supported |
| `/payments/:psp/cancels` | ✅ Supported |
| `/payments/:psp/captures` | ✅ Supported |
| `/payments/:psp/refunds` | ✅ Supported |
| `X-API-Key` header auth | ✓ By design — Intentional for a local, zero-cost test emulator |
| Real card processing / 3DS challenges | ✓ By design — Always succeeds deterministically — no real funds move |
| Webhooks (notifications) | ⟳ Roadmap |
| HMAC signature validation | ✓ By design — Not enforced |

## Manifest

See `services/adyen/manifest.json` — name `adyen`, port `4869`, protocol `http`,
healthcheck `/health`, env `ADYEN_API_KEY`, `ADYEN_MERCHANT_ACCOUNT`,
`ADYEN_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ADYEN_API_KEY=parlel
ADYEN_MERCHANT_ACCOUNT=ParlelECOM
ADYEN_BASE_URL=http://localhost:4869
```

<!-- parlel:testenv:end -->
