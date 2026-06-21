# parlel/ebs

A zero-dependency, in-process fake of **AWS EBS** (Elastic Block Store — the
volume & snapshot subset of the EC2 API). Speaks the AWS Query (XML) wire
protocol, so the real `@aws-sdk/client-ec2` works against it unchanged.

| | |
|---|---|
| **Port** | `4701` |
| **Protocol** | AWS Query / XML (API version `2016-11-15`, part of the EC2 API) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4701
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified). EBS is technically
part of the EC2 API; this is a standalone emulator scoped to volumes and
snapshots so it can run on its own port.

## Supported operations

| Category | Operations |
|---|---|
| Volumes | `CreateVolume`, `DescribeVolumes`, `DeleteVolume`, `AttachVolume`, `DetachVolume` |
| Snapshots | `CreateSnapshot`, `DescribeSnapshots`, `DeleteSnapshot` |

Generated ids: `vol-…`, `snap-…`.

## SDK usage example

```js
import { EC2Client, CreateVolumeCommand, CreateSnapshotCommand } from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({
  endpoint: "http://127.0.0.1:4701",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const vol = await ec2.send(new CreateVolumeCommand({ AvailabilityZone: "us-east-1a", Size: 20 }));
const snap = await ec2.send(new CreateSnapshotCommand({ VolumeId: vol.VolumeId, Description: "nightly" }));
console.log(snap.State); // "completed"
```

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
|---|---|
| State | Snapshots complete instantly (`100%`); no `pending`/`creating` interim state. |
| Attachments | A volume holds at most one attachment; multi-attach is not modeled. |
| Cross-service | Instance ids in `AttachVolume` are not validated against the EC2 emulator. |
| Filters | `Describe*` `Filters` are not applied — id selection only. |
| Auth | SigV4 is accepted but never validated. |
| Persistence | In-memory; lost on restart/reset. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4701
```

<!-- parlel:testenv:end -->
