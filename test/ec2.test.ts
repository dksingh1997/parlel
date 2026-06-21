import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Ec2Server } from "../services/ec2/src/server.js";

const PORT = 14700;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function query(params: Record<string, string>) {
  const body = new URLSearchParams({ Version: "2016-11-15", ...params }).toString();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  return { status: res.status, text };
}

describe("EC2", () => {
  let server: Ec2Server;
  beforeAll(async () => {
    server = new Ec2Server(PORT);
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
    expect(j.service).toBe("ec2");
  });

  it("RunInstances + DescribeInstances round-trip", async () => {
    const run = await query({ Action: "RunInstances", ImageId: "ami-0abcdef1234567890", MinCount: "1", MaxCount: "1", InstanceType: "t3.small" });
    expect(run.status).toBe(200);
    expect(run.text).toContain("<instanceId>i-");
    expect(run.text).toContain("<name>running</name>");
    const id = run.text.match(/<instanceId>(i-[0-9a-f]+)<\/instanceId>/)![1];

    const desc = await query({ Action: "DescribeInstances" });
    expect(desc.text).toContain(id);
    expect(desc.text).toContain("<instanceType>t3.small</instanceType>");
  });

  it("Stop / Start / Terminate transitions", async () => {
    const run = await query({ Action: "RunInstances", ImageId: "ami-0abcdef1234567890" });
    const id = run.text.match(/<instanceId>(i-[0-9a-f]+)<\/instanceId>/)![1];

    const stop = await query({ Action: "StopInstances", "InstanceId.1": id });
    expect(stop.text).toContain("<name>stopped</name>");

    const start = await query({ Action: "StartInstances", "InstanceId.1": id });
    expect(start.text).toContain("<name>running</name>");

    const term = await query({ Action: "TerminateInstances", "InstanceId.1": id });
    expect(term.text).toContain("<name>terminated</name>");
  });

  it("CreateSecurityGroup + Authorize + Describe", async () => {
    const cg = await query({ Action: "CreateSecurityGroup", GroupName: "web", GroupDescription: "web sg" });
    expect(cg.text).toContain("<groupId>sg-");
    const gid = cg.text.match(/<groupId>(sg-[0-9a-f]+)<\/groupId>/)![1];

    const auth = await query({ Action: "AuthorizeSecurityGroupIngress", GroupId: gid, IpProtocol: "tcp", FromPort: "80", ToPort: "80", CidrIp: "0.0.0.0/0" });
    expect(auth.text).toContain("<return>true</return>");

    const desc = await query({ Action: "DescribeSecurityGroups", "GroupId.1": gid });
    expect(desc.text).toContain("web");
    expect(desc.text).toContain("<cidrIp>0.0.0.0/0</cidrIp>");
  });

  it("CreateVpc + CreateSubnet + Describe", async () => {
    const vpc = await query({ Action: "CreateVpc", CidrBlock: "10.0.0.0/16" });
    expect(vpc.text).toContain("<vpcId>vpc-");
    const vpcId = vpc.text.match(/<vpcId>(vpc-[0-9a-f]+)<\/vpcId>/)![1];

    const subnet = await query({ Action: "CreateSubnet", VpcId: vpcId, CidrBlock: "10.0.1.0/24" });
    expect(subnet.text).toContain("<subnetId>subnet-");
    const subnetId = subnet.text.match(/<subnetId>(subnet-[0-9a-f]+)<\/subnetId>/)![1];

    const dv = await query({ Action: "DescribeVpcs", "VpcId.1": vpcId });
    expect(dv.text).toContain("10.0.0.0/16");

    const ds = await query({ Action: "DescribeSubnets", "SubnetId.1": subnetId });
    expect(ds.text).toContain("10.0.1.0/24");
    expect(ds.text).toContain(vpcId);
  });

  it("DescribeImages returns seeded AMI", async () => {
    const di = await query({ Action: "DescribeImages" });
    expect(di.text).toContain("<imageId>ami-");
    expect(di.text).toContain("parlel-amzn2-base");
  });

  it("CreateTags + DescribeTags", async () => {
    const run = await query({ Action: "RunInstances", ImageId: "ami-0abcdef1234567890" });
    const id = run.text.match(/<instanceId>(i-[0-9a-f]+)<\/instanceId>/)![1];
    const ct = await query({ Action: "CreateTags", "ResourceId.1": id, "Tag.1.Key": "Env", "Tag.1.Value": "prod" });
    expect(ct.text).toContain("<return>true</return>");
    const dt = await query({ Action: "DescribeTags" });
    expect(dt.text).toContain("<key>Env</key>");
    expect(dt.text).toContain("<value>prod</value>");
  });

  it("CreateKeyPair returns material", async () => {
    const kp = await query({ Action: "CreateKeyPair", KeyName: "mykey" });
    expect(kp.text).toContain("<keyName>mykey</keyName>");
    expect(kp.text).toContain("<keyFingerprint>");
    expect(kp.text).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("error: RunInstances missing ImageId", async () => {
    const r = await query({ Action: "RunInstances", MinCount: "1", MaxCount: "1" });
    expect(r.status).not.toBe(200);
    expect(r.text).toContain("<Code>MissingParameter</Code>");
  });

  it("error: DescribeInstances unknown id", async () => {
    const r = await query({ Action: "DescribeInstances", "InstanceId.1": "i-doesnotexist000" });
    expect(r.status).not.toBe(200);
    expect(r.text).toContain("InvalidInstanceID.NotFound");
  });
});
