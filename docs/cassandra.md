# Cassandra

Lightweight, dependency-free Cassandra emulator speaking the native CQL binary
protocol (v4).

| Key | Value |
|-----|-------|
| Port | 9042 |
| Protocol | CQL native (TCP) |
| Size | ~90 KB |
| Startup | < 300ms |

## Default Connection

```
cassandra://localhost:9042
```

No auth required.

## Supported CQL

| Statement | Notes |
|-----------|-------|
| `CREATE KEYSPACE [IF NOT EXISTS] <ks>` | Registers a keyspace |
| `USE <ks>` | Accepted |
| `CREATE TABLE [IF NOT EXISTS] <ks>.<t> (...)` | Columns + types parsed |
| `INSERT INTO <ks>.<t> (cols) VALUES (...)` | Row insert |
| `SELECT <cols>\|* FROM <ks>.<t>` | Returns matching rows |
| `SELECT release_version` | Returns `4.0.0` |

## Usage

with an **unmodified** `cassandra-driver` — no Parlel code in the app.

```bash

```

```typescript
import { Client } from "cassandra-driver";

// Unmodified real driver, pointed at the bridge hostname
// (or `localhost` if you run the bridge outside Docker and publish ports)
const client = new Client({
  contactPoints: ["localhost:9042"],
  localDataCenter: "datacenter1",
});
await client.execute("CREATE KEYSPACE app WITH replication = {'class':'SimpleStrategy','replication_factor':1}");
await client.execute("CREATE TABLE app.users (id int PRIMARY KEY, name text)");
await client.execute("INSERT INTO app.users (id, name) VALUES (1, 'Ada')");
const rs = await client.execute("SELECT * FROM app.users");
```

## Access via MCP (Parlel Sandbox)

Cassandra runs as a TCP service inside a Parlel sandbox; drive CQL through the
sandbox MCP endpoint with `parlel_execute` (statements separated by `;`):

```json
{
  "service": "cassandra",
  "command": "CREATE KEYSPACE app; CREATE TABLE app.users (id int, name text); INSERT INTO app.users (id, name) VALUES (1, 'Ada'); SELECT * FROM app.users;"
}
```

Each statement returns `{ statement, fields, rows }`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Keyspaces / tables / insert / select | Supported |
| WHERE / clustering / secondary indexes | Not evaluated |
| Prepared statements / batches | Accepted, simplified |
| Auth / TLS | Not required / not supported |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CASSANDRA_CLUSTER_NAME=parlel-cluster
CASSANDRA_DC=datacenter1
```

<!-- parlel:testenv:end -->
