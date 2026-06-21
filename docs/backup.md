# backup (parlel)

A zero-dependency, in-process fake of AWS Backup. Speaks the REST/JSON API.

| Field | Value |
| --- | --- |
| Service | `backup` |
| Port | `4741` |
| Protocol | REST / JSON |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4741
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation | HTTP |
| --- | --- |
| CreateBackupVault | `PUT /backup-vaults/{name}` |
| ListBackupVaults | `GET /backup-vaults` |
| DescribeBackupVault | `GET /backup-vaults/{name}` |
| DeleteBackupVault | `DELETE /backup-vaults/{name}` |
| CreateBackupPlan | `PUT /backup/plans` |
| ListBackupPlans | `GET /backup/plans` |
| GetBackupPlan | `GET /backup/plans/{id}` |
| CreateBackupSelection | `PUT /backup/plans/{id}/selections` |
| ListBackupSelections | `GET /backup/plans/{id}/selections` |
| StartBackupJob | `PUT /backup-jobs` |
| ListBackupJobs | `GET /backup-jobs` |
| DescribeBackupJob | `GET /backup-jobs/{id}` |

Backup jobs complete synchronously (`State: COMPLETED`, 100%) and produce a
synthetic recovery point ARN.

## SDK example

```js
import { BackupClient, StartBackupJobCommand } from "@aws-sdk/client-backup";

const backup = new BackupClient({
  endpoint: "http://127.0.0.1:4741",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await backup.send(new StartBackupJobCommand({
  BackupVaultName: "Default",
  ResourceArn: "arn:aws:dynamodb:us-east-1:000000000000:table/orders",
  IamRoleArn: "arn:aws:iam::000000000000:role/backup",
}));
```

## Access via MCP / preview URL

Under the parlel pool, reach this service through the MCP gateway and the pool's
preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| Backups | No data is copied; recovery points are synthetic. |
| Restore | `StartRestoreJob` not implemented. |
| Scheduling | Plan rules are stored but never scheduled. |
| Resource type | Inferred from the resource ARN heuristically. |
| Vault lock | Locking is not enforced. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4741
```

<!-- parlel:testenv:end -->
