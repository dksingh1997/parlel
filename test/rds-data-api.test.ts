import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { RdsDataApiServer } from "../services/rds-data-api/src/server.js";

const PORT = 14722;
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

const RES = "arn:aws:rds:us-east-1:000000000000:cluster:c1";

describe("RDS Data API", () => {
  let server: RdsDataApiServer;
  beforeAll(async () => {
    server = new RdsDataApiServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4722", () => {
    expect(new RdsDataApiServer().port).toBe(4722);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("rds-data-api");
  });

  it("ExecuteStatement SELECT 1", async () => {
    const r = await call("/Execute", { resourceArn: RES, secretArn: "s", database: "db", sql: "SELECT 1" });
    expect(r.status).toBe(200);
    expect(r.json.records[0][0].longValue).toBe(1);
  });

  it("ExecuteStatement SELECT literal string", async () => {
    const r = await call("/Execute", { resourceArn: RES, secretArn: "s", database: "db", sql: "SELECT 'hello'" });
    expect(r.json.records[0][0].stringValue).toBe("hello");
  });

  it("CREATE TABLE + INSERT + SELECT round trip", async () => {
    await call("/Execute", {
      resourceArn: RES,
      database: "app",
      sql: "CREATE TABLE users (id INTEGER, name TEXT)",
    });
    const ins = await call("/Execute", {
      resourceArn: RES,
      database: "app",
      sql: "INSERT INTO users (id, name) VALUES (1, 'Alice')",
    });
    expect(ins.json.numberOfRecordsUpdated).toBe(1);
    await call("/Execute", {
      resourceArn: RES,
      database: "app",
      sql: "INSERT INTO users (id, name) VALUES (2, 'Bob')",
    });
    const sel = await call("/Execute", { resourceArn: RES, database: "app", sql: "SELECT * FROM users" });
    expect(sel.json.records).toHaveLength(2);
    expect(sel.json.records[0][1].stringValue).toBe("Alice");
    expect(sel.json.columnMetadata.map((c: any) => c.name)).toEqual(["id", "name"]);
  });

  it("parameterized INSERT and WHERE filter", async () => {
    await call("/Execute", { resourceArn: RES, database: "app", sql: "CREATE TABLE t (id INTEGER, v TEXT)" });
    await call("/Execute", {
      resourceArn: RES,
      database: "app",
      sql: "INSERT INTO t (id, v) VALUES (:id, :v)",
      parameters: [
        { name: "id", value: { longValue: 7 } },
        { name: "v", value: { stringValue: "seven" } },
      ],
    });
    const sel = await call("/Execute", {
      resourceArn: RES,
      database: "app",
      sql: "SELECT v FROM t WHERE id = :id",
      parameters: [{ name: "id", value: { longValue: 7 } }],
    });
    expect(sel.json.records).toHaveLength(1);
    expect(sel.json.records[0][0].stringValue).toBe("seven");
  });

  it("UPDATE rows", async () => {
    await call("/Execute", { resourceArn: RES, database: "app", sql: "CREATE TABLE t (id INTEGER, v TEXT)" });
    await call("/Execute", { resourceArn: RES, database: "app", sql: "INSERT INTO t (id, v) VALUES (1, 'a')" });
    const u = await call("/Execute", {
      resourceArn: RES,
      database: "app",
      sql: "UPDATE t SET v = 'b' WHERE id = 1",
    });
    expect(u.json.numberOfRecordsUpdated).toBe(1);
    const sel = await call("/Execute", { resourceArn: RES, database: "app", sql: "SELECT v FROM t WHERE id = 1" });
    expect(sel.json.records[0][0].stringValue).toBe("b");
  });

  it("BatchExecuteStatement inserts multiple", async () => {
    await call("/Execute", { resourceArn: RES, database: "app", sql: "CREATE TABLE t (id INTEGER)" });
    const b = await call("/BatchExecute", {
      resourceArn: RES,
      database: "app",
      sql: "INSERT INTO t (id) VALUES (:id)",
      parameterSets: [
        [{ name: "id", value: { longValue: 1 } }],
        [{ name: "id", value: { longValue: 2 } }],
      ],
    });
    expect(b.json.updateResults).toHaveLength(2);
    const sel = await call("/Execute", { resourceArn: RES, database: "app", sql: "SELECT * FROM t" });
    expect(sel.json.records).toHaveLength(2);
  });

  it("BeginTransaction + CommitTransaction", async () => {
    const begin = await call("/BeginTransaction", { resourceArn: RES, database: "app" });
    expect(begin.json.transactionId).toBeTruthy();
    const commit = await call("/CommitTransaction", {
      resourceArn: RES,
      transactionId: begin.json.transactionId,
    });
    expect(commit.json.transactionStatus).toContain("Committed");
  });

  it("RollbackTransaction", async () => {
    const begin = await call("/BeginTransaction", { resourceArn: RES, database: "app" });
    const rb = await call("/RollbackTransaction", {
      resourceArn: RES,
      transactionId: begin.json.transactionId,
    });
    expect(rb.json.transactionStatus).toContain("Rollback");
  });

  it("Commit unknown transaction errors", async () => {
    const r = await call("/CommitTransaction", { resourceArn: RES, transactionId: "nope" });
    expect(r.status).toBe(400);
  });

  it("ExecuteStatement without sql errors", async () => {
    const r = await call("/Execute", { resourceArn: RES, database: "app" });
    expect(r.status).toBe(400);
  });
});
