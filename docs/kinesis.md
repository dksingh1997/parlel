# Kinesis

Lightweight, dependency-free fake of Amazon Kinesis Data Streams that speaks the real Kinesis AWS JSON 1.1 wire protocol, so application code using `@aws-sdk/client-kinesis` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4576 |
| Protocol | Kinesis AWS JSON 1.1 over HTTP/2 cleartext (h2c, prior knowledge) |
| Compatible client | `@aws-sdk/client-kinesis` (v3) |
| Image | `parlel/kinesis:0.1` |
| Size | ~95 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

> **Why HTTP/2?** The real `@aws-sdk/client-kinesis` ships a `NodeHttp2Handler`, so the client talks HTTP/2 cleartext (h2c) with prior knowledge — it does *not* speak HTTP/1.1. The parlel fake fronts the port with a tiny TCP listener that sniffs the connection preface: h2c connections are routed to an HTTP/2 server, while plain HTTP/1.1 requests (e.g. `curl`/`fetch` against the internal `/_parlel/*` endpoints) are routed to an HTTP/1.1 server. Both are served on the same port.

## Quick Start

Start the server:

```js
import { KinesisServer } from "./services/kinesis/src/server.js";

const server = new KinesisServer(4576);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  KinesisClient,
  CreateStreamCommand,
  PutRecordCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
  ListShardsCommand,
} from "@aws-sdk/client-kinesis";

const kinesis = new KinesisClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4576",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

// Create a stream with one shard.
await kinesis.send(new CreateStreamCommand({ StreamName: "events", ShardCount: 1 }));

// Write a record.
await kinesis.send(
  new PutRecordCommand({
    StreamName: "events",
    PartitionKey: "user-123",
    Data: new TextEncoder().encode("hello-kinesis"),
  }),
);

// Read it back.
const { Shards } = await kinesis.send(new ListShardsCommand({ StreamName: "events" }));
const { ShardIterator } = await kinesis.send(
  new GetShardIteratorCommand({
    StreamName: "events",
    ShardId: Shards[0].ShardId,
    ShardIteratorType: "TRIM_HORIZON",
  }),
);
const { Records } = await kinesis.send(new GetRecordsCommand({ ShardIterator }));
console.log(new TextDecoder().decode(Records[0].Data)); // "hello-kinesis"
```

## Implemented Operations

All 39 operations exposed by `@aws-sdk/client-kinesis` are dispatched. 38 are fully functional; `SubscribeToShard` is intentionally a no-op error (see below).

### Stream lifecycle
- `CreateStream` — PROVISIONED (requires `ShardCount`) and `ON_DEMAND` modes; creates an evenly hash-partitioned set of shards.
- `DeleteStream`
- `ListStreams` — pagination via `Limit` / `NextToken` / `ExclusiveStartStreamName`, includes `StreamSummaries`.
- `DescribeStream` — full shard list with pagination (`ExclusiveStartShardId`).
- `DescribeStreamSummary` — open shard count, consumer count, encryption, retention.
- `DescribeLimits` — shard limit, open shard count, on-demand stream count.
- `DescribeAccountSettings` / `UpdateAccountSettings` — minimum throughput billing commitment.
- `UpdateMaxRecordSize` — per-stream max record size (1024–10240 KiB).

### Retention
- `IncreaseStreamRetentionPeriod` — up to 8760 hours.
- `DecreaseStreamRetentionPeriod` — down to 24 hours.

### Shards
- `ListShards` — pagination via `MaxResults` / `NextToken` / `ExclusiveStartShardId`.
- `GetShardIterator` — `TRIM_HORIZON`, `LATEST`, `AT_SEQUENCE_NUMBER`, `AFTER_SEQUENCE_NUMBER`, `AT_TIMESTAMP`.
- `SplitShard` — closes parent, opens two children over the split hash key.
- `MergeShards` — requires adjacent shards; closes both parents, opens one child.
- `UpdateShardCount` — `UNIFORM_SCALING`; closes existing open shards and re-partitions.
- `UpdateStreamMode` — switch between `PROVISIONED` and `ON_DEMAND`.
- `UpdateStreamWarmThroughput` — `WarmThroughputMiBps`.

### Records
- `PutRecord` — partition-key MD5 hashing routes to a shard; honors `ExplicitHashKey`.
- `PutRecords` — batch up to 500 records; per-record `ErrorCode` / `ErrorMessage` on partial failure.
- `GetRecords` — `Limit` (1–10000), advances the iterator, returns `NextShardIterator` and `MillisBehindLatest`. `Data` round-trips byte-for-byte.

### Tags
- `AddTagsToStream` / `RemoveTagsFromStream` / `ListTagsForStream` (with pagination).
- `TagResource` / `UntagResource` / `ListTagsForResource` (works for stream and consumer ARNs).

### Enhanced monitoring
- `EnableEnhancedMonitoring` / `DisableEnhancedMonitoring` — supports `ALL` and the seven shard-level metric names.

### Encryption
- `StartStreamEncryption` (KMS) / `StopStreamEncryption`.

### Consumers (enhanced fan-out)
- `RegisterStreamConsumer` / `DeregisterStreamConsumer` / `DescribeStreamConsumer` / `ListStreamConsumers`.

### Resource policies
- `PutResourcePolicy` / `GetResourcePolicy` / `DeleteResourcePolicy`.

### Streaming (unsupported)
- `SubscribeToShard` — see the table below.

## Addressing: StreamName vs StreamARN

Every stream-scoped operation accepts either `StreamName` or `StreamARN`. ARNs follow the form:

```
arn:aws:kinesis:us-east-1:000000000000:stream/<streamName>
```

Consumer ARNs follow:

```
arn:aws:kinesis:us-east-1:000000000000:stream/<streamName>/consumer/<consumerName>:<creationEpochSeconds>
```

## Records, shards, and iterators

- **Sharding** is simplified: a record's target shard is chosen by `MD5(PartitionKey)` interpreted as a 128-bit integer over the shard's hash-key range, or by `ExplicitHashKey` when provided. Records are appended to the matching open shard.
- **Sequence numbers** are monotonic, zero-padded, and lexicographically sortable. They are opaque to clients.
- **Shard iterators** are opaque base64 tokens encoding `(stream, shardId, position)`. `GetRecords` returns a fresh `NextShardIterator` advanced past the records it returned.
- **Data fidelity**: record `Data` is carried as base64 on the wire (exactly as the SDK sends it) and returned verbatim, so binary payloads survive a round trip byte-for-byte.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
|---|---|---|
| Stream create/delete/describe/list | ✅ Supported | PROVISIONED + ON_DEMAND |
| PutRecord / PutRecords / GetRecords | ✅ Supported | byte-accurate `Data`, partial-batch failures |
| Shard iterators (all 5 types) | ✅ Supported | incl. `AT_TIMESTAMP` |
| Split / merge / UpdateShardCount | ✅ Supported | parent/child lineage tracked |
| Retention increase/decrease | ✅ Supported | bounds enforced (24–8760h) |
| Tags (stream + generic resource) | ✅ Supported | pagination on `ListTagsForStream` |
| Enhanced monitoring | ✅ Supported | metric names + `ALL` |
| Stream encryption (KMS) | ✅ Supported | metadata only; no actual crypto |
| Consumers (register/describe/list) | ✅ Supported | enhanced fan-out registration |
| Resource policies | ✅ Supported | stored verbatim, no policy evaluation |
| Account settings / max record size | ✅ Supported | in-memory toggles |
| Addressing by StreamName or StreamARN | ✅ Supported | both accepted everywhere |
| `SubscribeToShard` | ⛔ Unsupported | requires a long-lived HTTP/2 event stream; returns `InvalidArgumentException` directing you to `GetRecords` |
| Actual KMS encryption of payloads | ⛔ Unsupported | encryption is metadata-only |
| Time-based record expiry / trimming | ⛔ Unsupported | records persist until `reset()` or process exit |
| IAM authorization / signature checks | ⛔ Unsupported | any credentials accepted |
| Cross-region / real throughput limits | ⛔ Unsupported | single in-memory region, no throttling |

## Error codes and shapes

Errors are returned as a non-2xx response with the JSON-RPC error body plus the `x-amzn-errortype` header. The SDK reads the error code from the body's `__type` field first, then the header.

```json
{
  "__type": "ResourceNotFoundException",
  "message": "Stream ghost under account 000000000000 not found."
}
```

Common error codes:

| Code | HTTP | When |
|---|---|---|
| `ResourceNotFoundException` | 400 | Stream/shard/consumer/policy does not exist |
| `ResourceInUseException` | 400 | Stream or consumer name already exists |
| `InvalidArgumentException` | 400 | Missing/invalid parameters, bad iterator, unsupported op |
| `ValidationException` | 400 | Out-of-range values (e.g. max record size) |
| `LimitExceededException` | 400 | Too many consumers on a stream |
| `ExpiredNextTokenException` | 400 | Malformed pagination token |
| `InternalFailureException` | 500 | Unexpected server error |

## Internal endpoints (not part of Kinesis)

These are served over plain HTTP/1.1 for convenience:

- `GET /_parlel/health` → `{ "status": "ok", "service": "kinesis", "streams": <n> }`
- `POST /_parlel/reset` → clears all in-memory state and returns `{ "ok": true }`

State can also be reset in-process via `server.reset()`.

## Environment variables

The manifest exports these so application code auto-discovers the endpoint:

```
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_KINESIS=http://127.0.0.1:4576
AWS_ENDPOINT_URL=http://127.0.0.1:4576
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_KINESIS=http://localhost:4576
AWS_ENDPOINT_URL=http://localhost:4576
```

<!-- parlel:testenv:end -->
