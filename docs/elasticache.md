# parlel/elasticache

A zero-dependency, in-process fake of **AWS ElastiCache**. Speaks the AWS Query
(XML) wire protocol, so the real `@aws-sdk/client-elasticache` works against it
unchanged.

> **Note:** ElastiCache here is *metadata only*. A cache cluster describes a
> Redis (or Memcached) endpoint. Conceptually it **backs onto the parlel
> `redis` emulator** — the `backingRedis` host/port recorded for each cluster
> points at the local redis service you can actually issue commands against.
> This service does not itself speak the Redis protocol.

| | |
|---|---|
| **Port** | `4707` |
| **Protocol** | AWS Query / XML (API version `2015-02-02`, member-style lists) |
| **Health** | `GET /_parlel/health` |
| **Reset** | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4707
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
```

Any SigV4 credentials are accepted (auth is not verified).

## Supported operations

| Category | Operations |
|---|---|
| Cache clusters | `CreateCacheCluster`, `DescribeCacheClusters`, `DeleteCacheCluster` |
| Replication groups | `CreateReplicationGroup`, `DescribeReplicationGroups` |

## SDK usage example

```js
import { ElastiCacheClient, CreateCacheClusterCommand, DescribeCacheClustersCommand } from "@aws-sdk/client-elasticache";

const ec = new ElastiCacheClient({
  endpoint: "http://127.0.0.1:4707",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await ec.send(new CreateCacheClusterCommand({ CacheClusterId: "redis1", Engine: "redis", CacheNodeType: "cache.t3.micro", NumCacheNodes: 1 }));
const d = await ec.send(new DescribeCacheClustersCommand({ CacheClusterId: "redis1", ShowCacheNodeInfo: true }));
console.log(d.CacheClusters[0].CacheNodes[0].Endpoint); // { Address, Port: 6379 }
```

To actually read/write data, connect a Redis client to the parlel `redis`
emulator (default `127.0.0.1:6379`).

## Access via MCP / preview URL

automatically-provisioned preview URL. Point the SDK `endpoint` at that URL and

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
|---|---|
| Data plane | No Redis/Memcached protocol here — use the parlel `redis` emulator for actual commands. |
| Lifecycle | Clusters become `available` instantly; no `creating`/`modifying` polling state. |
| Modify ops | `ModifyCacheCluster`, snapshots, parameter/subnet groups, and users are not implemented. |
| Failover | Replication group roles are static; no automatic failover simulation. |
| Auth | SigV4 is accepted but never validated. |
| Persistence | In-memory; lost on restart/reset. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4707
```

<!-- parlel:testenv:end -->
