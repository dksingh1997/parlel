import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AutoscalingServer } from "../services/autoscaling/src/server.js";

const PORT = 14706;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function query(params: Record<string, string>) {
  const body = new URLSearchParams({ Version: "2011-01-01", ...params }).toString();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe("AutoScaling", () => {
  let server: AutoscalingServer;
  beforeAll(async () => {
    server = new AutoscalingServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("autoscaling");
  });

  it("CreateLaunchConfiguration + Describe", async () => {
    const c = await query({ Action: "CreateLaunchConfiguration", LaunchConfigurationName: "lc1", ImageId: "ami-123", InstanceType: "t3.micro" });
    expect(c.status).toBe(200);
    const d = await query({ Action: "DescribeLaunchConfigurations" });
    expect(d.text).toContain("<LaunchConfigurationName>lc1</LaunchConfigurationName>");
    expect(d.text).toContain("<InstanceType>t3.micro</InstanceType>");
  });

  it("CreateAutoScalingGroup + Describe with instances", async () => {
    await query({ Action: "CreateLaunchConfiguration", LaunchConfigurationName: "lc2", ImageId: "ami-1", InstanceType: "t2.micro" });
    const c = await query({
      Action: "CreateAutoScalingGroup",
      AutoScalingGroupName: "asg1",
      LaunchConfigurationName: "lc2",
      MinSize: "1",
      MaxSize: "5",
      DesiredCapacity: "2",
      "AvailabilityZones.member.1": "us-east-1a",
    });
    expect(c.status).toBe(200);

    const d = await query({ Action: "DescribeAutoScalingGroups", "AutoScalingGroupNames.member.1": "asg1" });
    expect(d.text).toContain("<AutoScalingGroupName>asg1</AutoScalingGroupName>");
    expect(d.text).toContain("<DesiredCapacity>2</DesiredCapacity>");
    expect(d.text).toContain("<MaxSize>5</MaxSize>");
    // Two instances should be present.
    expect((d.text.match(/<InstanceId>i-/g) || []).length).toBe(2);
  });

  it("SetDesiredCapacity scales instances", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "asg2", MinSize: "0", MaxSize: "10", DesiredCapacity: "1" });
    const s = await query({ Action: "SetDesiredCapacity", AutoScalingGroupName: "asg2", DesiredCapacity: "3" });
    expect(s.status).toBe(200);
    const d = await query({ Action: "DescribeAutoScalingGroups", "AutoScalingGroupNames.member.1": "asg2" });
    expect(d.text).toContain("<DesiredCapacity>3</DesiredCapacity>");
    expect((d.text.match(/<InstanceId>i-/g) || []).length).toBe(3);
  });

  it("UpdateAutoScalingGroup", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "asg3", MinSize: "1", MaxSize: "3", DesiredCapacity: "1" });
    const u = await query({ Action: "UpdateAutoScalingGroup", AutoScalingGroupName: "asg3", MaxSize: "8", DesiredCapacity: "4" });
    expect(u.status).toBe(200);
    const d = await query({ Action: "DescribeAutoScalingGroups", "AutoScalingGroupNames.member.1": "asg3" });
    expect(d.text).toContain("<MaxSize>8</MaxSize>");
    expect(d.text).toContain("<DesiredCapacity>4</DesiredCapacity>");
  });

  it("DeleteAutoScalingGroup with ForceDelete", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "asg4", MinSize: "1", MaxSize: "3", DesiredCapacity: "1" });
    const fail = await query({ Action: "DeleteAutoScalingGroup", AutoScalingGroupName: "asg4" });
    expect(fail.status).not.toBe(200);
    expect(fail.text).toContain("ResourceInUse");
    const ok = await query({ Action: "DeleteAutoScalingGroup", AutoScalingGroupName: "asg4", ForceDelete: "true" });
    expect(ok.status).toBe(200);
    const d = await query({ Action: "DescribeAutoScalingGroups" });
    expect(d.text).not.toContain("asg4");
  });

  it("CreateLaunchTemplate", async () => {
    const c = await query({ Action: "CreateLaunchTemplate", LaunchTemplateName: "lt1", "LaunchTemplateData.ImageId": "ami-9", "LaunchTemplateData.InstanceType": "t3.small" });
    expect(c.status).toBe(200);
    expect(c.text).toContain("<LaunchTemplateName>lt1</LaunchTemplateName>");
    expect(c.text).toContain("<LaunchTemplateId>lt-");
  });

  it("error: duplicate ASG", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "dup", MinSize: "0", MaxSize: "1" });
    const c = await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "dup", MinSize: "0", MaxSize: "1" });
    expect(c.status).not.toBe(200);
    expect(c.text).toContain("<Code>AlreadyExists</Code>");
  });

  it("error: SetDesiredCapacity on missing group", async () => {
    const r = await query({ Action: "SetDesiredCapacity", AutoScalingGroupName: "ghost", DesiredCapacity: "1" });
    expect(r.status).not.toBe(200);
    expect(r.text).toContain("<Code>ValidationError</Code>");
  });

  it("error envelope has correct shape (Type/Code/Message)", async () => {
    const r = await query({ Action: "SetDesiredCapacity", AutoScalingGroupName: "ghost", DesiredCapacity: "1" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("<ErrorResponse");
    expect(r.text).toContain("<Type>Sender</Type>");
    expect(r.text).toContain("<Code>ValidationError</Code>");
    expect(r.text).toContain("<Message>");
    expect(r.text).toContain("</Message>");
    expect(r.text).toContain("<RequestId>");
  });

  it("error: unsupported action returns ValidationError", async () => {
    const r = await query({ Action: "NoSuchAction" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("<Code>ValidationError</Code>");
    expect(r.text).toContain("not valid");
  });

  it("error: GET method returns 405", async () => {
    const r = await fetch(ENDPOINT, { method: "GET" });
    expect(r.status).toBe(405);
    const text = await r.text();
    expect(text).toContain("<Code>ValidationError</Code>");
  });

  it("ASG response includes empty elements for optional fields", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "asg5", MinSize: "0", MaxSize: "1", DesiredCapacity: "0" });
    const d = await query({ Action: "DescribeAutoScalingGroups", "AutoScalingGroupNames.member.1": "asg5" });
    expect(d.text).toContain("<LaunchConfigurationName/>");
    expect(d.text).toContain("<LaunchTemplate/>");
    expect(d.text).toContain("<MixedInstancesPolicy/>");
    expect(d.text).toContain("<LoadBalancerNames/>");
    expect(d.text).toContain("<TargetGroupARNs/>");
    expect(d.text).toContain("<SuspendedProcesses/>");
    expect(d.text).toContain("<PlacementGroup/>");
    expect(d.text).toContain("<EnabledMetrics/>");
    expect(d.text).toContain("<Status/>");
    expect(d.text).toContain("<TerminationPolicies>");
    expect(d.text).toContain("<ServiceLinkedRoleARN/>");
    expect(d.text).toContain("<TrafficSources/>");
  });

  it("ASG instance includes InstanceType and WeightedCapacity fields", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "asg6", MinSize: "0", MaxSize: "1", DesiredCapacity: "1" });
    const d = await query({ Action: "DescribeAutoScalingGroups", "AutoScalingGroupNames.member.1": "asg6" });
    expect(d.text).toContain("<InstanceType/>");
    expect(d.text).toContain("<WeightedCapacity/>");
    expect(d.text).toContain("<ProtectedFromScaleIn>false</ProtectedFromScaleIn>");
  });

  it("LaunchConfiguration response includes all fields", async () => {
    await query({
      Action: "CreateLaunchConfiguration",
      LaunchConfigurationName: "lc-full",
      ImageId: "ami-abc",
      InstanceType: "t3.large",
      KeyName: "my-key",
      "SecurityGroups.member.1": "sg-123",
    });
    const d = await query({ Action: "DescribeLaunchConfigurations", "LaunchConfigurationNames.member.1": "lc-full" });
    expect(d.text).toContain("<LaunchConfigurationName>lc-full</LaunchConfigurationName>");
    expect(d.text).toContain("<ImageId>ami-abc</ImageId>");
    expect(d.text).toContain("<InstanceType>t3.large</InstanceType>");
    expect(d.text).toContain("<KeyName>my-key</KeyName>");
    expect(d.text).toContain("<EbsOptimized>false</EbsOptimized>");
    expect(d.text).toContain("<KernelId/>");
    expect(d.text).toContain("<RamdiskId/>");
    expect(d.text).toContain("<BlockDeviceMappings/>");
    expect(d.text).toContain("<ClassicLinkVPCSecurityGroups/>");
  });

  it("error: duplicate LaunchConfiguration", async () => {
    await query({ Action: "CreateLaunchConfiguration", LaunchConfigurationName: "lc-dup", ImageId: "ami-1" });
    const r = await query({ Action: "CreateLaunchConfiguration", LaunchConfigurationName: "lc-dup", ImageId: "ami-2" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("<Code>AlreadyExists</Code>");
  });

  it("error: duplicate LaunchTemplate", async () => {
    await query({ Action: "CreateLaunchTemplate", LaunchTemplateName: "lt-dup", "LaunchTemplateData.ImageId": "ami-1" });
    const r = await query({ Action: "CreateLaunchTemplate", LaunchTemplateName: "lt-dup", "LaunchTemplateData.ImageId": "ami-2" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("<Code>AlreadyExists</Code>");
  });

  it("error: missing AutoScalingGroupName in CreateAutoScalingGroup", async () => {
    const r = await query({ Action: "CreateAutoScalingGroup", MinSize: "0", MaxSize: "1" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("<Code>ValidationError</Code>");
    expect(r.text).toContain("AutoScalingGroupName is required");
  });

  it("error: missing LaunchConfigurationName in CreateLaunchConfiguration", async () => {
    const r = await query({ Action: "CreateLaunchConfiguration", ImageId: "ami-1" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("<Code>ValidationError</Code>");
    expect(r.text).toContain("LaunchConfigurationName is required");
  });

  it("error: missing LaunchTemplateName in CreateLaunchTemplate", async () => {
    const r = await query({ Action: "CreateLaunchTemplate", "LaunchTemplateData.ImageId": "ami-1" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("<Code>ValidationError</Code>");
    expect(r.text).toContain("LaunchTemplateName is required");
  });

  it("DeleteAutoScalingGroup without instances succeeds", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "asg-empty", MinSize: "0", MaxSize: "1", DesiredCapacity: "0" });
    const r = await query({ Action: "DeleteAutoScalingGroup", AutoScalingGroupName: "asg-empty" });
    expect(r.status).toBe(200);
  });

  it("response includes ResponseMetadata with RequestId", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "asg-meta", MinSize: "0", MaxSize: "1", DesiredCapacity: "0" });
    const d = await query({ Action: "DescribeAutoScalingGroups", "AutoScalingGroupNames.member.1": "asg-meta" });
    expect(d.text).toContain("<ResponseMetadata>");
    expect(d.text).toContain("<RequestId>");
    expect(d.text).toContain("</ResponseMetadata>");
  });

  it("response wrapper uses correct namespace", async () => {
    await query({ Action: "CreateAutoScalingGroup", AutoScalingGroupName: "asg-ns", MinSize: "0", MaxSize: "1", DesiredCapacity: "0" });
    const d = await query({ Action: "DescribeAutoScalingGroups", "AutoScalingGroupNames.member.1": "asg-ns" });
    expect(d.text).toContain('xmlns="https://autoscaling.amazonaws.com/doc/2011-01-01/"');
  });
});
