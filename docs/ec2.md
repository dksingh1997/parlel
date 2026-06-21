# parlel/ec2

A zero-dependency, in-process fake of **AWS EC2**. Speaks the AWS Query (XML) wire
protocol, so the real `@aws-sdk/client-ec2` works against it unchanged.

| | |
|---|---|
| **Port** | `4700` |
| **Protocol** | AWS Query / XML (API version `2016-11-15`) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4700
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Supported operations

| Category | Operations |
|---|---|
| Instances | `RunInstances`, `DescribeInstances`, `StartInstances`, `StopInstances`, `TerminateInstances` |
| Security groups | `CreateSecurityGroup`, `DescribeSecurityGroups`, `AuthorizeSecurityGroupIngress` |
| VPC / Subnets | `CreateVpc`, `DescribeVpcs`, `CreateSubnet`, `DescribeSubnets` |
| Images | `DescribeImages` (one AMI is seeded: `ami-0abcdef1234567890`) |
| Tags | `CreateTags`, `DescribeTags` |
| Key pairs | `CreateKeyPair` |

Generated ids look like real EC2: `i-…`, `sg-…`, `vpc-…`, `subnet-…`, `ami-…`.

## SDK usage example

```js
import { EC2Client, RunInstancesCommand, DescribeInstancesCommand } from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({
  endpoint: "http://127.0.0.1:4700",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const run = await ec2.send(new RunInstancesCommand({
  ImageId: "ami-0abcdef1234567890",
  MinCount: 1,
  MaxCount: 1,
  InstanceType: "t3.small",
}));
const id = run.Instances[0].InstanceId;

const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
console.log(desc.Reservations[0].Instances[0].State.Name); // "running"
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

```js
const ec2 = new EC2Client({

  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },

});
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
|---|---|
| Lifecycle | State transitions are instantaneous; there is no `pending`/`stopping` interim state. |
| Networking | No real network connectivity; IPs are synthetic placeholders. |
| Filters | `Describe*` filters (`Filters` param) are not applied — id selection only. |
| AMIs | Only one AMI is seeded; `RegisterImage`/`CopyImage` are not implemented. |
| Auth | SigV4 is accepted but never validated. |
| Persistence | State is in-memory and lost on restart/reset. |
| Pagination | Results are returned in a single page. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4700
```

<!-- parlel:testenv:end -->
