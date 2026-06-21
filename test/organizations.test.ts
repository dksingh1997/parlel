import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OrganizationsServer } from "../services/organizations/src/server.js";

const PORT = 14733;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(op: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSOrganizationsV20161128.${op}`,
    },
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

describe("Organizations Service", () => {
  let server: OrganizationsServer;

  beforeAll(async () => {
    server = new OrganizationsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("uses default port 4733", () => {
    expect(new OrganizationsServer().port).toBe(4733);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await res.json()).service).toBe("organizations");
  });

  it("creates and describes an organization", async () => {
    const c = await call("CreateOrganization", { FeatureSet: "ALL" });
    expect(c.status).toBe(200);
    expect(c.json.Organization.Id).toContain("o-");
    const d = await call("DescribeOrganization");
    expect(d.json.Organization.Id).toBe(c.json.Organization.Id);
  });

  it("requires an org for member ops", async () => {
    const d = await call("DescribeOrganization");
    expect(d.status).toBe(400);
    expect(d.json.__type).toBe("AWSOrganizationsNotInUseException");
  });

  it("lists accounts including management account", async () => {
    await call("CreateOrganization");
    const l = await call("ListAccounts");
    expect(l.json.Accounts.length).toBe(1);
    expect(l.json.Accounts[0].Id).toBe("000000000000");
  });

  it("creates a new account", async () => {
    await call("CreateOrganization");
    const c = await call("CreateAccount", { AccountName: "dev", Email: "dev@example.com" });
    expect(c.json.CreateAccountStatus.State).toBe("SUCCEEDED");
    const newId = c.json.CreateAccountStatus.AccountId;
    const d = await call("DescribeAccount", { AccountId: newId });
    expect(d.json.Account.Name).toBe("dev");
    const l = await call("ListAccounts");
    expect(l.json.Accounts.length).toBe(2);
  });

  it("creates and lists organizational units", async () => {
    const org = await call("CreateOrganization");
    const roots = await call("ListRoots");
    const rootId = roots.json.Roots[0].Id;
    const ou = await call("CreateOrganizationalUnit", { ParentId: rootId, Name: "Engineering" });
    expect(ou.json.OrganizationalUnit.Name).toBe("Engineering");
    const list = await call("ListOrganizationalUnitsForParent", { ParentId: rootId });
    expect(list.json.OrganizationalUnits.length).toBe(1);
  });

  it("creates, lists and attaches policies", async () => {
    await call("CreateOrganization");
    const roots = await call("ListRoots");
    const rootId = roots.json.Roots[0].Id;
    const p = await call("CreatePolicy", {
      Name: "scp1",
      Type: "SERVICE_CONTROL_POLICY",
      Content: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
    });
    const policyId = p.json.Policy.PolicySummary.Id;
    const l = await call("ListPolicies", { Filter: "SERVICE_CONTROL_POLICY" });
    expect(l.json.Policies.length).toBe(1);
    const a = await call("AttachPolicy", { PolicyId: policyId, TargetId: rootId });
    expect(a.status).toBe(200);
    const lt = await call("ListPoliciesForTarget", { TargetId: rootId, Filter: "SERVICE_CONTROL_POLICY" });
    expect(lt.json.Policies.length).toBe(1);
  });
});
