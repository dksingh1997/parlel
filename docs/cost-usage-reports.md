# parlel/cost-usage-reports

A zero-dependency, in-process fake of the **AWS Cost and Usage Report Service (CUR)**.
Speaks AWS JSON 1.1 (`X-Amz-Target: AWSOrigamiServiceGatewayService.<Op>`).

| Property     | Value                                       |
| ------------ | ------------------------------------------- |
| Service name | `cost-usage-reports`                        |
| Port         | `4737`                                      |
| Protocol     | AWS JSON 1.1 (POST `/`)                     |
| Target       | `AWSOrigamiServiceGatewayService.<Operation>` |
| Healthcheck  | `GET /_parlel/health`                       |
| Account ID   | `000000000000`                              |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4737
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation                 | Notes                                                |
| ------------------------- | ---------------------------------------------------- |
| PutReportDefinition       | Creates a report; rejects duplicate names.           |
| DescribeReportDefinitions | Lists all report definitions.                        |
| DeleteReportDefinition    | Deletes by `ReportName`.                             |
| ModifyReportDefinition    | Updates (and optionally renames) a report.           |

Required fields validated on put/modify: `ReportName`, `S3Bucket`, `TimeUnit`.

## SDK example

```js
import {
  CostAndUsageReportServiceClient,
  PutReportDefinitionCommand,
  DescribeReportDefinitionsCommand,
} from "@aws-sdk/client-cost-and-usage-report-service";

const cur = new CostAndUsageReportServiceClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4737",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await cur.send(
  new PutReportDefinitionCommand({
    ReportDefinition: {
      ReportName: "monthly",
      TimeUnit: "MONTHLY",
      Format: "textORcsv",
      Compression: "GZIP",
      AdditionalSchemaElements: ["RESOURCES"],
      S3Bucket: "cur-bucket",
      S3Prefix: "cur/",
      S3Region: "us-east-1",
    },
  }),
);
const { ReportDefinitions } = await cur.send(new DescribeReportDefinitionsCommand({}));
console.log(ReportDefinitions[0].ReportName); // monthly
```

## Access via MCP / preview URL

When run inside parlel, CUR is reachable through the pool's MCP bridge and any
assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Limitation                                                    |
| ----------- | ------------------------------------------------------------- |
| Reports     | No actual cost/usage data is generated or delivered to S3.    |
| Validation  | Only required-field presence is checked.                      |
| Pagination  | Single-page `DescribeReportDefinitions`.                      |
| State       | In memory, cleared on reset.                                  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4737
```

<!-- parlel:testenv:end -->
