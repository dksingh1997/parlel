# cloudformation (parlel)

A zero-dependency, in-process fake of AWS CloudFormation. Speaks the AWS Query
(XML) wire protocol, API version `2010-05-15`.

| Field | Value |
| --- | --- |
| Service | `cloudformation` |
| Port | `4564` |
| Protocol | AWS Query / XML |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4564
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

Any credentials are accepted.

## Supported operations

| Operation | Notes |
| --- | --- |
| CreateStack | Parses a JSON template's `Resources`/`Outputs`/`Parameters`. |
| DescribeStacks | Returns status, parameters, outputs, tags. |
| UpdateStack | Re-applies template/parameters; status `UPDATE_COMPLETE`. |
| DeleteStack | Idempotent; status `DELETE_COMPLETE`. |
| ListStacks | Optional `StackStatusFilter`. |
| GetTemplate | Returns the original template body. |
| CreateChangeSet | `CREATE` or `UPDATE`; computes resource changes. |
| DescribeChangeSet | Returns change list + parameters. |
| ExecuteChangeSet | Applies the change set to the stack. |
| ListChangeSets | Per-stack change set summaries. |
| DescribeStackResources | Per-resource detail. |
| ListStackResources | Resource summaries. |
| ListExports | Outputs with an `Export.Name`. |
| ValidateTemplate | Returns template parameters + description. |

## SDK example

```js
import { CloudFormationClient, CreateStackCommand } from "@aws-sdk/client-cloudformation";

const cfn = new CloudFormationClient({
  endpoint: "http://127.0.0.1:4564",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await cfn.send(new CreateStackCommand({
  StackName: "demo",
  TemplateBody: JSON.stringify({ Resources: { B: { Type: "AWS::S3::Bucket" } } }),
}));
```

## Access via MCP / preview URL

When running under the parlel pool, this service is reachable through the MCP
gateway and the preview URL assigned to the pool. Use the same operations over
the preview URL host; credentials are still ignored.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| Templates | JSON only (no full YAML parser). |
| Intrinsics | Only simple `{ "Ref": "Param" }` resolved in outputs. |
| Provisioning | Resources are simulated, not actually created. |
| Drift / rollback | Not modeled (status always `NOT_CHECKED`). |
| Async states | All operations complete synchronously. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_CLOUDFORMATION=http://localhost:4564
AWS_ENDPOINT_URL=http://localhost:4564
```

<!-- parlel:testenv:end -->
