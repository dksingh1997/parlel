import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GlueServer } from "../services/glue/src/server.js";

const PORT = 14724;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const TARGET = "AWSGlue";

async function call(op: string, body: object) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `${TARGET}.${op}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("Glue", () => {
  let server: GlueServer;
  beforeAll(async () => {
    server = new GlueServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4724", () => {
    expect(new GlueServer().port).toBe(4724);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("glue");
  });

  it("CreateDatabase + GetDatabase + GetDatabases", async () => {
    await call("CreateDatabase", { DatabaseInput: { Name: "analytics" } });
    const g = await call("GetDatabase", { Name: "analytics" });
    expect(g.json.Database.Name).toBe("analytics");
    const l = await call("GetDatabases", {});
    expect(l.json.DatabaseList).toHaveLength(1);
  });

  it("DeleteDatabase", async () => {
    await call("CreateDatabase", { DatabaseInput: { Name: "db1" } });
    await call("DeleteDatabase", { Name: "db1" });
    const g = await call("GetDatabase", { Name: "db1" });
    expect(g.status).toBe(400);
  });

  it("CreateTable + GetTable + GetTables", async () => {
    await call("CreateDatabase", { DatabaseInput: { Name: "db1" } });
    await call("CreateTable", {
      DatabaseName: "db1",
      TableInput: { Name: "events", StorageDescriptor: { Columns: [{ Name: "id", Type: "string" }] } },
    });
    const g = await call("GetTable", { DatabaseName: "db1", Name: "events" });
    expect(g.json.Table.Name).toBe("events");
    const l = await call("GetTables", { DatabaseName: "db1" });
    expect(l.json.TableList).toHaveLength(1);
  });

  it("DeleteTable", async () => {
    await call("CreateDatabase", { DatabaseInput: { Name: "db1" } });
    await call("CreateTable", { DatabaseName: "db1", TableInput: { Name: "t" } });
    await call("DeleteTable", { DatabaseName: "db1", Name: "t" });
    const g = await call("GetTable", { DatabaseName: "db1", Name: "t" });
    expect(g.status).toBe(400);
  });

  it("CreateJob + GetJob + GetJobs", async () => {
    const c = await call("CreateJob", {
      Name: "etl",
      Role: "arn:aws:iam::000000000000:role/glue",
      Command: { Name: "glueetl", ScriptLocation: "s3://x/y.py" },
    });
    expect(c.json.Name).toBe("etl");
    const g = await call("GetJob", { JobName: "etl" });
    expect(g.json.Job.Role).toContain("glue");
    const l = await call("GetJobs", {});
    expect(l.json.Jobs).toHaveLength(1);
  });

  it("StartJobRun + GetJobRun", async () => {
    await call("CreateJob", { Name: "etl", Command: { Name: "glueetl" } });
    const r = await call("StartJobRun", { JobName: "etl" });
    expect(r.json.JobRunId).toBeTruthy();
    const g = await call("GetJobRun", { JobName: "etl", RunId: r.json.JobRunId });
    expect(g.json.JobRun.JobRunState).toBe("SUCCEEDED");
  });

  it("duplicate database errors", async () => {
    await call("CreateDatabase", { DatabaseInput: { Name: "dup" } });
    const r = await call("CreateDatabase", { DatabaseInput: { Name: "dup" } });
    expect(r.status).toBe(400);
    expect(r.json.__type).toContain("AlreadyExistsException");
  });

  it("CreateTable in missing database errors", async () => {
    const r = await call("CreateTable", { DatabaseName: "nope", TableInput: { Name: "t" } });
    expect(r.status).toBe(400);
    expect(r.json.__type).toContain("EntityNotFoundException");
  });
});
