import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ApigatewayV1Server } from "../services/apigateway-v1/src/server.js";

const PORT = 14715;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function jhr(method: string, path: string, body?: unknown) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* */
  }
  return { status: res.status, json, text, headers: res.headers };
}

describe("API Gateway v1 Service", () => {
  let server: ApigatewayV1Server;

  beforeAll(async () => {
    server = new ApigatewayV1Server(PORT);
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

    it("uses default port 4715", () => {
      const s = new ApigatewayV1Server();
      expect(s.port).toBe(4715);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.service).toBe("apigateway-v1");
    });

    it("supports POST /_parlel/reset", async () => {
      await jhr("POST", "/restapis", { name: "reset-api" });
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.restApis.size).toBe(0);
    });
  });

  describe("REST APIs", () => {
    it("creates a REST API with a root resource", async () => {
      const res = await jhr("POST", "/restapis", { name: "my-rest-api" });
      expect(res.status).toBe(200);
      expect(res.json.id).toBeTruthy();
      expect(res.json.rootResourceId).toBeTruthy();
      const apiId = res.json.id;
      const resources = await jhr("GET", `/restapis/${apiId}/resources`);
      expect(resources.json.items.length).toBe(1);
      expect(resources.json.items[0].path).toBe("/");
    });

    it("rejects a REST API without a name", async () => {
      const res = await jhr("POST", "/restapis", {});
      expect(res.status).toBe(400);
      expect(res.json.__type).toBe("BadRequestException");
      expect(res.json.message).toBeTruthy();
      expect(res.json.Message).toBeUndefined();
    });

    it("gets and lists REST APIs", async () => {
      const created = await jhr("POST", "/restapis", { name: "g-rest" });
      const id = created.json.id;
      const got = await jhr("GET", `/restapis/${id}`);
      expect(got.json.name).toBe("g-rest");
      const list = await jhr("GET", "/restapis");
      expect(list.json.items.length).toBe(1);
    });

    it("deletes a REST API", async () => {
      const created = await jhr("POST", "/restapis", { name: "d-rest" });
      const id = created.json.id;
      const del = await jhr("DELETE", `/restapis/${id}`);
      expect(del.status).toBe(202);
      const got = await jhr("GET", `/restapis/${id}`);
      expect(got.status).toBe(404);
    });

    it("updates a REST API via PATCH", async () => {
      const created = await jhr("POST", "/restapis", { name: "u-rest" });
      const id = created.json.id;
      const patched = await jhr("PATCH", `/restapis/${id}`, { name: "u-rest-v2", description: "updated" });
      expect(patched.status).toBe(200);
      expect(patched.json.name).toBe("u-rest-v2");
      expect(patched.json.description).toBe("updated");
    });
  });

  describe("Resources, methods, deployments, stages", () => {
    let apiId: string;
    let rootId: string;

    beforeEach(async () => {
      const created = await jhr("POST", "/restapis", { name: "full-rest" });
      apiId = created.json.id;
      rootId = created.json.rootResourceId;
    });

    it("creates a child resource and puts a method", async () => {
      const child = await jhr("POST", `/restapis/${apiId}/resources/${rootId}`, {
        pathPart: "items",
      });
      expect(child.status).toBe(200);
      expect(child.json.path).toBe("/items");

      const method = await jhr(
        "PUT",
        `/restapis/${apiId}/resources/${child.json.id}/methods/GET`,
        { authorizationType: "NONE" },
      );
      expect(method.status).toBe(200);
      expect(method.json.httpMethod).toBe("GET");

      const getM = await jhr(
        "GET",
        `/restapis/${apiId}/resources/${child.json.id}/methods/GET`,
      );
      expect(getM.status).toBe(200);
    });

    it("deletes a resource", async () => {
      const child = await jhr("POST", `/restapis/${apiId}/resources/${rootId}`, {
        pathPart: "tmp",
      });
      const resId = child.json.id;
      const del = await jhr("DELETE", `/restapis/${apiId}/resources/${resId}`);
      expect(del.status).toBe(202);
      const get = await jhr("GET", `/restapis/${apiId}/resources/${resId}`);
      expect(get.status).toBe(404);
    });

    it("creates a deployment and a stage", async () => {
      const deploy = await jhr("POST", `/restapis/${apiId}/deployments`, {
        description: "first",
      });
      expect(deploy.status).toBe(200);
      expect(deploy.json.apiSummary).toBeDefined();
      const deploymentId = deploy.json.id;

      const stage = await jhr("POST", `/restapis/${apiId}/stages`, {
        stageName: "prod",
        deploymentId,
      });
      expect(stage.status).toBe(200);
      expect(stage.json.stageName).toBe("prod");

      const getStage = await jhr("GET", `/restapis/${apiId}/stages/prod`);
      expect(getStage.json.deploymentId).toBe(deploymentId);
    });

    it("gets a deployment by ID", async () => {
      const deploy = await jhr("POST", `/restapis/${apiId}/deployments`, {
        description: "dep-1",
      });
      const deploymentId = deploy.json.id;
      const got = await jhr("GET", `/restapis/${apiId}/deployments/${deploymentId}`);
      expect(got.status).toBe(200);
      expect(got.json.id).toBe(deploymentId);
    });

    it("deletes a deployment", async () => {
      const deploy = await jhr("POST", `/restapis/${apiId}/deployments`, {
        description: "dep-del",
      });
      const deploymentId = deploy.json.id;
      const del = await jhr("DELETE", `/restapis/${apiId}/deployments/${deploymentId}`);
      expect(del.status).toBe(202);
      const got = await jhr("GET", `/restapis/${apiId}/deployments/${deploymentId}`);
      expect(got.status).toBe(404);
    });

    it("deletes a stage", async () => {
      const deploy = await jhr("POST", `/restapis/${apiId}/deployments`, { description: "d" });
      await jhr("POST", `/restapis/${apiId}/stages`, {
        stageName: "staging",
        deploymentId: deploy.json.id,
      });
      const del = await jhr("DELETE", `/restapis/${apiId}/stages/staging`);
      expect(del.status).toBe(202);
      const got = await jhr("GET", `/restapis/${apiId}/stages/staging`);
      expect(got.status).toBe(404);
    });

    it("updates a stage via PATCH", async () => {
      const deploy = await jhr("POST", `/restapis/${apiId}/deployments`, { description: "d" });
      await jhr("POST", `/restapis/${apiId}/stages`, {
        stageName: "dev",
        deploymentId: deploy.json.id,
      });
      const patched = await jhr("PATCH", `/restapis/${apiId}/stages/dev`, {
        description: "updated stage",
        variables: { key: "val" },
      });
      expect(patched.status).toBe(200);
      expect(patched.json.description).toBe("updated stage");
      expect(patched.json.variables.key).toBe("val");
    });

    it("rejects a stage without a deploymentId", async () => {
      const res = await jhr("POST", `/restapis/${apiId}/stages`, { stageName: "dev" });
      expect(res.status).toBe(400);
    });

    it("errors creating a resource on a missing API", async () => {
      const res = await jhr("POST", "/restapis/ghost/resources/root", { pathPart: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("API keys", () => {
    it("creates and lists API keys", async () => {
      const created = await jhr("POST", "/apikeys", { name: "key-1", enabled: true });
      expect(created.status).toBe(201);
      expect(created.json.value).toBeTruthy();
      const list = await jhr("GET", "/apikeys");
      expect(list.json.items.length).toBe(1);
      expect(list.json.items[0].name).toBe("key-1");
    });

    it("gets an API key by ID", async () => {
      const created = await jhr("POST", "/apikeys", { name: "key-single" });
      const keyId = created.json.id;
      const got = await jhr("GET", `/apikeys/${keyId}`);
      expect(got.status).toBe(200);
      expect(got.json.name).toBe("key-single");
    });

    it("returns 404 for missing API key", async () => {
      const got = await jhr("GET", "/apikeys/nonexistent");
      expect(got.status).toBe(404);
      expect(got.json.__type).toBe("NotFoundException");
    });
  });

  describe("Error envelope", () => {
    it("returns correct error shape without extra Message field", async () => {
      const res = await jhr("GET", "/restapis/nonexistent");
      expect(res.status).toBe(404);
      expect(res.json.__type).toBe("NotFoundException");
      expect(res.json.message).toBeTruthy();
      expect(res.json.Message).toBeUndefined();
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await fetch(`${ENDPOINT}/restapis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.__type).toBe("BadRequestException");
    });

    it("returns 404 for unknown paths", async () => {
      const res = await jhr("GET", "/unknown/path");
      expect(res.status).toBe(404);
    });

    it("returns x-amzn-errortype header on errors", async () => {
      const res = await fetch(`${ENDPOINT}/restapis/nonexistent`);
      expect(res.headers.get("x-amzn-errortype")).toBe("NotFoundException");
    });

    it("returns x-amzn-RequestId header", async () => {
      const res = await fetch(`${ENDPOINT}/restapis`);
      expect(res.headers.get("x-amzn-RequestId")).toBeTruthy();
    });
  });
});
