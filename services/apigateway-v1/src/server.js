// parlel/apigateway-v1 — a lightweight, dependency-free fake of AWS API Gateway
// v1 (REST APIs).
//
// Speaks the REST/JSON protocol: RESTful paths (e.g. POST /restapis) with JSON
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
  UnauthorizedException: 401,
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

export class ApigatewayV1Server {
  constructor(port = 4715, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.restApis = new Map(); // apiId -> api
    this.resources = new Map(); // apiId -> Map<resourceId, resource>
    this.deployments = new Map(); // apiId -> Map<deploymentId, deployment>
    this.stages = new Map(); // apiId -> Map<stageName, stage>
    this.apiKeys = new Map(); // keyId -> key
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
        service: "apigateway-v1",
        restApis: this.restApis.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-apigateway-v1");

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
    const parts = path.split("/").filter(Boolean);

    // /apikeys
    if (parts[0] === "apikeys") {
      if (parts.length === 1) {
        if (method === "POST") return this.createApiKey(body, res);
        if (method === "GET") return this.getApiKeys(res);
      }
      // /apikeys/{id}
      if (parts.length === 2) {
        if (method === "GET") return this.getApiKey(parts[1], res);
      }
    }

    if (parts[0] !== "restapis") {
      throw new ApiError("NotFoundException", `Unknown path ${path}`, 404);
    }

    // /restapis
    if (parts.length === 1) {
      if (method === "POST") return this.createRestApi(body, res);
      if (method === "GET") return this.getRestApis(res);
    }

    const apiId = parts[1];

    // /restapis/{id}
    if (parts.length === 2) {
      if (method === "GET") return this.getRestApi(apiId, res);
      if (method === "DELETE") return this.deleteRestApi(apiId, res);
      if (method === "PATCH") return this.updateRestApi(apiId, body, res);
    }

    const collection = parts[2];

    // /restapis/{id}/resources
    if (collection === "resources") {
      if (parts.length === 3) {
        if (method === "GET") return this.getResources(apiId, res);
      }
      // /restapis/{id}/resources/{resourceId}
      if (parts.length === 4) {
        const resourceId = parts[3];
        if (method === "POST") return this.createResource(apiId, resourceId, body, res);
        if (method === "GET") return this.getResource(apiId, resourceId, res);
        if (method === "DELETE") return this.deleteResource(apiId, resourceId, res);
      }
      // /restapis/{id}/resources/{resourceId}/methods/{httpMethod}
      if (parts.length === 6 && parts[4] === "methods") {
        const resourceId = parts[3];
        const httpMethod = parts[5];
        if (method === "PUT") return this.putMethod(apiId, resourceId, httpMethod, body, res);
        if (method === "GET") return this.getMethod(apiId, resourceId, httpMethod, res);
      }
    }

    // /restapis/{id}/deployments
    if (collection === "deployments") {
      if (parts.length === 3) {
        if (method === "POST") return this.createDeployment(apiId, body, res);
        if (method === "GET") return this.getDeployments(apiId, res);
      }
      // /restapis/{id}/deployments/{deploymentId}
      if (parts.length === 4) {
        if (method === "GET") return this.getDeployment(apiId, parts[3], res);
        if (method === "DELETE") return this.deleteDeployment(apiId, parts[3], res);
      }
    }

    // /restapis/{id}/stages
    if (collection === "stages") {
      if (parts.length === 3) {
        if (method === "POST") return this.createStage(apiId, body, res);
        if (method === "GET") return this.getStages(apiId, res);
      }
      if (parts.length === 4) {
        if (method === "GET") return this.getStage(apiId, parts[3], res);
        if (method === "DELETE") return this.deleteStage(apiId, parts[3], res);
        if (method === "PATCH") return this.updateStage(apiId, parts[3], body, res);
      }
    }

    throw new ApiError("NotFoundException", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  createRestApi(body, res) {
    const name = body.name;
    if (!name) throw new ApiError("BadRequestException", "name is required");
    const apiId = shortId();
    // Seed a root "/" resource.
    const rootId = shortId();
    const api = {
      id: apiId,
      name,
      description: body.description,
      version: body.version,
      createdDate: Math.floor(Date.now() / 1000),
      apiKeySource: body.apiKeySource || "HEADER",
      endpointConfiguration: body.endpointConfiguration || { types: ["EDGE"] },
      disableExecuteApiEndpoint: body.disableExecuteApiEndpoint || false,
      tags: body.tags || {},
      rootResourceId: rootId,
    };
    this.restApis.set(apiId, api);
    const resources = new Map();
    resources.set(rootId, { id: rootId, path: "/", resourceMethods: {} });
    this.resources.set(apiId, resources);
    this.deployments.set(apiId, new Map());
    this.stages.set(apiId, new Map());
    return this.sendJson(res, 200, api);
  }

  getRestApis(res) {
    return this.sendJson(res, 200, { items: [...this.restApis.values()] });
  }

  requireApi(apiId) {
    const api = this.restApis.get(apiId);
    if (!api) throw new ApiError("NotFoundException", `Invalid REST API identifier specified: ${apiId}`, 404);
    return api;
  }

  getRestApi(apiId, res) {
    return this.sendJson(res, 200, this.requireApi(apiId));
  }

  deleteRestApi(apiId, res) {
    this.requireApi(apiId);
    this.restApis.delete(apiId);
    this.resources.delete(apiId);
    this.deployments.delete(apiId);
    this.stages.delete(apiId);
    res.statusCode = 202;
    res.end();
  }

  updateRestApi(apiId, body, res) {
    const api = this.requireApi(apiId);
    if (body.name !== undefined) api.name = body.name;
    if (body.description !== undefined) api.description = body.description;
    if (body.version !== undefined) api.version = body.version;
    if (body.apiKeySource !== undefined) api.apiKeySource = body.apiKeySource;
    if (body.endpointConfiguration !== undefined) api.endpointConfiguration = body.endpointConfiguration;
    if (body.disableExecuteApiEndpoint !== undefined) api.disableExecuteApiEndpoint = body.disableExecuteApiEndpoint;
    if (body.tags !== undefined) api.tags = body.tags;
    return this.sendJson(res, 200, api);
  }

  // -------------------------------------------------------------------------
  getResources(apiId, res) {
    this.requireApi(apiId);
    return this.sendJson(res, 200, { items: [...this.resources.get(apiId).values()] });
  }

  getResource(apiId, resourceId, res) {
    this.requireApi(apiId);
    const resource = this.resources.get(apiId).get(resourceId);
    if (!resource) throw new ApiError("NotFoundException", `Invalid resource identifier: ${resourceId}`, 404);
    return this.sendJson(res, 200, resource);
  }

  createResource(apiId, parentId, body, res) {
    this.requireApi(apiId);
    const resources = this.resources.get(apiId);
    const parent = resources.get(parentId);
    if (!parent) throw new ApiError("NotFoundException", `Invalid parent resource: ${parentId}`, 404);
    const pathPart = body.pathPart;
    if (!pathPart) throw new ApiError("BadRequestException", "pathPart is required");
    const id = shortId();
    const fullPath = parent.path === "/" ? `/${pathPart}` : `${parent.path}/${pathPart}`;
    const resource = {
      id,
      parentId,
      pathPart,
      path: fullPath,
      resourceMethods: {},
    };
    resources.set(id, resource);
    return this.sendJson(res, 200, resource);
  }

  putMethod(apiId, resourceId, httpMethod, body, res) {
    this.requireApi(apiId);
    const resource = this.resources.get(apiId).get(resourceId);
    if (!resource) throw new ApiError("NotFoundException", `Invalid resource: ${resourceId}`, 404);
    const method = {
      httpMethod,
      authorizationType: body.authorizationType || "NONE",
      apiKeyRequired: body.apiKeyRequired || false,
      requestParameters: body.requestParameters || {},
      requestModels: body.requestModels || {},
      authorizerId: body.authorizerId,
      operationName: body.operationName,
    };
    resource.resourceMethods[httpMethod] = method;
    return this.sendJson(res, 200, method);
  }

  getMethod(apiId, resourceId, httpMethod, res) {
    this.requireApi(apiId);
    const resource = this.resources.get(apiId).get(resourceId);
    if (!resource) throw new ApiError("NotFoundException", `Invalid resource: ${resourceId}`, 404);
    const method = resource.resourceMethods[httpMethod];
    if (!method) throw new ApiError("NotFoundException", `Invalid method: ${httpMethod}`, 404);
    return this.sendJson(res, 200, method);
  }

  deleteResource(apiId, resourceId, res) {
    this.requireApi(apiId);
    const resources = this.resources.get(apiId);
    if (!resources.has(resourceId)) throw new ApiError("NotFoundException", `Invalid resource: ${resourceId}`, 404);
    resources.delete(resourceId);
    res.statusCode = 202;
    res.end();
  }

  // -------------------------------------------------------------------------
  createDeployment(apiId, body, res) {
    this.requireApi(apiId);
    const id = shortId();
    const deployment = {
      id,
      description: body.description,
      createdDate: Math.floor(Date.now() / 1000),
      apiSummary: {},
    };
    this.deployments.get(apiId).set(id, deployment);
    if (body.stageName) {
      const stages = this.stages.get(apiId);
      stages.set(body.stageName, {
        stageName: body.stageName,
        deploymentId: id,
        description: body.stageDescription,
        createdDate: Math.floor(Date.now() / 1000),
        lastUpdatedDate: Math.floor(Date.now() / 1000),
        variables: body.variables || {},
        cacheClusterEnabled: body.cacheClusterEnabled || false,
        tracingEnabled: body.tracingEnabled || false,
        tags: body.tags || {},
      });
    }
    return this.sendJson(res, 200, deployment);
  }

  getDeployments(apiId, res) {
    this.requireApi(apiId);
    return this.sendJson(res, 200, { items: [...this.deployments.get(apiId).values()] });
  }

  getDeployment(apiId, deploymentId, res) {
    this.requireApi(apiId);
    const deployment = this.deployments.get(apiId).get(deploymentId);
    if (!deployment) throw new ApiError("NotFoundException", `Invalid deployment identifier: ${deploymentId}`, 404);
    return this.sendJson(res, 200, deployment);
  }

  deleteDeployment(apiId, deploymentId, res) {
    this.requireApi(apiId);
    const deployments = this.deployments.get(apiId);
    if (!deployments.has(deploymentId)) throw new ApiError("NotFoundException", `Invalid deployment identifier: ${deploymentId}`, 404);
    deployments.delete(deploymentId);
    res.statusCode = 202;
    res.end();
  }

  createStage(apiId, body, res) {
    this.requireApi(apiId);
    const stageName = body.stageName;
    if (!stageName) throw new ApiError("BadRequestException", "stageName is required");
    const stages = this.stages.get(apiId);
    if (stages.has(stageName)) {
      throw new ApiError("ConflictException", `Stage already exists: ${stageName}`, 409);
    }
    if (!body.deploymentId) {
      throw new ApiError("BadRequestException", "deploymentId is required");
    }
    const stage = {
      stageName,
      deploymentId: body.deploymentId,
      description: body.description,
      createdDate: Math.floor(Date.now() / 1000),
      lastUpdatedDate: Math.floor(Date.now() / 1000),
      variables: body.variables || {},
      cacheClusterEnabled: body.cacheClusterEnabled || false,
      tracingEnabled: body.tracingEnabled || false,
      tags: body.tags || {},
    };
    stages.set(stageName, stage);
    return this.sendJson(res, 200, stage);
  }

  getStages(apiId, res) {
    this.requireApi(apiId);
    return this.sendJson(res, 200, { item: [...this.stages.get(apiId).values()] });
  }

  getStage(apiId, stageName, res) {
    this.requireApi(apiId);
    const stage = this.stages.get(apiId).get(stageName);
    if (!stage) throw new ApiError("NotFoundException", `Invalid stage: ${stageName}`, 404);
    return this.sendJson(res, 200, stage);
  }

  deleteStage(apiId, stageName, res) {
    this.requireApi(apiId);
    const stages = this.stages.get(apiId);
    if (!stages.has(stageName)) throw new ApiError("NotFoundException", `Invalid stage: ${stageName}`, 404);
    stages.delete(stageName);
    res.statusCode = 202;
    res.end();
  }

  updateStage(apiId, stageName, body, res) {
    this.requireApi(apiId);
    const stage = this.stages.get(apiId).get(stageName);
    if (!stage) throw new ApiError("NotFoundException", `Invalid stage: ${stageName}`, 404);
    if (body.description !== undefined) stage.description = body.description;
    if (body.variables !== undefined) stage.variables = body.variables;
    if (body.cacheClusterEnabled !== undefined) stage.cacheClusterEnabled = body.cacheClusterEnabled;
    if (body.tracingEnabled !== undefined) stage.tracingEnabled = body.tracingEnabled;
    if (body.tags !== undefined) stage.tags = body.tags;
    stage.lastUpdatedDate = Math.floor(Date.now() / 1000);
    return this.sendJson(res, 200, stage);
  }

  // -------------------------------------------------------------------------
  createApiKey(body, res) {
    const id = shortId();
    const value = body.value || randomBytes(20).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
    const key = {
      id,
      name: body.name,
      description: body.description,
      enabled: body.enabled !== undefined ? body.enabled : true,
      value,
      createdDate: Math.floor(Date.now() / 1000),
      lastUpdatedDate: Math.floor(Date.now() / 1000),
      stageKeys: body.stageKeys || [],
      tags: body.tags || {},
    };
    this.apiKeys.set(id, key);
    return this.sendJson(res, 201, key);
  }

  getApiKey(keyId, res) {
    const key = this.apiKeys.get(keyId);
    if (!key) throw new ApiError("NotFoundException", `Invalid API Key identifier specified: ${keyId}`, 404);
    return this.sendJson(res, 200, key);
  }

  getApiKeys(res) {
    return this.sendJson(res, 200, { items: [...this.apiKeys.values()] });
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
    res.end(JSON.stringify({ __type: code, message: error.message || code }));
  }
}

export default ApigatewayV1Server;
