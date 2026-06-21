// parlel/appsync — dependency-free fake of AWS AppSync (GraphQL APIs).
//
// REST/JSON protocol:
//   POST   /v1/apis                                              -> CreateGraphqlApi
//   GET    /v1/apis                                              -> ListGraphqlApis
//   GET    /v1/apis/{apiId}                                      -> GetGraphqlApi
//   DELETE /v1/apis/{apiId}                                      -> DeleteGraphqlApi
//   POST   /v1/apis/{apiId}/datasources                         -> CreateDataSource
//   GET    /v1/apis/{apiId}/datasources                         -> ListDataSources
//   POST   /v1/apis/{apiId}/types/{typeName}/resolvers          -> CreateResolver
//   GET    /v1/apis/{apiId}/types/{typeName}/resolvers          -> ListResolvers
//   POST   /v1/apis/{apiId}/resolve                             -> trivial resolver dispatch
//
// State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class AppSyncError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class AppsyncServer {
  constructor(port = 4728, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // apis: Map<apiId, { apiId, name, ..., dataSources: Map, resolvers: Map<`${type}.${field}`, r> }>
    this.apis = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new AppSyncError("InternalFailureException", error.message, 500));
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

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  apiArn(apiId) {
    return `arn:aws:appsync:${this.region}:${this.accountId}:apis/${apiId}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "appsync", apis: this.apis.size });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());

    const body = await this.readBody(req);
    let input = {};
    if (body.length) {
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        return this.sendError(res, new AppSyncError("BadRequestException", "Invalid JSON.", 400));
      }
    }

    try {
      const segs = path.split("/").filter(Boolean); // strips leading /v1
      // segs[0] === "v1"
      if (segs[0] !== "v1" || segs[1] !== "apis") {
        throw new AppSyncError("UnknownOperationException", `Unknown route: ${method} ${path}`, 404);
      }
      // /v1/apis
      if (segs.length === 2) {
        if (method === "POST") return this.sendJson(res, 200, this.createGraphqlApi(input));
        if (method === "GET") return this.sendJson(res, 200, this.listGraphqlApis());
      }
      const apiId = segs[2];
      // /v1/apis/{apiId}
      if (segs.length === 3) {
        if (method === "GET") return this.sendJson(res, 200, this.getGraphqlApi(apiId));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteGraphqlApi(apiId));
      }
      // /v1/apis/{apiId}/datasources
      if (segs.length === 4 && segs[3] === "datasources") {
        if (method === "POST") return this.sendJson(res, 200, this.createDataSource(apiId, input));
        if (method === "GET") return this.sendJson(res, 200, this.listDataSources(apiId));
      }
      // /v1/apis/{apiId}/resolve
      if (segs.length === 4 && segs[3] === "resolve") {
        if (method === "POST") return this.sendJson(res, 200, this.resolve(apiId, input));
      }
      // /v1/apis/{apiId}/types/{typeName}/resolvers
      if (segs.length === 6 && segs[3] === "types" && segs[5] === "resolvers") {
        const typeName = decodeURIComponent(segs[4]);
        if (method === "POST") return this.sendJson(res, 200, this.createResolver(apiId, typeName, input));
        if (method === "GET") return this.sendJson(res, 200, this.listResolvers(apiId, typeName));
      }
      throw new AppSyncError("UnknownOperationException", `Unknown route: ${method} ${path}`, 404);
    } catch (error) {
      if (error instanceof AppSyncError) return this.sendError(res, error);
      throw error;
    }
  }

  createGraphqlApi(input) {
    if (!input.name) throw new AppSyncError("BadRequestException", "name is required.");
    if (!input.authenticationType) throw new AppSyncError("BadRequestException", "authenticationType is required.");
    const apiId = randomUUID().replace(/-/g, "").slice(0, 26);
    const api = {
      apiId,
      name: input.name,
      arn: this.apiArn(apiId),
      authenticationType: input.authenticationType || "API_KEY",
      uris: {
        GRAPHQL: `https://${apiId}.appsync-api.${this.region}.amazonaws.com/graphql`,
        REALTIME: `wss://${apiId}.appsync-realtime-api.${this.region}.amazonaws.com/graphql`,
      },
      tags: input.tags || {},
      xrayEnabled: input.xrayEnabled || false,
      dataSources: new Map(),
      resolvers: new Map(),
    };
    this.apis.set(apiId, api);
    return { graphqlApi: this.apiView(api) };
  }

  apiView(api) {
    return {
      apiId: api.apiId,
      name: api.name,
      arn: api.arn,
      authenticationType: api.authenticationType,
      apiType: api.apiType || "GRAPHQL",
      uris: api.uris,
      tags: api.tags,
      xrayEnabled: api.xrayEnabled,
      owner: api.owner || `${this.accountId}`,
      ownerContact: api.ownerContact || "",
      visibility: api.visibility || "GLOBAL",
      dns: api.dns || {},
    };
  }

  listGraphqlApis() {
    return { graphqlApis: [...this.apis.values()].map((a) => this.apiView(a)) };
  }

  requireApi(apiId) {
    const a = this.apis.get(apiId);
    if (!a) throw new AppSyncError("NotFoundException", `API ${apiId} not found.`, 404);
    return a;
  }

  getGraphqlApi(apiId) {
    return { graphqlApi: this.apiView(this.requireApi(apiId)) };
  }

  deleteGraphqlApi(apiId) {
    this.requireApi(apiId);
    this.apis.delete(apiId);
    return {};
  }

  createDataSource(apiId, input) {
    const api = this.requireApi(apiId);
    const name = input.name;
    if (!name) throw new AppSyncError("BadRequestException", "name is required.");
    if (!input.type) throw new AppSyncError("BadRequestException", "type is required.");
    if (api.dataSources.has(name)) {
      throw new AppSyncError("BadRequestException", `DataSource ${name} already exists.`);
    }
    const ds = {
      dataSourceArn: `${api.arn}/datasources/${name}`,
      name,
      description: input.description,
      type: input.type,
      serviceRoleArn: input.serviceRoleArn,
      dynamodbConfig: input.dynamodbConfig,
      lambdaConfig: input.lambdaConfig,
      httpConfig: input.httpConfig,
      elasticsearchConfig: input.elasticsearchConfig,
      openSearchServiceConfig: input.openSearchServiceConfig,
      relationalDatabaseConfig: input.relationalDatabaseConfig,
      eventBridgeConfig: input.eventBridgeConfig,
      metricsConfig: input.metricsConfig,
    };
    api.dataSources.set(name, ds);
    return { dataSource: ds };
  }

  listDataSources(apiId) {
    const api = this.requireApi(apiId);
    return { dataSources: [...api.dataSources.values()] };
  }

  createResolver(apiId, typeName, input) {
    const api = this.requireApi(apiId);
    const fieldName = input.fieldName;
    if (!fieldName) throw new AppSyncError("BadRequestException", "fieldName is required.");
    const key = `${typeName}.${fieldName}`;
    if (api.resolvers.has(key)) {
      throw new AppSyncError("BadRequestException", `Resolver ${key} already exists.`);
    }
    const resolver = {
      resolverArn: `${api.arn}/types/${typeName}/resolvers/${fieldName}`,
      typeName,
      fieldName,
      dataSourceName: input.dataSourceName,
      requestMappingTemplate: input.requestMappingTemplate,
      responseMappingTemplate: input.responseMappingTemplate,
      kind: input.kind || "UNIT",
      cachingConfig: input.cachingConfig,
      code: input.code,
      maxBatchSize: input.maxBatchSize,
      metricsConfig: input.metricsConfig,
      pipelineConfig: input.pipelineConfig,
      runtime: input.runtime,
      syncConfig: input.syncConfig,
    };
    api.resolvers.set(key, resolver);
    return { resolver };
  }

  listResolvers(apiId, typeName) {
    const api = this.requireApi(apiId);
    const list = [...api.resolvers.values()].filter((r) => r.typeName === typeName);
    return { resolvers: list };
  }

  // Trivial resolver dispatch: echoes arguments back as the result.
  resolve(apiId, input) {
    const api = this.requireApi(apiId);
    const key = `${input.typeName}.${input.fieldName}`;
    const resolver = api.resolvers.get(key);
    if (!resolver) throw new AppSyncError("NotFoundException", `Resolver ${key} not found.`, 404);
    return {
      data: { [input.fieldName]: input.arguments || {} },
      resolver: key,
    };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", error.code || "BadRequestException");
    res.end(JSON.stringify({ __type: error.code, message: error.message }));
  }
}

export default AppsyncServer;
