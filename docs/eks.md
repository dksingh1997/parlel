# parlel/eks

A zero-dependency, in-process fake of **AWS EKS** (Elastic Kubernetes Service).
EKS uses the AWS REST-JSON protocol (HTTP method + path), so the real
`@aws-sdk/client-eks` works against it unchanged.

| | |
|---|---|
| **Port** | `4704` |
| **Protocol** | AWS REST-JSON (e.g. `POST /clusters`, `GET /clusters/{name}`) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4704
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Supported operations

| Operation | Route |
|---|---|
| `CreateCluster` | `POST /clusters` |
| `ListClusters` | `GET /clusters` |
| `DescribeCluster` | `GET /clusters/{name}` |
| `DeleteCluster` | `DELETE /clusters/{name}` |
| `CreateAccessEntry` | `POST /clusters/{name}/access-entries` |
| `ListAccessEntries` | `GET /clusters/{name}/access-entries` |

## SDK usage example

```js
import { EKSClient, CreateClusterCommand, DescribeClusterCommand } from "@aws-sdk/client-eks";

const eks = new EKSClient({
  endpoint: "http://127.0.0.1:4704",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await eks.send(new CreateClusterCommand({
  name: "demo",
  roleArn: "arn:aws:iam::000000000000:role/eks",
  resourcesVpcConfig: { subnetIds: ["subnet-123"] },
}));
const d = await eks.send(new DescribeClusterCommand({ name: "demo" }));
console.log(d.cluster.status); // "ACTIVE"
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
|---|---|
| Control plane | No real Kubernetes API server is provisioned; `endpoint` is synthetic and unreachable. |
| Lifecycle | Clusters become `ACTIVE` instantly; no `CREATING`/`DELETING` polling delay. |
| Node groups | Managed node groups, Fargate profiles, and add-ons are not implemented. |
| Access entries | Access policies (`AssociateAccessPolicy`) are not modeled, only entries. |
| Auth | SigV4 is accepted but never validated. |
| Persistence | In-memory; lost on restart/reset. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4704
```

<!-- parlel:testenv:end -->
