import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EcsServer } from "../services/ecs/src/server.js";

const PORT = 14703;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const PREFIX = "AmazonEC2ContainerServiceV20141113";

async function call(op: string, body: object) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `${PREFIX}.${op}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("ECS", () => {
  let server: EcsServer;
  beforeAll(async () => {
    server = new EcsServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await r.json()).status).toBe("ok");
  });

  it("CreateCluster + ListClusters + DescribeClusters + DeleteCluster", async () => {
    const c = await call("CreateCluster", { clusterName: "prod" });
    expect(c.json.cluster.clusterName).toBe("prod");
    expect(c.json.cluster.status).toBe("ACTIVE");

    const l = await call("ListClusters", {});
    expect(l.json.clusterArns[0]).toContain("cluster/prod");

    const d = await call("DescribeClusters", { clusters: ["prod"] });
    expect(d.json.clusters).toHaveLength(1);

    const del = await call("DeleteCluster", { cluster: "prod" });
    expect(del.json.cluster.status).toBe("INACTIVE");
    const l2 = await call("ListClusters", {});
    expect(l2.json.clusterArns).toHaveLength(0);
  });

  it("RegisterTaskDefinition increments revisions", async () => {
    const t1 = await call("RegisterTaskDefinition", { family: "web", containerDefinitions: [{ name: "nginx", image: "nginx:latest" }] });
    expect(t1.json.taskDefinition.revision).toBe(1);
    const t2 = await call("RegisterTaskDefinition", { family: "web", containerDefinitions: [{ name: "nginx", image: "nginx:1.25" }] });
    expect(t2.json.taskDefinition.revision).toBe(2);

    const list = await call("ListTaskDefinitions", { familyPrefix: "web" });
    expect(list.json.taskDefinitionArns).toHaveLength(2);
  });

  it("RunTask + ListTasks + DescribeTasks + StopTask", async () => {
    await call("CreateCluster", { clusterName: "c1" });
    await call("RegisterTaskDefinition", { family: "batch", containerDefinitions: [{ name: "job", image: "busybox" }] });

    const run = await call("RunTask", { cluster: "c1", taskDefinition: "batch", count: 2 });
    expect(run.json.tasks).toHaveLength(2);
    expect(run.json.tasks[0].lastStatus).toBe("RUNNING");
    const taskArn = run.json.tasks[0].taskArn;

    const list = await call("ListTasks", { cluster: "c1" });
    expect(list.json.taskArns).toHaveLength(2);

    const desc = await call("DescribeTasks", { cluster: "c1", tasks: [taskArn] });
    expect(desc.json.tasks[0].containers[0].name).toBe("job");

    const stop = await call("StopTask", { cluster: "c1", task: taskArn });
    expect(stop.json.task.lastStatus).toBe("STOPPED");
  });

  it("CreateService + ListServices + DescribeServices + UpdateService + DeleteService", async () => {
    await call("CreateCluster", { clusterName: "svc-cluster" });
    await call("RegisterTaskDefinition", { family: "api", containerDefinitions: [{ name: "api", image: "api:1" }] });

    const cs = await call("CreateService", { cluster: "svc-cluster", serviceName: "api-svc", taskDefinition: "api", desiredCount: 3 });
    expect(cs.json.service.desiredCount).toBe(3);
    expect(cs.json.service.status).toBe("ACTIVE");

    const ls = await call("ListServices", { cluster: "svc-cluster" });
    expect(ls.json.serviceArns[0]).toContain("service/svc-cluster/api-svc");

    const ds = await call("DescribeServices", { cluster: "svc-cluster", services: ["api-svc"] });
    expect(ds.json.services[0].serviceName).toBe("api-svc");

    const us = await call("UpdateService", { cluster: "svc-cluster", service: "api-svc", desiredCount: 5 });
    expect(us.json.service.desiredCount).toBe(5);

    const del = await call("DeleteService", { cluster: "svc-cluster", service: "api-svc", force: true });
    expect(del.json.service.status).toBe("DRAINING");
  });

  it("error: RunTask on missing cluster", async () => {
    const r = await call("RunTask", { cluster: "ghost", taskDefinition: "x" });
    expect(r.status).not.toBe(200);
    expect(r.json.__type).toBe("ClusterNotFoundException");
  });

  it("error: UpdateService missing service", async () => {
    await call("CreateCluster", { clusterName: "c2" });
    const r = await call("UpdateService", { cluster: "c2", service: "nope", desiredCount: 1 });
    expect(r.status).not.toBe(200);
    expect(r.json.__type).toBe("ServiceNotFoundException");
  });
});
