# MySQL

Lightweight in-memory MySQL implementation speaking the real wire protocol.

| Key | Value |
|-----|-------|
| Port | 3306 |
| Protocol | Wire protocol (TCP) |
| Size | ~90 KB |
| Startup | < 200ms |

## Default Connection

```
mysql://parlel:parlel@localhost:3306/parlel
```

| Parameter | Value |
|-----------|-------|
| User | `parlel` |
| Password | `parlel` |
| Database | `parlel` |

## Supported SQL

### DDL

```sql
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  age INT DEFAULT 0,
  active BOOLEAN DEFAULT true
);

ALTER TABLE users ADD COLUMN role VARCHAR(50);
ALTER TABLE users DROP COLUMN role;
CREATE INDEX idx_users_email ON users (email);
CREATE UNIQUE INDEX idx_users_email_unique ON users (email);
DROP INDEX idx_users_email ON users;
TRUNCATE TABLE users;
DROP TABLE users;
```

### DML

```sql
INSERT INTO users (email, name) VALUES ('alice@test.com', 'Alice');
INSERT INTO users (email, name, age) VALUES ('bob@test.com', 'Bob', 30);

SELECT * FROM users;
SELECT name, email FROM users;
SELECT * FROM users WHERE id = 1;
SELECT * FROM users WHERE age > 25;
SELECT * FROM users WHERE name LIKE 'A%';
SELECT COUNT(*) FROM users;
SELECT * FROM users ORDER BY name ASC;
SELECT * FROM users LIMIT 10 OFFSET 5;
SELECT * FROM users WHERE id IN (1, 2, 3);
SELECT * FROM users WHERE age BETWEEN 20 AND 30;

UPDATE users SET name = 'Alice Updated' WHERE id = 1;
DELETE FROM users WHERE id = 1;
```

### Introspection

```sql
SELECT 1;
SHOW TABLES;
SHOW DATABASES;
DESCRIBE users;
EXPLAIN SELECT * FROM users;
```

### Transactions & sessions

```sql
BEGIN;                 -- or START TRANSACTION
COMMIT;
ROLLBACK;
SAVEPOINT sp1;
USE parlel;
SET autocommit = 1;
```

`GRANT`, `REVOKE`, `CREATE USER`, and `ALTER USER` are accepted as no-ops so
ORMs and migration tools that issue them do not error.

### Result, OK & error packets

The emulator returns the same three response packet types real MySQL does, so
drivers (`mysql2`, `PyMySQL`) frame each statement correctly:

- **Result set** for statements that produce rows — `SELECT`, `SHOW`,
  `DESCRIBE`, `EXPLAIN`, `SELECT COUNT(*)`.
- **OK packet** for writes and DDL — `INSERT`, `UPDATE`, `DELETE`, `CREATE
  TABLE`, `ALTER TABLE`, `DROP TABLE`, `SET`, `USE`, `BEGIN`/`COMMIT`/`ROLLBACK`.
  `affected_rows` reflects rows changed; `INSERT` reports `last_insert_id` (read
  it as `result.insertId` in `mysql2` or `cursor.lastrowid` in PyMySQL).
- **ERR packet** (`0xFF`, error code, `#`+SQLSTATE, message) for failures —
  unknown table (`1146` / `42S02`), and unsupported constructs such as `JOIN`,
  `GROUP BY`, window functions, and aggregates other than `COUNT(*)` (`1235`).
  Unsupported queries **error honestly** rather than silently returning empty
  rows, so an agent never gets a wrong answer mistaken for success.

## Usage

`localhost:3306` and your app connects with an **unmodified** real driver
(`mysql2`, `PyMySQL`) — no Parlel code in the app.

```bash

```

```typescript
import mysql from "mysql2/promise";

const conn = await mysql.createConnection({

  port: 3306,
  user: "parlel",
  password: "parlel",
  database: "parlel",
});

await conn.query("CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100))");
await conn.query("INSERT INTO items (name) VALUES (?)", ["Widget"]);
const [rows] = await conn.query("SELECT * FROM items");
```

## Access via MCP (Parlel Sandbox)

When MySQL runs inside a Parlel sandbox, drive it through the sandbox's MCP
endpoint with the `parlel_execute` tool. Pass raw SQL as `command` (multiple
statements may be separated by `;`):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "parlel_execute",
    "arguments": {
      "service": "mysql",
      "command": "CREATE TABLE t (id INT, name VARCHAR(50)); INSERT INTO t (id, name) VALUES (1, 'Ada'); SELECT * FROM t;"
    }
  }
}
```

Each statement returns `{ statement, fields, rows, error }`.

## Access via Parlel Sandbox

WebSocket. `mysql2`, `PyMySQL`, or any driver connects to
`mysql://parlel:parlel@localhost:3306/parlel` unmodified — with just an API
key (or `localhost` if you run the bridge outside Docker and publish ports). No

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Wire handshake + `COM_QUERY`/`COM_PING`/`COM_QUIT` | ✅ Supported |
| CRUD (`INSERT`/`SELECT`/`UPDATE`/`DELETE`) | ✅ Supported |
| OK packet for writes/DDL with `affected_rows` + `last_insert_id` | ✅ Supported |
| ERR packet for unknown tables and unsupported statements | ✅ Supported |
| `WHERE` with numeric-aware `=` `!=` `<` `>` `<=` `>=`, `AND`/`OR` | ✅ Supported |
| `IN (...)` / `NOT IN`, `BETWEEN`, `LIKE`, `IS [NOT] NULL` | ✅ Supported |
| `ORDER BY` (numeric + text, `ASC`/`DESC`), `LIMIT`, `COUNT(*)` | ✅ Supported |
| Transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) | ◐ Accepted (no isolation enforcement) |
| Indexes / foreign keys | ◐ Accepted (not physically enforced — results stay correct) |
| Authentication | ◐ Accepted (any credentials; fixed local creds by design) |
| `JOIN` | ⟳ Roadmap — single-table queries only (errors honestly) |
| Aggregates other than `COUNT(*)` / `GROUP BY` | ⟳ Roadmap — error honestly |
| Server-side prepared statements (binary protocol) | ⟳ Roadmap |
| Stored procedures / triggers / views | ⟳ Roadmap — accepted as no-ops |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MYSQL_ROOT_PASSWORD=parlel
MYSQL_DATABASE=parlel
MYSQL_USER=parlel
MYSQL_PASSWORD=parlel
```

<!-- parlel:testenv:end -->
