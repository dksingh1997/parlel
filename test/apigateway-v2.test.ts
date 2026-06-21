import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ApigatewayV2Server } from "../services/apigateway-v2/src/server.js";

const PORT = 14714;
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
    /* non-json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

describe("API Gateway v2 Service", () => {
  let server: ApigatewayV2Server;

  beforeAll(async () => {
    server = new ApigatewayV2Server(PORT);
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

    it("uses default port 4714", () => {
      const s = new ApigatewayV2Server();
      expect(s.port).toBe(4714);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.service).toBe("apigateway-v2");
    });

    it("supports POST /_parlel/reset", async () => {
      await jhr("POST", "/v2/apis", { Name: "reset-api", ProtocolType: "HTTP" });
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.apis.size).toBe(0);
    });
  });

  describe("APIs", () => {
    it("creates an HTTP API", async () => {
      const res = await jhr("POST", "/v2/apis", { Name: "http-api", ProtocolType: "HTTP" });
      expect(res.status).toBe(201);
      expect(res.json.ApiId).toBeTruthy();
      expect(res.json.ProtocolType).toBe("HTTP");
      expect(res.json.ApiEndpoint).toContain("execute-api");
      expect(res.json.CreatedDate).toBeTruthy();
    });

    it("creates a WebSocket API", async () => {
      const res = await jhr("POST", "/v2/apis", {
        Name: "ws-api",
        ProtocolType: "WEBSOCKET",
        RouteSelectionExpression: "$request.body.action",
      });
      expect(res.status).toBe(201);
      expect(res.json.ProtocolType).toBe("WEBSOCKET");
    });

    it("rejects WebSocket API without RouteSelectionExpression", async () => {
      const res = await jhr("POST", "/v2/apis", { Name: "bad-ws", ProtocolType: "WEBSOCKET" });
      expect(res.status).toBe(400);
      expect(res.json.message).toContain("RouteSelectionExpression");
    });

    it("rejects missing Name", async () => {
      const res = await jhr("POST", "/v2/apis", { ProtocolType: "HTTP" });
      expect(res.status).toBe(400);
      expect(res.json.message).toBeTruthy();
    });

    it("rejects invalid ProtocolType", async () => {
      const res = await jhr("POST", "/v2/apis", { Name: "bad", ProtocolType: "INVALID" });
      expect(res.status).toBe(400);
      expect(res.json.message).toContain("ProtocolType");
    });

    it("gets and lists APIs", async () => {
      const created = await jhr("POST", "/v2/apis", { Name: "g-api", ProtocolType: "HTTP" });
      const id = created.json.ApiId;
      const got = await jhr("GET", `/v2/apis/${id}`);
      expect(got.json.Name).toBe("g-api");
      const list = await jhr("GET", "/v2/apis");
      expect(list.json.Items.length).toBe(1);
    });

    it("deletes an API", async () => {
      const created = await jhr("POST", "/v2/apis", { Name: "d-api", ProtocolType: "HTTP" });
      const id = created.json.ApiId;
      const del = await jhr("DELETE", `/v2/apis/${id}`);
      expect(del.status).toBe(204);
      expect(del.text).toBe("");
      const got = await jhr("GET", `/v2/apis/${id}`);
      expect(got.status).toBe(404);
      expect(got.json.message).toContain("Invalid API identifier");
      expect(got.json.resourceType).toBe("Api");
    });
  });

  describe("Error envelope shape", () => {
    it("returns { message } without __type or Message on 404", async () => {
      const res = await jhr("GET", "/v2/apis/nonexistent");
      expect(res.status).toBe(404);
      expect(res.json.__type).toBeUndefined();
      expect(res.json.Message).toBeUndefined();
      expect(res.json.message).toBeTruthy();
    });

    it("returns x-amzn-errortype header on errors", async () => {
      const res = await fetch(`${ENDPOINT}/v2/apis/nonexistent`);
      expect(res.headers.get("x-amzn-errortype")).toBe("NotFoundException");
    });

    it("returns x-amzn-RequestId header on all responses", async () => {
      const res = await fetch(`${ENDPOINT}/v2/apis`);
      expect(res.headers.get("x-amzn-RequestId")).toBeTruthy();
    });
  });

  describe("Routes", () => {
    let apiId: string;

    beforeEach(async () => {
      const created = await jhr("POST", "/v2/apis", { Name: "route-api", ProtocolType: "HTTP" });
      apiId = created.json.ApiId;
    });

    it("creates and gets a route", async () => {
      const created = await jhr("POST", `/v2/apis/${apiId}/routes`, { RouteKey: "GET /items" });
      expect(created.status).toBe(201);
      expect(created.json.RouteId).toBeTruthy();
      expect(created.json.RouteKey).toBe("GET /items");
      expect(created.json.AuthorizationType).toBe("NONE");

      const got = await jhr("GET", `/v2/apis/${apiId}/routes/${created.json.RouteId}`);
      expect(got.status).toBe(200);
      expect(got.json.RouteKey).toBe("GET /items");
    });

    it("lists routes", async () => {
      await jhr("POST", `/v2/apis/${apiId}/routes`, { RouteKey: "GET /a" });
      await jhr("POST", `/v2/apis/${apiId}/routes`, { RouteKey: "POST /b" });
      const list = await jhr("GET", `/v2/apis/${apiId}/routes`);
      expect(list.status).toBe(200);
      expect(list.json.Items.length).toBe(2);
    });

    it("deletes a route", async () => {
      const created = await jhr("POST", `/v2/apis/${apiId}/routes`, { RouteKey: "DELETE /x" });
      const routeId = created.json.RouteId;
      const del = await jhr("DELETE", `/v2/apis/${apiId}/routes/${routeId}`);
      expect(del.status).toBe(204);
      const got = await jhr("GET", `/v2/apis/${apiId}/routes/${routeId}`);
      expect(got.status).toBe(404);
    });

    it("returns 404 for missing route", async () => {
      const res = await jhr("GET", `/v2/apis/${apiId}/routes/nosuchroute`);
      expect(res.status).toBe(404);
      expect(res.json.message).toContain("Route not found");
    });

    it("rejects missing RouteKey", async () => {
      const res = await jhr("POST", `/v2/apis/${apiId}/routes`, { Target: "integrations/i" });
      expect(res.status).toBe(400);
      expect(res.json.message).toContain("RouteKey");
    });
  });

  describe("Integrations", () => {
    let apiId: string;

    beforeEach(async () => {
      const created = await jhr("POST", "/v2/apis", { Name: "integ-api", ProtocolType: "HTTP" });
      apiId = created.json.ApiId;
    });

    it("creates and gets an integration", async () => {
      const created = await jhr("POST", `/v2/apis/${apiId}/integrations`, {
        IntegrationType: "AWS_PROXY",
        IntegrationUri: "arn:aws:lambda:us-east-1:000000000000:function:f",
      });
      expect(created.status).toBe(201);
      expect(created.json.IntegrationId).toBeTruthy();
      expect(created.json.IntegrationType).toBe("AWS_PROXY");
      expect(created.json.PayloadFormatVersion).toBe("2.0");

      const got = await jhr("GET", `/v2/apis/${apiId}/integrations/${created.json.IntegrationId}`);
      expect(got.status).toBe(200);
      expect(got.json.IntegrationType).toBe("AWS_PROXY");
    });

    it("lists integrations", async () => {
      await jhr("POST", `/v2/apis/${apiId}/integrations`, { IntegrationType: "MOCK" });
      await jhr("POST", `/v2/apis/${apiId}/integrations`, { IntegrationType: "HTTP_PROXY", IntegrationUri: "https://example.com" });
      const list = await jhr("GET", `/v2/apis/${apiId}/integrations`);
      expect(list.status).toBe(200);
      expect(list.json.Items.length).toBe(2);
    });

    it("deletes an integration", async () => {
      const created = await jhr("POST", `/v2/apis/${apiId}/integrations`, { IntegrationType: "MOCK" });
      const intId = created.json.IntegrationId;
      const del = await jhr("DELETE", `/v2/apis/${apiId}/integrations/${intId}`);
      expect(del.status).toBe(204);
      const got = await jhr("GET", `/v2/apis/${apiId}/integrations/${intId}`);
      expect(got.status).toBe(404);
    });

    it("returns 404 for missing integration", async () => {
      const res = await jhr("GET", `/v2/apis/${apiId}/integrations/nosuchint`);
      expect(res.status).toBe(404);
      expect(res.json.message).toContain("Integration not found");
    });

    it("rejects missing IntegrationType", async () => {
      const res = await jhr("POST", `/v2/apis/${apiId}/integrations`, { IntegrationUri: "https://example.com" });
      expect(res.status).toBe(400);
      expect(res.json.message).toContain("IntegrationType");
    });

    it("rejects invalid IntegrationType", async () => {
      const res = await jhr("POST", `/v2/apis/${apiId}/integrations`, { IntegrationType: "INVALID" });
      expect(res.status).toBe(400);
      expect(res.json.message).toContain("Invalid IntegrationType");
    });
  });

  describe("Stages", () => {
    let apiId: string;

    beforeEach(async () => {
      const created = await jhr("POST", "/v2/apis", { Name: "stage-api", ProtocolType: "HTTP" });
      apiId = created.json.ApiId;
    });

    it("creates and gets a stage", async () => {
      const created = await jhr("POST", `/v2/apis/${apiId}/stages`, { StageName: "prod" });
      expect(created.status).toBe(201);
      expect(created.json.StageName).toBe("prod");
      expect(created.json.CreatedDate).toBeTruthy();
      expect(created.json.LastUpdatedDate).toBeTruthy();

      const got = await jhr("GET", `/v2/apis/${apiId}/stages/prod`);
      expect(got.status).toBe(200);
      expect(got.json.StageName).toBe("prod");
    });

    it("lists stages", async () => {
      await jhr("POST", `/v2/apis/${apiId}/stages`, { StageName: "dev" });
      await jhr("POST", `/v2/apis/${apiId}/stages`, { StageName: "prod" });
      const list = await jhr("GET", `/v2/apis/${apiId}/stages`);
      expect(list.status).toBe(200);
      expect(list.json.Items.length).toBe(2);
    });

    it("deletes a stage", async () => {
      await jhr("POST", `/v2/apis/${apiId}/stages`, { StageName: "temp" });
      const del = await jhr("DELETE", `/v2/apis/${apiId}/stages/temp`);
      expect(del.status).toBe(204);
      const got = await jhr("GET", `/v2/apis/${apiId}/stages/temp`);
      expect(got.status).toBe(404);
    });

    it("returns 404 for missing stage", async () => {
      const res = await jhr("GET", `/v2/apis/${apiId}/stages/nosuchstage`);
      expect(res.status).toBe(404);
      expect(res.json.message).toContain("Stage not found");
    });

    it("returns 404 when deleting missing stage", async () => {
      const res = await jhr("DELETE", `/v2/apis/${apiId}/stages/nosuchstage`);
      expect(res.status).toBe(404);
    });

    it("rejects duplicate stage", async () => {
      await jhr("POST", `/v2/apis/${apiId}/stages`, { StageName: "dev" });
      const dup = await jhr("POST", `/v2/apis/${apiId}/stages`, { StageName: "dev" });
      expect(dup.status).toBe(409);
      expect(dup.json.message).toContain("Stage already exists");
    });

    it("rejects missing StageName", async () => {
      const res = await jhr("POST", `/v2/apis/${apiId}/stages`, {});
      expect(res.status).toBe(400);
      expect(res.json.message).toContain("StageName");
    });
  });

  describe("Deployments", () => {
    let apiId: string;

    beforeEach(async () => {
      const created = await jhr("POST", "/v2/apis", { Name: "deploy-api", ProtocolType: "HTTP" });
      apiId = created.json.ApiId;
    });

    it("creates and gets a deployment", async () => {
      const created = await jhr("POST", `/v2/apis/${apiId}/deployments`, { Description: "v1" });
      expect(created.status).toBe(201);
      expect(created.json.DeploymentId).toBeTruthy();
      expect(created.json.DeploymentStatus).toBe("DEPLOYED");
      expect(created.json.CreatedDate).toBeTruthy();

      const got = await jhr("GET", `/v2/apis/${apiId}/deployments/${created.json.DeploymentId}`);
      expect(got.status).toBe(200);
      expect(got.json.Description).toBe("v1");
    });

    it("lists deployments", async () => {
      await jhr("POST", `/v2/apis/${apiId}/deployments`, { Description: "v1" });
      await jhr("POST", `/v2/apis/${apiId}/deployments`, { Description: "v2" });
      const list = await jhr("GET", `/v2/apis/${apiId}/deployments`);
      expect(list.status).toBe(200);
      expect(list.json.Items.length).toBe(2);
    });

    it("deletes a deployment", async () => {
      const created = await jhr("POST", `/v2/apis/${apiId}/deployments`, {});
      const depId = created.json.DeploymentId;
      const del = await jhr("DELETE", `/v2/apis/${apiId}/deployments/${depId}`);
      expect(del.status).toBe(204);
      const got = await jhr("GET", `/v2/apis/${apiId}/deployments/${depId}`);
      expect(got.status).toBe(404);
    });

    it("returns 404 for missing deployment", async () => {
      const res = await jhr("GET", `/v2/apis/${apiId}/deployments/nosuchdep`);
      expect(res.status).toBe(404);
      expect(res.json.message).toContain("Deployment not found");
    });

    it("links deployment to stage when StageName provided", async () => {
      await jhr("POST", `/v2/apis/${apiId}/stages`, { StageName: "prod" });
      const deploy = await jhr("POST", `/v2/apis/${apiId}/deployments`, { StageName: "prod" });
      expect(deploy.status).toBe(201);
      const stage = await jhr("GET", `/v2/apis/${apiId}/stages/prod`);
      expect(stage.json.DeploymentId).toBe(deploy.json.DeploymentId);
    });
  });

  describe("Route + integration wiring", () => {
    it("creates a route targeting an integration", async () => {
      const api = await jhr("POST", "/v2/apis", { Name: "wired", ProtocolType: "HTTP" });
      const apiId = api.json.ApiId;

      const integ = await jhr("POST", `/v2/apis/${apiId}/integrations`, {
        IntegrationType: "AWS_PROXY",
        IntegrationUri: "arn:aws:lambda:us-east-1:000000000000:function:f",
        PayloadFormatVersion: "2.0",
      });
      const integrationId = integ.json.IntegrationId;

      const route = await jhr("POST", `/v2/apis/${apiId}/routes`, {
        RouteKey: "GET /items",
        Target: `integrations/${integrationId}`,
      });
      expect(route.status).toBe(201);
      expect(route.json.Target).toBe(`integrations/${integrationId}`);

      const got = await jhr("GET", `/v2/apis/${apiId}/routes/${route.json.RouteId}`);
      expect(got.json.Target).toBe(`integrations/${integrationId}`);
    });
  });

  describe("404 on unknown paths", () => {
    it("returns 404 for unsupported path", async () => {
      const res = await jhr("GET", "/v2/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 404 for unsupported method on valid path", async () => {
      const res = await jhr("PATCH", "/v2/apis");
      expect(res.status).toBe(404);
    });
  });
});
