# iot-core (parlel)

A zero-dependency, in-process fake of AWS IoT Core. Covers the control-plane
Thing registry and the device-shadow REST surface.

| Field | Value |
| --- | --- |
| Service | `iot-core` |
| Port | `4743` |
| Protocol | REST / JSON |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4743
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation | HTTP |
| --- | --- |
| CreateThing | `POST /things/{name}` |
| ListThings | `GET /things` |
| DescribeThing | `GET /things/{name}` |
| UpdateThing | `PATCH /things/{name}` |
| DeleteThing | `DELETE /things/{name}` |
| GetThingShadow | `GET /things/{name}/shadow[?name={shadowName}]` |
| UpdateThingShadow | `POST /things/{name}/shadow[?name={shadowName}]` |
| DeleteThingShadow | `DELETE /things/{name}/shadow[?name={shadowName}]` |

Shadows track `desired`/`reported` state and compute the `delta` (keys whose
desired value differs from reported). Each update bumps the shadow `version`.
Named shadows are supported via the `name` query parameter; the default shadow
is `$default`.

## MQTT over WebSocket

MQTT (incl. MQTT-over-WebSocket on `wss://<endpoint>/mqtt`) is **not**
implemented in this fake. Only the HTTPS control plane and the shadow REST
surface are emulated. For pub/sub message flows, point your code at the parlel
`rabbitmq` or `sns`/`sqs` fakes instead.

## SDK example

```js
import { IoTClient, CreateThingCommand } from "@aws-sdk/client-iot";

const iot = new IoTClient({
  endpoint: "http://127.0.0.1:4743",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await iot.send(new CreateThingCommand({
  thingName: "sensor-1",
  attributePayload: { attributes: { room: "kitchen" } },
}));
```

For shadows, use the IoT Data Plane client (`@aws-sdk/client-iot-data-plane`)
pointed at the same endpoint.

## Access via MCP / preview URL

Under the parlel pool, reach this service through the MCP gateway and the pool's
preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| MQTT | No MQTT broker / WebSocket transport. |
| Certificates / policies | Not implemented. |
| Thing types / groups | `thingTypeName` is stored but not validated. |
| Rules engine | Not implemented. |
| Jobs / fleet provisioning | Not implemented. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4743
```

<!-- parlel:testenv:end -->
