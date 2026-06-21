# Snowflake

Lightweight, dependency-free, in-memory Snowflake SQL API v2 fake for testing code that issues SQL over the Snowflake REST SQL API. Includes a **minimal real SQL engine** (CREATE TABLE / INSERT / SELECT \*) so round-trips actually persist and return your rows.

Default port: `4811`

## Quick start

```js
import { SnowflakeServer } from "./services/snowflake/src/server.js";

const server = new SnowflakeServer(4811);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Execute SQL via the v2 statements endpoint:

```js
const res = await fetch("http://127.0.0.1:4811/api/v2/statements", {
  method: "POST",
  headers: { Authorization: "Bearer parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ statement: "SELECT * FROM users" }),
});
const { resultSetMetaData, data } = await res.json();
// data is an array-of-arrays, e.g. [["1","Alice","true"], ...]
```

State is in-memory and ephemeral.

## Implemented operations

Authentication is via `Authorization: Bearer <token>`; any non-empty bearer token is accepted.

### SQL statements

- `POST /api/v2/statements` — execute a SQL statement (`{ statement: "..." }`). Returns the Snowflake response envelope `{ resultSetMetaData: { rowType, numRows, ... }, data: [[...]], code, statementHandle, sqlState, message, ... }`. All cell values in `data` are stringified, matching Snowflake.
- `GET /api/v2/statements/:handle` — retrieve a prior statement's result by `statementHandle`.

### SQL engine

A minimal but real engine backs the statements endpoint:

- `CREATE TABLE name (col TYPE, ...)` — declares columns; supports `IF NOT EXISTS` / `OR REPLACE`. Types are mapped to Snowflake column types (`FIXED`, `REAL`, `BOOLEAN`, `TEXT`).
- `INSERT INTO name [(cols)] VALUES (...), (...)` — inserts one or more tuples; columns may be implicit (positional) or explicit. String, integer, float, boolean and `NULL` literals are parsed; embedded commas inside `'...'` are handled.
- `SELECT * FROM name` — returns all rows as an array-of-arrays with `rowType` metadata.
- `DROP TABLE name` — drops a table.

Unsupported statements / projections return a `422` with a Snowflake-style `code`/`message`/`sqlState`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state (tables + statement cache).
- `GET /__parlel/history` — list executed statements.
- `GET /__parlel/tables` — list tables with column metadata and row counts.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool, the service is reachable at its preview URL (host/port shown by the pool); point your SQL API base URL at it. Through the parlel MCP server, `POST /api/v2/statements` is exposed as a tool surface so an AI agent can run SQL and read the array-of-arrays result without a Snowflake account.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `POST /api/v2/statements` (execute) | ✅ Supported |
| `GET /api/v2/statements/:handle` (result by handle) | ✅ Supported |
| `CREATE TABLE` / `INSERT` / `SELECT *` / `DROP TABLE` | ✅ Supported (real in-memory engine) |
| Snowflake array-of-arrays `data` + `resultSetMetaData.rowType` | ✅ Supported |
| `WHERE` / `JOIN` / aggregates / projections other than `*` | ⟳ Roadmap — **rejected with a `422` SQL compilation error, never silently wrong rows** |
| Async statements / partitioned result retrieval | ◐ Single-partition synchronous results only |
| Bind variables (`bindings`) | ⟳ Roadmap — Not interpolated |
| Real warehouses / roles / databases | ⟳ Roadmap — Single implicit `PARLEL.PUBLIC` namespace |
| Bearer-token validity check | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Manifest

See `services/snowflake/manifest.json`:

- name: `snowflake`, image: `parlel/snowflake:1.0`
- port: `4811`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `SNOWFLAKE_TOKEN`, `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SNOWFLAKE_TOKEN=parlel
SNOWFLAKE_ACCOUNT=parlel
SNOWFLAKE_HOST=http://localhost:4811
SNOWFLAKE_BASE_URL=http://localhost:4811
```

<!-- parlel:testenv:end -->
