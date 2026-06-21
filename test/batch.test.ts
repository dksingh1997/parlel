import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BatchServer } from "../services/batch/src/server.js";

const PORT = 14705;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(path: string, body: object) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("Batch", () => {
  let server: BatchServer;
  beforeAll(async () => {
    server = new BatchServer(PORT);
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

  it("CreateJobQueue + DescribeJobQueues", async () => {
    const c = await call("/v1/createjobqueue", { jobQueueName: "q1", priority: 5, computeEnvironmentOrder: [] });
    expect(c.status).toBe(200);
    expect(c.json.jobQueueName).toBe("q1");
    expect(c.json.jobQueueArn).toContain("job-queue/q1");

    const d = await call("/v1/describejobqueues", { jobQueues: ["q1"] });
    expect(d.json.jobQueues).toHaveLength(1);
    expect(d.json.jobQueues[0].state).toBe("ENABLED");
    expect(d.json.jobQueues[0].priority).toBe(5);
  });

  it("RegisterJobDefinition increments revisions", async () => {
    const r1 = await call("/v1/registerjobdefinition", { jobDefinitionName: "jd", type: "container", containerProperties: { image: "busybox", vcpus: 1, memory: 512 } });
    expect(r1.json.revision).toBe(1);
    const r2 = await call("/v1/registerjobdefinition", { jobDefinitionName: "jd", type: "container", containerProperties: { image: "busybox:1.36" } });
    expect(r2.json.revision).toBe(2);

    const d = await call("/v1/describejobdefinitions", { jobDefinitionName: "jd" });
    expect(d.json.jobDefinitions).toHaveLength(2);
  });

  it("SubmitJob + DescribeJobs + ListJobs", async () => {
    await call("/v1/createjobqueue", { jobQueueName: "jq", priority: 1 });
    await call("/v1/registerjobdefinition", { jobDefinitionName: "echo", type: "container", containerProperties: { image: "busybox" } });

    const s = await call("/v1/submitjob", { jobName: "myjob", jobQueue: "jq", jobDefinition: "echo" });
    expect(s.status).toBe(200);
    expect(s.json.jobName).toBe("myjob");
    expect(s.json.jobId).toBeDefined();
    expect(s.json.jobArn).toContain("job/");
    const jobId = s.json.jobId;

    const d = await call("/v1/describejobs", { jobs: [jobId] });
    expect(d.json.jobs[0].status).toBe("SUCCEEDED");
    expect(d.json.jobs[0].jobName).toBe("myjob");

    const l = await call("/v1/listjobs", { jobQueue: "jq" });
    expect(l.json.jobSummaryList).toHaveLength(1);
    expect(l.json.jobSummaryList[0].jobId).toBe(jobId);
  });

  it("CancelJob", async () => {
    await call("/v1/createjobqueue", { jobQueueName: "cq", priority: 1 });
    await call("/v1/registerjobdefinition", { jobDefinitionName: "cd", type: "container", containerProperties: { image: "x" } });
    const s = await call("/v1/submitjob", { jobName: "cancelme", jobQueue: "cq", jobDefinition: "cd" });
    const c = await call("/v1/canceljob", { jobId: s.json.jobId, reason: "no longer needed" });
    expect(c.status).toBe(200);
  });

  it("error: SubmitJob with unknown queue", async () => {
    await call("/v1/registerjobdefinition", { jobDefinitionName: "jd", type: "container", containerProperties: { image: "x" } });
    const s = await call("/v1/submitjob", { jobName: "x", jobQueue: "ghost", jobDefinition: "jd" });
    expect(s.status).toBe(400);
    expect(s.json.__type).toBe("ClientException");
  });

  it("error: SubmitJob with unknown definition", async () => {
    await call("/v1/createjobqueue", { jobQueueName: "q", priority: 1 });
    const s = await call("/v1/submitjob", { jobName: "x", jobQueue: "q", jobDefinition: "ghost" });
    expect(s.status).toBe(400);
    expect(s.json.__type).toBe("ClientException");
  });

  it("error: CreateJobQueue missing name", async () => {
    const r = await call("/v1/createjobqueue", { priority: 1 });
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("ClientException");
  });

  it("error: CreateJobQueue missing priority", async () => {
    const r = await call("/v1/createjobqueue", { jobQueueName: "q" });
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("ClientException");
  });

  it("error: RegisterJobDefinition missing type", async () => {
    const r = await call("/v1/registerjobdefinition", { jobDefinitionName: "z" });
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("ClientException");
  });

  it("error: SubmitJob missing jobDefinition", async () => {
    await call("/v1/createjobqueue", { jobQueueName: "q", priority: 1 });
    const r = await call("/v1/submitjob", { jobName: "x", jobQueue: "q" });
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("ClientException");
  });

  it("error: SubmitJob missing jobName", async () => {
    await call("/v1/createjobqueue", { jobQueueName: "q", priority: 1 });
    await call("/v1/registerjobdefinition", { jobDefinitionName: "jd", type: "container", containerProperties: { image: "x" } });
    const r = await call("/v1/submitjob", { jobQueue: "q", jobDefinition: "jd" });
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("ClientException");
  });

  it("error: CancelJob missing reason", async () => {
    await call("/v1/createjobqueue", { jobQueueName: "q", priority: 1 });
    await call("/v1/registerjobdefinition", { jobDefinitionName: "jd", type: "container", containerProperties: { image: "x" } });
    const s = await call("/v1/submitjob", { jobName: "x", jobQueue: "q", jobDefinition: "jd" });
    const r = await call("/v1/canceljob", { jobId: s.json.jobId });
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("ClientException");
  });

  it("error: DescribeJobs missing jobs array", async () => {
    const r = await call("/v1/describejobs", {});
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("ClientException");
  });

  it("error: GET method not allowed", async () => {
    const res = await fetch(`${ENDPOINT}/v1/submitjob`, { method: "GET" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.__type).toBe("ClientException");
  });
});
