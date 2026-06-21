# Mercury

Lightweight, dependency-free, in-memory Mercury banking API fake for testing code
that uses the Mercury REST API.

Default port: `4875`

## Quick start

```js
import { MercuryServer } from "./services/mercury/src/server.js";

const server = new MercuryServer(4875);
await server.start();
// ... run your app/tests ...
await server.stop();
```

All API routes require an `Authorization: Bearer <token>` header (any non-empty
value accepted):

```js
const res = await fetch("http://127.0.0.1:4875/api/v1/accounts", {
  headers: { Authorization: "Bearer secret-token" },
});
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4875`) and through the parlel MCP
server as the `mercury` tool. Set `MERCURY_BASE_URL=http://127.0.0.1:4875` and any
non-empty `MERCURY_API_TOKEN`.

## Implemented operations

- `GET /api/v1/accounts` — list accounts (`{ accounts: [...] }`; checking + savings seeded).
- `GET /api/v1/accounts/:id` — retrieve a single account.
- `GET /api/v1/account/:id/transactions` — `{ total, transactions: [...] }`.
- `POST /api/v1/account/:id/request-send-money` (alias `/transactions`) — initiate a transfer; debits `availableBalance`.
- `GET /api/v1/recipients` — list payment recipients.
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

## Account shape

```json
{
  "id": "uuid",
  "name": "Parlel Checking",
  "accountNumber": "204529912345",
  "routingNumber": "084106768",
  "availableBalance": 25000.0,
  "currentBalance": 25000.0,
  "kind": "checking",
  "type": "mercury",
  "status": "active"
}
```

## Error envelope

```json
{ "errors": { "message": "..." } }
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Accounts list / get | ✅ Supported |
| Transactions list | ✅ Supported |
| Send money (request-send-money) | ✅ Supported (debits available balance) |
| Recipients list | ✅ Supported |
| Bearer auth | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Real money movement / settlement | ✓ By design — Always succeeds deterministically — no real funds move |
| Statements / cards / treasury | ⟳ Roadmap |
| Webhooks | ⟳ Roadmap |

## Manifest

See `services/mercury/manifest.json` — name `mercury`, port `4875`, protocol
`http`, healthcheck `/health`, env `MERCURY_API_TOKEN`, `MERCURY_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MERCURY_API_TOKEN=parlel
MERCURY_BASE_URL=http://localhost:4875
```

<!-- parlel:testenv:end -->
