# SQLite

Lightweight in-process SQLite emulator with a `better-sqlite3`-style synchronous
API.

| Key | Value |
|-----|-------|
| Protocol | Embedded (in-process) |
| Size | small |

> **Note:** SQLite is **embedded** (in-process), not a network service. Unlike

> hostname — there is nothing to connect to over the network. It is exercised
> inside a sandbox directly by your app (or via MCP), as an in-process file DB.

## Supported SQL

| Statement | Notes |
|-----------|-------|
| `CREATE TABLE` / `DROP TABLE` | DDL |
| `INSERT` | Row insert |
| `SELECT` / `SELECT ... WHERE` | Query |
| `UPDATE` | Update rows |
| `DELETE` | Delete rows |
| Prepared statements | `.prepare(sql).all()` / `.run()` |

## Usage Examples

SQLite runs in-process with a `better-sqlite3`-style synchronous API. Inside a
sandbox, your app uses it directly as an embedded file DB — there is no network
connection to establish.

```typescript
import Database from "better-sqlite3";

const db = new Database(":memory:");
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

const insert = db.prepare("INSERT INTO users (name) VALUES (?)");
insert.run("Ada");

const rows = db.prepare("SELECT * FROM users WHERE name = ?").all("Ada");
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| CRUD + prepared statements | Supported |
| Network access (port / sandbox) | Not available — in-process only |
| JOINs / transactions / advanced SQL | Simplified |
