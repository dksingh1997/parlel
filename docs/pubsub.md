# Pub/Sub

Lightweight, dependency-free fake of Google Cloud Pub/Sub that speaks the real Pub/Sub v1 REST API (`https://pubsub.googleapis.com/v1`), so application code using `@google-cloud/pubsub` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4582 |
| Protocol | Pub/Sub v1 REST API (HTTP + JSON) |
| Compatible client | `@google-cloud/pubsub` (v4) |
| Size | ~70 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { PubsubServer } from "./services/pubsub/src/server.js";

const server = new PubsubServer(4582);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real `@google-cloud/pubsub` client. The fake speaks the
**HTTP/1.1 REST** transport (the google-gax `fallback` mode), so the client must
be constructed with `fallback: true` and `protocol: "http"`. Point it at the
fake via the `PUBSUB_EMULATOR_HOST` environment variable:

```bash
export PUBSUB_EMULATOR_HOST=127.0.0.1:4582
```

```js
import { PubSub } from "@google-cloud/pubsub";

const pubsub = new PubSub({
  projectId: "parlel",
  fallback: true,       // use the HTTP/1.1 REST transport instead of gRPC
  protocol: "http",     // talk plain HTTP to the local fake
  // Any credentials work — the fake does not verify them.
  credentials: {
    client_email: "parlel@parlel.iam.gserviceaccount.com",
    private_key: "<any valid PEM>",
  },
});

// Create a topic and a subscription.
const [topic] = await pubsub.createTopic("orders");
const [subscription] = await topic.createSubscription("orders-worker");

// Publish a message.
const messageId = await topic.publishMessage({
  data: Buffer.from("hello"),
  attributes: { tier: "gold" },
});
```

### Pulling messages

The high-level `subscription.on("message", ...)` streaming API uses bidi gRPC
`StreamingPull`, which is **not available over the REST transport**. Use the
low-level synchronous `Pull` RPC instead (this is exactly what the real service
exposes over REST):

```js
import { v1 } from "@google-cloud/pubsub";

const subClient = new v1.SubscriberClient({
  projectId: "parlel",
  fallback: true,
  protocol: "http",
  apiEndpoint: "127.0.0.1", // low-level gapic clients need the host explicitly
  port: 4582,
  credentials: { client_email: "parlel@parlel.iam.gserviceaccount.com", private_key: "<PEM>" },
});

const subscriptionPath = subClient.subscriptionPath("parlel", "orders-worker");

const [response] = await subClient.pull({ subscription: subscriptionPath, maxMessages: 10 });
for (const received of response.receivedMessages) {
  console.log(Buffer.from(received.message.data, "base64").toString());
  await subClient.acknowledge({ subscription: subscriptionPath, ackIds: [received.ackId] });
}
```

### Authentication

Google credentials and OAuth tokens are **accepted but not verified** (any
syntactically valid credentials work). No network calls leave the process.

## Internal (parlel) endpoints

These are not part of Pub/Sub; they exist to manage the fake.

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/_parlel/health` | Health check + resource counts |
| POST | `/_parlel/reset`  | Wipe all in-memory state |
| GET  | `/_parlel/dump`   | Dump topics/subscriptions/snapshots/schemas |

You can also call `server.reset()` directly in process.

## Implemented operations / endpoints

All 35 Pub/Sub v1 RPCs plus the 3 IAM RPCs are implemented.

### Publisher (topics)

| RPC | HTTP |
|-----|------|
| CreateTopic | `PUT /v1/{name=projects/*/topics/*}` |
| UpdateTopic | `PATCH /v1/{topic.name=projects/*/topics/*}` |
| GetTopic | `GET /v1/{topic=projects/*/topics/*}` |
| ListTopics | `GET /v1/{project=projects/*}/topics` |
| ListTopicSubscriptions | `GET /v1/{topic=projects/*/topics/*}/subscriptions` |
| ListTopicSnapshots | `GET /v1/{topic=projects/*/topics/*}/snapshots` |
| DeleteTopic | `DELETE /v1/{topic=projects/*/topics/*}` |
| Publish | `POST /v1/{topic=projects/*/topics/*}:publish` |
| DetachSubscription | `POST /v1/{subscription=projects/*/subscriptions/*}:detach` |

### Subscriber (subscriptions)

| RPC | HTTP |
|-----|------|
| CreateSubscription | `PUT /v1/{name=projects/*/subscriptions/*}` |
| GetSubscription | `GET /v1/{subscription=projects/*/subscriptions/*}` |
| UpdateSubscription | `PATCH /v1/{subscription.name=projects/*/subscriptions/*}` |
| ListSubscriptions | `GET /v1/{project=projects/*}/subscriptions` |
| DeleteSubscription | `DELETE /v1/{subscription=projects/*/subscriptions/*}` |
| ModifyAckDeadline | `POST /v1/{subscription=...}:modifyAckDeadline` |
| Acknowledge | `POST /v1/{subscription=...}:acknowledge` |
| Pull | `POST /v1/{subscription=...}:pull` |
| ModifyPushConfig | `POST /v1/{subscription=...}:modifyPushConfig` |
| Seek | `POST /v1/{subscription=...}:seek` |

### Snapshots

| RPC | HTTP |
|-----|------|
| CreateSnapshot | `PUT /v1/{name=projects/*/snapshots/*}` |
| GetSnapshot | `GET /v1/{snapshot=projects/*/snapshots/*}` |
| UpdateSnapshot | `PATCH /v1/{snapshot.name=projects/*/snapshots/*}` |
| ListSnapshots | `GET /v1/{project=projects/*}/snapshots` |
| DeleteSnapshot | `DELETE /v1/{snapshot=projects/*/snapshots/*}` |

### Schemas

| RPC | HTTP |
|-----|------|
| CreateSchema | `POST /v1/{parent=projects/*}/schemas` |
| GetSchema | `GET /v1/{name=projects/*/schemas/*}` |
| ListSchemas | `GET /v1/{parent=projects/*}/schemas` |
| ListSchemaRevisions | `GET /v1/{name=projects/*/schemas/*}:listRevisions` |
| CommitSchema | `POST /v1/{name=projects/*/schemas/*}:commit` |
| RollbackSchema | `POST /v1/{name=projects/*/schemas/*}:rollback` |
| DeleteSchemaRevision | `DELETE /v1/{name=projects/*/schemas/*}:deleteRevision` |
| DeleteSchema | `DELETE /v1/{name=projects/*/schemas/*}` |
| ValidateSchema | `POST /v1/{parent=projects/*}/schemas:validate` |
| ValidateMessage | `POST /v1/{parent=projects/*}/schemas:validateMessage` |

### IAM (`google.iam.v1`)

| RPC | HTTP |
|-----|------|
| GetIamPolicy | `POST /v1/{resource=**}:getIamPolicy` |
| SetIamPolicy | `POST /v1/{resource=**}:setIamPolicy` |
| TestIamPermissions | `POST /v1/{resource=**}:testIamPermissions` |

## Behavior notes

- **Message delivery.** Publishing fans a message out to every subscription
  attached to the topic. Each subscription holds an in-memory backlog. `Pull`
  moves messages into an "outstanding" set keyed by `ackId`.
- **Ack deadlines.** Outstanding messages whose ack deadline has elapsed are
  returned to the backlog on the next `Pull` (lazy expiry). `Acknowledge`
  removes them permanently. `ModifyAckDeadline` with `ackDeadlineSeconds: 0`
  nacks (immediate redelivery); a positive value extends the lease.
- **Snapshots / Seek.** `CreateSnapshot` captures a subscription's current
  unacked backlog. `Seek` to a snapshot restores that backlog; `Seek` to a time
  re-queues outstanding messages for redelivery.
- **Dead-letter policy.** When a subscription has a `deadLetterPolicy`, pulled
  messages include a `deliveryAttempt` counter.
- **Schema revisions.** `CommitSchema` / `RollbackSchema` maintain an ordered
  revision history; schemas can be addressed by `name@revisionId`.
- **State is ephemeral.** Everything lives in memory and is wiped on `reset()`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Topic CRUD + list + update | ✅ Supported |
| Subscription CRUD + list + update | ✅ Supported |
| Publish (single + batch, attributes, ordering key) | ✅ Supported |
| Pull / Acknowledge / ModifyAckDeadline (lease + nack) | ✅ Supported |
| Push config (set via create/update/modifyPushConfig) | ✅ Stored (no actual HTTP push delivery) |
| Snapshots + Seek (by snapshot and by time) | ✅ Supported |
| Schemas (create/get/list/commit/rollback/revisions/validate) | ✅ Supported |
| ValidateMessage (JSON payloads) | ✅ Supported (JSON well-formedness) |
| IAM get/set/test policy | ✅ Supported (permissive: grants all) |
| DetachSubscription | ✅ Supported |
| Message filtering (`filter` evaluated at delivery) | ⚠️ Stored on the subscription, not enforced at pull time |
| Exactly-once delivery semantics | ⚠️ Flag stored; delivery is at-least-once |
| Ordering guarantees | ⚠️ `orderingKey` is stored & returned; strict per-key ordering is not enforced |
| Avro/protobuf payload schema enforcement | ⚠️ Structural validation only (JSON well-formedness / record shape) |
| StreamingPull (`subscription.on("message")`) | ⟳ Roadmap — Unsupported — bidi gRPC stream, not available over REST. Use `Pull`. |
| BigQuery / Cloud Storage subscriptions | ⚠️ Config stored; no actual export |
| Real push HTTP delivery to endpoints | ✓ By design — Not delivered |

## Error codes / shapes

Errors are returned in the standard Google REST error envelope:

```json
{
  "error": {
    "code": 404,
    "message": "Topic not found: projects/parlel/topics/missing",
    "status": "NOT_FOUND"
  }
}
```

The `@google-cloud/pubsub` client (over the gax REST transport) decodes the
canonical gRPC status code from the HTTP status.

| Condition | HTTP | gRPC code (as decoded by the client) |
|-----------|------|--------------------------------------|
| Invalid argument (bad name, bad ack deadline, empty message) | 400 | `INVALID_ARGUMENT` (3) |
| Resource not found (topic/subscription/snapshot/schema) | 404 | `NOT_FOUND` (5) |
| Duplicate create (topic/subscription/snapshot/schema already exists) | 412 | `FAILED_PRECONDITION` (9) † |
| Unimplemented verb | 501 | `UNIMPLEMENTED` (12) |
| Internal error | 500 | `INTERNAL` (13) |

† The underlying service semantic is `ALREADY_EXISTS` (6). Over the REST
fallback transport there is no HTTP status that decodes back to code 6, and HTTP
409 decodes to `ABORTED` — which the client's create-subscription retry policy
would retry. The fake therefore surfaces create-conflicts as a non-retryable
`FAILED_PRECONDITION`, so a duplicate create rejects immediately.

## Resource naming rules

Topic / subscription / snapshot IDs must be 3–255 characters, start with a
letter, contain only letters, digits, and `-._~%+`, and must not start with
`goog`. These match the real Pub/Sub constraints.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PUBSUB_EMULATOR_HOST=localhost:4582
PUBSUB_PROJECT_ID=parlel
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
