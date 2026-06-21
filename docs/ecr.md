# parlel/ecr

A zero-dependency, in-process fake of **AWS ECR** (Elastic Container Registry).
Speaks the AWS JSON 1.1 wire protocol, so the real `@aws-sdk/client-ecr` works
against it unchanged.

| | |
|---|---|
| **Port** | `4702` |
| **Protocol** | AWS JSON 1.1 (`X-Amz-Target: AmazonEC2ContainerRegistry_V20150921.<Op>`) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4702
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Supported operations

| Category | Operations |
|---|---|
| Repositories | `CreateRepository`, `DescribeRepositories`, `DeleteRepository` |
| Images | `PutImage`, `ListImages`, `BatchGetImage`, `DescribeImages` |
| Auth | `GetAuthorizationToken` |

## SDK usage example

```js
import { ECRClient, CreateRepositoryCommand, PutImageCommand, ListImagesCommand } from "@aws-sdk/client-ecr";

const ecr = new ECRClient({
  endpoint: "http://127.0.0.1:4702",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await ecr.send(new CreateRepositoryCommand({ repositoryName: "my-app" }));
await ecr.send(new PutImageCommand({ repositoryName: "my-app", imageManifest: '{"schemaVersion":2}', imageTag: "v1" }));
const list = await ecr.send(new ListImagesCommand({ repositoryName: "my-app" }));
console.log(list.imageIds);
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
|---|---|
| Layers | No layer upload/blob storage; manifests are stored opaquely as strings. |
| Scanning | `imageScanningConfiguration` is recorded but no scans run; no findings. |
| Lifecycle policies | Lifecycle / repository policies are not implemented. |
| Tag immutability | `IMMUTABLE` tag mutability is recorded but not enforced. |
| Auth token | The authorization token is a synthetic base64 string, not a real Docker credential. |
| Persistence | In-memory; lost on restart/reset. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4702
```

<!-- parlel:testenv:end -->
