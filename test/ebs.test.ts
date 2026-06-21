import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EbsServer } from "../services/ebs/src/server.js";

const PORT = 14701;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function query(params: Record<string, string>) {
  const body = new URLSearchParams({ Version: "2016-11-15", ...params }).toString();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe("EBS", () => {
  let server: EbsServer;
  beforeAll(async () => {
    server = new EbsServer(PORT);
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
    expect(j.service).toBe("ebs");
  });

  it("CreateVolume + DescribeVolumes", async () => {
    const cv = await query({ Action: "CreateVolume", AvailabilityZone: "us-east-1a", Size: "20", VolumeType: "gp3" });
    expect(cv.text).toContain("<volumeId>vol-");
    expect(cv.text).toContain("<size>20</size>");
    const id = cv.text.match(/<volumeId>(vol-[0-9a-f]+)<\/volumeId>/)![1];

    const dv = await query({ Action: "DescribeVolumes", "VolumeId.1": id });
    expect(dv.text).toContain(id);
    expect(dv.text).toContain("<status>available</status>");
  });

  it("Attach + Detach volume", async () => {
    const cv = await query({ Action: "CreateVolume", AvailabilityZone: "us-east-1a", Size: "10" });
    const id = cv.text.match(/<volumeId>(vol-[0-9a-f]+)<\/volumeId>/)![1];

    const at = await query({ Action: "AttachVolume", VolumeId: id, InstanceId: "i-1234567890abcdef0", Device: "/dev/sdf" });
    expect(at.text).toContain("<status>attached</status>");

    const dv = await query({ Action: "DescribeVolumes", "VolumeId.1": id });
    expect(dv.text).toContain("<status>in-use</status>");

    const dt = await query({ Action: "DetachVolume", VolumeId: id });
    expect(dt.text).toContain("<status>detaching</status>");

    const dv2 = await query({ Action: "DescribeVolumes", "VolumeId.1": id });
    expect(dv2.text).toContain("<status>available</status>");
  });

  it("CreateSnapshot + DescribeSnapshots + Delete", async () => {
    const cv = await query({ Action: "CreateVolume", AvailabilityZone: "us-east-1a", Size: "8" });
    const vid = cv.text.match(/<volumeId>(vol-[0-9a-f]+)<\/volumeId>/)![1];

    const cs = await query({ Action: "CreateSnapshot", VolumeId: vid, Description: "backup" });
    expect(cs.text).toContain("<snapshotId>snap-");
    const sid = cs.text.match(/<snapshotId>(snap-[0-9a-f]+)<\/snapshotId>/)![1];
    expect(cs.text).toContain("<status>completed</status>");

    const ds = await query({ Action: "DescribeSnapshots", "SnapshotId.1": sid });
    expect(ds.text).toContain(sid);
    expect(ds.text).toContain("backup");

    const del = await query({ Action: "DeleteSnapshot", SnapshotId: sid });
    expect(del.text).toContain("<return>true</return>");

    const ds2 = await query({ Action: "DescribeSnapshots" });
    expect(ds2.text).not.toContain(sid);
  });

  it("DeleteVolume", async () => {
    const cv = await query({ Action: "CreateVolume", AvailabilityZone: "us-east-1a", Size: "5" });
    const id = cv.text.match(/<volumeId>(vol-[0-9a-f]+)<\/volumeId>/)![1];
    const del = await query({ Action: "DeleteVolume", VolumeId: id });
    expect(del.text).toContain("<return>true</return>");
    const dv = await query({ Action: "DescribeVolumes" });
    expect(dv.text).not.toContain(id);
  });

  it("cannot delete an attached volume", async () => {
    const cv = await query({ Action: "CreateVolume", AvailabilityZone: "us-east-1a", Size: "5" });
    const id = cv.text.match(/<volumeId>(vol-[0-9a-f]+)<\/volumeId>/)![1];
    await query({ Action: "AttachVolume", VolumeId: id, InstanceId: "i-1234567890abcdef0", Device: "/dev/sdf" });
    const del = await query({ Action: "DeleteVolume", VolumeId: id });
    expect(del.status).not.toBe(200);
    expect(del.text).toContain("VolumeInUse");
  });

  it("error: CreateVolume missing AvailabilityZone", async () => {
    const r = await query({ Action: "CreateVolume", Size: "10" });
    expect(r.status).not.toBe(200);
    expect(r.text).toContain("<Code>MissingParameter</Code>");
  });

  it("error: DescribeVolumes unknown id", async () => {
    const r = await query({ Action: "DescribeVolumes", "VolumeId.1": "vol-nope000000000" });
    expect(r.status).not.toBe(200);
    expect(r.text).toContain("InvalidVolume.NotFound");
  });
});
