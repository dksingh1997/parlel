import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GitlabServer } from "../services/gitlab/src/server.js";

const PORT = 14768;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { "PRIVATE-TOKEN": "glpat-parlelTestKey" };

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

describe("GitLab Service", () => {
  let server: GitlabServer;

  beforeAll(async () => {
    server = new GitlabServer(PORT);
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
      expect(root.body.name).toBe("gitlab");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with the real 401 envelope", async () => {
      const res = await fetch(`${BASE_URL}/api/v4/user`);
      expect(res.status).toBe(401);
      const body = await res.json();
      // Real GitLab: { "message": "401 Unauthorized" }
      expect(body).toEqual({ message: "401 Unauthorized" });
    });

    it("accepts PRIVATE-TOKEN and Bearer", async () => {
      const a = await api("GET", "/api/v4/user", undefined, { "PRIVATE-TOKEN": "x" });
      const b = await api("GET", "/api/v4/user", undefined, { Authorization: "Bearer x" });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    });
  });

  describe("GET /api/v4/user", () => {
    it("returns current user", async () => {
      const res = await api("GET", "/api/v4/user");
      expect(res.status).toBe(200);
      expect(res.body.username).toBe("parlel-user");
      expect(res.body.id).toBe(1);
    });
  });

  describe("Projects", () => {
    it("lists seeded projects", async () => {
      const res = await api("GET", "/api/v4/projects");
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0].path_with_namespace).toContain("parlel-user/");
    });

    it("emits GitLab offset-pagination headers on list", async () => {
      const res = await api("GET", "/api/v4/projects");
      // Real GitLab emits these on every offset-paginated list.
      expect(res.headers.get("x-total")).toBe("1");
      expect(res.headers.get("x-page")).toBe("1");
      expect(res.headers.get("x-per-page")).toBe("20");
      expect(res.headers.get("x-total-pages")).toBe("1");
      // Single page => no next/prev.
      expect(res.headers.get("x-next-page")).toBe("");
      expect(res.headers.get("x-prev-page")).toBe("");
    });

    it("paginates with page/per_page and sets Link rels", async () => {
      // Seed enough projects to span pages.
      for (let i = 0; i < 4; i++) {
        await api("POST", "/api/v4/projects", { name: `p${i}`, path: `p${i}` });
      }
      const page1 = await api("GET", "/api/v4/projects?per_page=2&page=1");
      expect(page1.status).toBe(200);
      expect(page1.body.length).toBe(2);
      expect(page1.headers.get("x-total")).toBe("5");
      expect(page1.headers.get("x-total-pages")).toBe("3");
      expect(page1.headers.get("x-next-page")).toBe("2");
      expect(page1.headers.get("link")).toContain('rel="next"');
      expect(page1.headers.get("link")).toContain('rel="last"');

      const page3 = await api("GET", "/api/v4/projects?per_page=2&page=3");
      expect(page3.body.length).toBe(1);
      expect(page3.headers.get("x-next-page")).toBe("");
      expect(page3.headers.get("x-prev-page")).toBe("2");
    });

    it("creates a project", async () => {
      const res = await api("POST", "/api/v4/projects", { name: "My Project", path: "my-project" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("My Project");
      expect(res.body.id).toBeGreaterThan(0);
    });

    it("creates a project from query-string attributes", async () => {
      // GitLab accepts attributes via query string OR body.
      const res = await api("POST", "/api/v4/projects?name=QueryProj&path=query-proj");
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("QueryProj");
      expect(res.body.path).toBe("query-proj");
    });

    it("rejects project without name/path with GitLab 400 envelope", async () => {
      const res = await api("POST", "/api/v4/projects", {});
      expect(res.status).toBe(400);
      // Exact real-API shape: { "message": "400 (Bad request) \"name\" not given" }
      expect(res.body.message).toBe('400 (Bad request) "name" not given');
      expect(res.body.error).toBeUndefined();
    });

    it("gets, updates and deletes a project", async () => {
      const created = await api("POST", "/api/v4/projects", { name: "tmp", path: "tmp" });
      const id = created.body.id;
      const got = await api("GET", `/api/v4/projects/${id}`);
      expect(got.body.name).toBe("tmp");
      const updated = await api("PUT", `/api/v4/projects/${id}`, { description: "desc" });
      expect(updated.body.description).toBe("desc");
      const deleted = await api("DELETE", `/api/v4/projects/${id}`);
      expect(deleted.status).toBe(202);
    });

    it("returns 404 with the real envelope for an unknown project", async () => {
      const res = await api("GET", "/api/v4/projects/999999");
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("404 Project Not Found");
    });

    it("returns 405 on an unsupported method against the collection", async () => {
      const res = await api("DELETE", "/api/v4/projects");
      expect(res.status).toBe(405);
      expect(res.body.message).toBe("405 Method Not Allowed");
    });
  });

  describe("Issues", () => {
    it("creates and lists issues with iid", async () => {
      const list = await api("GET", "/api/v4/projects");
      const pid = list.body[0].id;
      const created = await api("POST", `/api/v4/projects/${pid}/issues`, { title: "Bug" });
      expect(created.status).toBe(201);
      expect(created.body.iid).toBe(1);
      expect(created.body.state).toBe("opened");

      const got = await api("GET", `/api/v4/projects/${pid}/issues/1`);
      expect(got.body.title).toBe("Bug");

      const closed = await api("PUT", `/api/v4/projects/${pid}/issues/1`, { state_event: "close" });
      expect(closed.body.state).toBe("closed");
    });

    it("returns the full GitLab issue shape on create", async () => {
      const list = await api("GET", "/api/v4/projects");
      const pid = list.body[0].id;
      const created = await api("POST", `/api/v4/projects/${pid}/issues`, { title: "Shape" });
      const i = created.body;
      // Rich fields a real client may read.
      expect(i.type).toBe("ISSUE");
      expect(i.assignee).toBeNull();
      expect(Array.isArray(i.assignees)).toBe(true);
      expect(i.author.web_url).toContain("gitlab.com/");
      expect(i.author.state).toBe("active");
      expect(i.references).toEqual({ short: "#1", relative: "#1", full: `${list.body[0].path_with_namespace}#1` });
      expect(i.time_stats).toMatchObject({ time_estimate: 0, total_time_spent: 0 });
      expect(i.task_completion_status).toEqual({ count: 0, completed_count: 0 });
      expect(i.upvotes).toBe(0);
      expect(i.downvotes).toBe(0);
      expect(i.merge_requests_count).toBe(0);
    });

    it("keeps open_issues_count in sync on close/reopen", async () => {
      const list = await api("GET", "/api/v4/projects");
      const pid = list.body[0].id;
      await api("POST", `/api/v4/projects/${pid}/issues`, { title: "Counter" });
      let proj = await api("GET", `/api/v4/projects/${pid}`);
      expect(proj.body.open_issues_count).toBe(1);

      const closed = await api("PUT", `/api/v4/projects/${pid}/issues/1`, { state_event: "close" });
      expect(closed.body.closed_at).not.toBeNull();
      expect(closed.body.closed_by.username).toBe("parlel-user");
      proj = await api("GET", `/api/v4/projects/${pid}`);
      expect(proj.body.open_issues_count).toBe(0);

      await api("PUT", `/api/v4/projects/${pid}/issues/1`, { state_event: "reopen" });
      proj = await api("GET", `/api/v4/projects/${pid}`);
      expect(proj.body.open_issues_count).toBe(1);
    });

    it("rejects an issue without title using the GitLab 400 envelope", async () => {
      const list = await api("GET", "/api/v4/projects");
      const pid = list.body[0].id;
      const res = await api("POST", `/api/v4/projects/${pid}/issues`, {});
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('400 (Bad request) "title" not given');
    });

    it("returns 404 for an unknown issue", async () => {
      const list = await api("GET", "/api/v4/projects");
      const pid = list.body[0].id;
      const res = await api("GET", `/api/v4/projects/${pid}/issues/999`);
      expect(res.status).toBe(404);
      expect(res.body.message).toContain("404");
    });
  });

  describe("Merge requests", () => {
    it("creates and lists merge requests", async () => {
      const list = await api("GET", "/api/v4/projects");
      const pid = list.body[0].id;
      const created = await api("POST", `/api/v4/projects/${pid}/merge_requests`, {
        title: "MR",
        source_branch: "feature",
        target_branch: "main",
      });
      expect(created.status).toBe(201);
      expect(created.body.iid).toBe(1);
      expect(created.body.source_branch).toBe("feature");

      const all = await api("GET", `/api/v4/projects/${pid}/merge_requests`);
      expect(all.body.length).toBe(1);
      // List is paginated like the real API.
      expect(all.headers.get("x-total")).toBe("1");
    });

    it("returns the full GitLab MR shape on create", async () => {
      const list = await api("GET", "/api/v4/projects");
      const pid = list.body[0].id;
      const created = await api("POST", `/api/v4/projects/${pid}/merge_requests`, {
        title: "Shape MR",
        source_branch: "feature",
        target_branch: "main",
      });
      const mr = created.body;
      expect(mr.merge_status).toBe("can_be_merged");
      expect(mr.detailed_merge_status).toBe("mergeable");
      expect(mr.references).toEqual({ short: "!1", relative: "!1", full: `${list.body[0].path_with_namespace}!1` });
      expect(mr.author.web_url).toContain("gitlab.com/");
      expect(mr.merged).toBe(false);
      expect(Array.isArray(mr.assignees)).toBe(true);
    });

    it("rejects MR with a missing branch using the GitLab 400 envelope", async () => {
      const list = await api("GET", "/api/v4/projects");
      const pid = list.body[0].id;
      const res = await api("POST", `/api/v4/projects/${pid}/merge_requests`, { title: "x", source_branch: "f" });
      expect(res.status).toBe(400);
      // First missing required attr is target_branch.
      expect(res.body.message).toBe('400 (Bad request) "target_branch" not given');
    });
  });
});
