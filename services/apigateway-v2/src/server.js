// parlel/apigateway-v2 — a lightweight, dependency-free fake of AWS API
// Gateway v2 (HTTP & WebSocket APIs).
//
// Speaks the REST/JSON protocol: RESTful paths (e.g. POST /v2/apis) with JSON
// request and response bodies. State is in-memory and ephemeral (resettable
// via reset() or POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  BadRequestException: 400,
  NotFoundException: 404,
  ConflictException: 409,
  TooManyRequestsException: 429,
  InternalServerErrorException: 500,
};

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function shortId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = randomBytes(10);
  for (let i = 0; i < 10; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export class ApigatewayV2Server {
  constructor(port = 4714, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.apis = new Map(); // apiId -> api
    this.routes = new Map(); // apiId -> Map<routeId, route>
    this.integrations = new Map(); // apiId -> Map<integrationId, integration>
    this.stages = new Map(); // apiId -> Map<stageName, stage>
    this.deployments = new Map(); // apiId -> Map<deploymentId, deployment>
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new ApiError("InternalServerErrorException", error.message, 500));
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  requestId() {
    return randomUUID();
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "apigateway-v2",
        apis: this.apis.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-apigateway-v2");

    const raw = (await this.readBody(req)).toString("utf8");
    let body = {};
    if (raw.length) {
      try {
        body = JSON.parse(raw);
      } catch {
        return this.sendError(res, new ApiError("BadRequestException", "Invalid JSON body"));
      }
    }

    try {
      return this.route(method, path, body, res);
    } catch (error) {
      if (error instanceof ApiError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, body, res) {
    if (!path.startsWith("/v2/apis")) {
      throw new ApiError("NotFoundException", `Unknown path ${path}`, 404);
    }
    const sub = path.slice("/v2/apis".length); // "" | "/{id}" | "/{id}/routes" ...

    if (sub === "" || sub === "/") {
      if (method === "POST") return this.createApi(body, res);
      if (method === "GET") return this.getApis(res);
    }

    const parts = sub.split("/").filter(Boolean); // [id], [id, routes], ...
    const apiId = parts[0];
    const collection = parts[1];
    const childId = parts[2];

    if (parts.length === 1) {
      if (method === "GET") return this.getApi(apiId, res);
      if (method === "DELETE") return this.deleteApi(apiId, res);
    }

    if (collection === "routes") {
      if (parts.length === 2) {
        if (method === "POST") return this.createRoute(apiId, body, res);
        if (method === "GET") return this.getRoutes(apiId, res);
      }
      if (parts.length === 3) {
        if (method === "GET") return this.getRoute(apiId, childId, res);
        if (method === "DELETE") return this.deleteRoute(apiId, childId, res);
      }
    }

    if (collection === "integrations") {
      if (parts.length === 2) {
        if (method === "POST") return this.createIntegration(apiId, body, res);
        if (method === "GET") return this.getIntegrations(apiId, res);
      }
      if (parts.length === 3) {
        if (method === "GET") return this.getIntegration(apiId, childId, res);
        if (method === "DELETE") return this.deleteIntegration(apiId, childId, res);
      }
    }

    if (collection === "stages") {
      if (parts.length === 2) {
        if (method === "POST") return this.createStage(apiId, body, res);
        if (method === "GET") return this.getStages(apiId, res);
      }
      if (parts.length === 3) {
        if (method === "GET") return this.getStage(apiId, childId, res);
        if (method === "DELETE") return this.deleteStage(apiId, childId, res);
      }
    }

    if (collection === "deployments") {
      if (parts.length === 2) {
        if (method === "POST") return this.createDeployment(apiId, body, res);
        if (method === "GET") return this.getDeployments(apiId, res);
      }
      if (parts.length === 3) {
        if (method === "GET") return this.getDeployment(apiId, childId, res);
        if (method === "DELETE") return this.deleteDeployment(apiId, childId, res);
      }
    }

    throw new ApiError("NotFoundException", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  createApi(body, res) {
    const name = body.Name;
    if (!name) throw new ApiError("BadRequestException", "Name is required");
    const protocolType = body.ProtocolType || "HTTP";
    if (!["HTTP", "WEBSOCKET"].includes(protocolType)) {
      throw new ApiError("BadRequestException", "ProtocolType must be HTTP or WEBSOCKET");
    }
    if (protocolType === "WEBSOCKET" && !body.RouteSelectionExpression) {
      throw new ApiError(
        "BadRequestException",
        "RouteSelectionExpression is required for WEBSOCKET APIs",
      );
    }
    const apiId = shortId();
    const api = {
      ApiId: apiId,
      Name: name,
      ProtocolType: protocolType,
      ApiEndpoint: `https://${apiId}.execute-api.${this.region}.amazonaws.com`,
      RouteSelectionExpression:
        body.RouteSelectionExpression ||
        (protocolType === "HTTP" ? "$request.method $request.path" : "$request.body.action"),
      ApiKeySelectionExpression: body.ApiKeySelectionExpression,
      Description: body.Description,
      Version: body.Version,
      CreatedDate: new Date().toISOString(),
      DisableExecuteApiEndpoint: body.DisableExecuteApiEndpoint || false,
      CorsConfiguration: body.CorsConfiguration,
      Tags: body.Tags || {},
    };
    this.apis.set(apiId, api);
    this.routes.set(apiId, new Map());
    this.integrations.set(apiId, new Map());
    this.stages.set(apiId, new Map());
    this.deployments.set(apiId, new Map());
    return this.sendJson(res, 201, api);
  }

  getApis(res) {
    return this.sendJson(res, 200, { Items: [...this.apis.values()] });
  }

  requireApi(apiId) {
    const api = this.apis.get(apiId);
    if (!api) {
      const error = new ApiError("NotFoundException", `Invalid API identifier specified: ${apiId}`, 404);
      error.resourceType = "Api";
      throw error;
    }
    return api;
  }

  getApi(apiId, res) {
    return this.sendJson(res, 200, this.requireApi(apiId));
  }

  deleteApi(apiId, res) {
    this.requireApi(apiId);
    this.apis.delete(apiId);
    this.routes.delete(apiId);
    this.integrations.delete(apiId);
    this.stages.delete(apiId);
    this.deployments.delete(apiId);
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  createRoute(apiId, body, res) {
    this.requireApi(apiId);
    const routeKey = body.RouteKey;
    if (!routeKey) throw new ApiError("BadRequestException", "RouteKey is required");
    const routeId = shortId();
    const route = {
      RouteId: routeId,
      RouteKey: routeKey,
      Target: body.Target,
      AuthorizationType: body.AuthorizationType || "NONE",
      ApiKeyRequired: body.ApiKeyRequired || false,
      OperationName: body.OperationName,
    };
    this.routes.get(apiId).set(routeId, route);
    return this.sendJson(res, 201, route);
  }

  getRoutes(apiId, res) {
    this.requireApi(apiId);
    return this.sendJson(res, 200, { Items: [...this.routes.get(apiId).values()] });
  }

  requireRoute(apiId, routeId) {
    this.requireApi(apiId);
    const route = this.routes.get(apiId).get(routeId);
    if (!route) throw new ApiError("NotFoundException", `Route not found: ${routeId}`, 404);
    return route;
  }

  getRoute(apiId, routeId, res) {
    return this.sendJson(res, 200, this.requireRoute(apiId, routeId));
  }

  deleteRoute(apiId, routeId, res) {
    this.requireRoute(apiId, routeId);
    this.routes.get(apiId).delete(routeId);
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  createIntegration(apiId, body, res) {
    this.requireApi(apiId);
    const integrationType = body.IntegrationType;
    if (!integrationType) {
      throw new ApiError("BadRequestException", "IntegrationType is required");
    }
    const valid = ["AWS_PROXY", "HTTP_PROXY", "MOCK", "AWS", "HTTP"];
    if (!valid.includes(integrationType)) {
      throw new ApiError("BadRequestException", `Invalid IntegrationType: ${integrationType}`);
    }
    const integrationId = shortId();
    const integration = {
      IntegrationId: integrationId,
      IntegrationType: integrationType,
      IntegrationUri: body.IntegrationUri,
      IntegrationMethod: body.IntegrationMethod,
      PayloadFormatVersion: body.PayloadFormatVersion || "2.0",
      ConnectionType: body.ConnectionType || "INTERNET",
      TimeoutInMillis: body.TimeoutInMillis || 30000,
      Description: body.Description,
    };
    this.integrations.get(apiId).set(integrationId, integration);
    return this.sendJson(res, 201, integration);
  }

  getIntegrations(apiId, res) {
    this.requireApi(apiId);
    return this.sendJson(res, 200, { Items: [...this.integrations.get(apiId).values()] });
  }

  requireIntegration(apiId, integrationId) {
    this.requireApi(apiId);
    const integration = this.integrations.get(apiId).get(integrationId);
    if (!integration) throw new ApiError("NotFoundException", `Integration not found: ${integrationId}`, 404);
    return integration;
  }

  getIntegration(apiId, integrationId, res) {
    return this.sendJson(res, 200, this.requireIntegration(apiId, integrationId));
  }

  deleteIntegration(apiId, integrationId, res) {
    this.requireIntegration(apiId, integrationId);
    this.integrations.get(apiId).delete(integrationId);
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  createStage(apiId, body, res) {
    this.requireApi(apiId);
    const stageName = body.StageName;
    if (!stageName) throw new ApiError("BadRequestException", "StageName is required");
    const stages = this.stages.get(apiId);
    if (stages.has(stageName)) {
      throw new ApiError("ConflictException", `Stage already exists: ${stageName}`, 409);
    }
    const stage = {
      StageName: stageName,
      DeploymentId: body.DeploymentId,
      Description: body.Description,
      AutoDeploy: body.AutoDeploy || false,
      StageVariables: body.StageVariables || {},
      CreatedDate: new Date().toISOString(),
      LastUpdatedDate: new Date().toISOString(),
    };
    stages.set(stageName, stage);
    return this.sendJson(res, 201, stage);
  }

  getStages(apiId, res) {
    this.requireApi(apiId);
    return this.sendJson(res, 200, { Items: [...this.stages.get(apiId).values()] });
  }

  getStage(apiId, stageName, res) {
    this.requireApi(apiId);
    const stage = this.stages.get(apiId).get(stageName);
    if (!stage) throw new ApiError("NotFoundException", `Stage not found: ${stageName}`, 404);
    return this.sendJson(res, 200, stage);
  }

  deleteStage(apiId, stageName, res) {
    this.requireApi(apiId);
    const stages = this.stages.get(apiId);
    if (!stages.has(stageName)) throw new ApiError("NotFoundException", `Stage not found: ${stageName}`, 404);
    stages.delete(stageName);
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  createDeployment(apiId, body, res) {
    this.requireApi(apiId);
    const deploymentId = shortId();
    const deployment = {
      DeploymentId: deploymentId,
      Description: body.Description,
      DeploymentStatus: "DEPLOYED",
      AutoDeployed: false,
      CreatedDate: new Date().toISOString(),
    };
    this.deployments.get(apiId).set(deploymentId, deployment);
    if (body.StageName) {
      const stages = this.stages.get(apiId);
      const stage = stages.get(body.StageName);
      if (stage) stage.DeploymentId = deploymentId;
    }
    return this.sendJson(res, 201, deployment);
  }

  getDeployments(apiId, res) {
    this.requireApi(apiId);
    return this.sendJson(res, 200, { Items: [...this.deployments.get(apiId).values()] });
  }

  requireDeployment(apiId, deploymentId) {
    this.requireApi(apiId);
    const deployment = this.deployments.get(apiId).get(deploymentId);
    if (!deployment) throw new ApiError("NotFoundException", `Deployment not found: ${deploymentId}`, 404);
    return deployment;
  }

  getDeployment(apiId, deploymentId, res) {
    return this.sendJson(res, 200, this.requireDeployment(apiId, deploymentId));
  }

  deleteDeployment(apiId, deploymentId, res) {
    this.requireDeployment(apiId, deploymentId);
    this.deployments.get(apiId).delete(deploymentId);
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerErrorException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", code);
    const body = { message: error.message || code };
    if (code === "NotFoundException" && error.resourceType) {
      body.resourceType = error.resourceType;
    }
    res.end(JSON.stringify(body));
  }
}

export default ApigatewayV2Server;
