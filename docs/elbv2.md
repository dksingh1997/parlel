# elbv2 — Elastic Load Balancing v2

A zero-dependency, in-process emulator for AWS ELBv2 (Application / Network /
Gateway load balancers).

| Property   | Value                          |
| ---------- | ------------------------------ |
| Port       | 4710                           |
| Protocol   | AWS Query / XML                |
| API Version| 2015-12-01                     |
| Health     | `GET /_parlel/health`          |
| Reset      | `POST /_parlel/reset`          |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4710
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

Any credentials are accepted — auth is never verified.

## Supported operations

| Operation              | Notes                                  |
| ---------------------- | -------------------------------------- |
| CreateLoadBalancer     | Generates ARN + DNSName                |
| DescribeLoadBalancers  | Filter by ARNs or Names                |
| DeleteLoadBalancer     | Cascades to listeners                  |
| CreateTargetGroup      | Generates ARN                          |
| DescribeTargetGroups   | Filter by ARNs or Names                |
| DeleteTargetGroup      |                                        |
| RegisterTargets        | Targets reported `healthy`             |
| DeregisterTargets      |                                        |
| DescribeTargetHealth   |                                        |
| CreateListener         | Requires existing load balancer        |
| DescribeListeners      | Filter by LoadBalancerArn / ARNs       |
| DeleteListener         | Cascades to rules                      |
| CreateRule             | Requires existing listener             |
| DescribeRules          | Filter by ListenerArn / ARNs           |

## SDK usage example

```ts
import {
  ElasticLoadBalancingV2Client,
  CreateLoadBalancerCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";

const elbv2 = new ElasticLoadBalancingV2Client({
  endpoint: "http://127.0.0.1:4710",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await elbv2.send(
  new CreateLoadBalancerCommand({
    Name: "my-alb",
    Subnets: ["subnet-aaa", "subnet-bbb"],
  }),
);
```

## Access via MCP / preview URL

When launched through the parlel pool, the service is reachable at the
allocated preview URL (e.g. `http://<host>:4710`). Point any AWS SDK or MCP
tool at that endpoint via `AWS_ENDPOINT_URL`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area                | Limitation                                       |
| ------------------- | ------------------------------------------------ |
| Target health       | Always reported `healthy` (no real checks)       |
| Listener rules      | Stored but not evaluated for routing             |
| Attributes          | LB/TG attributes are not persisted               |
| Tags                | Accepted on create but not queryable             |
| State               | In-memory only; lost on restart                  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4710
```

<!-- parlel:testenv:end -->
