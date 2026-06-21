# Service Bus

Lightweight, dependency-free fake of **Azure Service Bus** that speaks the documented [Service Bus REST API](https://learn.microsoft.com/rest/api/servicebus/) over plain HTTP, so application code can drive queues, topics, subscriptions, rules and brokered messages with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4592 |
| Protocol | Azure Service Bus REST API (HTTP + Atom/XML management, brokered-message runtime) |
| Compatible client | `@azure/service-bus` (logical surface) / any HTTP client |
| Size | ~64 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

> **Wire-transport note.** The real `@azure/service-bus` SDK uses **AMQP 1.0** for its data plane — a binary framing protocol that is intentionally out of scope for a tiny in-process fake. This fake instead implements Azure's documented **HTTP/REST** surface, which mirrors the same logical operations 1:1 (send / peek-lock receive / complete / abandon / renew-lock / dead-letter / defer / schedule, plus the full Atom-based management API). Agents and application code can therefore exercise every Service Bus concept without a broker. See the **Supported vs unsupported** table below.

## Quick Start

Start the server:

```js
import { ServicebusServer } from "./services/servicebus/src/server.js";

const server = new ServicebusServer(4592);
await server.start();
// ... use it ...
await server.stop();
```

Drive it over the Service Bus REST API with any HTTP client. The examples below use `fetch`.

### Management (Atom/XML)

```js
const base = "http://127.0.0.1:4592";
const ATOM = { "Content-Type": "application/atom+xml;type=entry;charset=utf-8" };

// Create a queue
await fetch(`${base}/orders`, {
  method: "PUT",
  headers: ATOM,
  body: `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">
    <QueueDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect">
      <MaxDeliveryCount>10</MaxDeliveryCount><LockDuration>PT30S</LockDuration>
    </QueueDescription></content></entry>`,
});

// Create a topic + subscription
await fetch(`${base}/events`, { method: "PUT", headers: ATOM, body: `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml"><TopicDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect"/></content></entry>` });
await fetch(`${base}/events/subscriptions/worker`, { method: "PUT", headers: ATOM, body: `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml"><SubscriptionDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect"/></content></entry>` });
```

### Send + receive (brokered messages)

```js
// Send a message (BrokerProperties carries system metadata, custom headers map
// to application properties)
await fetch(`${base}/orders/messages`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    BrokerProperties: JSON.stringify({ MessageId: "m1", Label: "new-order", CorrelationId: "c1" }),
    priority: '"high"',
  },
  body: JSON.stringify({ id: 42 }),
});

// Peek-lock receive
const recv = await fetch(`${base}/orders/messages/head?timeout=30`, { method: "POST" });
const props = JSON.parse(recv.headers.get("brokerproperties"));
const body = await recv.text();

// Complete (delete) the locked message
await fetch(`${base}/orders/messages/${props.SequenceNumber}/${props.LockToken}`, { method: "DELETE" });
```

### Using the real `@azure/service-bus` client

The SDK's `ServiceBusAdministrationClient` (management plane) issues exactly the
Atom/XML HTTP requests this fake implements. Point it at the local endpoint:

```js
import { ServiceBusAdministrationClient } from "@azure/service-bus";

const admin = new ServiceBusAdministrationClient(
  "Endpoint=sb://127.0.0.1:4592/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=parlellocaldevkey;UseDevelopmentEmulator=true"
);
await admin.createQueue("orders");
await admin.createTopic("events");
await admin.createSubscription("events", "worker");
```

The data-plane `ServiceBusClient` (`sendMessages` / `receiveMessages`) speaks
AMQP and is therefore not wire-compatible with this HTTP fake — use the REST
runtime endpoints above (or raw HTTP) to send/receive against the fake.

## Implemented operations

### Internal (parlel)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/_parlel/health` | Health check + entity counts |
| POST | `/_parlel/reset` | Reset all in-memory state |
| GET | `/_parlel/dump` | Dump queues / topics / subscriptions |

### Management — Queues

| Method | Path | Operation |
|--------|------|-----------|
| PUT | `/{queue}` | CreateQueue |
| GET | `/{queue}` | GetQueue |
| DELETE | `/{queue}` | DeleteQueue |
| GET | `/$Resources/Queues` | ListQueues |

### Management — Topics

| Method | Path | Operation |
|--------|------|-----------|
| PUT | `/{topic}` | CreateTopic |
| GET | `/{topic}` | GetTopic |
| DELETE | `/{topic}` | DeleteTopic |
| GET | `/$Resources/Topics` | ListTopics |

### Management — Subscriptions

| Method | Path | Operation |
|--------|------|-----------|
| PUT | `/{topic}/subscriptions/{sub}` | CreateSubscription |
| GET | `/{topic}/subscriptions/{sub}` | GetSubscription |
| DELETE | `/{topic}/subscriptions/{sub}` | DeleteSubscription |
| GET | `/{topic}/subscriptions` | ListSubscriptions |

### Management — Rules

| Method | Path | Operation |
|--------|------|-----------|
| PUT | `/{topic}/subscriptions/{sub}/rules/{rule}` | CreateRule (SqlFilter / CorrelationFilter / True / False, with optional SqlRuleAction) |
| GET | `/{topic}/subscriptions/{sub}/rules/{rule}` | GetRule |
| DELETE | `/{topic}/subscriptions/{sub}/rules/{rule}` | DeleteRule |
| GET | `/{topic}/subscriptions/{sub}/rules` | ListRules |

Every subscription is created with the default `$Default` `TrueFilter` rule.

### Runtime — Messaging

| Method | Path | Operation |
|--------|------|-----------|
| POST | `/{queue\|topic}/messages` | Send (single) |
| POST | `/{queue\|topic}/messages` + `Content-Type: application/vnd.microsoft.servicebus.json` | SendBatch |
| POST | `/{entity}/messages/head?timeout=N` | Receive (peek-lock) → `201` + `LockToken` |
| DELETE | `/{entity}/messages/head?timeout=N` | Receive-and-delete → `200` |
| DELETE | `/{entity}/messages/{seq}/{lockToken}` | Complete |
| PUT | `/{entity}/messages/{seq}/{lockToken}` | Abandon (unlock) — default disposition |
| PUT | `/{entity}/messages/{seq}/{lockToken}` + `Disposition: deadletter` | Dead-letter |
| PUT | `/{entity}/messages/{seq}/{lockToken}` + `Disposition: defer` | Defer |
| POST | `/{entity}/messages/{seq}/{lockToken}` | Renew lock |
| POST | `/{entity}/messages/{sequenceNumber}` | Receive deferred message by sequence number |

`{entity}` is one of:

- `{queue}` — a queue
- `{queue}/$DeadLetterQueue` — the queue's dead-letter sub-queue
- `{topic}/subscriptions/{sub}` — a subscription
- `{topic}/subscriptions/{sub}/$DeadLetterQueue` — the subscription's dead-letter sub-queue

### Message semantics

- **Scheduled messages** — set `BrokerProperties.ScheduledEnqueueTimeUtc`; messages in the future are held until their time arrives.
- **Topic fan-out** — a message published to a topic is copied to every subscription whose rules match.
- **Filtering** — `TrueFilter`, `FalseFilter`, `CorrelationFilter` (CorrelationId / Label), and a useful subset of `SqlFilter` (`prop = 'value'`, numeric comparisons `> < >= <= != <>`, and `AND` / `OR`).
- **Dead-lettering** — automatic when `deliveryCount` exceeds the entity's `MaxDeliveryCount` on abandon, or explicit via the `deadletter` disposition.
- **Lock expiry** — peek-locks last 30s; expired locks are reclaimed and the message returns to the queue.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported |
|---------|-----------|
| Queue / Topic / Subscription / Rule management (Atom) | ✅ |
| List queues / topics / subscriptions / rules | ✅ |
| Send (single + batch) | ✅ |
| Peek-lock receive | ✅ |
| Receive-and-delete | ✅ |
| Complete / Abandon / Renew-lock | ✅ |
| Dead-letter (auto on max-delivery + explicit) | ✅ |
| Dead-letter queue addressing (`$DeadLetterQueue`) | ✅ |
| Defer + receive-by-sequence-number | ✅ |
| Scheduled (future-enqueue) messages | ✅ |
| Topic → subscription fan-out | ✅ |
| SQL / Correlation / True / False filters | ✅ (subset of SQL grammar) |
| BrokerProperties + custom application properties | ✅ |
| AMQP 1.0 binary transport (`ServiceBusClient` data plane) | ⟳ Roadmap — intentionally — REST runtime endpoints used instead |
| Sessions (ordered, session-locked receive) | ⟳ Roadmap — stored on the entity but no session-locked receive |
| Auto-forwarding (`ForwardTo`) | ✓ By design — accepted + persisted, not enforced |
| Duplicate detection | ✓ By design — accepted + persisted, not enforced |
| Shared Access Signature auth / RBAC | ✓ By design — all requests accepted (local fake) |
| Geo-disaster recovery, partitioning internals, metrics | ⟳ Roadmap |

## Error codes / shapes

Errors are returned as Azure-style XML:

```xml
<Error><Code>404</Code><Detail>MessagingEntityNotFound: The messaging entity could not be found.</Detail></Error>
```

| HTTP status | Code | When |
|-------------|------|------|
| 400 | `BadRequest` | Malformed request / invalid JSON / sending to a subscription path |
| 404 | `MessagingEntityNotFound` | Queue/topic/subscription/rule does not exist |
| 409 | `MessagingEntityAlreadyExists` | Creating an entity that already exists |
| 410 | `LockTokenNotFound` | Lock token invalid or expired (complete/abandon/renew) |
| 500 | `InternalServerError` | Unexpected server error |

Successful responses use Azure's conventions:

- Create → `201` with the entity's Atom `<entry>`.
- Get → `200` with the Atom `<entry>`.
- Delete → `200` (empty).
- Send → `201`.
- Peek-lock receive → `201` with the message body + a `BrokerProperties` response header containing `LockToken`, `SequenceNumber`, `DeliveryCount`, etc.
- Receive-and-delete → `200` with the message body.
- Empty receive → `204` (no message available).

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SERVICEBUS_NAMESPACE=parlel
SERVICEBUS_ENDPOINT=http://localhost:4592
SERVICEBUS_CONNECTION_STRING=Endpoint=sb://127.0.0.1:4592/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=parlellocaldevkey;UseDevelopmentEmulator=true
```

<!-- parlel:testenv:end -->
