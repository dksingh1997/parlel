# cloudwatch-logs (parlel)

A zero-dependency, in-process fake of Amazon CloudWatch Logs. Speaks the AWS
JSON 1.1 wire protocol (`X-Amz-Target: Logs_20140328.<Operation>`). This is the
standalone "extend CloudWatch with Logs" deliverable.

| Field | Value |
| --- | --- |
| Service | `cloudwatch-logs` |
| Port | `4745` |
| Protocol | AWS JSON 1.1 |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4745
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation | Notes |
| --- | --- |
| CreateLogGroup | Rejects duplicates. |
| DescribeLogGroups | Optional `logGroupNamePrefix`. |
| DeleteLogGroup | |
| CreateLogStream | |
| DescribeLogStreams | Optional `logStreamNamePrefix`. |
| DeleteLogStream | |
| PutLogEvents | Returns/validates `nextSequenceToken`. |
| GetLogEvents | `startTime`/`endTime`/`limit`/`startFromHead`. |
| FilterLogEvents | Basic substring/term filter pattern. |
| PutRetentionPolicy | Stores `retentionInDays`. |
| TagLogGroup / ListTagsLogGroup / UntagLogGroup | |

### Filter patterns

`FilterLogEvents` supports a simplified CloudWatch Logs pattern:

- plain term — message must contain it (AND across terms)
- `-term` — message must **not** contain it
- `?term` — at least one optional term must match (OR group)
- `"quoted phrase"` — matched as a substring

## SDK example

```js
import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const logs = new CloudWatchLogsClient({
  endpoint: "http://127.0.0.1:4745",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await logs.send(new PutLogEventsCommand({
  logGroupName: "/app/api",
  logStreamName: "instance-1",
  logEvents: [{ timestamp: Date.now(), message: "started" }],
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
| Retention | `retentionInDays` is stored but events are never expired. |
| Metric filters | Not implemented. |
| Subscription filters | Not implemented. |
| Insights queries | `StartQuery`/`GetQueryResults` not implemented. |
| Filter pattern | Substring/term matching only (no JSON/metric syntax). |
| Pagination | Tokens are generated but events are returned in full per call. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4745
```

<!-- parlel:testenv:end -->
