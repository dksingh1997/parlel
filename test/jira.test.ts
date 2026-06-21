import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { JiraServer } from "../services/jira/src/server.js";

const PORT = 14787;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Basic ${Buffer.from("parlel@example.com:token").toString("base64")}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
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

function newIssue(summary = "Test issue"): Json {
  return {
    fields: {
      project: { key: "PARLEL" },
      summary,
      issuetype: { name: "Task" },
    },
  };
}

describe("Jira Service", () => {
  let server: JiraServer;

  beforeAll(async () => {
    server = new JiraServer(PORT);
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
      expect(root.body.name).toBe("jira");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const response = await fetch(`${BASE_URL}/rest/api/3/myself`);
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth", async () => {
      const me = await api("GET", "/rest/api/3/myself");
      expect(me.status).toBe(200);
      expect(me.body.accountId).toBeTruthy();
    });

    it("accepts Bearer auth", async () => {
      const me = await api("GET", "/rest/api/3/myself", undefined, { Authorization: "Bearer abc" });
      expect(me.status).toBe(200);
    });
  });

  describe("Issues CRUD", () => {
    it("creates an issue and returns {id,key,self}", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue("Build feature"));
      expect(created.status).toBe(201);
      expect(created.body.id).toBeTruthy();
      expect(created.body.key).toMatch(/^PARLEL-\d+$/);
      expect(created.body.self).toContain("/rest/api/3/issue/");
    });

    it("rejects issue creation without summary", async () => {
      const created = await api("POST", "/rest/api/3/issue", {
        fields: { project: { key: "PARLEL" }, issuetype: { name: "Task" } },
      });
      expect(created.status).toBe(400);
      expect(created.body.errors).toBeTruthy();
      expect(created.body.errors.summary).toBeTruthy();
    });

    it("rejects issue creation without project (no silent default)", async () => {
      const created = await api("POST", "/rest/api/3/issue", {
        fields: { summary: "Orphan", issuetype: { name: "Task" } },
      });
      expect(created.status).toBe(400);
      expect(created.body.errors.project).toBeTruthy();
    });

    it("rejects issue creation referencing an unknown project", async () => {
      const created = await api("POST", "/rest/api/3/issue", {
        fields: { summary: "Bad project", project: { key: "NOPE" }, issuetype: { name: "Task" } },
      });
      expect(created.status).toBe(400);
      expect(created.body.errors.project).toBeTruthy();
    });

    it("rejects issue creation without issuetype", async () => {
      const created = await api("POST", "/rest/api/3/issue", {
        fields: { summary: "No type", project: { key: "PARLEL" } },
      });
      expect(created.status).toBe(400);
      expect(created.body.errors.issuetype).toBeTruthy();
    });

    it("reports every missing required field at once", async () => {
      const created = await api("POST", "/rest/api/3/issue", { fields: {} });
      expect(created.status).toBe(400);
      expect(created.body.errors.summary).toBeTruthy();
      expect(created.body.errors.project).toBeTruthy();
      expect(created.body.errors.issuetype).toBeTruthy();
    });

    it("creates an issue against a project referenced by id", async () => {
      const created = await api("POST", "/rest/api/3/issue", {
        fields: { summary: "By id", project: { id: "10000" }, issuetype: { name: "Task" } },
      });
      expect(created.status).toBe(201);
      expect(created.body.key).toMatch(/^PARLEL-\d+$/);
    });

    it("retrieves an issue by key with fields shape", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue("Readable"));
      const got = await api("GET", `/rest/api/3/issue/${created.body.key}`);
      expect(got.status).toBe(200);
      expect(got.body.key).toBe(created.body.key);
      expect(got.body.fields.summary).toBe("Readable");
      expect(got.body.fields.status.name).toBeTruthy();
    });

    it("retrieves an issue by id", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue());
      const got = await api("GET", `/rest/api/3/issue/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(created.body.id);
    });

    it("updates an issue (204)", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue("Before"));
      const updated = await api("PUT", `/rest/api/3/issue/${created.body.key}`, {
        fields: { summary: "After" },
      });
      expect(updated.status).toBe(204);
      const got = await api("GET", `/rest/api/3/issue/${created.body.key}`);
      expect(got.body.fields.summary).toBe("After");
    });

    it("deletes an issue (204)", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue());
      const deleted = await api("DELETE", `/rest/api/3/issue/${created.body.key}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/rest/api/3/issue/${created.body.key}`);
      expect(gone.status).toBe(404);
    });

    it("returns 404 for unknown issue", async () => {
      const got = await api("GET", "/rest/api/3/issue/PARLEL-9999");
      expect(got.status).toBe(404);
    });
  });

  describe("Search (JQL)", () => {
    it("searches issues by project via JQL", async () => {
      await api("POST", "/rest/api/3/issue", newIssue("One"));
      await api("POST", "/rest/api/3/issue", newIssue("Two"));
      const search = await api("POST", "/rest/api/3/search", { jql: "project = PARLEL" });
      expect(search.status).toBe(200);
      expect(search.body.total).toBe(2);
      expect(search.body.issues.length).toBe(2);
      expect(search.body.issues[0].fields.summary).toBeTruthy();
    });

    it("filters by status", async () => {
      await api("POST", "/rest/api/3/issue", newIssue());
      const search = await api("POST", "/rest/api/3/search", { jql: 'status = "Done"' });
      expect(search.status).toBe(200);
      expect(search.body.total).toBe(0);
    });
  });

  describe("Transitions", () => {
    it("lists available transitions for a new issue", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue("Workflow"));
      const got = await api("GET", `/rest/api/3/issue/${created.body.key}/transitions`);
      expect(got.status).toBe(200);
      expect(Array.isArray(got.body.transitions)).toBe(true);
      const names = got.body.transitions.map((t: any) => t.name);
      expect(names).toContain("Done");
      // The current status (To Do) is not offered as a transition target.
      expect(names).not.toContain("To Do");
    });

    it("transitions an issue to Done (204) and reflects new status", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue("Ship"));
      const transitions = await api("GET", `/rest/api/3/issue/${created.body.key}/transitions`);
      const done = transitions.body.transitions.find((t: any) => t.name === "Done");
      const applied = await api(
        "POST",
        `/rest/api/3/issue/${created.body.key}/transitions`,
        { transition: { id: done.id } },
      );
      expect(applied.status).toBe(204);
      const got = await api("GET", `/rest/api/3/issue/${created.body.key}`);
      expect(got.body.fields.status.name).toBe("Done");
    });

    it("rejects an unknown transition id (400)", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue());
      const applied = await api(
        "POST",
        `/rest/api/3/issue/${created.body.key}/transitions`,
        { transition: { id: "9999" } },
      );
      expect(applied.status).toBe(400);
    });

    it("requires a transition body (400)", async () => {
      const created = await api("POST", "/rest/api/3/issue", newIssue());
      const applied = await api(
        "POST",
        `/rest/api/3/issue/${created.body.key}/transitions`,
        {},
      );
      expect(applied.status).toBe(400);
    });
  });

  describe("Projects", () => {
    it("lists projects (seeded default)", async () => {
      const list = await api("GET", "/rest/api/3/project");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body.length).toBeGreaterThanOrEqual(1);
    });

    it("creates a project and retrieves it", async () => {
      const created = await api("POST", "/rest/api/3/project", { key: "NEW", name: "New Project" });
      expect(created.status).toBe(201);
      expect(created.body.key).toBe("NEW");
      const got = await api("GET", "/rest/api/3/project/NEW");
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("New Project");
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await api("POST", "/rest/api/3/issue", newIssue());
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const search = await api("POST", "/rest/api/3/search", { jql: "project = PARLEL" });
      expect(search.body.total).toBe(0);
    });
  });
});
