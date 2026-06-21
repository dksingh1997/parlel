import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { S3TablesServer } from "../services/s3-tables/src/server.js";

const PORT = 14727;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function req(method: string, path: string, body?: object) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("S3 Tables", () => {
  let server: S3TablesServer;
  beforeAll(async () => {
    server = new S3TablesServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4727", () => {
    expect(new S3TablesServer().port).toBe(4727);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("s3-tables");
  });

  it("CreateTableBucket + GetTableBucket + ListTableBuckets", async () => {
    const c = await req("POST", "/table-buckets", { name: "lake" });
    expect(c.status).toBe(200);
    expect(c.json.arn).toContain("bucket/lake");
    const arn = c.json.arn;

    const g = await req("GET", `/table-buckets/${arn}`);
    expect(g.json.name).toBe("lake");

    const l = await req("GET", "/table-buckets");
    expect(l.json.tableBuckets).toHaveLength(1);
  });

  it("DeleteTableBucket", async () => {
    const c = await req("POST", "/table-buckets", { name: "lake" });
    const del = await req("DELETE", `/table-buckets/${c.json.arn}`);
    expect(del.status).toBe(200);
    const g = await req("GET", `/table-buckets/${c.json.arn}`);
    expect(g.status).toBe(400);
  });

  it("CreateNamespace + ListNamespaces", async () => {
    const c = await req("POST", "/table-buckets", { name: "lake" });
    const arn = c.json.arn;
    const ns = await req("PUT", `/namespaces/${arn}`, { namespace: ["analytics"] });
    expect(ns.json.namespace).toEqual(["analytics"]);
    const l = await req("GET", `/namespaces/${arn}`);
    expect(l.json.namespaces).toHaveLength(1);
    expect(l.json.namespaces[0].namespace).toEqual(["analytics"]);
  });

  it("CreateTable + ListTables + GetTable", async () => {
    const c = await req("POST", "/table-buckets", { name: "lake" });
    const arn = c.json.arn;
    await req("PUT", `/namespaces/${arn}`, { namespace: ["analytics"] });
    const t = await req("PUT", `/tables/${arn}/analytics`, { name: "events", format: "ICEBERG" });
    expect(t.json.tableARN).toContain("table/");

    const l = await req("GET", `/tables/${arn}/analytics`);
    expect(l.json.tables).toHaveLength(1);
    expect(l.json.tables[0].name).toBe("events");

    const g = await req("GET", `/get-table/${arn}/analytics/events`);
    expect(g.json.name).toBe("events");
    expect(g.json.format).toBe("ICEBERG");
    expect(g.json.metadataLocation).toContain("events");
  });

  it("duplicate bucket errors", async () => {
    await req("POST", "/table-buckets", { name: "lake" });
    const r = await req("POST", "/table-buckets", { name: "lake" });
    expect(r.status).toBe(400);
    expect(r.json.__type).toContain("ConflictException");
  });

  it("namespace in missing bucket errors", async () => {
    const fakeArn = "arn:aws:s3tables:us-east-1:000000000000:bucket/none";
    const r = await req("PUT", `/namespaces/${fakeArn}`, { namespace: ["x"] });
    expect(r.status).toBe(400);
    expect(r.json.__type).toContain("NotFoundException");
  });
});
