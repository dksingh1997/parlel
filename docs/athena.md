# Athena (parlel emulator)

A zero-dependency, in-process fake of Amazon Athena. Ships a trivial query
engine that resolves `SELECT <literal>` queries.

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4723                           |
| Protocol    | AWS JSON 1.1 (`X-Amz-Target: AmazonAthena.<Op>`) |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Default connection

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4723
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

- Queries: `StartQueryExecution`, `GetQueryExecution`, `GetQueryResults`, `StopQueryExecution`, `ListQueryExecutions`
- Work groups: `CreateWorkGroup`, `ListWorkGroups`, `GetWorkGroup`
- Named queries: `CreateNamedQuery`, `ListNamedQueries`, `GetNamedQuery`

`StartQueryExecution` returns a `QueryExecutionId`; `GetQueryExecution` reports
`SUCCEEDED`; `GetQueryResults` returns a `ResultSet` with a header row plus data
rows (trivial `SELECT 1` / `SELECT '<literal>'` are evaluated).

## SDK example

```ts
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-athena";

const athena = new AthenaClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4723",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { QueryExecutionId } = await athena.send(
  new StartQueryExecutionCommand({ QueryString: "SELECT 1" }),
);
const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId }));
```

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Limitation                                                  |
| ----------- | ----------------------------------------------------------- |
| Query engine| Only `SELECT <literal>` truly evaluates; `FROM` returns demo rows. |
| State       | Queries always `SUCCEEDED` immediately.                     |
| S3 output   | `OutputLocation` is recorded but no S3 objects are written. |
| Catalogs    | Glue catalog integration is not wired.                      |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4723
```

<!-- parlel:testenv:end -->
