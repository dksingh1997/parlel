# Plaid

Lightweight, dependency-free, in-memory Plaid API fake for testing code that uses the official `plaid` Node client (and the language-agnostic Plaid REST API).

Default port: `4866`

## Quick start

```js
import { PlaidServer } from "./services/plaid/src/server.js";

const server = new PlaidServer(4866);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the official `plaid` client at it via the base URL:

```js
import { Configuration, PlaidApi } from "plaid";

const client = new PlaidApi(new Configuration({
  basePath: "http://127.0.0.1:4866",
  baseOptions: { headers: { "PLAID-CLIENT-ID": "parlel", "PLAID-SECRET": "parlel" } },
}));
```

Auth is via `client_id` + `secret` in the JSON request body (any non-empty values are accepted, matching a local sandbox key).

## Access via MCP / preview URL

Once registered in the parlel pool, the service is reachable at its preview URL
(`http://127.0.0.1:4866`) and through the parlel MCP server as the `plaid` tool.
Set `PLAID_BASE_URL=http://127.0.0.1:4866` and any non-empty `PLAID_CLIENT_ID` /
`PLAID_SECRET`. The MCP layer proxies the REST calls below verbatim.

## Implemented operations

- `POST /link/token/create` — create a Link token → `{ link_token, expiration, request_id }`.
- `POST /item/public_token/exchange` — exchange a public token → `{ access_token, item_id, request_id }`.
- `POST /accounts/get` (and `/accounts/balance/get`) — `{ accounts: [{ account_id, balances: { available, current }, name, type, subtype }], item, request_id }`.
- `POST /transactions/get` — `{ accounts, transactions, total_transactions, item, request_id }`.
- `POST /auth/get` — `{ accounts, numbers: { ach: [...] }, item, request_id }`.
- `POST /identity/get` — `{ accounts: [{ ..., owners }], item, request_id }`.
- `POST /item/get` — `{ item, status, request_id }`.
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

## Error envelope

```json
{
  "error_type": "INVALID_INPUT",
  "error_code": "INVALID_ACCESS_TOKEN",
  "error_message": "...",
  "display_message": null,
  "request_id": "..."
}
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Link token create / public-token exchange | ✅ Supported |
| Accounts / balances / transactions / auth / identity | ✅ Supported |
| Item retrieval | ✅ Supported |
| `client_id` + `secret` body auth | ✓ By design — Intentional for a local, zero-cost test emulator |
| Real bank data / live institutions | ✓ By design — Always succeeds deterministically — no real funds move |
| Webhooks / async updates | ✓ By design — Not emitted |
| Asset reports / income / investments | ⟳ Roadmap |

## Manifest

See `services/plaid/manifest.json` — name `plaid`, port `4866`, protocol `http`,
healthcheck `/health`, env `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PLAID_CLIENT_ID=parlel
PLAID_SECRET=parlel
PLAID_BASE_URL=http://localhost:4866
```

<!-- parlel:testenv:end -->
