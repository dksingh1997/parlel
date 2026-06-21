import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { LinearServer } from "../services/linear/src/server.js";

const PORT = 14788;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "lin_api_parlelTestKey" };

type Json = Record<string, any>;

async function gql(query: string, variables?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}/graphql`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Linear Service", () => {
  let server: LinearServer;

  beforeAll(async () => {
    server = new LinearServer(PORT);
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
      const root = await fetch(`${BASE_URL}/`).then((r) => r.json());
      const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
      expect(root.name).toBe("linear");
      expect(health).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    // Real Linear returns HTTP 400 (not 401) with a GraphQL `errors` envelope
    // whose `extensions.type` is "authentication error".
    it("rejects missing authorization with 400 + GraphQL auth error envelope", async () => {
      const response = await fetch(`${BASE_URL}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id } }" }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors[0].extensions.type).toBe("authentication error");
    });

    it("accepts a raw API key", async () => {
      const res = await gql("{ viewer { id name email } }");
      expect(res.status).toBe(200);
      expect(res.body.data.viewer.email).toBe("parlel@example.com");
    });

    it("accepts a Bearer token", async () => {
      const res = await gql("{ viewer { id } }", undefined, { Authorization: "Bearer lin_oauth_xxx" });
      expect(res.status).toBe(200);
      expect(res.body.data.viewer.id).toBeTruthy();
    });
  });

  describe("Bad requests", () => {
    it("returns 400 when the query attribute is missing", async () => {
      const response = await fetch(`${BASE_URL}/graphql`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ variables: {} }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors).toBeTruthy();
    });
  });

  describe("Queries", () => {
    it("resolves viewer", async () => {
      const res = await gql("query { viewer { id name email } }");
      expect(res.body.data.viewer.id).toBeTruthy();
      expect(res.body.data.viewer.name).toBe("Parlel User");
    });

    it("resolves teams { nodes }", async () => {
      const res = await gql("{ teams { nodes { id name key } } }");
      expect(Array.isArray(res.body.data.teams.nodes)).toBe(true);
      expect(res.body.data.teams.nodes.length).toBeGreaterThanOrEqual(1);
    });

    it("resolves issues { nodes } (empty at first)", async () => {
      const res = await gql("{ issues { nodes { id identifier title } } }");
      expect(res.body.data.issues.nodes).toEqual([]);
    });

    it("returns a full Relay pageInfo on connections", async () => {
      const res = await gql(
        "{ issues { pageInfo { startCursor endCursor hasPreviousPage hasNextPage } } }"
      );
      const pi = res.body.data.issues.pageInfo;
      expect(pi).toHaveProperty("startCursor");
      expect(pi).toHaveProperty("endCursor");
      expect(pi.hasPreviousPage).toBe(false);
      expect(pi.hasNextPage).toBe(false);
    });
  });

  describe("Mutations", () => {
    it("creates an issue via issueCreate(input)", async () => {
      const res = await gql(
        `mutation Create($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier title } }
        }`,
        { input: { title: "Ship parlel", teamId: server.defaultTeamId } }
      );
      expect(res.status).toBe(200);
      expect(res.body.data.issueCreate.success).toBe(true);
      expect(res.body.data.issueCreate.issue.title).toBe("Ship parlel");
      expect(res.body.data.issueCreate.issue.identifier).toMatch(/^PAR-\d+$/);
    });

    it("issueCreate payload includes lastSyncId", async () => {
      const res = await gql(
        `mutation { issueCreate(input: { title: "Sync" }) { success lastSyncId issue { id } } }`
      );
      expect(res.body.data.issueCreate.lastSyncId).toEqual(expect.any(Number));
    });

    it("issueCreate issue exposes enriched fields (number, priorityLabel, team, updatedAt)", async () => {
      const res = await gql(
        `mutation { issueCreate(input: { title: "Enriched", priority: 2 }) {
          issue { id number priorityLabel url branchName createdAt updatedAt team { id } creator { id } }
        } }`
      );
      const issue = res.body.data.issueCreate.issue;
      expect(issue.number).toEqual(expect.any(Number));
      expect(issue.priorityLabel).toBe("High");
      expect(issue.team.id).toBeTruthy();
      expect(issue.creator.id).toBeTruthy();
      expect(issue.updatedAt).toBeTruthy();
      expect(issue.branchName).toBeTruthy();
    });

    it("issueUpdate on a missing id returns a GraphQL error (not silent success:false)", async () => {
      const res = await gql(
        `mutation { issueUpdate(id: "does-not-exist", input: { title: "x" }) { success } }`
      );
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeTruthy();
      expect(res.body.data.issueUpdate).toBeNull();
    });

    it("issueUpdate updates and bumps lastSyncId", async () => {
      const created = await gql(
        `mutation { issueCreate(input: { title: "Before" }) { issue { id } } }`
      );
      const id = created.body.data.issueCreate.issue.id;
      const res = await gql(
        `mutation Up($id: String!) { issueUpdate(id: $id, input: { title: "After" }) { success lastSyncId issue { title } } }`,
        { id }
      );
      expect(res.body.data.issueUpdate.success).toBe(true);
      expect(res.body.data.issueUpdate.lastSyncId).toEqual(expect.any(Number));
      expect(res.body.data.issueUpdate.issue.title).toBe("After");
    });

    it("issueDelete returns { success, lastSyncId } and errors on missing id", async () => {
      const created = await gql(
        `mutation { issueCreate(input: { title: "ToDelete" }) { issue { id } } }`
      );
      const id = created.body.data.issueCreate.issue.id;
      const ok = await gql(`mutation Del($id: String!) { issueDelete(id: $id) { success lastSyncId } }`, { id });
      expect(ok.body.data.issueDelete.success).toBe(true);
      expect(ok.body.data.issueDelete.lastSyncId).toEqual(expect.any(Number));

      const missing = await gql(`mutation { issueDelete(id: "nope") { success } }`);
      expect(missing.body.errors).toBeTruthy();
      expect(missing.body.data.issueDelete).toBeNull();
    });

    it("commentCreate creates a comment on an existing issue", async () => {
      const created = await gql(
        `mutation { issueCreate(input: { title: "Has comments" }) { issue { id } } }`
      );
      const issueId = created.body.data.issueCreate.issue.id;
      const res = await gql(
        `mutation C($input: CommentCreateInput!) {
          commentCreate(input: $input) { success lastSyncId comment { id body issue { id } } }
        }`,
        { input: { issueId, body: "Looks good" } }
      );
      expect(res.body.data.commentCreate.success).toBe(true);
      expect(res.body.data.commentCreate.lastSyncId).toEqual(expect.any(Number));
      expect(res.body.data.commentCreate.comment.body).toBe("Looks good");
      expect(res.body.data.commentCreate.comment.issue.id).toBe(issueId);

      const fetched = await gql(
        `query Get($id: String!) { comment(id: $id) { id body } }`,
        { id: res.body.data.commentCreate.comment.id }
      );
      expect(fetched.body.data.comment.body).toBe("Looks good");
    });

    it("commentCreate errors when the issue does not exist", async () => {
      const res = await gql(
        `mutation { commentCreate(input: { issueId: "missing", body: "hi" }) { success } }`
      );
      expect(res.body.errors).toBeTruthy();
      expect(res.body.data.commentCreate).toBeNull();
    });

    it("created issues appear in issues { nodes }", async () => {
      await gql(
        `mutation { issueCreate(input: { title: "Inline title" }) { success issue { id } } }`
      );
      const res = await gql("{ issues { nodes { id title } } }");
      expect(res.body.data.issues.nodes.length).toBe(1);
      expect(res.body.data.issues.nodes[0].title).toBe("Inline title");
    });

    it("returns a GraphQL error when title is missing", async () => {
      const res = await gql(
        `mutation { issueCreate(input: { description: "no title" }) { success } }`
      );
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeTruthy();
    });

    it("round-trips create -> fetch by id", async () => {
      const created = await gql(
        `mutation { issueCreate(input: { title: "Roundtrip" }) { issue { id identifier } } }`
      );
      const id = created.body.data.issueCreate.issue.id;
      const res = await gql(`query Get($id: String!) { issue(id: $id) { id title } }`, { id });
      expect(res.body.data.issue.title).toBe("Roundtrip");
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await gql(`mutation { issueCreate(input: { title: "x" }) { success } }`);
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const res = await gql("{ issues { nodes { id } } }");
      expect(res.body.data.issues.nodes).toEqual([]);
    });
  });
});
