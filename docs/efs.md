# parlel/efs

A zero-dependency, in-process fake of **AWS EFS** (Elastic File System). EFS uses
the AWS REST-JSON protocol with paths under `/2015-02-01`, so the real
`@aws-sdk/client-efs` works against it unchanged.

| | |
|---|---|
| **Port** | `4708` |
| **Protocol** | AWS REST-JSON (e.g. `POST /2015-02-01/file-systems`) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4708
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Supported operations

| Operation | Route |
|---|---|
| `CreateFileSystem` | `POST /2015-02-01/file-systems` |
| `DescribeFileSystems` | `GET /2015-02-01/file-systems` (or `/file-systems/{id}`) |
| `DeleteFileSystem` | `DELETE /2015-02-01/file-systems/{id}` |
| `CreateMountTarget` | `POST /2015-02-01/mount-targets` |
| `DescribeMountTargets` | `GET /2015-02-01/mount-targets?FileSystemId=…` |

Generated ids: `fs-…`, `fsmt-…`.

## SDK usage example

```js
import { EFSClient, CreateFileSystemCommand, CreateMountTargetCommand } from "@aws-sdk/client-efs";

const efs = new EFSClient({
  endpoint: "http://127.0.0.1:4708",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const fs = await efs.send(new CreateFileSystemCommand({ CreationToken: "my-token", Tags: [{ Key: "Name", Value: "data" }] }));
await efs.send(new CreateMountTargetCommand({ FileSystemId: fs.FileSystemId, SubnetId: "subnet-123" }));
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
|---|---|
| Data plane | No NFS server — files cannot actually be read or written; `SizeInBytes` is always 0. |
| Lifecycle | File systems and mount targets become `available` instantly. |
| Access points | `CreateAccessPoint`, lifecycle/backup policies, and replication are not implemented. |
| Networking | Mount target ENIs/IPs are synthetic; subnets are not validated against EC2. |
| Auth | SigV4 is accepted but never validated. |
| Persistence | In-memory; lost on restart/reset. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4708
```

<!-- parlel:testenv:end -->
