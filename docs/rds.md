# RDS (parlel emulator)

A zero-dependency, in-process fake of the Amazon RDS control plane. Models DB
instance/cluster/snapshot metadata. The data plane backs onto the parlel
`postgres` and `mysql` emulators.

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4721                           |
| Protocol    | AWS Query/XML (Version 2014-10-31) |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Default connection

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4721
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

- Instances: `CreateDBInstance`, `DescribeDBInstances`, `DeleteDBInstance`, `ModifyDBInstance`
- Clusters: `CreateDBCluster`, `DescribeDBClusters`
- Snapshots: `CreateDBSnapshot`, `DescribeDBSnapshots`

`CreateDBInstance` returns an `Endpoint { Address, Port }`. The port defaults to
5432 (postgres family) or 3306 (mysql/maria/aurora-mysql). Point your SQL client
at the matching parlel `postgres`/`mysql` emulator for the actual data plane.

## SDK example

```ts
import { RDSClient, CreateDBInstanceCommand } from "@aws-sdk/client-rds";

const rds = new RDSClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4721",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { DBInstance } = await rds.send(new CreateDBInstanceCommand({
  DBInstanceIdentifier: "db1",
  Engine: "postgres",
  DBInstanceClass: "db.t3.micro",
  AllocatedStorage: 20,
  MasterUsername: "admin",
  MasterUserPassword: "secret99",
}));
console.log(DBInstance?.Endpoint); // { Address, Port: 5432 }
```

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Limitation                                                  |
| ----------- | ----------------------------------------------------------- |
| Provisioning| Instances are immediately `available`; no async states.     |
| Data plane  | This service is metadata only — use postgres/mysql emulators.|
| Parameter groups | Not modeled.                                           |
| Restore     | Snapshot restore is not implemented.                        |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4721
```

<!-- parlel:testenv:end -->
