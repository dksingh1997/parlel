# RabbitMQ

Lightweight, dependency-free RabbitMQ emulator speaking the AMQP 0-9-1 binary
protocol.

| Key | Value |
|-----|-------|
| Port | 5672 |
| Protocol | AMQP 0-9-1 (TCP) |
| Size | ~90 KB |
| Startup | fast |

## Default Connection

```
amqp://parlel:parlel@localhost:5672
```

## Supported Operations

| Area | Operations |
|------|-----------|
| Connection | Handshake (Connection.Start/Tune/Open), channels |
| Queues | Queue.Declare, Queue.Delete |
| Exchanges | Exchange.Declare, Exchange.Delete |
| Messaging | Basic.Publish (push), Basic.Get / Basic.Consume (consume) |

## Usage

`localhost:5672` and your app connects with the **unmodified** real
`amqplib` client — no Parlel code in the app.

```bash

```

```typescript
import amqp from "amqplib";

const conn = await amqp.connect("amqp://parlel:parlel@localhost:5672");
const ch = await conn.createChannel();
await ch.assertQueue("tasks");
ch.sendToQueue("tasks", Buffer.from("hello"));
const msg = await ch.get("tasks");
```

## Access via Parlel Sandbox

RabbitMQ uses the binary AMQP protocol, so `parlel_execute` does not drive it —

sidecar exposes RabbitMQ at `localhost:5672`, tunneling the raw AMQP

`localhost` if you run the bridge outside Docker and publish ports). No SSH

handshake, declares queues, publishes, and consumes (both push delivery and
`Basic.Get`) end-to-end.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Queues / exchanges / publish / consume | Supported |
| Routing keys / bindings / topic exchanges | Simplified |
| Acknowledgements / prefetch / DLX | Not enforced |
| TLS / vhosts | Not supported |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
RABBITMQ_DEFAULT_USER=parlel
RABBITMQ_DEFAULT_PASS=parlel
RABBITMQ_DEFAULT_VHOST=/
```

<!-- parlel:testenv:end -->
