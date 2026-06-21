# xray (parlel)

A zero-dependency, in-process fake of AWS X-Ray. Speaks the X-Ray REST/JSON API.

| Field | Value |
| --- | --- |
| Service | `xray` |
| Port | `4744` |
| Protocol | REST / JSON |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4744
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation | HTTP |
| --- | --- |
| PutTraceSegments | `POST /TraceSegments` |
| BatchGetTraces | `POST /Traces` |
| GetTraceSummaries | `POST /TraceSummaries` |
| PutTelemetryRecords | `POST /TelemetryRecords` |
| GetSamplingRules | `POST /GetSamplingRules` or `GET /GetSamplingRules` |

`PutTraceSegments` accepts `TraceSegmentDocuments` (JSON strings) and groups
them by `trace_id`. `BatchGetTraces` returns each trace's segments and computes
a duration from `start_time`/`end_time`. A `Default` sampling rule is seeded.

## SDK example

```js
import { XRayClient, PutTraceSegmentsCommand } from "@aws-sdk/client-xray";

const xray = new XRayClient({
  endpoint: "http://127.0.0.1:4744",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await xray.send(new PutTraceSegmentsCommand({
  TraceSegmentDocuments: [JSON.stringify({
    trace_id: "1-58406520-a006649127e371903a2de979",
    id: "6226467e3f845502",
    name: "my-service",
    start_time: 1700000000.0,
    end_time: 1700000001.5,
  })],
}));
```

## Access via MCP / preview URL

Under the parlel pool, reach this service through the MCP gateway and the pool's
preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| Service graph | `GetServiceGraph` not implemented. |
| Sampling | Rules are seeded/returned but no sampling decisions are made. |
| Insights | Not implemented. |
| Encryption config | Not implemented. |
| Time filters | `GetTraceSummaries` ignores `StartTime`/`EndTime` windows. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4744
```

<!-- parlel:testenv:end -->
