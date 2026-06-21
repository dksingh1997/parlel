# parlel/cloudtrail

A zero-dependency, in-process fake of **AWS CloudTrail**.
Speaks AWS JSON 1.1 (`X-Amz-Target: com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.<Op>`).

| Property     | Value                                                                |
| ------------ | -------------------------------------------------------------------- |
| Service name | `cloudtrail`                                                         |
| Port         | `4734`                                                               |
| Protocol     | AWS JSON 1.1 (POST `/`)                                              |
| Target       | `com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.<Operation>`|
| Healthcheck  | `GET /_parlel/health`                                               |
| Account ID   | `000000000000`                                                       |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4734
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation         | Notes                                                       |
| ----------------- | ----------------------------------------------------------- |
| CreateTrail       | Requires `Name` and `S3BucketName`.                        |
| DescribeTrails    | Optional `trailNameList` filter.                           |
| ListTrails        | Returns trail ARNs/names.                                  |
| GetTrailStatus    | Returns `IsLogging` and timestamps.                        |
| StartLogging      | Marks the trail as logging.                                |
| StopLogging       | Marks the trail as stopped.                                |
| DeleteTrail       | Removes the trail.                                         |
| UpdateTrail       | Mutates trail settings.                                    |
| LookupEvents      | Returns seeded audit events; supports `LookupAttributes`.  |
| PutEventSelectors | Stores event selectors.                                   |
| GetEventSelectors | Returns event selectors.                                  |

`LookupEvents` returns three seeded events (`ConsoleLogin`, `RunInstances`,
`CreateBucket`), each with a full `CloudTrailEvent` JSON payload.

## SDK example

```js
import {
  CloudTrailClient,
  CreateTrailCommand,
  StartLoggingCommand,
  LookupEventsCommand,
} from "@aws-sdk/client-cloudtrail";

const ct = new CloudTrailClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4734",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await ct.send(new CreateTrailCommand({ Name: "audit", S3BucketName: "logs" }));
await ct.send(new StartLoggingCommand({ Name: "audit" }));
const { Events } = await ct.send(new LookupEventsCommand({}));
console.log(Events[0].EventName);
```

## Access via MCP / preview URL

When run inside parlel, CloudTrail is reachable through the pool's MCP bridge and
any assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area          | Limitation                                                  |
| ------------- | ----------------------------------------------------------- |
| Events        | `LookupEvents` returns fixed seeded events, not live logs.  |
| Log delivery  | No real S3 objects are written.                             |
| Insights      | CloudTrail Insights and Lake are not implemented.           |
| State         | In memory, cleared on reset (events re-seeded).             |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4734
```

<!-- parlel:testenv:end -->
