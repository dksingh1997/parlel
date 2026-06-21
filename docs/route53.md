# route53 — Route 53 DNS

A zero-dependency, in-process emulator for AWS Route 53 hosted zones and
resource record sets.

| Property    | Value                 |
| ----------- | --------------------- |
| Port        | 4711                  |
| Protocol    | REST / XML            |
| API Version | 2013-04-01            |
| Health      | `GET /_parlel/health` |
| Reset       | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4711
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation                  | Path                                          |
| -------------------------- | --------------------------------------------- |
| CreateHostedZone           | `POST /2013-04-01/hostedzone`                 |
| ListHostedZones            | `GET /2013-04-01/hostedzone`                  |
| GetHostedZone              | `GET /2013-04-01/hostedzone/{id}`             |
| DeleteHostedZone           | `DELETE /2013-04-01/hostedzone/{id}`          |
| ChangeResourceRecordSets   | `POST /2013-04-01/hostedzone/{id}/rrset`      |
| ListResourceRecordSets     | `GET /2013-04-01/hostedzone/{id}/rrset`       |

New zones are seeded with NS and SOA records, matching real Route 53.
`DeleteHostedZone` refuses a zone that still has non-NS/SOA records.

## SDK usage example

```ts
import {
  Route53Client,
  CreateHostedZoneCommand,
  ChangeResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";

const r53 = new Route53Client({
  endpoint: "http://127.0.0.1:4711",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { HostedZone } = await r53.send(
  new CreateHostedZoneCommand({
    Name: "example.com",
    CallerReference: `${Date.now()}`,
  }),
);

await r53.send(
  new ChangeResourceRecordSetsCommand({
    HostedZoneId: HostedZone!.Id!,
    ChangeBatch: {
      Changes: [
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: "www.example.com",
            Type: "A",
            TTL: 300,
            ResourceRecords: [{ Value: "1.2.3.4" }],
          },
        },
      ],
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

| Area              | Limitation                                      |
| ----------------- | ----------------------------------------------- |
| DNS resolution    | Records are stored, never actually resolved     |
| Change tracking   | `GetChange` is not implemented; changes PENDING |
| Routing policies  | Weighted/latency/geo policies are not evaluated |
| Health checks     | Not supported                                   |
| Pagination        | Always returns the full list (not truncated)    |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4711
```

<!-- parlel:testenv:end -->
