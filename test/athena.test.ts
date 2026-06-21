import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AthenaServer } from "../services/athena/src/server.js";

const PORT = 14723;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const TARGET = "AmazonAthena";

async function call(op: string, body: object) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `${TARGET}.${op}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("Athena", () => {
  let server: AthenaServer;
  beforeAll(async () => {
    server = new AthenaServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4723", () => {
    expect(new AthenaServer().port).toBe(4723);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("athena");
  });

  it("StartQueryExecution + GetQueryExecution SUCCEEDED", async () => {
    const s = await call("StartQueryExecution", { QueryString: "SELECT 1" });
    expect(s.json.QueryExecutionId).toBeTruthy();
    const g = await call("GetQueryExecution", { QueryExecutionId: s.json.QueryExecutionId });
    expect(g.json.QueryExecution.Status.State).toBe("SUCCEEDED");
    expect(g.json.QueryExecution.Query).toBe("SELECT 1");
  });

  it("GetQueryResults for SELECT 1", async () => {
    const s = await call("StartQueryExecution", { QueryString: "SELECT 1" });
    const r = await call("GetQueryResults", { QueryExecutionId: s.json.QueryExecutionId });
    // first row is header
    expect(r.json.ResultSet.Rows.length).toBeGreaterThanOrEqual(2);
    expect(r.json.ResultSet.Rows[1].Data[0].VarCharValue).toBe("1");
  });

  it("GetQueryResults for SELECT literal string", async () => {
    const s = await call("StartQueryExecution", { QueryString: "SELECT 'hi'" });
    const r = await call("GetQueryResults", { QueryExecutionId: s.json.QueryExecutionId });
    expect(r.json.ResultSet.Rows[1].Data[0].VarCharValue).toBe("hi");
  });

  it("StopQueryExecution sets CANCELLED", async () => {
    const s = await call("StartQueryExecution", { QueryString: "SELECT 1" });
    await call("StopQueryExecution", { QueryExecutionId: s.json.QueryExecutionId });
    const g = await call("GetQueryExecution", { QueryExecutionId: s.json.QueryExecutionId });
    expect(g.json.QueryExecution.Status.State).toBe("CANCELLED");
  });

  it("ListQueryExecutions", async () => {
    await call("StartQueryExecution", { QueryString: "SELECT 1" });
    await call("StartQueryExecution", { QueryString: "SELECT 2" });
    const l = await call("ListQueryExecutions", {});
    expect(l.json.QueryExecutionIds).toHaveLength(2);
  });

  it("CreateWorkGroup + ListWorkGroups", async () => {
    await call("CreateWorkGroup", { Name: "analytics" });
    const l = await call("ListWorkGroups", {});
    const names = l.json.WorkGroups.map((w: any) => w.Name);
    expect(names).toContain("primary");
    expect(names).toContain("analytics");
  });

  it("CreateNamedQuery + ListNamedQueries", async () => {
    const c = await call("CreateNamedQuery", {
      Name: "q1",
      Database: "default",
      QueryString: "SELECT 1",
    });
    expect(c.json.NamedQueryId).toBeTruthy();
    const l = await call("ListNamedQueries", {});
    expect(l.json.NamedQueryIds).toContain(c.json.NamedQueryId);
  });

  it("StartQueryExecution without QueryString errors", async () => {
    const r = await call("StartQueryExecution", {});
    expect(r.status).toBe(400);
    expect(r.json.__type).toContain("InvalidRequestException");
  });

  it("GetQueryExecution on missing id errors", async () => {
    const r = await call("GetQueryExecution", { QueryExecutionId: "nope" });
    expect(r.status).toBe(400);
  });
});
