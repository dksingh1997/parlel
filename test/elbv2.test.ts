import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Elbv2Server } from "../services/elbv2/src/server.js";

const PORT = 14710;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

// Drive the Query/XML protocol over raw HTTP.
async function query(action: string, params: Record<string, string> = {}) {
  const body = new URLSearchParams({
    Action: action,
    Version: "2015-12-01",
    ...params,
  });
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function extract(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : undefined;
}

describe("ELBv2 Service", () => {
  let server: Elbv2Server;

  beforeAll(async () => {
    server = new Elbv2Server(PORT);
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

    it("uses default port 4710", () => {
      const s = new Elbv2Server();
      expect(s.port).toBe(4710);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("elbv2");
    });

    it("supports POST /_parlel/reset", async () => {
      await query("CreateLoadBalancer", {
        Name: "reset-lb",
        "Subnets.member.1": "subnet-1",
      });
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.loadBalancers.size).toBe(0);
    });
  });

  describe("Load balancers", () => {
    it("creates and describes a load balancer", async () => {
      const created = await query("CreateLoadBalancer", {
        Name: "my-alb",
        "Subnets.member.1": "subnet-aaa",
        "Subnets.member.2": "subnet-bbb",
      });
      expect(created.status).toBe(200);
      expect(created.text).toContain("loadbalancer/app/my-alb");
      expect(created.text).toContain("<DNSName>");

      const listed = await query("DescribeLoadBalancers");
      expect(listed.text).toContain("my-alb");
    });

    it("rejects duplicate load balancer names", async () => {
      await query("CreateLoadBalancer", { Name: "dup-lb" });
      const dup = await query("CreateLoadBalancer", { Name: "dup-lb" });
      expect(dup.status).toBe(400);
      expect(dup.text).toContain("DuplicateLoadBalancerName");
    });

    it("describes a single LB by ARN", async () => {
      const created = await query("CreateLoadBalancer", { Name: "by-arn-lb" });
      const arn = extract(created.text, "LoadBalancerArn")!;
      expect(arn).toContain("loadbalancer/");
      const res = await query("DescribeLoadBalancers", {
        "LoadBalancerArns.member.1": arn,
      });
      expect(res.text).toContain("by-arn-lb");
    });

    it("deletes a load balancer", async () => {
      const created = await query("CreateLoadBalancer", { Name: "del-lb" });
      const arn = extract(created.text, "LoadBalancerArn")!;
      const del = await query("DeleteLoadBalancer", { LoadBalancerArn: arn });
      expect(del.status).toBe(200);
      const res = await query("DescribeLoadBalancers", {
        "LoadBalancerArns.member.1": arn,
      });
      expect(res.status).toBe(400);
      expect(res.text).toContain("LoadBalancerNotFound");
    });
  });

  describe("Target groups & targets", () => {
    it("creates a target group and registers targets", async () => {
      const created = await query("CreateTargetGroup", {
        Name: "my-tg",
        Protocol: "HTTP",
        Port: "80",
        VpcId: "vpc-123",
      });
      expect(created.status).toBe(200);
      const tgArn = extract(created.text, "TargetGroupArn")!;
      expect(tgArn).toContain("targetgroup/my-tg");

      const reg = await query("RegisterTargets", {
        TargetGroupArn: tgArn,
        "Targets.member.1.Id": "i-12345",
        "Targets.member.1.Port": "80",
      });
      expect(reg.status).toBe(200);

      const health = await query("DescribeTargetHealth", { TargetGroupArn: tgArn });
      expect(health.text).toContain("i-12345");
      expect(health.text).toContain("healthy");
    });

    it("deregisters targets", async () => {
      const created = await query("CreateTargetGroup", {
        Name: "dereg-tg",
        Protocol: "HTTP",
        Port: "80",
      });
      const tgArn = extract(created.text, "TargetGroupArn")!;
      await query("RegisterTargets", {
        TargetGroupArn: tgArn,
        "Targets.member.1.Id": "i-deadbeef",
      });
      await query("DeregisterTargets", {
        TargetGroupArn: tgArn,
        "Targets.member.1.Id": "i-deadbeef",
      });
      const health = await query("DescribeTargetHealth", { TargetGroupArn: tgArn });
      expect(health.text).not.toContain("i-deadbeef");
    });

    it("errors on register to missing target group", async () => {
      const res = await query("RegisterTargets", {
        TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/ghost/abc",
        "Targets.member.1.Id": "i-1",
      });
      expect(res.status).toBe(400);
      expect(res.text).toContain("TargetGroupNotFound");
    });
  });

  describe("Listeners & rules", () => {
    it("creates a listener and a rule", async () => {
      const lb = await query("CreateLoadBalancer", { Name: "lr-lb" });
      const lbArn = extract(lb.text, "LoadBalancerArn")!;
      const tg = await query("CreateTargetGroup", {
        Name: "lr-tg",
        Protocol: "HTTP",
        Port: "80",
      });
      const tgArn = extract(tg.text, "TargetGroupArn")!;

      const listener = await query("CreateListener", {
        LoadBalancerArn: lbArn,
        Protocol: "HTTP",
        Port: "80",
        "DefaultActions.member.1.Type": "forward",
        "DefaultActions.member.1.TargetGroupArn": tgArn,
      });
      expect(listener.status).toBe(200);
      const listenerArn = extract(listener.text, "ListenerArn")!;
      expect(listenerArn).toContain("listener/");

      const rule = await query("CreateRule", {
        ListenerArn: listenerArn,
        Priority: "10",
        "Conditions.member.1.Field": "path-pattern",
        "Conditions.member.1.Values.member.1": "/api/*",
        "Actions.member.1.Type": "forward",
        "Actions.member.1.TargetGroupArn": tgArn,
      });
      expect(rule.status).toBe(200);
      expect(rule.text).toContain("listener-rule/");

      const listeners = await query("DescribeListeners", { LoadBalancerArn: lbArn });
      expect(listeners.text).toContain(listenerArn);

      const rules = await query("DescribeRules", { ListenerArn: listenerArn });
      expect(rules.text).toContain("path-pattern");
    });

    it("errors creating a listener on a missing LB", async () => {
      const res = await query("CreateListener", {
        LoadBalancerArn: "arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/ghost/abc",
        Protocol: "HTTP",
        Port: "80",
      });
      expect(res.status).toBe(400);
      expect(res.text).toContain("LoadBalancerNotFound");
    });
  });
});
