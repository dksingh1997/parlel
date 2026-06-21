import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { RdsServer } from "../services/rds/src/server.js";

const PORT = 14721;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function action(params: Record<string, string>) {
  const body = new URLSearchParams({ Version: "2014-10-31", ...params }).toString();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  return { status: res.status, text };
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : undefined;
}

describe("RDS", () => {
  let server: RdsServer;
  beforeAll(async () => {
    server = new RdsServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4721", () => {
    expect(new RdsServer().port).toBe(4721);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("rds");
  });

  it("CreateDBInstance returns endpoint", async () => {
    const r = await action({
      Action: "CreateDBInstance",
      DBInstanceIdentifier: "db1",
      Engine: "postgres",
      DBInstanceClass: "db.t3.micro",
      AllocatedStorage: "20",
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("<DBInstanceIdentifier>db1</DBInstanceIdentifier>");
    expect(tag(r.text, "Address")).toContain("db1");
    expect(tag(r.text, "Port")).toBe("5432");
    expect(tag(r.text, "DBInstanceStatus")).toBe("available");
  });

  it("mysql engine gets port 3306", async () => {
    const r = await action({
      Action: "CreateDBInstance",
      DBInstanceIdentifier: "mydb",
      Engine: "mysql",
    });
    expect(tag(r.text, "Port")).toBe("3306");
  });

  it("DescribeDBInstances lists instances", async () => {
    await action({ Action: "CreateDBInstance", DBInstanceIdentifier: "db1", Engine: "postgres" });
    await action({ Action: "CreateDBInstance", DBInstanceIdentifier: "db2", Engine: "postgres" });
    const r = await action({ Action: "DescribeDBInstances" });
    expect(r.text).toContain("db1");
    expect(r.text).toContain("db2");
  });

  it("ModifyDBInstance changes class", async () => {
    await action({ Action: "CreateDBInstance", DBInstanceIdentifier: "db1", Engine: "postgres" });
    const r = await action({
      Action: "ModifyDBInstance",
      DBInstanceIdentifier: "db1",
      DBInstanceClass: "db.r5.large",
    });
    expect(tag(r.text, "DBInstanceClass")).toBe("db.r5.large");
  });

  it("DeleteDBInstance removes instance", async () => {
    await action({ Action: "CreateDBInstance", DBInstanceIdentifier: "db1", Engine: "postgres" });
    const d = await action({ Action: "DeleteDBInstance", DBInstanceIdentifier: "db1" });
    expect(tag(d.text, "DBInstanceStatus")).toBe("deleting");
    const list = await action({ Action: "DescribeDBInstances" });
    expect(list.text).not.toContain("<DBInstanceIdentifier>db1</DBInstanceIdentifier>");
  });

  it("CreateDBCluster + DescribeDBClusters", async () => {
    const c = await action({
      Action: "CreateDBCluster",
      DBClusterIdentifier: "cl1",
      Engine: "aurora-postgresql",
    });
    expect(tag(c.text, "Status")).toBe("available");
    expect(tag(c.text, "Endpoint")).toContain("cl1.cluster");
    const d = await action({ Action: "DescribeDBClusters", DBClusterIdentifier: "cl1" });
    expect(d.text).toContain("cl1");
  });

  it("CreateDBSnapshot + DescribeDBSnapshots", async () => {
    await action({ Action: "CreateDBInstance", DBInstanceIdentifier: "db1", Engine: "postgres" });
    const s = await action({
      Action: "CreateDBSnapshot",
      DBSnapshotIdentifier: "snap1",
      DBInstanceIdentifier: "db1",
    });
    expect(tag(s.text, "Status")).toBe("available");
    const d = await action({ Action: "DescribeDBSnapshots", DBInstanceIdentifier: "db1" });
    expect(d.text).toContain("snap1");
  });

  it("duplicate instance errors", async () => {
    await action({ Action: "CreateDBInstance", DBInstanceIdentifier: "db1", Engine: "postgres" });
    const r = await action({ Action: "CreateDBInstance", DBInstanceIdentifier: "db1", Engine: "postgres" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("DBInstanceAlreadyExists");
  });

  it("describe missing instance errors", async () => {
    const r = await action({ Action: "DescribeDBInstances", DBInstanceIdentifier: "nope" });
    expect(r.status).toBe(404);
    expect(r.text).toContain("DBInstanceNotFound");
  });
});
