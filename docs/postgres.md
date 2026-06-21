# Postgres

Lightweight in-memory Postgres implementation speaking the real wire protocol.

| Key | Value |
|-----|-------|
| Port | 5432 |
| Protocol | Wire protocol (TCP) |
| Size | ~80 KB |
| Startup | < 200ms |

## Default Connection

```
postgresql://parlel:parlel@localhost:5432/parlel
```

| Parameter | Value |
|-----------|-------|
| User | `parlel` |
| Password | `parlel` |
| Database | `parlel` |

## Supported SQL

### DDL

```sql
-- Create table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  age INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create view
CREATE VIEW active_users AS SELECT * FROM users WHERE active = true;

-- Create index
CREATE INDEX idx_users_email ON users (email);
CREATE UNIQUE INDEX idx_users_email_unique ON users (email);

-- Create sequence
CREATE SEQUENCE order_id_seq START 1000;

-- Create function (accepted, not executed)
CREATE FUNCTION update_timestamp() RETURNS TRIGGER AS $$ BEGIN ... END; $$ LANGUAGE plpgsql;
```

### DML — INSERT

```sql
INSERT INTO users (email, name) VALUES ('alice@test.com', 'Alice');
INSERT INTO users (email, name, age) VALUES ('bob@test.com', 'Bob', 30);

-- RETURNING
INSERT INTO users (email, name) VALUES ('charlie@test.com', 'Charlie') RETURNING *;
INSERT INTO users (email, name) VALUES ('dave@test.com', 'Dave') RETURNING id;
```

### DML — SELECT

```sql
SELECT * FROM users;
SELECT name, email FROM users;
SELECT * FROM users WHERE id = 1;
SELECT * FROM users WHERE email = 'alice@test.com';
SELECT * FROM users WHERE age > 25;
SELECT * FROM users WHERE name LIKE 'A%';
SELECT * FROM users WHERE active = true;

-- Aggregates
SELECT COUNT(*) FROM users;
SELECT COUNT(*) as total FROM users WHERE active = true;

-- Sorting
SELECT * FROM users ORDER BY name ASC;
SELECT * FROM users ORDER BY created_at DESC;

-- Limit
SELECT * FROM users LIMIT 10;
SELECT * FROM users LIMIT 10 OFFSET 5;

-- IN
SELECT * FROM users WHERE id IN (1, 2, 3);

-- BETWEEN
SELECT * FROM users WHERE age BETWEEN 20 AND 30;

-- JOINs (inner equi-join: `FROM a x JOIN b y ON a.c = b.d`)
SELECT u.name, o.total
FROM users u
JOIN orders o ON u.id = o.user_id;

-- Subqueries
SELECT * FROM users WHERE id IN (SELECT user_id FROM orders);
```

### DML — UPDATE

```sql
UPDATE users SET name = 'Alice Updated' WHERE id = 1;
UPDATE users SET age = age + 1 WHERE active = true;
UPDATE users SET name = 'New Name', email = 'new@test.com' WHERE id = 5;
```

### DML — DELETE

```sql
DELETE FROM users WHERE id = 1;
DELETE FROM users WHERE active = false;
DELETE FROM orders WHERE user_id = 1;
```

### Sequences

```sql
SELECT NEXTVAL('order_id_seq');
SELECT CURRVAL('order_id_seq');
SELECT SETVAL('order_id_seq', 2000);
```

### System Queries

```sql
SELECT 1;
SELECT version();
SELECT current_database();
SELECT current_user;

-- Information schema introspection (minimal read-only catalog)
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users';
```

`information_schema.columns` reports SQL-standard `data_type` names (`integer`,
`bigint`, `boolean`, `text`, `numeric`, `timestamp without time zone`, `date`,
`jsonb`, `uuid`, …) derived from the declared column types.

### Transactions

```sql
BEGIN;
INSERT INTO users (email, name) VALUES ('tx@test.com', 'TX User');
COMMIT;

BEGIN;
INSERT INTO users (email, name) VALUES ('rollback@test.com', 'Rollback');
ROLLBACK;
```

## Usage

code in your app.

Run it:

```bash

```

Then connect with your normal client. Python:

```python
import psycopg

conn = psycopg.connect("postgres://parlel:parlel@localhost:5432/parlel")
with conn.cursor() as cur:
    cur.execute("CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT)")
    cur.execute("INSERT INTO items (name) VALUES (%s)", ["Widget"])
    cur.execute("SELECT * FROM items")
    print(cur.fetchall())
```

Node:

```javascript
import pg from "pg";

const pool = new pg.Pool({

  port: 5432,
  user: "parlel",
  password: "parlel",
  database: "parlel",
});

await pool.query("CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT)");
await pool.query("INSERT INTO items (name) VALUES ($1)", ["Widget"]);
const { rows } = await pool.query("SELECT * FROM items");
```

### Via MCP (Parlel Sandbox)

When Postgres runs inside a Parlel sandbox, drive it through the sandbox's MCP
endpoint with `parlel_execute`. Pass raw SQL as `command` (multiple statements
may be separated by `;`):

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "parlel_execute",
    "arguments": {
      "service": "postgres",
      "command": "CREATE TABLE t (id int, name text); INSERT INTO t VALUES (1, 'Ada'); SELECT * FROM t;"
    }
  }
}
```

Each statement returns `{ statement, tag, fields, rows, error }`.

## Seed Data

```sql
-- schema.sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'user'
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT,
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (email, name, role) VALUES ('admin@test.com', 'Admin', 'admin');
INSERT INTO users (email, name) VALUES ('alice@test.com', 'Alice');
INSERT INTO users (email, name) VALUES ('bob@test.com', 'Bob');

INSERT INTO posts (user_id, title, body, published) VALUES (1, 'First Post', 'Hello world', true);
INSERT INTO posts (user_id, title, body) VALUES (2, 'Draft', 'Work in progress');
```

Seed via MCP `parlel_execute`, or run these against the bridge with your normal client.

## Access via Parlel Sandbox

`localhost:5432`. It tunnels the raw Postgres wire protocol as TCP over the

connects to `postgresql://parlel:parlel@localhost:5432/parlel` unmodified —

Postgres and Redis start by default in a new sandbox.

## Error codes & shapes

Errors are returned as a real Postgres `ErrorResponse` message with the
`S` (severity), `V` (non-localized severity), `C` (SQLSTATE), and `M` (message)
fields, so drivers like `pg` and `psycopg` populate `err.code` / `err.severity`
exactly as they would against real Postgres. Branch on the SQLSTATE, not the text:

| Scenario | SQLSTATE | Example message |
|----------|----------|-----------------|
| Missing relation (`SELECT … FROM missing`) | `42P01` (`undefined_table`) | `relation "missing" does not exist` |
| Undefined column (in a JOIN) | `42703` (`undefined_column`) | `column does not exist` |
| Syntax / unsupported statement | `42601` (`syntax_error`) | `syntax error at or near "…"` |
| Window functions (`OVER (...)`) | `0A000` (`feature_not_supported`) | `window functions are not supported by the parlel postgres emulator` |
| Missing sequence (`nextval`) | `42P01` | `sequence "x" does not exist` |

```js
try {
  await client.query("INVALID SQL");
} catch (err) {
  err.code;     // "42601"
  err.severity; // "ERROR"
}
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Wire protocol v3 (startup, auth, simple + extended query, `$n` params) | ✅ Supported |
| CRUD (`INSERT`/`SELECT`/`UPDATE`/`DELETE`, `RETURNING`) | ✅ Supported |
| `WHERE` with numeric-aware `=` `<>` `<` `>` `<=` `>=`, `AND`/`OR` | ✅ Supported |
| `IN (...)`, `IN (subquery)`, `NOT IN`, `BETWEEN`, `LIKE`/`ILIKE`, `IS [NOT] NULL` | ✅ Supported |
| `ORDER BY` (numeric + text, `ASC`/`DESC`, multi-key), `LIMIT`, `OFFSET`, `DISTINCT` | ✅ Supported |
| Aggregates `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` with `GROUP BY` and `HAVING` | ✅ Supported |
| `JOIN` — inner equi-join (`FROM a x JOIN b y ON a.c = b.d`) | ✅ Supported |
| `LEFT`/`RIGHT`/`FULL` JOIN | ⟳ Roadmap |
| Set ops `UNION` / `INTERSECT` / `EXCEPT` | ✅ Supported |
| CTEs (`WITH name AS (...) SELECT ...`, multiple CTEs) | ✅ Supported |
| `information_schema.tables` / `.columns` introspection | ✅ Supported (minimal read-only catalog) |
| Error envelope — SQLSTATE (`42P01`/`42703`/`42601`/`0A000`) + `S`/`V`/`C`/`M` fields | ✅ Supported |
| Sequences (`nextval`/`currval`/`setval`, `SERIAL`) | ✅ Supported |
| Transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) | ◐ Accepted — `ROLLBACK` does **not** revert state (no MVCC) |
| Views | ◐ Stored; queryable as snapshots |
| Indexes | ◐ Accepted (no physical effect — results are always correct) |
| Authentication | ✓ By design — trust auth; any password is accepted for the configured user |
| Window functions (`OVER (...)`) | ⟳ Roadmap — **returns an explicit `0A000` error, never wrong rows** |
| Stored procedures / triggers | ⟳ Roadmap — DDL accepted; bodies not executed |
| JSON/JSONB operators (`->`, `->>`, `@>`) | ⟳ Roadmap |
| Array types / full-text search (`tsvector`) | ⟳ Roadmap |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
POSTGRES_USER=parlel
POSTGRES_PASSWORD=parlel
POSTGRES_DB=parlel
```

<!-- parlel:testenv:end -->
