import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WafV2Server } from "../services/waf-v2/src/server.js";

const PORT = 14716;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const PREFIX = "AWSWAF_20190729";

async function waf(operation: string, body: unknown) {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `${PREFIX}.${operation}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* */
  }
  return { status: res.status, json };
}

describe("WAFv2 Service", () => {
  let server: WafV2Server;

  beforeAll(async () => {
    server = new WafV2Server(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("uses default port 4716", () => {
      const s = new WafV2Server();
      expect(s.port).toBe(4716);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.service).toBe("waf-v2");
    });

    it("supports POST /_parlel/reset", async () => {
      await waf("CreateWebACL", {
        Name: "reset-acl",
        Scope: "REGIONAL",
        DefaultAction: { Allow: {} },
        VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: "m" },
      });
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.webACLs.size).toBe(0);
    });
  });

  describe("Web ACLs", () => {
    const base = {
      Scope: "REGIONAL",
      DefaultAction: { Allow: {} },
      VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: "m" },
    };

    it("creates a web ACL", async () => {
      const res = await waf("CreateWebACL", { Name: "my-acl", ...base });
      expect(res.status).toBe(200);
      expect(res.json.Summary.Id).toBeTruthy();
      expect(res.json.Summary.ARN).toContain("webacl/my-acl");
    });

    it("rejects a duplicate web ACL", async () => {
      await waf("CreateWebACL", { Name: "dup-acl", ...base });
      const dup = await waf("CreateWebACL", { Name: "dup-acl", ...base });
      expect(dup.status).toBe(400);
      expect(dup.json.__type).toBe("WAFDuplicateItemException");
    });

    it("gets and lists web ACLs", async () => {
      const created = await waf("CreateWebACL", { Name: "g-acl", ...base });
      const id = created.json.Summary.Id;
      const got = await waf("GetWebACL", { Name: "g-acl", Scope: "REGIONAL", Id: id });
      expect(got.json.WebACL.Name).toBe("g-acl");
      const list = await waf("ListWebACLs", { Scope: "REGIONAL" });
      expect(list.json.WebACLs.length).toBe(1);
    });

    it("deletes a web ACL", async () => {
      const created = await waf("CreateWebACL", { Name: "d-acl", ...base });
      const id = created.json.Summary.Id;
      const del = await waf("DeleteWebACL", {
        Name: "d-acl",
        Scope: "REGIONAL",
        Id: id,
        LockToken: created.json.Summary.LockToken,
      });
      expect(del.status).toBe(200);
      const got = await waf("GetWebACL", { Name: "d-acl", Scope: "REGIONAL", Id: id });
      expect(got.status).toBe(400);
      expect(got.json.__type).toBe("WAFNonexistentItemException");
    });
  });

  describe("IP sets", () => {
    it("creates, gets and lists an IP set", async () => {
      const created = await waf("CreateIPSet", {
        Name: "my-ipset",
        Scope: "REGIONAL",
        IPAddressVersion: "IPV4",
        Addresses: ["1.2.3.4/32", "10.0.0.0/8"],
      });
      expect(created.status).toBe(200);
      const id = created.json.Summary.Id;
      const got = await waf("GetIPSet", { Name: "my-ipset", Scope: "REGIONAL", Id: id });
      expect(got.json.IPSet.Addresses).toContain("1.2.3.4/32");
      const list = await waf("ListIPSets", { Scope: "REGIONAL" });
      expect(list.json.IPSets.length).toBe(1);
    });

    it("errors getting a missing IP set", async () => {
      const res = await waf("GetIPSet", { Name: "ghost", Scope: "REGIONAL", Id: "no-such-id" });
      expect(res.status).toBe(400);
      expect(res.json.__type).toBe("WAFNonexistentItemException");
    });
  });

  describe("Rule groups", () => {
    it("creates and lists a rule group", async () => {
      const created = await waf("CreateRuleGroup", {
        Name: "my-rg",
        Scope: "REGIONAL",
        Capacity: 100,
        VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: "m" },
      });
      expect(created.status).toBe(200);
      const id = created.json.Summary.Id;
      const got = await waf("GetRuleGroup", { Name: "my-rg", Scope: "REGIONAL", Id: id });
      expect(got.json.RuleGroup.Capacity).toBe(100);
      const list = await waf("ListRuleGroups", { Scope: "REGIONAL" });
      expect(list.json.RuleGroups.length).toBe(1);
    });
  });
});
