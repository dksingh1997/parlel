import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AppconfigServer } from "../services/appconfig/src/server.js";

const PORT = 14739;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(ENDPOINT + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

let server: AppconfigServer;

beforeAll(async () => {
  server = new AppconfigServer(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

async function mkApp(name = "app1") {
  const res = await call("POST", "/applications", { Name: name, Description: "d" });
  return res.json.Id as string;
}

describe("appconfig", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("appconfig");
  });

  it("default port 4739", () => {
    expect(new AppconfigServer().port).toBe(4739);
  });

  it("creates and gets application", async () => {
    const create = await call("POST", "/applications", { Name: "myapp" });
    expect(create.status).toBe(201);
    const id = create.json.Id;
    const get = await call("GET", `/applications/${id}`);
    expect(get.status).toBe(200);
    expect(get.json.Name).toBe("myapp");
  });

  it("lists applications", async () => {
    await mkApp("a1");
    await mkApp("a2");
    const list = await call("GET", "/applications");
    expect(list.json.Items.length).toBe(2);
  });

  it("creates and lists environments", async () => {
    const id = await mkApp();
    const env = await call("POST", `/applications/${id}/environments`, { Name: "prod" });
    expect(env.status).toBe(201);
    expect(env.json.State).toBe("ReadyForDeployment");
    const list = await call("GET", `/applications/${id}/environments`);
    expect(list.json.Items.length).toBe(1);
  });

  it("creates and lists configuration profiles", async () => {
    const id = await mkApp();
    const prof = await call("POST", `/applications/${id}/configurationprofiles`, {
      Name: "config",
      LocationUri: "hosted",
    });
    expect(prof.status).toBe(201);
    const list = await call("GET", `/applications/${id}/configurationprofiles`);
    expect(list.json.Items.length).toBe(1);
    expect(list.json.Items[0].Name).toBe("config");
  });

  it("requires LocationUri on profile", async () => {
    const id = await mkApp();
    const prof = await call("POST", `/applications/${id}/configurationprofiles`, { Name: "x" });
    expect(prof.status).toBe(400);
  });

  it("starts a deployment", async () => {
    const id = await mkApp();
    const env = await call("POST", `/applications/${id}/environments`, { Name: "prod" });
    const envId = env.json.Id;
    const prof = await call("POST", `/applications/${id}/configurationprofiles`, {
      Name: "config",
      LocationUri: "hosted",
    });
    const dep = await call("POST", `/applications/${id}/environments/${envId}/deployments`, {
      ConfigurationProfileId: prof.json.Id,
      ConfigurationVersion: "1",
      DeploymentStrategyId: "AppConfig.AllAtOnce",
    });
    expect(dep.status).toBe(201);
    expect(dep.json.State).toBe("COMPLETE");
    expect(dep.json.DeploymentNumber).toBe(1);
  });

  it("404 on missing application", async () => {
    const res = await call("GET", "/applications/nope1234");
    expect(res.status).toBe(404);
  });

  it("404 environment on missing application", async () => {
    const res = await call("GET", "/applications/nope1234/environments");
    expect(res.status).toBe(404);
  });
});
