# parlel/ecs

A zero-dependency, in-process fake of **AWS ECS** (Elastic Container Service).
Speaks the AWS JSON 1.1 wire protocol, so the real `@aws-sdk/client-ecs` works
against it unchanged.

| | |
|---|---|
| **Port** | `4703` |
| **Protocol** | AWS JSON 1.1 (`X-Amz-Target: AmazonEC2ContainerServiceV20141113.<Op>`) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4703
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Supported operations

| Category | Operations |
|---|---|
| Clusters | `CreateCluster`, `ListClusters`, `DescribeClusters`, `DeleteCluster` |
| Task definitions | `RegisterTaskDefinition`, `ListTaskDefinitions` |
| Tasks | `RunTask`, `ListTasks`, `DescribeTasks`, `StopTask` |
| Services | `CreateService`, `ListServices`, `DescribeServices`, `UpdateService`, `DeleteService` |

## SDK usage example

```js
import { ECSClient, CreateClusterCommand, RegisterTaskDefinitionCommand, RunTaskCommand } from "@aws-sdk/client-ecs";

const ecs = new ECSClient({
  endpoint: "http://127.0.0.1:4703",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await ecs.send(new CreateClusterCommand({ clusterName: "prod" }));
await ecs.send(new RegisterTaskDefinitionCommand({
  family: "web",
  containerDefinitions: [{ name: "nginx", image: "nginx:latest" }],
}));
const run = await ecs.send(new RunTaskCommand({ cluster: "prod", taskDefinition: "web", count: 2 }));
console.log(run.tasks.map((t) => t.lastStatus)); // ["RUNNING", "RUNNING"]
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
|---|---|
| Scheduling | Tasks go straight to `RUNNING`; there is no real placement or container runtime. |
| Services | `runningCount` always equals `desiredCount`; no rolling deployments or health checks. |
| Container instances | EC2 container instances / capacity providers are not modeled. |
| Networking | `awsvpc` ENI attachments are not created. |
| Auth | SigV4 is accepted but never validated. |
| Persistence | In-memory; lost on restart/reset. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4703
```

<!-- parlel:testenv:end -->
