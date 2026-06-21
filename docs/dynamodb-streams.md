# DynamoDB Streams (parlel emulator)

A zero-dependency, in-process fake of Amazon DynamoDB Streams.

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4720                           |
| Protocol    | AWS JSON 1.0 (`X-Amz-Target: DynamoDBStreams_20120810.<Op>`) |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Default connection

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4720
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

- `ListStreams`
- `DescribeStream`
- `GetShardIterator`
- `GetRecords`

Streams are seeded programmatically with `server.seedStream(tableName)` and
records appended with `server.putRecord(arn, { eventName, keys, newImage, oldImage })`.
`eventName` is one of `INSERT`, `MODIFY`, `REMOVE`.

## SDK example

```ts
import {
  DynamoDBStreamsClient,
  ListStreamsCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
} from "@aws-sdk/client-dynamodb-streams";

const ddbs = new DynamoDBStreamsClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4720",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { Streams } = await ddbs.send(new ListStreamsCommand({}));
```

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area      | Limitation                                                     |
| --------- | -------------------------------------------------------------- |
| Sharding  | One shard per stream; no shard splits/merges.                  |
| Auto-wire | Not auto-coupled to the dynamodb service; seed records manually.|
| Iterators | `AT_SEQUENCE_NUMBER` / `AFTER_SEQUENCE_NUMBER` map to position. |
| Trimming  | Records are retained for the process lifetime (no trim).        |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4720
```

<!-- parlel:testenv:end -->
