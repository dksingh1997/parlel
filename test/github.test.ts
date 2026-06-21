import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GithubServer } from "../services/github/src/server.js";

const PORT = 14767;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer ghp_parlelTestKey" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("GitHub Service", () => {
  let server: GithubServer;

  beforeAll(async () => {
    server = new GithubServer(PORT);
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
    it("starts on configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("github");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("resets state", async () => {
      await api("POST", "/user/repos", { name: "tmp" });
      server.reset();
      const list = await api("GET", "/__parlel/repos", undefined, AUTH);
      expect(list.body.repos).not.toContain("parlel-user/tmp");
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const res = await fetch(`${BASE_URL}/user`);
      const body = await res.json();
      expect(res.status).toBe(401);
      expect(body.message).toMatch(/authentication/i);
    });

    it("accepts Bearer and token auth", async () => {
      const a = await api("GET", "/user", undefined, { Authorization: "Bearer x" });
      const b = await api("GET", "/user", undefined, { Authorization: "token x" });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    });

    it("returns the GitHub error envelope on bad JSON", async () => {
      const res = await fetch(`${BASE_URL}/user/repos`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "{not json",
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.message).toMatch(/parsing JSON/i);
    });
  });

  describe("GET /user", () => {
    it("returns the authenticated user with faithful shape", async () => {
      const res = await api("GET", "/user");
      expect(res.status).toBe(200);
      expect(res.body.login).toBe("parlel-user");
      expect(res.body.id).toBe(1);
      expect(res.body.node_id).toBeTruthy();
      expect(res.body.html_url).toContain("github.com");
    });
  });

  describe("Repos", () => {
    it("gets a seeded repo", async () => {
      const res = await api("GET", "/repos/parlel-user/hello-world");
      expect(res.status).toBe(200);
      expect(res.body.full_name).toBe("parlel-user/hello-world");
      expect(res.body.node_id).toBeTruthy();
      expect(res.body.owner.login).toBe("parlel-user");
    });

    it("404 for unknown repo", async () => {
      const res = await api("GET", "/repos/parlel-user/nope");
      expect(res.status).toBe(404);
    });

    it("creates a repo via POST /user/repos", async () => {
      const res = await api("POST", "/user/repos", { name: "new-repo", description: "x", private: true });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("new-repo");
      expect(res.body.private).toBe(true);
      expect(res.body.id).toBeGreaterThan(0);
    });

    it("rejects repo creation without name", async () => {
      const res = await api("POST", "/user/repos", {});
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe("name");
    });

    it("lists user repos", async () => {
      const res = await api("GET", "/user/repos");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects duplicate repo name with 422 custom error", async () => {
      await api("POST", "/user/repos", { name: "dup-repo" });
      const res = await api("POST", "/user/repos", { name: "dup-repo" });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].code).toBe("custom");
    });

    it("404s on POST /repos/:owner/:repo (no create-by-path endpoint)", async () => {
      const res = await api("POST", "/repos/parlel-user/brand-new", { name: "brand-new" });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Not Found");
      const list = await api("GET", "/__parlel/repos", undefined, AUTH);
      expect(list.body.repos).not.toContain("parlel-user/brand-new");
    });
  });

  describe("Issues", () => {
    it("creates, lists, gets and updates issues", async () => {
      const created = await api("POST", "/repos/parlel-user/hello-world/issues", { title: "Bug", body: "broken" });
      expect(created.status).toBe(201);
      expect(created.body.number).toBe(1);
      expect(created.body.state).toBe("open");

      const list = await api("GET", "/repos/parlel-user/hello-world/issues");
      expect(list.body.length).toBe(1);

      const got = await api("GET", "/repos/parlel-user/hello-world/issues/1");
      expect(got.body.title).toBe("Bug");

      const patched = await api("PATCH", "/repos/parlel-user/hello-world/issues/1", { state: "closed" });
      expect(patched.body.state).toBe("closed");
      expect(patched.body.closed_at).toBeTruthy();
      expect(patched.body.state_reason).toBe("completed");
    });

    it("returns the full GitHub issue shape on create", async () => {
      const res = await api("POST", "/repos/parlel-user/hello-world/issues", { title: "Shape" });
      expect(res.status).toBe(201);
      expect(res.body.repository_url).toBe("https://api.github.com/repos/parlel-user/hello-world");
      expect(res.body.comments_url).toContain("/issues/1/comments");
      expect(res.body.events_url).toContain("/issues/1/events");
      expect(res.body.labels_url).toContain("/issues/1/labels");
      expect(res.body.timeline_url).toContain("/issues/1/timeline");
      expect(res.body.author_association).toBe("OWNER");
      expect(res.body.state_reason).toBe(null);
      expect(res.body.active_lock_reason).toBe(null);
      expect(res.body.reactions.total_count).toBe(0);
      expect(res.body.reactions["+1"]).toBe(0);
    });

    it("tracks open_issues_count across close and reopen", async () => {
      await api("POST", "/repos/parlel-user/hello-world/issues", { title: "Track" });
      let repo = await api("GET", "/repos/parlel-user/hello-world");
      expect(repo.body.open_issues_count).toBe(1);

      await api("PATCH", "/repos/parlel-user/hello-world/issues/1", { state: "closed" });
      repo = await api("GET", "/repos/parlel-user/hello-world");
      expect(repo.body.open_issues_count).toBe(0);

      await api("PATCH", "/repos/parlel-user/hello-world/issues/1", { state: "open" });
      repo = await api("GET", "/repos/parlel-user/hello-world");
      expect(repo.body.open_issues_count).toBe(1);
    });

    it("rejects issue without title with the validation envelope", async () => {
      const res = await api("POST", "/repos/parlel-user/hello-world/issues", {});
      expect(res.status).toBe(422);
      expect(res.body.message).toBe("Validation Failed");
      expect(res.body.errors[0]).toMatchObject({ resource: "Issue", field: "title", code: "missing_field" });
    });
  });

  describe("Pull requests", () => {
    it("creates and gets a pull request", async () => {
      const created = await api("POST", "/repos/parlel-user/hello-world/pulls", {
        title: "Add feature",
        head: "feature",
        base: "main",
      });
      expect(created.status).toBe(201);
      expect(created.body.state).toBe("open");
      expect(created.body.head.ref).toBe("feature");

      const list = await api("GET", "/repos/parlel-user/hello-world/pulls");
      expect(list.body.length).toBe(1);

      const got = await api("GET", `/repos/parlel-user/hello-world/pulls/${created.body.number}`);
      expect(got.body.title).toBe("Add feature");
    });
  });

  describe("Contents", () => {
    it("puts and gets file contents", async () => {
      const content = Buffer.from("hello parlel").toString("base64");
      const put = await api("PUT", "/repos/parlel-user/hello-world/contents/README.md", {
        message: "add readme",
        content,
      });
      expect(put.status).toBe(201);
      expect(put.body.content.path).toBe("README.md");
      // Real content object carries git_url + _links {self, git, html}.
      expect(put.body.content.git_url).toContain("/git/blobs/");
      expect(put.body.content._links.self).toContain("/contents/README.md");
      expect(put.body.content._links.git).toBe(put.body.content.git_url);
      expect(put.body.content._links.html).toContain("/blob/main/README.md");
      // Real commit object is rich.
      expect(put.body.commit.node_id).toBeTruthy();
      expect(put.body.commit.html_url).toContain("/commit/");
      expect(put.body.commit.author.name).toBeTruthy();
      expect(put.body.commit.committer).toBeTruthy();
      expect(put.body.commit.tree.sha).toBeTruthy();
      expect(Array.isArray(put.body.commit.parents)).toBe(true);
      expect(put.body.commit.verification.verified).toBe(false);
      expect(put.body.commit.message).toBe("add readme");

      const got = await api("GET", "/repos/parlel-user/hello-world/contents/README.md");
      expect(got.status).toBe(200);
      expect(got.body.content).toBe(content);
    });

    it("updating a file returns 200 with parent commit", async () => {
      const content = Buffer.from("v1").toString("base64");
      await api("PUT", "/repos/parlel-user/hello-world/contents/FILE.md", { message: "create", content });
      const updated = await api("PUT", "/repos/parlel-user/hello-world/contents/FILE.md", {
        message: "update",
        content: Buffer.from("v2").toString("base64"),
      });
      expect(updated.status).toBe(200);
      expect(updated.body.commit.parents.length).toBe(1);
    });

    it("rejects PUT contents without message (422, both fields required)", async () => {
      const content = Buffer.from("no message").toString("base64");
      const res = await api("PUT", "/repos/parlel-user/hello-world/contents/NOMSG.md", { content });
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/Invalid request/);
    });

    it("rejects PUT contents without content (422)", async () => {
      const res = await api("PUT", "/repos/parlel-user/hello-world/contents/NOCONTENT.md", { message: "x" });
      expect(res.status).toBe(422);
    });

    it("404 for missing content", async () => {
      const res = await api("GET", "/repos/parlel-user/hello-world/contents/missing.txt");
      expect(res.status).toBe(404);
    });
  });

  describe("GraphQL", () => {
    it("returns viewer login", async () => {
      const res = await api("POST", "/graphql", { query: "query { viewer { login id name } }" });
      expect(res.status).toBe(200);
      expect(res.body.data.viewer.login).toBe("parlel-user");
      expect(res.body.data.viewer.id).toBeTruthy();
    });

    it("returns repository basics", async () => {
      const res = await api("POST", "/graphql", {
        query: 'query { repository(owner: "parlel-user", name: "hello-world") { name nameWithOwner isPrivate } }',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.repository.nameWithOwner).toBe("parlel-user/hello-world");
    });

    it("requires auth", async () => {
      const res = await fetch(`${BASE_URL}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { viewer { login } }" }),
      });
      expect(res.status).toBe(401);
    });
  });
});
