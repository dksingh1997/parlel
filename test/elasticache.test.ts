import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ElasticacheServer } from "../services/elasticache/src/server.js";

const PORT = 14707;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function query(params: Record<string, string>) {
  const body = new URLSearchParams({ Version: "2015-02-02", ...params }).toString();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe("ElastiCache", () => {
  let server: ElasticacheServer;
  beforeAll(async () => {
    server = new ElasticacheServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("elasticache");
  });

  it("CreateCacheCluster + DescribeCacheClusters", async () => {
    const c = await query({ Action: "CreateCacheCluster", CacheClusterId: "redis1", Engine: "redis", CacheNodeType: "cache.t3.micro", NumCacheNodes: "1" });
    expect(c.status).toBe(200);
    expect(c.text).toContain("<CacheClusterId>redis1</CacheClusterId>");
    expect(c.text).toContain("<Engine>redis</Engine>");
    expect(c.text).toContain("<CacheClusterStatus>available</CacheClusterStatus>");

    const d = await query({ Action: "DescribeCacheClusters", CacheClusterId: "redis1", ShowCacheNodeInfo: "true" });
    expect(d.text).toContain("<CacheClusterId>redis1</CacheClusterId>");
    expect(d.text).toContain("<Port>6379</Port>");
  });

  it("DeleteCacheCluster", async () => {
    await query({ Action: "CreateCacheCluster", CacheClusterId: "todelete", Engine: "redis" });
    const del = await query({ Action: "DeleteCacheCluster", CacheClusterId: "todelete" });
    expect(del.status).toBe(200);
    expect(del.text).toContain("<CacheClusterStatus>deleting</CacheClusterStatus>");
    const d = await query({ Action: "DescribeCacheClusters" });
    expect(d.text).not.toContain("todelete");
  });

  it("CreateReplicationGroup + DescribeReplicationGroups", async () => {
    const c = await query({
      Action: "CreateReplicationGroup",
      ReplicationGroupId: "rg1",
      ReplicationGroupDescription: "primary+replica",
      NumCacheClusters: "2",
      AutomaticFailoverEnabled: "true",
    });
    expect(c.status).toBe(200);
    expect(c.text).toContain("<ReplicationGroupId>rg1</ReplicationGroupId>");
    expect(c.text).toContain("<AutomaticFailover>enabled</AutomaticFailover>");
    expect(c.text).toContain("<CurrentRole>primary</CurrentRole>");
    expect(c.text).toContain("<CurrentRole>replica</CurrentRole>");

    const d = await query({ Action: "DescribeReplicationGroups", ReplicationGroupId: "rg1" });
    expect(d.text).toContain("<ReplicationGroupId>rg1</ReplicationGroupId>");
    expect(d.text).toContain("primary+replica");
  });

  it("memcached cluster exposes configuration endpoint", async () => {
    const c = await query({ Action: "CreateCacheCluster", CacheClusterId: "mc1", Engine: "memcached", NumCacheNodes: "2" });
    expect(c.text).toContain("<ConfigurationEndpoint>");
    expect(c.text).toContain("<Port>11211</Port>");
  });

  it("error: duplicate cache cluster", async () => {
    await query({ Action: "CreateCacheCluster", CacheClusterId: "dup", Engine: "redis" });
    const c = await query({ Action: "CreateCacheCluster", CacheClusterId: "dup", Engine: "redis" });
    expect(c.status).not.toBe(200);
    expect(c.text).toContain("<Code>CacheClusterAlreadyExists</Code>");
  });

  it("error: describe unknown cache cluster", async () => {
    const r = await query({ Action: "DescribeCacheClusters", CacheClusterId: "ghost" });
    expect(r.status).not.toBe(200);
    expect(r.text).toContain("<Code>CacheClusterNotFound</Code>");
  });

  it("error: CreateCacheCluster missing id", async () => {
    const r = await query({ Action: "CreateCacheCluster", Engine: "redis" });
    expect(r.status).not.toBe(200);
    expect(r.text).toContain("<Code>MissingParameter</Code>");
  });
});
