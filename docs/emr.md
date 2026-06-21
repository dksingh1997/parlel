# parlel/emr

A zero-dependency, in-process fake of **AWS EMR** (Elastic MapReduce). Speaks the
AWS JSON 1.1 wire protocol, so the real `@aws-sdk/client-emr` works against it
unchanged.

| | |
|---|---|
| **Port** | `4709` |
| **Protocol** | AWS JSON 1.1 (`X-Amz-Target: ElasticMapReduce.<Op>`) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4709
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Supported operations

| Category | Operations |
|---|---|
| Clusters | `RunJobFlow`, `ListClusters`, `DescribeCluster`, `TerminateJobFlows` |
| Steps | `AddJobFlowSteps`, `ListSteps`, `DescribeStep` |

Generated ids: `j-…` (clusters / job flows), `s-…` (steps).

## SDK usage example

```js
import { EMRClient, RunJobFlowCommand, ListStepsCommand } from "@aws-sdk/client-emr";

const emr = new EMRClient({
  endpoint: "http://127.0.0.1:4709",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const r = await emr.send(new RunJobFlowCommand({
  Name: "etl-cluster",
  ReleaseLabel: "emr-7.1.0",
  Instances: { InstanceCount: 3, KeepJobFlowAliveWhenNoSteps: true },
  Applications: [{ Name: "Spark" }],
  Steps: [{ Name: "ingest", HadoopJarStep: { Jar: "command-runner.jar", Args: ["spark-submit", "job.py"] } }],
}));
const steps = await emr.send(new ListStepsCommand({ ClusterId: r.JobFlowId }));
console.log(steps.Steps[0].Status.State); // "COMPLETED"
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
|---|---|
| Execution | Nothing runs — clusters land in `WAITING` and steps are immediately `COMPLETED`. |
| Instances | Instance groups/fleets are recorded opaquely; no real EC2 provisioning. |
| Step types | All steps are treated as Hadoop JAR steps; logs and stderr/stdout are not captured. |
| Auto-scaling | Managed scaling, instance fleets, and bootstrap actions are not modeled. |
| Auth | SigV4 is accepted but never validated. |
| Persistence | In-memory; lost on restart/reset. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4709
```

<!-- parlel:testenv:end -->
