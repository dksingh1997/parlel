# Kafka

Lightweight, dependency-free Kafka broker emulator speaking the Kafka binary
wire protocol, so the standard `kafkajs` client can connect.

| Key | Value |
|-----|-------|
| Port | 9092 |
| Protocol | Kafka wire protocol (TCP) |
| Size | ~90 KB |
| Startup | fast |

## Default Connection

```
localhost:9092
```

## Supported APIs

| Area | Operations |
|------|-----------|
| Cluster | ApiVersions, Metadata, FindCoordinator |
| Topics | CreateTopics, DeleteTopics, ListTopics (incl. multi-partition) |
| Produce | Produce one or many messages, partition distribution |
| Consume | Fetch from offset, per-partition offset tracking, ListOffsets |
| Groups | JoinGroup, SyncGroup, Heartbeat, LeaveGroup, OffsetCommit/Fetch |

## Usage

`localhost:9092` and your app connects with the **unmodified** real
`kafkajs` client — no Parlel code in the app.

```bash

```

```typescript
import { Kafka } from "kafkajs";

const kafka = new Kafka({ brokers: ["localhost:9092"] });

const admin = kafka.admin();
await admin.createTopics({ topics: [{ topic: "events", numPartitions: 3 }] });

const producer = kafka.producer();
await producer.connect();
await producer.send({ topic: "events", messages: [{ value: "hello" }] });

const consumer = kafka.consumer({ groupId: "g1" });
await consumer.subscribe({ topic: "events", fromBeginning: true });
```

## Access via Parlel Sandbox

Kafka uses a binary wire protocol, so `parlel_execute` does not drive it — point

exposes Kafka at `localhost:9092`, tunneling the raw protocol as TCP over

CLI. Because Kafka advertises its broker as `localhost:9092` in metadata
(and clients reconnect there), the bridge listens on `9092` so that reconnect
lands correctly. A real `kafkajs` producer and consumer group produce and
consume end-to-end.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Topics / partitions / produce / fetch | Supported |
| Consumer groups (basic) | Supported |
| Transactions / exactly-once | Not supported |
| Compression / SASL / TLS | Not supported |
