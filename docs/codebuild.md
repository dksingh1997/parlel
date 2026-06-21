# codebuild (parlel)

A zero-dependency, in-process fake of AWS CodeBuild. Speaks the AWS JSON 1.1
wire protocol (`X-Amz-Target: CodeBuild_20161006.<Operation>`).

| Field | Value |
| --- | --- |
| Service | `codebuild` |
| Port | `4742` |
| Protocol | AWS JSON 1.1 |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4742
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation | Notes |
| --- | --- |
| CreateProject | Stores source/artifacts/environment. |
| ListProjects | Project name list. |
| BatchGetProjects | Returns `projects` + `projectsNotFound`. |
| UpdateProject | Patches fields in place. |
| DeleteProject | Removes the project. |
| StartBuild | Immediately `SUCCEEDED`; increments build number. |
| BatchGetBuilds | Returns `builds` + `buildsNotFound`. |
| ListBuilds | All build ids (newest first). |
| ListBuildsForProject | Build ids scoped to a project. |
| StopBuild | Marks the build `STOPPED`. |

## SDK example

```js
import { CodeBuildClient, StartBuildCommand } from "@aws-sdk/client-codebuild";

const cb = new CodeBuildClient({
  endpoint: "http://127.0.0.1:4742",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const out = await cb.send(new StartBuildCommand({ projectName: "my-project" }));
console.log(out.build.buildStatus); // "SUCCEEDED"
```

## Access via MCP / preview URL

Under the parlel pool, reach this service through the MCP gateway and the pool's
preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| Builds | No build is actually executed; status is always `SUCCEEDED`. |
| Phases | A canned `SUBMITTED → BUILD → COMPLETED` phase list is returned. |
| Logs | Log group/stream names are synthetic; no log content. |
| Webhooks / source | Source is stored but never fetched. |
| Reports | Test/coverage report APIs not implemented. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4742
```

<!-- parlel:testenv:end -->
