import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EfsServer } from "../services/efs/src/server.js";

const PORT = 14708;
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

describe("EFS", () => {
  let server: EfsServer;
  beforeAll(async () => {
    server = new EfsServer(PORT);
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

  it("CreateFileSystem + DescribeFileSystems", async () => {
    const c = await req("POST", "/2015-02-01/file-systems", { CreationToken: "tok1", Tags: [{ Key: "Name", Value: "data" }] });
    expect(c.status).toBe(201);
    expect(c.json.FileSystemId).toContain("fs-");
    expect(c.json.LifeCycleState).toBe("available");
    expect(c.json.Name).toBe("data");
    const id = c.json.FileSystemId;

    const d = await req("GET", "/2015-02-01/file-systems");
    expect(d.json.FileSystems).toHaveLength(1);

    const one = await req("GET", `/2015-02-01/file-systems/${id}`);
    expect(one.json.FileSystems[0].FileSystemId).toBe(id);
  });

  it("CreateMountTarget + DescribeMountTargets", async () => {
    const c = await req("POST", "/2015-02-01/file-systems", { CreationToken: "tok2" });
    const fsid = c.json.FileSystemId;
    const mt = await req("POST", "/2015-02-01/mount-targets", { FileSystemId: fsid, SubnetId: "subnet-123" });
    expect(mt.status).toBe(200);
    expect(mt.json.MountTargetId).toContain("fsmt-");
    expect(mt.json.IpAddress).toBeTruthy();

    const d = await req("GET", `/2015-02-01/mount-targets?FileSystemId=${fsid}`);
    expect(d.json.MountTargets).toHaveLength(1);
    expect(d.json.MountTargets[0].FileSystemId).toBe(fsid);
  });

  it("file system NumberOfMountTargets reflects mounts", async () => {
    const c = await req("POST", "/2015-02-01/file-systems", { CreationToken: "tok3" });
    const fsid = c.json.FileSystemId;
    await req("POST", "/2015-02-01/mount-targets", { FileSystemId: fsid, SubnetId: "subnet-a" });
    await req("POST", "/2015-02-01/mount-targets", { FileSystemId: fsid, SubnetId: "subnet-b" });
    const d = await req("GET", `/2015-02-01/file-systems/${fsid}`);
    expect(d.json.FileSystems[0].NumberOfMountTargets).toBe(2);
  });

  it("cannot delete fs with mount targets", async () => {
    const c = await req("POST", "/2015-02-01/file-systems", { CreationToken: "tok4" });
    const fsid = c.json.FileSystemId;
    await req("POST", "/2015-02-01/mount-targets", { FileSystemId: fsid, SubnetId: "subnet-x" });
    const del = await req("DELETE", `/2015-02-01/file-systems/${fsid}`);
    expect(del.status).toBe(409);
    expect(del.json.ErrorCode).toBe("FileSystemInUse");
  });

  it("DeleteFileSystem", async () => {
    const c = await req("POST", "/2015-02-01/file-systems", { CreationToken: "tok5" });
    const fsid = c.json.FileSystemId;
    const del = await req("DELETE", `/2015-02-01/file-systems/${fsid}`);
    expect(del.status).toBe(204);
    const d = await req("GET", "/2015-02-01/file-systems");
    expect(d.json.FileSystems).toHaveLength(0);
  });

  it("error: describe unknown file system", async () => {
    const r = await req("GET", "/2015-02-01/file-systems/fs-ghost000000000");
    expect(r.status).toBe(404);
    expect(r.json.ErrorCode).toBe("FileSystemNotFound");
  });

  it("error: mount target on missing fs", async () => {
    const r = await req("POST", "/2015-02-01/mount-targets", { FileSystemId: "fs-nope0000000000", SubnetId: "subnet-1" });
    expect(r.status).toBe(404);
    expect(r.json.ErrorCode).toBe("FileSystemNotFound");
  });
});
