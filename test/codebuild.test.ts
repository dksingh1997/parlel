import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CodebuildServer } from "../services/codebuild/src/server.js";

const PORT = 14742;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const TARGET_PREFIX = "CodeBuild_20161006";

async function op(name: string, body: unknown = {}) {
  const res = await fetch(ENDPOINT + "/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `${TARGET_PREFIX}.${name}`,
    },
    body: JSON.stringify(body),
  });
  let json: any = {};
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

let server: CodebuildServer;

beforeAll(async () => {
  server = new CodebuildServer(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

async function mkProject(name = "proj1") {
  return op("CreateProject", {
    name,
    source: { type: "GITHUB", location: "https://github.com/x/y" },
    artifacts: { type: "NO_ARTIFACTS" },
    environment: {
      type: "LINUX_CONTAINER",
      image: "aws/codebuild/standard:7.0",
      computeType: "BUILD_GENERAL1_SMALL",
    },
    serviceRole: "arn:aws:iam::000000000000:role/cb",
  });
}

describe("codebuild", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("codebuild");
  });

  it("default port 4742", () => {
    expect(new CodebuildServer().port).toBe(4742);
  });

  it("creates a project", async () => {
    const c = await mkProject("p1");
    expect(c.status).toBe(200);
    expect(c.json.project.arn).toContain("project/p1");
  });

  it("rejects duplicate project", async () => {
    await mkProject("dup");
    const again = await mkProject("dup");
    expect(again.status).toBe(400);
    expect(again.json.__type).toContain("ResourceAlreadyExists");
  });

  it("lists and batch-gets projects", async () => {
    await mkProject("a");
    await mkProject("b");
    const list = await op("ListProjects");
    expect(list.json.projects.sort()).toEqual(["a", "b"]);
    const batch = await op("BatchGetProjects", { names: ["a", "missing"] });
    expect(batch.json.projects.length).toBe(1);
    expect(batch.json.projectsNotFound).toEqual(["missing"]);
  });

  it("updates a project", async () => {
    await mkProject("u1");
    const upd = await op("UpdateProject", { name: "u1", description: "new desc" });
    expect(upd.status).toBe(200);
    expect(upd.json.project.description).toBe("new desc");
  });

  it("deletes a project", async () => {
    await mkProject("d1");
    const del = await op("DeleteProject", { name: "d1" });
    expect(del.status).toBe(200);
    const get = await op("BatchGetProjects", { names: ["d1"] });
    expect(get.json.projectsNotFound).toEqual(["d1"]);
  });

  it("starts a build with SUCCEEDED status", async () => {
    await mkProject("b1");
    const start = await op("StartBuild", { projectName: "b1" });
    expect(start.status).toBe(200);
    expect(start.json.build.buildStatus).toBe("SUCCEEDED");
    expect(start.json.build.buildNumber).toBe(1);
    expect(start.json.build.id).toContain("b1:");
  });

  it("batch-gets builds", async () => {
    await mkProject("b1");
    const s = await op("StartBuild", { projectName: "b1" });
    const id = s.json.build.id;
    const batch = await op("BatchGetBuilds", { ids: [id, "missing:1"] });
    expect(batch.json.builds.length).toBe(1);
    expect(batch.json.buildsNotFound).toEqual(["missing:1"]);
  });

  it("lists builds and builds for project", async () => {
    await mkProject("b1");
    await mkProject("b2");
    await op("StartBuild", { projectName: "b1" });
    await op("StartBuild", { projectName: "b2" });
    const all = await op("ListBuilds");
    expect(all.json.ids.length).toBe(2);
    const forB1 = await op("ListBuildsForProject", { projectName: "b1" });
    expect(forB1.json.ids.length).toBe(1);
  });

  it("stops a build", async () => {
    await mkProject("b1");
    const s = await op("StartBuild", { projectName: "b1" });
    const stop = await op("StopBuild", { id: s.json.build.id });
    expect(stop.status).toBe(200);
    expect(stop.json.build.buildStatus).toBe("STOPPED");
  });

  it("start build on missing project errors", async () => {
    const s = await op("StartBuild", { projectName: "nope" });
    expect(s.status).toBe(400);
    expect(s.json.__type).toContain("ResourceNotFound");
  });
});
