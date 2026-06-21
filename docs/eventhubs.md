# Event Hubs

Lightweight, dependency-free fake of **Azure Event Hubs** that speaks the documented [Event Hubs REST API](https://learn.microsoft.com/rest/api/eventhub/) over plain HTTP, so application code and AI agents can publish and consume events across partitions and consumer groups with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4595 |
| Protocol | Azure Event Hubs REST API (HTTP + Atom/XML management, JSON publish/consume control plane) |
| Compatible client | `@azure/event-hubs` (logical surface) / any HTTP client |
| Size | ~64 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

> **Wire-transport note.** The real `@azure/event-hubs` SDK uses **AMQP 1.0** for its data plane — a binary framing protocol that is intentionally out of scope for a tiny in-process fake. This fake instead implements Azure's documented **HTTP/REST** publish surface plus a small JSON control plane that mirrors the SDK's logical operations 1:1 (createBatch / sendBatch / send to partition / send by partition key / getEventHubProperties / getPartitionIds / getPartitionProperties / receiveBatch with earliest/latest/offset/sequenceNumber/enqueuedTime positions), plus the Atom-based management API for hubs and consumer groups. Agents and application code can therefore exercise every Event Hubs concept without a broker. See the **Supported vs unsupported** table below.

## Quick Start

Start the server:

```js
import { EventhubsServer } from "./services/eventhubs/src/server.js";

const server = new EventhubsServer(4595);
await server.start();
// ... use it ...
await server.stop();
```

Drive it over the Event Hubs REST API with any HTTP client. The examples below use `fetch`.

### Management (Atom/XML)

```js
const base = "http://127.0.0.1:4595";
const ATOM = { "Content-Type": "application/atom+xml;type=entry;charset=utf-8" };

// Create an event hub with 4 partitions
await fetch(`${base}/telemetry`, {
  method: "PUT",
  headers: ATOM,
  body: `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">
    <EventHubDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect">
      <PartitionCount>4</PartitionCount><MessageRetentionInDays>7</MessageRetentionInDays>
    </EventHubDescription></content></entry>`,
});

// Create a consumer group
await fetch(`${base}/telemetry/consumergroups/workers`, {
  method: "PUT",
  headers: ATOM,
  body: `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">
    <ConsumerGroupDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect"/>
  </content></entry>`,
});
```

### Publish events (REST send)

```js
// Send a single event (BrokerProperties carries PartitionKey + system metadata,
// custom headers map to application properties)
await fetch(`${base}/telemetry/messages`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    BrokerProperties: JSON.stringify({ PartitionKey: "device-7", MessageId: "m1" }),
    priority: '"high"',
  },
  body: JSON.stringify({ temp: 21.5 }),
});

// Send to a specific partition
await fetch(`${base}/telemetry/partitions/2/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ temp: 22.0 }),
});

// Send a batch (lands together in one partition, like the real broker)
await fetch(`${base}/telemetry/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/vnd.microsoft.servicebus.json" },
  body: JSON.stringify([
    { Body: { temp: 1 }, UserProperties: { unit: "C" } },
    { Body: { temp: 2 } },
  ]),
});
```

### Consume events (receiveBatch)

```js
// Read metadata
const meta = await (await fetch(`${base}/telemetry/properties`)).json();
// { name, createdOn, partitionIds: ["0","1","2","3"] }

const part = await (await fetch(`${base}/telemetry/partitions/0/properties`)).json();
// { partitionId, beginningSequenceNumber, lastEnqueuedSequenceNumber, lastEnqueuedOffset, isEmpty }

// Read events from a partition (earliest by default)
const r = await (await fetch(`${base}/telemetry/partitions/0/events?maxMessageCount=10`)).json();
for (const ev of r.events) console.log(ev.sequenceNumber, ev.body);

// Read from a position: earliest | latest | fromSequenceNumber | fromOffset | fromEnqueuedTime
await fetch(`${base}/telemetry/partitions/0/events?fromSequenceNumber=5&inclusive=true`);
await fetch(`${base}/telemetry/partitions/0/events?position=latest`);

// Read via a named consumer group
await fetch(`${base}/telemetry/consumergroups/workers/partitions/0/events`);
```

### Using the real `@azure/event-hubs` client

The SDK's `EventHubProducerClient` / `EventHubConsumerClient` data plane speaks
**AMQP 1.0** and is therefore not wire-compatible with this HTTP fake. Use the
REST publish/consume endpoints above (or raw HTTP) to drive the fake. The
logical operations map 1:1:

| SDK call | Fake endpoint |
|----------|---------------|
| `producer.getEventHubProperties()` | `GET /{hub}/properties` |
| `producer.getPartitionIds()` | `GET /{hub}/partitions` |
| `producer.getPartitionProperties(id)` | `GET /{hub}/partitions/{id}/properties` |
| `producer.createBatch()` + `sendBatch(batch)` | `POST /{hub}/messages` (batch content-type) |
| `producer.sendBatch(events, { partitionId })` | `POST /{hub}/partitions/{id}/messages` |
| `producer.sendBatch(events, { partitionKey })` | `POST /{hub}/messages` + `BrokerProperties.PartitionKey` |
| `consumer.subscribe()` / `receiveBatch()` | `GET /{hub}/partitions/{id}/events?...` |
| consumer group | `GET /{hub}/consumergroups/{g}/partitions/{id}/events?...` |

The management surface is identical in shape to `@azure/arm-eventhub` /
`ServiceBusAdministrationClient`-style Atom entities.

## Implemented operations

### Internal (parlel)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/_parlel/health` | Health check + hub count |
| POST | `/_parlel/reset` | Reset all in-memory state |
| GET | `/_parlel/dump` | Dump hubs / partitions / consumer groups |

### Management — Event Hubs

| Method | Path | Operation |
|--------|------|-----------|
| PUT | `/{hub}` | CreateEventHub (PartitionCount, MessageRetentionInDays, Status) |
| GET | `/{hub}` | GetEventHub (Atom) |
| DELETE | `/{hub}` | DeleteEventHub |
| GET | `/$Resources/EventHubs` | ListEventHubs |

### Management — Consumer groups

| Method | Path | Operation |
|--------|------|-----------|
| PUT | `/{hub}/consumergroups/{group}` | CreateConsumerGroup (UserMetadata) |
| GET | `/{hub}/consumergroups/{group}` | GetConsumerGroup |
| DELETE | `/{hub}/consumergroups/{group}` | DeleteConsumerGroup (`$Default` is protected) |
| GET | `/{hub}/consumergroups` | ListConsumerGroups |

Every hub is created with the default `$Default` consumer group.

### Metadata (JSON — mirrors the SDK)

| Method | Path | Operation |
|--------|------|-----------|
| GET | `/{hub}/properties` | getEventHubProperties → `{ name, createdOn, partitionIds }` |
| GET | `/{hub}/partitions` | getPartitionIds → `{ partitionIds }` |
| GET | `/{hub}/partitions/{id}/properties` | getPartitionProperties → watermarks |

### Runtime — Publish

| Method | Path | Operation |
|--------|------|-----------|
| POST | `/{hub}/messages` | Send (single) |
| POST | `/{hub}/messages?partitionId=N` | Send to a partition (via query) |
| POST | `/{hub}/messages` + `BrokerProperties.PartitionKey` | Send by partition key |
| POST | `/{hub}/partitions/{id}/messages` | Send to a partition (via path) |
| POST | `/{hub}/messages` + `Content-Type: application/vnd.microsoft.servicebus.json` | SendBatch |

### Runtime — Consume

| Method | Path | Operation |
|--------|------|-----------|
| GET | `/{hub}/partitions/{id}/events?...` | receiveBatch (via `$Default` group) |
| GET | `/{hub}/consumergroups/{g}/partitions/{id}/events?...` | receiveBatch (via named group) |

Consume query parameters:

- `maxMessageCount` — cap on events returned (default 100).
- `position=earliest|latest` — start from the beginning or only future events.
- `fromSequenceNumber=N` — start after sequence N (add `inclusive=true` to include N).
- `fromOffset=N` — start after offset N (add `inclusive=true` to include N).
- `fromEnqueuedTime=<ms-or-ISO>` — start from the first event enqueued at/after the time.

### Event semantics

- **Partitions** — each hub has N ordered partitions; events get a per-partition monotonic `sequenceNumber` (starting at 0) and `offset`.
- **Partition routing** — explicit `partitionId` (path/query), `partitionKey` (deterministic hash → stable partition affinity), or automatic least-loaded spread. `partitionId` and `partitionKey` are mutually exclusive on a send.
- **Batches** — a whole batch lands in a single partition (mirrors real Event Hubs).
- **Watermarks** — `getPartitionProperties` reports `beginningSequenceNumber`, `lastEnqueuedSequenceNumber`, `lastEnqueuedOffset`, `lastEnqueuedOnUtc`, `isEmpty`.
- **EventData** — `messageId`, `correlationId`, `contentType` (from `BrokerProperties`) and custom application `properties` (from headers) round-trip through consume; `systemProperties` carry `x-opt-sequence-number`, `x-opt-offset`, `x-opt-enqueued-time`, `x-opt-partition-key`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported |
|---------|-----------|
| Event Hub management (create / get / delete / list, Atom) | ✅ |
| Consumer group management (create / get / delete / list) | ✅ |
| `$Default` consumer group auto-created + delete-protected | ✅ |
| getEventHubProperties / getPartitionIds / getPartitionProperties | ✅ |
| Send (single + batch) | ✅ |
| Send to explicit partition (path + query) | ✅ |
| Send by partition key (stable affinity) | ✅ |
| Automatic partition spread | ✅ |
| receiveBatch from earliest / latest | ✅ |
| receiveBatch from sequenceNumber / offset / enqueuedTime (inclusive flag) | ✅ |
| maxMessageCount cap | ✅ |
| Per-partition sequence numbers + offsets + watermarks | ✅ |
| BrokerProperties + custom application properties + system properties | ✅ |
| Max single-event size enforcement (1 MB → 413) | ✅ |
| AMQP 1.0 binary transport (`EventHubProducerClient`/`ConsumerClient` data plane) | ⟳ Roadmap — intentionally — REST publish/consume endpoints used instead |
| Checkpointing / `EventProcessorHost` / blob checkpoint store | ⟳ Roadmap — consume is stateless; pass a position each call |
| Consumer `ownerLevel` / epoch enforcement (exclusive readers) | ✓ By design — accepted, not enforced |
| Message retention expiry / log truncation | ⟳ Roadmap — events retained for process lifetime |
| Capture (to Blob/ADLS), geo-DR, throughput units, auto-inflate | ⟳ Roadmap |
| Shared Access Signature auth / RBAC | ✓ By design — all requests accepted (local fake) |

## Error codes / shapes

Errors are returned as Azure-style XML:

```xml
<Error><Code>404</Code><Detail>MessagingEntityNotFound: The Event Hub 'x' could not be found.</Detail></Error>
```

| HTTP status | Code | When |
|-------------|------|------|
| 400 | `BadRequest` | Malformed request / invalid batch JSON / partitionId+partitionKey together / unsupported method / `$Default` group delete |
| 400 | `ArgumentOutOfRange` | Invalid / non-existent partition id |
| 404 | `MessagingEntityNotFound` | Event hub or consumer group does not exist |
| 409 | `MessagingEntityAlreadyExists` | Creating a hub / consumer group that already exists |
| 413 | `MessageSizeExceeded` | Single event larger than 1 MB |
| 500 | `InternalServerError` | Unexpected server error |

Successful responses use Azure's conventions:

- Create → `201` with the entity's Atom `<entry>`.
- Get → `200` with the Atom `<entry>`.
- Delete → `200` (empty).
- Send → `201` with a `BrokerProperties` response header (`PartitionId`, `SequenceNumber`, `Offset`, `EnqueuedTimeUtc`).
- Metadata / consume → `200` with a JSON body.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
EVENTHUBS_NAMESPACE=parlel
EVENTHUBS_ENDPOINT=http://localhost:4595
EVENTHUBS_CONNECTION_STRING=Endpoint=sb://127.0.0.1:4595/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=parlellocaldevkey;UseDevelopmentEmulator=true
EVENTHUB_NAME=parlelhub
```

<!-- parlel:testenv:end -->
