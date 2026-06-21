import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EcrServer } from "../services/ecr/src/server.js";

const PORT = 14702;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const PREFIX = "AmazonEC2ContainerRegistry_V20150921";

async function call(op: string, body: object) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `${PREFIX}.${op}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("ECR", () => {
  let server: EcrServer;
  beforeAll(async () => {
    server = new EcrServer(PORT);
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

  it("CreateRepository + DescribeRepositories", async () => {
    const c = await call("CreateRepository", { repositoryName: "my-app" });
    expect(c.status).toBe(200);
    expect(c.json.repository.repositoryName).toBe("my-app");
    expect(c.json.repository.repositoryUri).toContain("my-app");
    expect(c.json.repository.repositoryArn).toContain("repository/my-app");

    const d = await call("DescribeRepositories", {});
    expect(d.json.repositories).toHaveLength(1);
  });

  it("duplicate repository errors", async () => {
    await call("CreateRepository", { repositoryName: "dup" });
    const c = await call("CreateRepository", { repositoryName: "dup" });
    expect(c.status).not.toBe(200);
    expect(c.json.__type).toBe("RepositoryAlreadyExistsException");
  });

  it("PutImage + ListImages + DescribeImages", async () => {
    await call("CreateRepository", { repositoryName: "img" });
    const p = await call("PutImage", { repositoryName: "img", imageManifest: '{"schemaVersion":2}', imageTag: "v1" });
    expect(p.status).toBe(200);
    expect(p.json.image.imageId.imageTag).toBe("v1");
    const digest = p.json.image.imageId.imageDigest;
    expect(digest).toContain("sha256:");

    const l = await call("ListImages", { repositoryName: "img" });
    expect(l.json.imageIds).toEqual([{ imageDigest: digest, imageTag: "v1" }]);

    const di = await call("DescribeImages", { repositoryName: "img" });
    expect(di.json.imageDetails[0].imageTags).toContain("v1");
  });

  it("BatchGetImage retrieves manifest", async () => {
    await call("CreateRepository", { repositoryName: "bg" });
    await call("PutImage", { repositoryName: "bg", imageManifest: '{"schemaVersion":2,"x":1}', imageTag: "latest" });
    const b = await call("BatchGetImage", { repositoryName: "bg", imageIds: [{ imageTag: "latest" }] });
    expect(b.json.images).toHaveLength(1);
    expect(b.json.images[0].imageManifest).toContain("schemaVersion");
    expect(b.json.failures).toHaveLength(0);
  });

  it("BatchGetImage reports failures for missing", async () => {
    await call("CreateRepository", { repositoryName: "bg2" });
    const b = await call("BatchGetImage", { repositoryName: "bg2", imageIds: [{ imageTag: "nope" }] });
    expect(b.json.images).toHaveLength(0);
    expect(b.json.failures[0].failureCode).toBe("ImageNotFound");
  });

  it("GetAuthorizationToken", async () => {
    const t = await call("GetAuthorizationToken", {});
    expect(t.json.authorizationData[0].authorizationToken).toBeTruthy();
    expect(t.json.authorizationData[0].proxyEndpoint).toContain("dkr.ecr");
  });

  it("DeleteRepository (force on non-empty)", async () => {
    await call("CreateRepository", { repositoryName: "del" });
    await call("PutImage", { repositoryName: "del", imageManifest: "{}", imageTag: "t" });
    const fail = await call("DeleteRepository", { repositoryName: "del" });
    expect(fail.status).not.toBe(200);
    expect(fail.json.__type).toBe("RepositoryNotEmptyException");

    const ok = await call("DeleteRepository", { repositoryName: "del", force: true });
    expect(ok.status).toBe(200);
    const d = await call("DescribeRepositories", {});
    expect(d.json.repositories).toHaveLength(0);
  });

  it("error: describe unknown repository", async () => {
    const r = await call("DescribeRepositories", { repositoryNames: ["ghost"] });
    expect(r.status).not.toBe(200);
    expect(r.json.__type).toBe("RepositoryNotFoundException");
  });
});
