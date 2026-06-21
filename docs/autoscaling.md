# autoscaling

A zero-dependency, in-process fake of **AWS Auto Scaling** (EC2 Auto Scaling
groups, launch configurations, and launch templates). Speaks the AWS Query
(XML) wire protocol (API version `2011-01-01`, member-style lists), so the
real `@aws-sdk/client-auto-scaling` works against it unchanged.

| | |
|---|---|
| **Port** | `4706` |
| **Protocol** | AWS Query / XML (API version `2011-01-01`, member-style lists) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4706
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Implemented operations

| Category | Operations |
|---|---|
| Auto Scaling groups | `CreateAutoScalingGroup`, `DescribeAutoScalingGroups`, `UpdateAutoScalingGroup`, `DeleteAutoScalingGroup`, `SetDesiredCapacity` |
| Launch configurations | `CreateLaunchConfiguration`, `DescribeLaunchConfigurations` |
| Launch templates | `CreateLaunchTemplate` (technically an EC2-API operation, included here for convenience) |

Setting/updating `DesiredCapacity` synthesizes or removes placeholder
instances (`i-…`) so describes reflect the requested capacity.

## SDK usage example

```js
import { AutoScalingClient, CreateAutoScalingGroupCommand, SetDesiredCapacityCommand } from "@aws-sdk/client-auto-scaling";

const asg = new AutoScalingClient({
  endpoint: "http://127.0.0.1:4706",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await asg.send(new CreateAutoScalingGroupCommand({
  AutoScalingGroupName: "web-asg",
  LaunchConfigurationName: "web-lc",
  MinSize: 1, MaxSize: 5, DesiredCapacity: 2,
  AvailabilityZones: ["us-east-1a"],
}));
await asg.send(new SetDesiredCapacityCommand({ AutoScalingGroupName: "web-asg", DesiredCapacity: 4 }));
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Status | Notes |
|---|---|---|
| CreateAutoScalingGroup | ✅ | Full request parsing, required-field validation, duplicate name detection. |
| DescribeAutoScalingGroups | ✅ | Filter by name, all response fields including empty elements for optional fields. |
| UpdateAutoScalingGroup | ✅ | Partial update of min/max/desired/cooldown/health check/AZs. |
| DeleteAutoScalingGroup | ✅ | ResourceInUse guard, ForceDelete support. |
| SetDesiredCapacity | ✅ | Scales synthetic instances up/down to match desired capacity. |
| CreateLaunchConfiguration | ✅ | Full field set: ImageId, InstanceType, KeyName, SecurityGroups, UserData, EbsOptimized, InstanceMonitoring, etc. |
| DescribeLaunchConfigurations | ✅ | Filter by name, all response fields. |
| CreateLaunchTemplate | ✅ | Minimal single-version template; returns LaunchTemplateId (lt-…). |
| Error envelope | ✅ | Matches real AWS XML error shape: ErrorResponse > Error > Type/Code/Message + RequestId. Status codes match real API. |
| Response XML namespace | ✅ | `https://autoscaling.amazonaws.com/doc/2011-01-01/` (matches real API). |
| Empty element handling | ✅ | Optional empty fields rendered as self-closing `<tag/>` (matches real API). |
| Instances | ✓ by design | Synthetic placeholders (`i-…`); nothing launched in the EC2 emulator. |
| Scaling policies | ⟳ roadmap | Target tracking / step scaling policies & CloudWatch alarms are not implemented. |
| Lifecycle hooks | ⟳ roadmap | Lifecycle hooks, warm pools, and instance refresh are not modeled. |
| Health checks | ◐ | `HealthCheckType` is recorded but no health evaluation happens. |
| Launch templates | ◐ | A minimal single-version template only; `CreateLaunchTemplateVersion` is not implemented. |
| MixedInstancesPolicy | ⟳ roadmap | Not yet parsed or stored. |
| Auth | ✓ by design | SigV4 is accepted but never validated. |
| Persistence | ✓ by design | In-memory; lost on restart/reset. |

## Error codes & shapes

Errors follow the real AWS Auto Scaling XML error envelope:

```xml
<ErrorResponse xmlns="https://autoscaling.amazonaws.com/doc/2011-01-01/">
  <Error>
    <Type>Sender</Type>
    <Code>ValidationError</Code>
    <Message>Human-readable error message</Message>
  </Error>
  <RequestId>…</RequestId>
</ErrorResponse>
```

| Code | HTTP Status | When |
|---|---|---|
| `ValidationError` | 400 | Missing required field, invalid action, invalid parameter. |
| `AlreadyExists` | 400 | Duplicate ASG or launch configuration name. |
| `InvalidParameterValue` | 400 | Reserved for future validation. |
| `InvalidParameterCombination` | 400 | Reserved for future validation. |
| `MissingParameter` | 400 | Reserved for future validation. |
| `ResourceInUse` | 400 | DeleteAutoScalingGroup with instances and no ForceDelete. |
| `InternalFailure` | 500 | Unhandled server error. |

The `<Type>` element is `Sender` for 4xx errors and `Receiver` for 5xx errors,
matching the real AWS behavior.

## Manifest

```json
{
  "name": "autoscaling",
  "version": "0.1",
  "port": 4706,
  "protocol": "http",
  "healthcheck": "/_parlel/health"
}
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4706
```

<!-- parlel:testenv:end -->
