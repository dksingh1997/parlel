# batch

A zero-dependency, in-process fake of **AWS Batch**. Batch uses the AWS
REST-JSON protocol with fixed POST paths under `/v1`, so the real
`@aws-sdk/client-batch` works against it unchanged.

| | |
|---|---|
| **Port** | `4705` |
| **Protocol** | AWS REST-JSON (e.g. `POST /v1/submitjob`, `POST /v1/describejobs`) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4705
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Implemented operations

| Operation | Route |
|---|---|
| `CreateJobQueue` | `POST /v1/createjobqueue` |
| `DescribeJobQueues` | `POST /v1/describejobqueues` |
| `RegisterJobDefinition` | `POST /v1/registerjobdefinition` |
| `DescribeJobDefinitions` | `POST /v1/describejobdefinitions` |
| `SubmitJob` | `POST /v1/submitjob` |
| `DescribeJobs` | `POST /v1/describejobs` |
| `ListJobs` | `POST /v1/listjobs` |
| `CancelJob` | `POST /v1/canceljob` |

## SDK usage example

```js
import { BatchClient, CreateJobQueueCommand, SubmitJobCommand, DescribeJobsCommand } from "@aws-sdk/client-batch";

const batch = new BatchClient({
  endpoint: "http://127.0.0.1:4705",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await batch.send(new CreateJobQueueCommand({ jobQueueName: "jq", priority: 1, computeEnvironmentOrder: [] }));
const s = await batch.send(new SubmitJobCommand({ jobName: "myjob", jobQueue: "jq", jobDefinition: "echo:1" }));
const d = await batch.send(new DescribeJobsCommand({ jobs: [s.jobId] }));
console.log(d.jobs[0].status); // "SUCCEEDED"
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Status | Notes |
|---|---|---|
| CreateJobQueue | ✅ | Required fields validated (jobQueueName, priority) |
| DescribeJobQueues | ✅ | Returns stored queue data |
| RegisterJobDefinition | ✅ | Revisions increment correctly |
| DescribeJobDefinitions | ✅ | Filter by name/status works |
| SubmitJob | ✅ | Required fields validated (jobName, jobQueue, jobDefinition) |
| DescribeJobs | ✅ | Returns job details from memory |
| ListJobs | ✅ | Filter by queue and status |
| CancelJob | ✅ | Sets FAILED status, returns empty object |
| Execution | ✓ by design | Jobs immediately succeed; no container runtime |
| Compute environments | ✓ by design | Queues reference them opaquely |
| Dependencies | ✓ by design | `dependsOn` stored but not enforced |
| Array / multi-node jobs | ⟳ roadmap | Not modeled |
| Auth | ✓ by design | SigV4 accepted but not validated |
| Persistence | ✓ by design | In-memory; lost on restart/reset |
| Pagination | ✓ by design | Not implemented (in-memory store) |

## Error codes & shapes

| Code | Status | When |
|---|---|---|
| `ClientException` | 400 | Missing required field, invalid value, resource not found, unsupported method |
| `ServerException` | 500 | Internal server error |

Error envelope: `{ "__type": "ClientException", "message": "..." }`

## Manifest

```json
{
  "name": "batch",
  "version": "0.1",
  "image": "parlel/batch:0.1",
  "size_kb": 80,
  "port": 4705,
  "protocol": "http",
  "healthcheck": "/_parlel/health",
  "startup_time_ms": 100,
  "env_vars": {
    "AWS_ACCESS_KEY_ID": "parlel",
    "AWS_SECRET_ACCESS_KEY": "parlel",
    "AWS_REGION": "us-east-1",
    "AWS_ENDPOINT_URL": "http://127.0.0.1:4705"
  }
}
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4705
```

<!-- parlel:testenv:end -->
