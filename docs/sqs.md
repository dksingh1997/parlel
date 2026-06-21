# SQS

Lightweight, dependency-free fake of AWS SQS that speaks the real modern SQS JSON wire protocol (AWS JSON 1.0, query-compatible), so application code using `@aws-sdk/client-sqs` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4568 |
| Protocol | AWS SQS JSON (AWS JSON 1.0, `awsQueryCompatible`) over HTTP |
| Compatible client | `@aws-sdk/client-sqs` (v3) |
| Size | ~80 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { SqsServer } from "./services/sqs/src/server.js";

const server = new SqsServer(4568);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4568",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: "jobs" }));

await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "hello world" }));

const { Messages } = await sqs.send(
  new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1 }),
);
console.log(Messages[0].Body); // "hello world"

await sqs.send(
  new DeleteMessageCommand({ QueueUrl, ReceiptHandle: Messages[0].ReceiptHandle }),
);
```

### Queue URLs

Created queues return a URL of the form `http://127.0.0.1:4568/{accountId}/{queueName}`
(default account id `000000000000`). The SDK's `useQueueUrlAsEndpoint` behavior uses
the URL's origin as the request endpoint, so the host/port in the URL must match the
running fake — which it does automatically. Bare queue names are also accepted wherever
a `QueueUrl` is expected (the last path segment is used as the queue name).

### Wire protocol

- Requests are `POST /` with header `X-Amz-Target: AmazonSQS.<Operation>` and
  `Content-Type: application/x-amz-json-1.0`. The body is the JSON-serialized input.
- Success responses are `200` with `Content-Type: application/x-amz-json-1.0` and a
  JSON body containing the output shape.
- Errors are non-2xx with a JSON body `{ "__type": "<Code>", "message": "<msg>" }`
  plus the query-compatible header `x-amzn-query-error: <Code>;<Sender|Receiver>`.

### Authentication

SigV4 signatures are **accepted but not verified** (any credentials work). This matches
LocalStack-style local development.

### MD5 checksums

The real `@aws-sdk/client-sqs` validates `MD5OfMessageBody`, `MD5OfBody`, and
`MD5OfMessageAttributes` locally after each call. This fake computes each of those
exactly the way AWS does (including the canonical length-prefixed message-attribute
digest), so the SDK's built-in validation passes.

## Implemented Operations

All 23 operations exposed by `@aws-sdk/client-sqs` are implemented and tested.

### Queue lifecycle
- `CreateQueue` — standard & FIFO queues, attribute defaults, idempotent re-create, tags.
- `DeleteQueue`
- `GetQueueUrl`
- `ListQueues` — prefix filter and `MaxResults`/`NextToken` pagination.

### Queue attributes
- `GetQueueAttributes` — including computed `QueueArn`, `ApproximateNumberOfMessages`,
  `ApproximateNumberOfMessagesNotVisible`, `ApproximateNumberOfMessagesDelayed`,
  `CreatedTimestamp`, `LastModifiedTimestamp`.
- `SetQueueAttributes`
- `PurgeQueue`

### Messaging
- `SendMessage` — delay, message attributes, system attributes, FIFO group/dedup.
- `SendMessageBatch` — up to 10 entries, partial success/failure.
- `ReceiveMessage` — `MaxNumberOfMessages`, `VisibilityTimeout`, system & message
  attribute selection, FIFO ordering, receive-count tracking.
- `DeleteMessage`
- `DeleteMessageBatch`
- `ChangeMessageVisibility`
- `ChangeMessageVisibilityBatch`

### Tags
- `TagQueue`
- `UntagQueue`
- `ListQueueTags`

### Permissions
- `AddPermission`
- `RemovePermission`

### Dead-letter queues & message move tasks
- `ListDeadLetterSourceQueues`
- `StartMessageMoveTask`
- `CancelMessageMoveTask`
- `ListMessageMoveTasks`

## Behavioral notes

- **Visibility timeout**: received messages are hidden for `VisibilityTimeout` seconds
  (default 30, or the queue's configured value). They become visible again automatically
  when the timeout elapses, or immediately when set to `0` via receive or
  `ChangeMessageVisibility`. Deleting a message before the timeout removes it permanently.
- **FIFO queues** (`.fifo` suffix, `FifoQueue=true`): require `MessageGroupId`; require
  either `MessageDeduplicationId` or `ContentBasedDeduplication=true`. Deduplication is
  enforced within a 5-minute window. Messages carry a monotonically increasing
  `SequenceNumber` and are received in FIFO order.
- **Delay**: per-message `DelaySeconds` or the queue's `DelaySeconds` attribute keeps a
  message invisible until the delay elapses.
- **Message move tasks**: `StartMessageMoveTask` drains the source (DLQ) into the
  destination queue (explicit `DestinationArn`, or the original source queue inferred
  from a matching `RedrivePolicy`). Completes synchronously in this fake.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
|---|---|---|
| Standard queues | ✅ Supported | |
| FIFO queues + dedup + ordering | ✅ Supported | 5-minute dedup window |
| Message attributes + MD5 | ✅ Supported | AWS-canonical MD5 digest |
| Message system attributes | ✅ Supported | e.g. `AWSTraceHeader` |
| Visibility timeout / delay | ✅ Supported | real timers, auto re-visibility |
| Batch send/delete/visibility | ✅ Supported | partial-failure semantics |
| Tags | ✅ Supported | |
| Permissions (Add/Remove) | ✅ Supported | stored, not enforced |
| Dead-letter source listing | ✅ Supported | derived from `RedrivePolicy` |
| Message move tasks (redrive) | ✅ Supported | synchronous completion |
| Pagination | ✅ Supported | `ListQueues` `MaxResults`/`NextToken` |
| Long polling (`WaitTimeSeconds`) | ⚠️ Accepted, returns immediately | no blocking wait |
| Server-side encryption / KMS | ⚠️ Attributes stored only | no real crypto |
| SigV4 signature verification | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| Actual message retention expiry | ✓ By design — Intentional for a local, zero-cost test emulator |
| Redrive `maxReceiveCount` auto-DLQ | ✓ By design — Not enforced |

## Error codes

Errors are returned as `{ "__type": "<Code>", "message": "..." }` with the
`x-amzn-query-error: <Code>;<Fault>` header. The SDK surfaces them as typed exceptions
(the modeled name may differ from the wire code, e.g. the wire code
`AWS.SimpleQueueService.NonExistentQueue` surfaces as `QueueDoesNotExist`).

| Wire code | HTTP | When |
|---|---|---|
| `AWS.SimpleQueueService.NonExistentQueue` | 400 | Queue URL/name does not exist (→ `QueueDoesNotExist`) |
| `QueueAlreadyExists` | 400 | Re-create with conflicting attributes (→ `QueueNameExists`) |
| `InvalidParameterValue` | 400 | Bad queue name, FIFO mismatch, oversized body, bad visibility, etc. |
| `InvalidAttributeName` | 400 | Unknown attribute passed to `SetQueueAttributes` |
| `MissingParameter` | 400 | Required parameter omitted |
| `ReceiptHandleIsInvalid` | 400 | Malformed receipt handle on delete |
| `AWS.SimpleQueueService.MessageNotInflight` | 400 | `ChangeMessageVisibility` on a non-inflight message |
| `AWS.SimpleQueueService.EmptyBatchRequest` | 400 | Batch request with no entries |
| `AWS.SimpleQueueService.TooManyEntriesInBatchRequest` | 400 | More than 10 batch entries |
| `AWS.SimpleQueueService.BatchEntryIdsNotDistinct` | 400 | Duplicate `Id` within a batch |
| `ResourceNotFoundException` | 404 | Move task / move-task source not found |
| `InvalidAction` | 400 | Unknown `X-Amz-Target` operation |

## Resetting state

State is in-memory and ephemeral. Reset it programmatically or over HTTP:

```js
server.reset();                                   // in-process
await fetch("http://127.0.0.1:4568/_parlel/reset", { method: "POST" }); // over HTTP
```

## Health check

```
GET http://127.0.0.1:4568/_parlel/health
→ { "status": "ok", "service": "sqs", "queues": <n> }
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_SQS=http://localhost:4568
AWS_ENDPOINT_URL=http://localhost:4568
```

<!-- parlel:testenv:end -->
