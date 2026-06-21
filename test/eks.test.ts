import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EksServer } from "../services/eks/src/server.js";

const PORT = 14704;
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

describe("EKS", () => {
  let server: EksServer;
  beforeAll(async () => {
    server = new EksServer(PORT);
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

  it("CreateCluster + DescribeCluster", async () => {
    const c = await req("POST", "/clusters", { name: "demo", roleArn: "arn:aws:iam::000000000000:role/eks", version: "1.30" });
    expect(c.status).toBe(200);
    expect(c.json.cluster.name).toBe("demo");
    expect(c.json.cluster.status).toBe("ACTIVE");
    expect(c.json.cluster.arn).toContain("cluster/demo");
    expect(c.json.cluster.endpoint).toContain("eks.amazonaws.com");

    const d = await req("GET", "/clusters/demo");
    expect(d.json.cluster.name).toBe("demo");
    expect(d.json.cluster.version).toBe("1.30");
  });

  it("ListClusters", async () => {
    await req("POST", "/clusters", { name: "a" });
    await req("POST", "/clusters", { name: "b" });
    const l = await req("GET", "/clusters");
    expect(l.json.clusters.sort()).toEqual(["a", "b"]);
  });

  it("DeleteCluster", async () => {
    await req("POST", "/clusters", { name: "gone" });
    const del = await req("DELETE", "/clusters/gone");
    expect(del.json.cluster.status).toBe("DELETING");
    const l = await req("GET", "/clusters");
    expect(l.json.clusters).toHaveLength(0);
  });

  it("CreateAccessEntry + ListAccessEntries", async () => {
    await req("POST", "/clusters", { name: "acc" });
    const principal = "arn:aws:iam::000000000000:role/dev";
    const ce = await req("POST", "/clusters/acc/access-entries", { principalArn: principal, kubernetesGroups: ["dev-team"] });
    expect(ce.status).toBe(200);
    expect(ce.json.accessEntry.principalArn).toBe(principal);
    expect(ce.json.accessEntry.kubernetesGroups).toContain("dev-team");

    const list = await req("GET", "/clusters/acc/access-entries");
    expect(list.json.accessEntries).toContain(principal);
  });

  it("duplicate cluster errors", async () => {
    await req("POST", "/clusters", { name: "dup" });
    const c = await req("POST", "/clusters", { name: "dup" });
    expect(c.status).not.toBe(200);
    expect(c.json.__type).toBe("ResourceInUseException");
  });

  it("error: describe missing cluster", async () => {
    const r = await req("GET", "/clusters/ghost");
    expect(r.status).toBe(404);
    expect(r.json.__type).toBe("ResourceNotFoundException");
  });

  it("error: CreateCluster missing name", async () => {
    const r = await req("POST", "/clusters", {});
    expect(r.status).not.toBe(200);
    expect(r.json.__type).toBe("InvalidParameterException");
  });

  it("error: access entry on missing cluster", async () => {
    const r = await req("POST", "/clusters/none/access-entries", { principalArn: "arn:aws:iam::000000000000:role/x" });
    expect(r.status).toBe(404);
    expect(r.json.__type).toBe("ResourceNotFoundException");
  });
});
