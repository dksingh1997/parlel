# RDS Data API (parlel emulator)

A zero-dependency, in-process fake of the Amazon RDS Data API. Ships a tiny
in-memory SQL engine (CREATE TABLE / INSERT / SELECT / UPDATE / DELETE) so round
trips return real data.

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4722                           |
| Protocol    | REST/JSON (operation paths)    |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Default connection

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4722
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations / paths

| Operation                 | Path                     |
| ------------------------- | ------------------------ |
| ExecuteStatement          | `POST /Execute`          |
| BatchExecuteStatement     | `POST /BatchExecute`     |
| BeginTransaction          | `POST /BeginTransaction` |
| CommitTransaction         | `POST /CommitTransaction`|
| RollbackTransaction       | `POST /RollbackTransaction` |

`ExecuteStatement` accepts `sql`, `database`, and `parameters`
(`[{ name, value: { stringValue | longValue | doubleValue | booleanValue } }]`)
and returns `{ records, columnMetadata, numberOfRecordsUpdated }`.

## SDK example

```ts
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";

const data = new RDSDataClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4722",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await data.send(new ExecuteStatementCommand({
  resourceArn: "arn:aws:rds:us-east-1:000000000000:cluster:c1",
  secretArn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:db",
  database: "app",
  sql: "CREATE TABLE users (id INTEGER, name TEXT)",
}));
```

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Limitation                                                   |
| ----------- | ------------------------------------------------------------ |
| SQL dialect | Subset only: single-table SELECT, simple `WHERE col = val`.  |
| Joins       | Not supported.                                               |
| Transactions| `transactionId` is tracked but statements are not isolated.  |
| Types       | Values are coerced to string/long/double/boolean.            |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4722
```

<!-- parlel:testenv:end -->
