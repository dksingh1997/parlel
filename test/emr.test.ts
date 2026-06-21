import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EmrServer } from "../services/emr/src/server.js";

const PORT = 14709;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const PREFIX = "ElasticMapReduce";

async function call(op: string, body: object) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `${PREFIX}.${op}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("EMR", () => {
  let server: EmrServer;
  beforeAll(async () => {
    server = new EmrServer(PORT);
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

  it("RunJobFlow + DescribeCluster + ListClusters", async () => {
    const r = await call("RunJobFlow", {
      Name: "my-cluster",
      ReleaseLabel: "emr-7.1.0",
      Instances: { InstanceCount: 3, KeepJobFlowAliveWhenNoSteps: true },
      Applications: [{ Name: "Spark" }],
    });
    expect(r.status).toBe(200);
    expect(r.json.JobFlowId).toContain("j-");
    expect(r.json.ClusterArn).toContain("cluster/");
    const id = r.json.JobFlowId;

    const d = await call("DescribeCluster", { ClusterId: id });
    expect(d.json.Cluster.Name).toBe("my-cluster");
    expect(d.json.Cluster.ReleaseLabel).toBe("emr-7.1.0");
    expect(d.json.Cluster.Applications[0].Name).toBe("Spark");

    const l = await call("ListClusters", {});
    expect(l.json.Clusters).toHaveLength(1);
    expect(l.json.Clusters[0].Id).toBe(id);
  });

  it("RunJobFlow with steps + ListSteps + DescribeStep", async () => {
    const r = await call("RunJobFlow", {
      Name: "withsteps",
      Steps: [
        { Name: "step1", HadoopJarStep: { Jar: "command-runner.jar", Args: ["spark-submit", "job.py"] }, ActionOnFailure: "CONTINUE" },
      ],
    });
    const id = r.json.JobFlowId;

    const ls = await call("ListSteps", { ClusterId: id });
    expect(ls.json.Steps).toHaveLength(1);
    expect(ls.json.Steps[0].Name).toBe("step1");
    expect(ls.json.Steps[0].Status.State).toBe("COMPLETED");
    const stepId = ls.json.Steps[0].Id;
    expect(stepId).toContain("s-");

    const ds = await call("DescribeStep", { ClusterId: id, StepId: stepId });
    expect(ds.json.Step.Config.Jar).toBe("command-runner.jar");
    expect(ds.json.Step.ActionOnFailure).toBe("CONTINUE");
  });

  it("AddJobFlowSteps", async () => {
    const r = await call("RunJobFlow", { Name: "addsteps" });
    const id = r.json.JobFlowId;
    const add = await call("AddJobFlowSteps", {
      JobFlowId: id,
      Steps: [
        { Name: "extra1", HadoopJarStep: { Jar: "a.jar" } },
        { Name: "extra2", HadoopJarStep: { Jar: "b.jar" } },
      ],
    });
    expect(add.json.StepIds).toHaveLength(2);
    const ls = await call("ListSteps", { ClusterId: id });
    expect(ls.json.Steps).toHaveLength(2);
  });

  it("TerminateJobFlows", async () => {
    const r = await call("RunJobFlow", { Name: "term", Instances: { KeepJobFlowAliveWhenNoSteps: true } });
    const id = r.json.JobFlowId;
    const t = await call("TerminateJobFlows", { JobFlowIds: [id] });
    expect(t.status).toBe(200);
    const d = await call("DescribeCluster", { ClusterId: id });
    expect(d.json.Cluster.Status.State).toBe("TERMINATED");
  });

  it("ListClusters filters by state", async () => {
    const r = await call("RunJobFlow", { Name: "c1", Instances: { KeepJobFlowAliveWhenNoSteps: true } });
    await call("TerminateJobFlows", { JobFlowIds: [r.json.JobFlowId] });
    const active = await call("ListClusters", { ClusterStates: ["WAITING", "RUNNING"] });
    expect(active.json.Clusters).toHaveLength(0);
    const terminated = await call("ListClusters", { ClusterStates: ["TERMINATED"] });
    expect(terminated.json.Clusters).toHaveLength(1);
  });

  it("error: RunJobFlow missing Name", async () => {
    const r = await call("RunJobFlow", {});
    expect(r.status).not.toBe(200);
    expect(r.json.__type).toBe("ValidationException");
  });

  it("error: DescribeCluster unknown id", async () => {
    const r = await call("DescribeCluster", { ClusterId: "j-NOTREAL" });
    expect(r.status).not.toBe(200);
    expect(r.json.__type).toBe("InvalidRequestException");
  });
});
