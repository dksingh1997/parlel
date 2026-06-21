# waf-v2 — AWS WAFv2

A zero-dependency, in-process emulator for AWS WAFv2 (Web ACLs, IP sets, and
rule groups).

| Property      | Value                 |
| ------------- | --------------------- |
| Port          | 4716                  |
| Protocol      | AWS JSON 1.1          |
| Target prefix | `AWSWAF_20190729`     |
| Health        | `GET /_parlel/health` |
| Reset         | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4716
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation       | Notes                            |
| --------------- | -------------------------------- |
| CreateWebACL    | Returns `Summary` with LockToken |
| ListWebACLs     | Filter by `Scope`                |
| GetWebACL       | Returns `WebACL` + LockToken     |
| DeleteWebACL    |                                  |
| CreateIPSet     | Requires `IPAddressVersion`      |
| ListIPSets      | Filter by `Scope`                |
| GetIPSet        |                                  |
| DeleteIPSet     |                                  |
| CreateRuleGroup | Requires `Capacity`              |
| ListRuleGroups  | Filter by `Scope`                |
| GetRuleGroup    |                                  |

`Scope` may be `REGIONAL` or `CLOUDFRONT`.

## SDK usage example

```ts
import { WAFV2Client, CreateWebACLCommand } from "@aws-sdk/client-wafv2";

const waf = new WAFV2Client({
  endpoint: "http://127.0.0.1:4716",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await waf.send(
  new CreateWebACLCommand({
    Name: "my-acl",
    Scope: "REGIONAL",
    DefaultAction: { Allow: {} },
    VisibilityConfig: {
      SampledRequestsEnabled: true,
      CloudWatchMetricsEnabled: true,
      MetricName: "myAcl",
    },
  }),
);
```

## Access via MCP / preview URL

Point any AWS SDK or MCP tool at the allocated preview URL via
`AWS_ENDPOINT_URL`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area              | Limitation                                       |
| ----------------- | ------------------------------------------------ |
| Rule evaluation   | Rules are stored but never evaluated against traffic |
| LockToken         | Returned but optimistic locking is not enforced  |
| Associations      | AssociateWebACL / resource scoping not implemented|
| Update operations | Update operations are not implemented            |
| State             | In-memory only; lost on restart                  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4716
```

<!-- parlel:testenv:end -->
