# Glue (parlel emulator)

A zero-dependency, in-process fake of AWS Glue (Data Catalog + Jobs).

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4724                           |
| Protocol    | AWS JSON 1.1 (`X-Amz-Target: AWSGlue.<Op>`) |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Default connection

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4724
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

- Databases: `CreateDatabase`, `GetDatabases`, `GetDatabase`, `DeleteDatabase`
- Tables: `CreateTable`, `GetTables`, `GetTable`, `DeleteTable`
- Jobs: `CreateJob`, `GetJobs`, `GetJob`, `StartJobRun`, `GetJobRun`

## SDK example

```ts
import { GlueClient, CreateDatabaseCommand, CreateTableCommand } from "@aws-sdk/client-glue";

const glue = new GlueClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4724",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await glue.send(new CreateDatabaseCommand({ DatabaseInput: { Name: "analytics" } }));
await glue.send(new CreateTableCommand({
  DatabaseName: "analytics",
  TableInput: { Name: "events", StorageDescriptor: { Columns: [{ Name: "id", Type: "string" }] } },
}));
```

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Limitation                                                  |
| ----------- | ----------------------------------------------------------- |
| Job runs    | `StartJobRun` returns `SUCCEEDED` immediately; no execution.|
| Crawlers    | Not modeled.                                                |
| Partitions  | Partition CRUD is not implemented.                          |
| Versioning  | Table/job version history is not tracked.                   |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4724
```

<!-- parlel:testenv:end -->
