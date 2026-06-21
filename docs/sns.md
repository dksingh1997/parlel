# SNS

Lightweight, dependency-free fake of AWS SNS that speaks the real SNS AWS Query wire protocol (form-encoded requests, XML responses, API version `2010-03-31`), so application code using `@aws-sdk/client-sns` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4569 |
| Protocol | AWS Query (`application/x-www-form-urlencoded` request, XML response) over HTTP |
| API version | 2010-03-31 |
| Compatible client | `@aws-sdk/client-sns` (v3) |
| Size | ~90 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { SnsServer } from "./services/sns/src/server.js";

const server = new SnsServer(4569);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
} from "@aws-sdk/client-sns";

const sns = new SNSClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4569",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

// Create a topic
const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "events" }));

// Subscribe an SQS queue (auto-confirmed)
await sns.send(
  new SubscribeCommand({
    TopicArn,
    Protocol: "sqs",
    Endpoint: "arn:aws:sqs:us-east-1:000000000000:events-queue",
    ReturnSubscriptionArn: true,
  }),
);

// Publish a message
const { MessageId } = await sns.send(
  new PublishCommand({ TopicArn, Message: "hello world" }),
);
console.log(MessageId);
```

### ARNs

- Topics: `arn:aws:sns:{region}:{accountId}:{topicName}`
- Subscriptions: `arn:aws:sns:{region}:{accountId}:{topicName}:{uuid}`
- Platform applications: `arn:aws:sns:{region}:{accountId}:app/{platform}/{name}`
- Platform endpoints: `arn:aws:sns:{region}:{accountId}:endpoint/{platform}/{name}/{uuid}`

The default region is `us-east-1` and the default account id is `000000000000` (both configurable via the constructor: `new SnsServer(port, { region, accountId, host })`).

### Internal endpoints (not part of SNS)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/_parlel/health` | GET | Returns `{ status, service, topics, subscriptions }` |
| `/_parlel/reset` | POST | Clears all in-memory state |

State can also be reset in-process with `server.reset()`. Published messages are captured in `server.published` for test assertions.

## Implemented operations

All 42 operations exposed by `@aws-sdk/client-sns` v3 are implemented.

### Topics
- `CreateTopic` — idempotent by name; supports FIFO (`.fifo` suffix), tags, and standard attributes
- `DeleteTopic` — idempotent; cascades to remove the topic's subscriptions
- `ListTopics` — paginated via `NextToken`
- `GetTopicAttributes` — returns `TopicArn`, `Owner`, `DisplayName`, `Policy`, `EffectiveDeliveryPolicy`, subscription counts, FIFO attributes, etc.
- `SetTopicAttributes` — mutable: `Policy`, `DisplayName`, `DeliveryPolicy`, `KmsMasterKeyId`, `ContentBasedDeduplication`, `SignatureVersion`, `TracingConfig`

### Subscriptions
- `Subscribe` — `sqs`/`lambda`/`application`/`firehose` auto-confirm; `http`/`https`/`email`/`email-json`/`sms` go into pending confirmation
- `ConfirmSubscription` — confirms a pending subscription using its token (tokens are stored in `server.pendingConfirmations`)
- `Unsubscribe`
- `ListSubscriptions` — paginated
- `ListSubscriptionsByTopic` — paginated
- `GetSubscriptionAttributes`
- `SetSubscriptionAttributes` — mutable: `DeliveryPolicy`, `RawMessageDelivery`, `FilterPolicy`, `FilterPolicyScope`, `RedrivePolicy`, `SubscriptionRoleArn`

### Publishing
- `Publish` — to `TopicArn`, `TargetArn` (platform endpoint), or `PhoneNumber`; supports `Subject`, `MessageAttributes`, `MessageStructure: "json"`, FIFO `MessageGroupId`/`MessageDeduplicationId`
- `PublishBatch` — up to 10 entries; per-entry success/failure reporting

### Permissions
- `AddPermission`
- `RemovePermission`

### Tags
- `TagResource`
- `UntagResource`
- `ListTagsForResource`

### Data protection policy
- `GetDataProtectionPolicy`
- `PutDataProtectionPolicy`

### SMS
- `GetSMSAttributes`
- `SetSMSAttributes`
- `CheckIfPhoneNumberIsOptedOut`
- `OptInPhoneNumber`
- `ListPhoneNumbersOptedOut`
- `ListOriginationNumbers`

### SMS sandbox
- `GetSMSSandboxAccountStatus`
- `CreateSMSSandboxPhoneNumber`
- `VerifySMSSandboxPhoneNumber` (default OTP is `123456`)
- `DeleteSMSSandboxPhoneNumber`
- `ListSMSSandboxPhoneNumbers`

### Platform applications & endpoints (mobile push)
- `CreatePlatformApplication`
- `DeletePlatformApplication`
- `GetPlatformApplicationAttributes`
- `SetPlatformApplicationAttributes`
- `ListPlatformApplications`
- `CreatePlatformEndpoint` — idempotent on `(applicationArn, token)`
- `DeleteEndpoint`
- `GetEndpointAttributes`
- `SetEndpointAttributes`
- `ListEndpointsByPlatformApplication`

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported | Notes |
|---------|-----------|-------|
| Topic lifecycle & attributes | ✅ | Full |
| FIFO topics | ✅ | Name-suffix detection, `MessageGroupId`/dedup validation, `SequenceNumber` returned |
| Standard & FIFO publish | ✅ | Captured in `server.published` |
| `PublishBatch` | ✅ | Up to 10 entries, partial failures |
| Subscriptions (all protocols) | ✅ | Protocol validation enforced |
| Confirmation flow | ✅ | Pending tokens are generated and confirmable |
| Filter policies / raw delivery | ✅ (stored) | Stored as subscription attributes; messages are **not** fanned out to endpoints |
| Tags | ✅ | Topic resources only |
| Data protection policy | ✅ | Stored verbatim, not enforced |
| SMS attributes & opt-out | ✅ | Stored in-memory |
| SMS sandbox | ✅ | OTP defaults to `123456` |
| Mobile push (platform apps/endpoints) | ✅ | Lifecycle + attributes |
| Actual message delivery / fan-out to SQS, HTTP, email, Lambda | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Real signature verification (SignatureVersion 1/2) | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| KMS encryption | ✓ By design — Plain in-memory storage — transport/at-rest crypto is unnecessary locally |
| Cross-account / IAM policy enforcement | ⟳ Roadmap |

## Error codes & shapes

Errors are returned as non-2xx HTTP responses with an XML body in the AWS Query error envelope:

```xml
<?xml version="1.0"?>
<ErrorResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
  <Error>
    <Type>Sender</Type>
    <Code>InvalidParameter</Code>
    <Message>Invalid parameter: Topic Name</Message>
  </Error>
  <RequestId>...</RequestId>
</ErrorResponse>
```

`<Type>` is `Sender` for client (4xx) faults and `Receiver` for server (5xx) faults.

| Code | HTTP | When |
|------|------|------|
| `InvalidParameter` | 400 | Missing/invalid parameter (bad topic name, empty message, bad protocol, immutable attribute, etc.) |
| `InvalidAction` | 400 | Unknown `Action` |
| `NotFound` | 404 | Topic / subscription / platform application / endpoint does not exist |
| `ResourceNotFound` | 404 | Tag resource or sandbox number not found |
| `AuthorizationError` | 403 | Authorization failures |
| `EmptyBatchRequest` | 400 | `PublishBatch` with no entries |
| `TooManyEntriesInBatchRequest` | 400 | `PublishBatch` with > 10 entries |
| `BatchEntryIdsNotDistinct` | 400 | Duplicate `Id` in a batch |
| `VerificationException` | 400 | Wrong OTP on `VerifySMSSandboxPhoneNumber` |
| `InternalError` | 500 | Unexpected server error |

Successful responses use the AWS Query success envelope, e.g.:

```xml
<?xml version="1.0"?>
<CreateTopicResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
  <CreateTopicResult>
    <TopicArn>arn:aws:sns:us-east-1:000000000000:events</TopicArn>
  </CreateTopicResult>
  <ResponseMetadata>
    <RequestId>...</RequestId>
  </ResponseMetadata>
</CreateTopicResponse>
```

## Running the tests

```bash
npx vitest run tests/sns.test.ts
```

The test suite starts the server on port `14569`, exercises every implemented operation (happy paths plus key edge cases), asserts the real SDK-parsed responses, and tears the server down in `afterAll`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_SNS=http://localhost:4569
AWS_ENDPOINT_URL=http://localhost:4569
```

<!-- parlel:testenv:end -->
