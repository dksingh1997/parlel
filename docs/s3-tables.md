# S3 Tables (parlel emulator)

A zero-dependency, in-process fake of Amazon S3 Tables (Iceberg table buckets).

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4727                           |
| Protocol    | REST/JSON                      |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Default connection

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4727
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations / paths

| Operation         | Path                                          |
| ----------------- | --------------------------------------------- |
| CreateTableBucket | `POST   /table-buckets`                       |
| ListTableBuckets  | `GET    /table-buckets`                        |
| GetTableBucket    | `GET    /table-buckets/{arn}`                  |
| DeleteTableBucket | `DELETE /table-buckets/{arn}`                 |
| CreateNamespace   | `PUT    /namespaces/{tableBucketARN}`         |
| ListNamespaces    | `GET    /namespaces/{tableBucketARN}`         |
| CreateTable       | `PUT    /tables/{tableBucketARN}/{namespace}` |
| ListTables        | `GET    /tables/{tableBucketARN}/{namespace}` |
| GetTable          | `GET    /get-table/{tableBucketARN}/{namespace}/{name}` |

## SDK example

```ts
import { S3TablesClient, CreateTableBucketCommand } from "@aws-sdk/client-s3tables";

const s3t = new S3TablesClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4727",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { arn } = await s3t.send(new CreateTableBucketCommand({ name: "lake" }));
```

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Limitation                                                  |
| ----------- | ----------------------------------------------------------- |
| Iceberg     | Table metadata is recorded; no actual Iceberg files written.|
| Data        | No row-level read/write; control-plane catalog only.        |
| Maintenance | Compaction/snapshot management is not modeled.              |
| Policies    | Bucket/table policies are not enforced.                     |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4727
```

<!-- parlel:testenv:end -->
