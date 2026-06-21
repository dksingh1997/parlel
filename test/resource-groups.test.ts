import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ResourceGroupsServer } from "../services/resource-groups/src/server.js";

const PORT = 14736;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function req(method: string, path: string, body?: Record<string, unknown>) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

const QUERY = {
  Type: "TAG_FILTERS_1_0",
  Query: JSON.stringify({ ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "env", Values: ["prod"] }] }),
};

describe("ResourceGroups Service", () => {
  let server: ResourceGroupsServer;

  beforeAll(async () => {
    server = new ResourceGroupsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("uses default port 4736", () => {
    expect(new ResourceGroupsServer().port).toBe(4736);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await res.json()).service).toBe("resource-groups");
  });

  it("creates and gets a group", async () => {
    const c = await req("POST", "/groups", { Name: "g1", ResourceQuery: QUERY, Description: "test" });
    expect(c.status).toBe(200);
    expect(c.json.Group.GroupArn).toContain(":group/g1");
    const g = await req("GET", "/groups/g1");
    expect(g.json.Group.Name).toBe("g1");
  });

  it("lists groups", async () => {
    await req("POST", "/groups", { Name: "ga", ResourceQuery: QUERY });
    await req("POST", "/groups", { Name: "gb", ResourceQuery: QUERY });
    const l = await req("GET", "/groups");
    expect(l.json.GroupIdentifiers.length).toBe(2);
  });

  it("deletes a group", async () => {
    await req("POST", "/groups", { Name: "gd", ResourceQuery: QUERY });
    await req("DELETE", "/groups/gd");
    const g = await req("GET", "/groups/gd");
    expect(g.status).toBe(404);
    expect(g.json.__type).toBe("NotFoundException");
  });

  it("searches resources", async () => {
    const s = await req("POST", "/resources/search", { ResourceQuery: QUERY });
    expect(s.json.ResourceIdentifiers.length).toBeGreaterThan(0);
  });

  it("lists group resources", async () => {
    await req("POST", "/groups", {
      Name: "gr",
      ResourceQuery: QUERY,
      Resources: ["arn:aws:ec2:us-east-1:000000000000:instance/i-abc"],
    });
    const r = await req("GET", "/groups/gr/resources");
    expect(r.json.ResourceIdentifiers.length).toBe(1);
  });

  it("tags and reads tags", async () => {
    const c = await req("POST", "/groups", { Name: "gt", ResourceQuery: QUERY });
    const arn = c.json.Group.GroupArn;
    await req("PUT", `/resources/${encodeURIComponent(arn)}/tags`, { Tags: { team: "infra" } });
    const t = await req("GET", `/resources/${encodeURIComponent(arn)}/tags`);
    expect(t.json.Tags.team).toBe("infra");
  });
});
