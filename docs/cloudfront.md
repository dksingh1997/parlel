# cloudfront — CloudFront CDN

A zero-dependency, in-process emulator for AWS CloudFront distributions,
invalidations, and origin access controls.

| Property    | Value                 |
| ----------- | --------------------- |
| Port        | 4712                  |
| Protocol    | REST / XML            |
| API Version | 2020-05-31            |
| Health      | `GET /_parlel/health` |
| Reset       | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4712
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation                  | Path                                                        |
| -------------------------- | ---------------------------------------------------------- |
| CreateDistribution         | `POST /2020-05-31/distribution`                            |
| ListDistributions          | `GET /2020-05-31/distribution`                             |
| GetDistribution            | `GET /2020-05-31/distribution/{id}`                        |
| DeleteDistribution         | `DELETE /2020-05-31/distribution/{id}` (must be disabled)  |
| CreateInvalidation         | `POST /2020-05-31/distribution/{id}/invalidation`          |
| ListInvalidations          | `GET /2020-05-31/distribution/{id}/invalidation`           |
| GetInvalidation            | `GET /2020-05-31/distribution/{id}/invalidation/{invId}`   |
| CreateOriginAccessControl  | `POST /2020-05-31/origin-access-control`                   |
| ListOriginAccessControls   | `GET /2020-05-31/origin-access-control`                    |

Distributions are reported `Deployed` immediately; invalidations complete
instantly. Deleting an `Enabled` distribution returns `DistributionNotDisabled`.

## SDK usage example

```ts
import {
  CloudFrontClient,
  CreateDistributionCommand,
} from "@aws-sdk/client-cloudfront";

const cf = new CloudFrontClient({
  endpoint: "http://127.0.0.1:4712",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await cf.send(
  new CreateDistributionCommand({
    DistributionConfig: {
      CallerReference: `${Date.now()}`,
      Comment: "test",
      Enabled: true,
      Origins: {
        Quantity: 1,
        Items: [{ Id: "o1", DomainName: "example.s3.amazonaws.com" }],
      },
      DefaultCacheBehavior: { TargetOriginId: "o1", ViewerProtocolPolicy: "allow-all" } as any,
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
| Caching / serving | No actual edge serving or caching                |
| UpdateDistribution| Not implemented (config is immutable after create)|
| Cache behaviors   | Stored loosely; not evaluated                    |
| ETag concurrency  | ETag returned but If-Match is not enforced       |
| State             | In-memory only; lost on restart                  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4712
```

<!-- parlel:testenv:end -->
