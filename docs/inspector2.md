# parlel/inspector2

A zero-dependency, in-process fake of **AWS Inspector2**.
Speaks the REST/JSON wire protocol used by `@aws-sdk/client-inspector2`.

| Property     | Value                          |
| ------------ | ------------------------------ |
| Service name | `inspector2`                   |
| Port         | `4735`                         |
| Protocol     | REST/JSON (POST to op paths)   |
| Healthcheck  | `GET /_parlel/health`          |
| Account ID   | `000000000000`                 |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4735
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation               | Path                          |
| ----------------------- | ----------------------------- |
| ListFindings            | `POST /findings/list`         |
| ListCoverage            | `POST /coverage/list`         |
| CreateFilter            | `POST /filters/create`        |
| ListFilters             | `POST /filters/list`          |
| DeleteFilter            | `POST /filters/delete`        |
| Enable                  | `POST /enable`                |
| Disable                 | `POST /disable`               |
| BatchGetAccountStatus   | `POST /status/batch/get`      |

`ListFindings` returns seeded findings (a package vulnerability and a network
reachability finding) and supports `filterCriteria` for `severity` and
`findingType`. `ListCoverage` returns seeded covered resources.

## SDK example

```js
import { Inspector2Client, ListFindingsCommand, EnableCommand } from "@aws-sdk/client-inspector2";

const ins = new Inspector2Client({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4735",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await ins.send(new EnableCommand({ resourceTypes: ["EC2", "ECR"] }));
const { findings } = await ins.send(new ListFindingsCommand({}));
console.log(findings[0].severity);
```

## Access via MCP / preview URL

When run inside parlel, Inspector2 is reachable through the pool's MCP bridge and
any assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area       | Limitation                                                     |
| ---------- | -------------------------------------------------------------- |
| Findings   | Findings are seeded fixtures, not produced by real scanning.   |
| Filters    | Filters are stored but never applied to suppress findings.     |
| Pagination | Single-page responses; `nextToken` is not implemented.         |
| State      | In memory, cleared on reset (findings/coverage re-seeded).     |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4735
```

<!-- parlel:testenv:end -->
