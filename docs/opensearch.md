# OpenSearch (parlel emulator)

A zero-dependency, in-process fake of the Amazon OpenSearch Service control
plane. The data plane reuses the parlel `elasticsearch` emulator.

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4726                           |
| Protocol    | REST/JSON (paths under `/2021-01-01/opensearch`) |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Default connection

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4726
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations / paths

| Operation         | Path                                          |
| ----------------- | --------------------------------------------- |
| CreateDomain      | `POST   /2021-01-01/opensearch/domain`        |
| DescribeDomain    | `GET    /2021-01-01/opensearch/domain/{name}` |
| ListDomainNames   | `GET    /2021-01-01/opensearch/domain`        |
| DescribeDomains   | `POST   /2021-01-01/opensearch/domain-info`   |
| DeleteDomain      | `DELETE /2021-01-01/opensearch/domain/{name}` |

## SDK example

```ts
import { OpenSearchClient, CreateDomainCommand } from "@aws-sdk/client-opensearch";

const os = new OpenSearchClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4726",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { DomainStatus } = await os.send(new CreateDomainCommand({ DomainName: "logs" }));
console.log(DomainStatus?.Endpoint); // search-logs-parlel.us-east-1.es.amazonaws.com
```

For indexing/searching documents, point an OpenSearch/Elasticsearch client at
the parlel `elasticsearch` emulator.

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Limitation                                                  |
| ----------- | ----------------------------------------------------------- |
| Data plane  | This is control-plane only — use the elasticsearch emulator.|
| Provisioning| Domains are usable immediately; cluster config is cosmetic. |
| VPC / IAM   | Network and access policies are stored but not enforced.    |
| Upgrades    | `UpgradeDomain` is not implemented.                         |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4726
```

<!-- parlel:testenv:end -->
