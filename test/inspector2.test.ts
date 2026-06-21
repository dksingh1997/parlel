import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Inspector2Server } from "../services/inspector2/src/server.js";

const PORT = 14735;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function post(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

describe("Inspector2 Service", () => {
  let server: Inspector2Server;

  beforeAll(async () => {
    server = new Inspector2Server(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("uses default port 4735", () => {
    expect(new Inspector2Server().port).toBe(4735);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await res.json()).service).toBe("inspector2");
  });

  it("lists seeded findings", async () => {
    const r = await post("/findings/list", {});
    expect(r.status).toBe(200);
    expect(r.json.findings.length).toBeGreaterThan(0);
    expect(r.json.findings[0].severity).toBeTruthy();
  });

  it("filters findings by severity", async () => {
    const r = await post("/findings/list", {
      filterCriteria: { severity: [{ comparison: "EQUALS", value: "HIGH" }] },
    });
    expect(r.json.findings.every((f: any) => f.severity === "HIGH")).toBe(true);
  });

  it("lists coverage", async () => {
    const r = await post("/coverage/list", {});
    expect(r.json.coveredResources.length).toBeGreaterThan(0);
  });

  it("creates, lists, and deletes filters", async () => {
    const c = await post("/filters/create", {
      name: "suppress-low",
      action: "SUPPRESS",
      filterCriteria: { severity: [{ comparison: "EQUALS", value: "LOW" }] },
    });
    expect(c.json.arn).toContain("/filter/");
    const l = await post("/filters/list", {});
    expect(l.json.filters.length).toBe(1);
    const d = await post("/filters/delete", { arn: c.json.arn });
    expect(d.json.arn).toBe(c.json.arn);
    const l2 = await post("/filters/list", {});
    expect(l2.json.filters.length).toBe(0);
  });

  it("enables and disables the service", async () => {
    const e = await post("/enable", { resourceTypes: ["EC2", "ECR"] });
    expect(e.json.accounts[0].status).toBe("ENABLED");
    const s = await post("/status/batch/get", { accountIds: ["000000000000"] });
    expect(s.json.accounts[0].state.status).toBe("ENABLED");
    const d = await post("/disable", { resourceTypes: ["EC2", "ECR", "LAMBDA"] });
    expect(d.json.accounts[0].status).toBe("DISABLED");
  });

  it("rejects deleting a missing filter", async () => {
    const d = await post("/filters/delete", { arn: "arn:aws:inspector2:us-east-1:000000000000:owner/000000000000/filter/missing" });
    expect(d.status).toBe(404);
    expect(d.json.__type).toBe("ResourceNotFoundException");
  });
});
