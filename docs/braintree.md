# Braintree

Lightweight, dependency-free, in-memory Braintree **GraphQL** API fake for testing
code that talks to Braintree's modern GraphQL endpoint.

Default port: `4868`

## Quick start

```js
import { BraintreeServer } from "./services/braintree/src/server.js";

const server = new BraintreeServer(4868);
await server.start();
// ... run your app/tests ...
await server.stop();
```

All requests go to the single GraphQL endpoint and require a bearer
`Authorization` header (any non-empty token accepted):

```js
const res = await fetch("http://127.0.0.1:4868/graphql", {
  method: "POST",
  headers: {
    Authorization: "Bearer parlel",
    "Content-Type": "application/json",
    "Braintree-Version": "2019-01-01",
  },
  body: JSON.stringify({ query: "query { ping }" }),
});
// => { data: { ping: "pong" } }
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4868/graphql`) and through the
parlel MCP server as the `braintree` tool. Set
`BRAINTREE_BASE_URL=http://127.0.0.1:4868` and any non-empty `BRAINTREE_API_KEY`.

## Implemented operations (GraphQL dispatch by top-level field)

The server parses the incoming query to find the top-level field and routes it:

- `ping` → `{ data: { ping: "pong" } }`.
- `chargeCreditCard(input)` → `{ data: { chargeCreditCard: { transaction { id, status, amount } } } }`.
- `createCustomer(input)` → `{ data: { createCustomer: { customer { id, email, ... } } } }`.
- `transaction(id)` → `{ data: { transaction { ... } } }` (or `null`).
- `customer(id)` → `{ data: { customer { ... } } }` (or `null`).

Unknown fields return a GraphQL `422 { errors: [{ message: "Cannot query field ..." }] }`.

`GET /` / `GET /health` / `POST /__parlel/reset` provide service + control endpoints.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| GraphQL dispatch (ping, charge, customer, transaction) | ✅ Supported |
| `{ data }` / `{ errors }` GraphQL envelope | ✅ Supported |
| Bearer / Basic auth | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Full GraphQL schema validation / introspection | ⟳ Roadmap — Top-level field dispatch only |
| Legacy XML/REST API | ⟳ Roadmap — GraphQL surface only |
| Real settlement / payouts | ⟳ Roadmap — Status stays `SUBMITTED_FOR_SETTLEMENT` |

## Manifest

See `services/braintree/manifest.json` — name `braintree`, port `4868`,
protocol `http`, healthcheck `/health`, env `BRAINTREE_API_KEY`,
`BRAINTREE_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
BRAINTREE_API_KEY=parlel
BRAINTREE_BASE_URL=http://localhost:4868
```

<!-- parlel:testenv:end -->
