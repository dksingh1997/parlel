import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { RailwayServer } from "../services/railway/src/server.js";

const PORT = 14882;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlelTestToken" };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

function gql(query: string, variables?: Json, headers: Json = AUTH) {
  return api("POST", "/graphql/v2", variables ? { query, variables } : { query }, headers);
}

describe("Railway Service", () => {
  let server: RailwayServer;

  beforeAll(async () => {
    server = new RailwayServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("railway");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const res = await fetch(`${BASE_URL}/graphql/v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ me { id } }" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GraphQL (POST /graphql/v2)", () => {
    it("resolves me { id email }", async () => {
      const result = await gql("{ me { id email } }");
      expect(result.status).toBe(200);
      expect(result.body.data.me.id).toBeTruthy();
      expect(result.body.data.me.email).toBeTruthy();
    });

    it("resolves projects { edges { node { id name } } }", async () => {
      const result = await gql("{ projects { edges { node { id name } } } }");
      expect(result.status).toBe(200);
      const edges = result.body.data.projects.edges;
      expect(Array.isArray(edges)).toBe(true);
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].node).toHaveProperty("id");
      expect(edges[0].node).toHaveProperty("name");
    });

    it("runs mutation projectCreate(input) { id name }", async () => {
      const result = await gql(
        'mutation { projectCreate(input: { name: "my-app" }) { id name } }'
      );
      expect(result.status).toBe(200);
      expect(result.body.data.projectCreate.name).toBe("my-app");
      expect(result.body.data.projectCreate.id).toBeTruthy();
    });

    it("created project appears in the projects list", async () => {
      await gql('mutation { projectCreate(input: { name: "listed-app" }) { id name } }');
      const result = await gql("{ projects { edges { node { id name } } } }");
      const names = result.body.data.projects.edges.map((e: any) => e.node.name);
      expect(names).toContain("listed-app");
    });

    it("supports variables in projectCreate", async () => {
      const result = await gql(
        "mutation Create($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }",
        { input: { name: "var-app" } }
      );
      expect(result.body.data.projectCreate.name).toBe("var-app");
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await gql('mutation { projectCreate(input: { name: "temp" }) { id name } }');
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const result = await gql("{ projects { edges { node { name } } } }");
      const names = result.body.data.projects.edges.map((e: any) => e.node.name);
      expect(names).not.toContain("temp");
    });
  });
});
