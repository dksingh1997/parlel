import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OpensearchServer } from "../services/opensearch/src/server.js";

const PORT = 14726;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const BASE = "/2021-01-01/opensearch";

async function req(method: string, path: string, body?: object) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("OpenSearch", () => {
  let server: OpensearchServer;
  beforeAll(async () => {
    server = new OpensearchServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4726", () => {
    expect(new OpensearchServer().port).toBe(4726);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("opensearch");
  });

  it("CreateDomain returns endpoint + arn", async () => {
    const c = await req("POST", `${BASE}/domain`, { DomainName: "logs", EngineVersion: "OpenSearch_2.11" });
    expect(c.status).toBe(200);
    expect(c.json.DomainStatus.DomainName).toBe("logs");
    expect(c.json.DomainStatus.ARN).toContain("domain/logs");
    expect(c.json.DomainStatus.Endpoint).toContain("logs");
  });

  it("DescribeDomain", async () => {
    await req("POST", `${BASE}/domain`, { DomainName: "logs" });
    const d = await req("GET", `${BASE}/domain/logs`);
    expect(d.json.DomainStatus.DomainName).toBe("logs");
  });

  it("ListDomainNames", async () => {
    await req("POST", `${BASE}/domain`, { DomainName: "a" });
    await req("POST", `${BASE}/domain`, { DomainName: "b" });
    const l = await req("GET", `${BASE}/domain`);
    const names = l.json.DomainNames.map((d: any) => d.DomainName);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("DescribeDomains for multiple", async () => {
    await req("POST", `${BASE}/domain`, { DomainName: "a" });
    await req("POST", `${BASE}/domain`, { DomainName: "b" });
    const d = await req("POST", `${BASE}/domain-info`, { DomainNames: ["a", "b"] });
    expect(d.json.DomainStatusList).toHaveLength(2);
  });

  it("DeleteDomain", async () => {
    await req("POST", `${BASE}/domain`, { DomainName: "logs" });
    const del = await req("DELETE", `${BASE}/domain/logs`);
    expect(del.json.DomainStatus.Deleted).toBe(true);
    const d = await req("GET", `${BASE}/domain/logs`);
    expect(d.status).toBe(400);
  });

  it("CreateDomain duplicate errors", async () => {
    await req("POST", `${BASE}/domain`, { DomainName: "dup" });
    const r = await req("POST", `${BASE}/domain`, { DomainName: "dup" });
    expect(r.status).toBe(400);
    expect(r.json.__type).toContain("ResourceAlreadyExistsException");
  });

  it("DescribeDomain missing errors", async () => {
    const d = await req("GET", `${BASE}/domain/nope`);
    expect(d.status).toBe(400);
    expect(d.json.__type).toContain("ResourceNotFoundException");
  });
});
