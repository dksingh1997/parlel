import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AppsyncServer } from "../services/appsync/src/server.js";

const PORT = 14728;
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

async function makeApi(name = "myapi") {
  const c = await req("POST", "/v1/apis", { name, authenticationType: "API_KEY" });
  return c.json.graphqlApi.apiId as string;
}

describe("AppSync", () => {
  let server: AppsyncServer;
  beforeAll(async () => {
    server = new AppsyncServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4728", () => {
    expect(new AppsyncServer().port).toBe(4728);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("appsync");
  });

  it("CreateGraphqlApi returns uris", async () => {
    const c = await req("POST", "/v1/apis", { name: "myapi", authenticationType: "API_KEY" });
    expect(c.status).toBe(200);
    expect(c.json.graphqlApi.apiId).toBeTruthy();
    expect(c.json.graphqlApi.uris.GRAPHQL).toContain("appsync-api");
  });

  it("GetGraphqlApi + ListGraphqlApis", async () => {
    const apiId = await makeApi();
    const g = await req("GET", `/v1/apis/${apiId}`);
    expect(g.json.graphqlApi.name).toBe("myapi");
    const l = await req("GET", "/v1/apis");
    expect(l.json.graphqlApis).toHaveLength(1);
  });

  it("DeleteGraphqlApi", async () => {
    const apiId = await makeApi();
    await req("DELETE", `/v1/apis/${apiId}`);
    const g = await req("GET", `/v1/apis/${apiId}`);
    expect(g.status).toBe(404);
  });

  it("CreateDataSource + ListDataSources", async () => {
    const apiId = await makeApi();
    const d = await req("POST", `/v1/apis/${apiId}/datasources`, {
      name: "ddb",
      type: "AMAZON_DYNAMODB",
      dynamodbConfig: { tableName: "Users", awsRegion: "us-east-1" },
    });
    expect(d.json.dataSource.name).toBe("ddb");
    const l = await req("GET", `/v1/apis/${apiId}/datasources`);
    expect(l.json.dataSources).toHaveLength(1);
  });

  it("CreateResolver + ListResolvers", async () => {
    const apiId = await makeApi();
    const r = await req("POST", `/v1/apis/${apiId}/types/Query/resolvers`, {
      fieldName: "getUser",
      dataSourceName: "ddb",
      requestMappingTemplate: "{}",
      responseMappingTemplate: "$util.toJson($ctx.result)",
    });
    expect(r.json.resolver.fieldName).toBe("getUser");
    expect(r.json.resolver.typeName).toBe("Query");
    const l = await req("GET", `/v1/apis/${apiId}/types/Query/resolvers`);
    expect(l.json.resolvers).toHaveLength(1);
  });

  it("trivial resolver dispatch echoes arguments", async () => {
    const apiId = await makeApi();
    await req("POST", `/v1/apis/${apiId}/types/Query/resolvers`, { fieldName: "getUser" });
    const r = await req("POST", `/v1/apis/${apiId}/resolve`, {
      typeName: "Query",
      fieldName: "getUser",
      arguments: { id: "u1" },
    });
    expect(r.json.data.getUser.id).toBe("u1");
  });

  it("resolve returns 404 for missing resolver", async () => {
    const apiId = await makeApi();
    const r = await req("POST", `/v1/apis/${apiId}/resolve`, {
      typeName: "Query",
      fieldName: "nonexistent",
    });
    expect(r.status).toBe(404);
    expect(r.json.__type).toBe("NotFoundException");
  });

  it("CreateGraphqlApi without name errors", async () => {
    const r = await req("POST", "/v1/apis", {});
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("BadRequestException");
  });

  it("CreateGraphqlApi without authenticationType errors", async () => {
    const r = await req("POST", "/v1/apis", { name: "test" });
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("BadRequestException");
    expect(r.json.message).toContain("authenticationType");
  });

  it("CreateDataSource without type errors", async () => {
    const apiId = await makeApi();
    const r = await req("POST", `/v1/apis/${apiId}/datasources`, { name: "ddb" });
    expect(r.status).toBe(400);
    expect(r.json.__type).toBe("BadRequestException");
    expect(r.json.message).toContain("type");
  });

  it("Unknown route returns UnknownOperationException", async () => {
    const r = await req("GET", "/v1/unknown");
    expect(r.status).toBe(404);
    expect(r.json.__type).toBe("UnknownOperationException");
  });

  it("GetGraphqlApi returns 404 for missing API", async () => {
    const r = await req("GET", "/v1/apis/nonexistent");
    expect(r.status).toBe(404);
    expect(r.json.__type).toBe("NotFoundException");
  });

  it("DataSource in missing api errors", async () => {
    const r = await req("POST", "/v1/apis/nope/datasources", { name: "x", type: "NONE" });
    expect(r.status).toBe(404);
    expect(r.json.__type).toContain("NotFoundException");
  });
});
