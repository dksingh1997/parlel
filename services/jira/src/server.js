import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/jira — a tiny, dependency-free fake of the Jira Cloud REST API v3.
//
// It speaks the wire protocol used by the official jira.js client and the
// language-agnostic /rest/api/3 surface so application code and AI agents can
// run against it with zero cost and zero side effects. State is in-memory and
// ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Jira error envelope: { errorMessages: [...], errors: {...} }
function jiraError(messages, errors = {}) {
  return {
    errorMessages: Array.isArray(messages) ? messages : [messages],
    errors,
  };
}

export class JiraServer {
  constructor(port = 4787, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.issues = new Map();
    this.projects = new Map();
    this.issueCounter = 10000;
    this.projectCounter = 10000;
    this._seedDefaults();
  }

  _seedDefaults() {
    const proj = {
      id: "10000",
      key: "PARLEL",
      name: "Parlel",
      projectTypeKey: "software",
      self: this._url("/rest/api/3/project/10000"),
      simplified: true,
      style: "next-gen",
    };
    this.projects.set(proj.key, proj);
    this.myself = {
      accountId: "parlel-account-id",
      accountType: "atlassian",
      displayName: "Parlel User",
      emailAddress: "parlel@example.com",
      active: true,
      self: this._url("/rest/api/3/user?accountId=parlel-account-id"),
    };
  }

  _url(path) {
    return `http://${this.host}:${this.port}${path}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, jiraError(error.message || "Internal server error"));
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
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-jira");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Everything else is /rest/api/3 and requires auth.
    if (!(parts[0] === "rest" && parts[1] === "api" && parts[2] === "3")) {
      return this.send(res, 404, jiraError("not found"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, jiraError("Client must be authenticated to access this resource."));
    }

    const route = parts.slice(3);

    // GET /rest/api/3/myself
    if (req.method === "GET" && route[0] === "myself" && route.length === 1) {
      return this.send(res, 200, clone(this.myself));
    }

    // /rest/api/3/issue ...
    if (route[0] === "issue") return this.handleIssue(req, res, route, body);

    // POST /rest/api/3/search  (JQL)
    if (route[0] === "search" && route.length === 1) return this.handleSearch(req, res, body, url);

    // /rest/api/3/project ...
    if (route[0] === "project") return this.handleProject(req, res, route, body);

    return this.send(res, 404, jiraError("not found"));
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------
  handleIssue(req, res, route, body) {
    // /rest/api/3/issue
    if (route.length === 1) {
      if (req.method === "POST") {
        if (!isPlainObject(body) || !isPlainObject(body.fields)) {
          return this.send(res, 400, jiraError([], { fields: "fields is required" }));
        }
        const fields = body.fields;

        // Real Jira validates every required field at once and returns a single
        // 400 whose `errors` map keys each offending field. The three fields the
        // create-issue endpoint requires are summary, project, and issuetype
        // (the Pipedream component always sends project + issuetype).
        const errors = {};

        if (typeof fields.summary !== "string" || !fields.summary) {
          errors.summary = "You must specify a summary of the issue.";
        }

        // Resolve the project from fields.project.{key|id}. Real Jira requires a
        // valid project; it never invents a default. A missing or unknown
        // project is a 400, not a silent success.
        let project = null;
        if (!isPlainObject(fields.project) || (!fields.project.key && fields.project.id === undefined)) {
          errors.project = "Specify a valid project ID or key";
        } else if (fields.project.key) {
          project = this.projects.get(String(fields.project.key)) || null;
          if (!project) errors.project = "Specify a valid project ID or key";
        } else if (fields.project.id !== undefined) {
          project = [...this.projects.values()].find((p) => p.id === String(fields.project.id)) || null;
          if (!project) errors.project = "Specify a valid project ID or key";
        }

        // issuetype is required: by name or id.
        let issueType = null;
        if (!isPlainObject(fields.issuetype) || (!fields.issuetype.name && fields.issuetype.id === undefined)) {
          errors.issuetype = "Specify an issue type.";
        } else {
          issueType = {
            id: fields.issuetype.id !== undefined ? String(fields.issuetype.id) : "10001",
            name: fields.issuetype.name || "Task",
          };
        }

        if (Object.keys(errors).length > 0) {
          return this.send(res, 400, jiraError([], errors));
        }

        this.issueCounter += 1;
        const id = String(this.issueCounter);
        const seq = this.issueCounter - 10000;
        const key = `${project.key}-${seq}`;
        const stored = {
          id,
          key,
          self: this._url(`/rest/api/3/issue/${id}`),
          fields: {
            summary: fields.summary,
            description: fields.description || null,
            issuetype: issueType,
            project: { id: project.id, key: project.key, name: project.name },
            status: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
            priority: isPlainObject(fields.priority) ? fields.priority : { id: "3", name: "Medium" },
            labels: Array.isArray(fields.labels) ? clone(fields.labels) : [],
            assignee: fields.assignee || null,
            reporter: clone(this.myself),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
          },
        };
        // Copy through any extra custom fields.
        for (const [k, v] of Object.entries(fields)) {
          if (!(k in stored.fields)) stored.fields[k] = clone(v);
        }
        this.issues.set(key, stored);
        return this.send(res, 201, { id, key, self: stored.self });
      }
      return this.send(res, 405, jiraError("method not allowed"));
    }

    // /rest/api/3/issue/{idOrKey}
    const idOrKey = route[1];
    const issue = this._findIssue(idOrKey);

    if (route.length === 2) {
      if (req.method === "GET") {
        if (!issue) return this.send(res, 404, jiraError(`Issue does not exist or you do not have permission to see it.`));
        return this.send(res, 200, clone(issue));
      }
      if (req.method === "PUT") {
        if (!issue) return this.send(res, 404, jiraError("Issue does not exist or you do not have permission to see it."));
        if (isPlainObject(body) && isPlainObject(body.fields)) {
          for (const [k, v] of Object.entries(body.fields)) {
            issue.fields[k] = clone(v);
          }
          issue.fields.updated = new Date().toISOString();
        }
        // Real Jira returns 204 No Content on update.
        return this.send(res, 204, null);
      }
      if (req.method === "DELETE") {
        if (!issue) return this.send(res, 404, jiraError("Issue does not exist or you do not have permission to see it."));
        this.issues.delete(issue.key);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, jiraError("method not allowed"));
    }

    // /rest/api/3/issue/{idOrKey}/transitions — the real, only supported way to
    // change an issue's status. GET lists the transitions available from the
    // current status; POST applies one by transition id.
    if (route.length === 3 && route[2] === "transitions") {
      if (!issue) {
        return this.send(res, 404, jiraError("Issue does not exist or you do not have permission to see it."));
      }
      if (req.method === "GET") {
        return this.send(res, 200, { expand: "transitions", transitions: this._availableTransitions(issue) });
      }
      if (req.method === "POST") {
        const transitionId = isPlainObject(body) && isPlainObject(body.transition)
          ? String(body.transition.id ?? "")
          : "";
        if (!transitionId) {
          return this.send(res, 400, jiraError([], { transition: "transition is required" }));
        }
        const available = this._availableTransitions(issue);
        const chosen = available.find((t) => t.id === transitionId);
        if (!chosen) {
          // Real Jira: 400 when the transition isn't valid from the current status.
          return this.send(res, 400, jiraError(
            `It is not possible to perform this transition (${transitionId}) from the current status.`,
          ));
        }
        issue.fields.status = clone(chosen.to);
        issue.fields.updated = new Date().toISOString();
        // Real Jira returns 204 No Content on a successful transition.
        return this.send(res, 204, null);
      }
      return this.send(res, 405, jiraError("method not allowed"));
    }

    return this.send(res, 404, jiraError("not found"));
  }

  // The fixed status workflow this emulator models, mirroring a default Jira
  // software project: To Do -> In Progress -> Done (and back).
  _availableTransitions(issue) {
    const STATUSES = {
      todo: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
      inprogress: { id: "3", name: "In Progress", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
      done: { id: "10001", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
    };
    // Every status can move to any of the three; transition ids are stable so
    // clients can look up "Done" by name and apply it.
    const ALL = [
      { id: "11", name: "To Do", to: STATUSES.todo },
      { id: "21", name: "In Progress", to: STATUSES.inprogress },
      { id: "31", name: "Done", to: STATUSES.done },
    ];
    const current = issue.fields.status && issue.fields.status.name;
    return ALL.filter((t) => t.name !== current);
  }

  _findIssue(idOrKey) {
    if (this.issues.has(idOrKey)) return this.issues.get(idOrKey);
    for (const issue of this.issues.values()) {
      if (issue.id === String(idOrKey)) return issue;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Search (JQL)
  // -------------------------------------------------------------------------
  handleSearch(req, res, body, url) {
    let jql = "";
    let maxResults = 50;
    let startAt = 0;
    if (req.method === "POST") {
      jql = typeof body.jql === "string" ? body.jql : "";
      if (Number.isFinite(body.maxResults)) maxResults = body.maxResults;
      if (Number.isFinite(body.startAt)) startAt = body.startAt;
    } else if (req.method === "GET") {
      jql = url.searchParams.get("jql") || "";
      if (url.searchParams.has("maxResults")) maxResults = Number(url.searchParams.get("maxResults"));
      if (url.searchParams.has("startAt")) startAt = Number(url.searchParams.get("startAt"));
    } else {
      return this.send(res, 405, jiraError("method not allowed"));
    }

    let matched = [...this.issues.values()];
    // Minimal JQL: support `project = KEY` and `status = "X"` filtering.
    const projMatch = /project\s*=\s*["']?([A-Za-z0-9_]+)["']?/i.exec(jql);
    if (projMatch) {
      const key = projMatch[1].toUpperCase();
      matched = matched.filter((i) => i.fields.project.key === key);
    }
    const statusMatch = /status\s*=\s*["']([^"']+)["']/i.exec(jql);
    if (statusMatch) {
      matched = matched.filter((i) => i.fields.status.name === statusMatch[1]);
    }

    const total = matched.length;
    const page = matched.slice(startAt, startAt + maxResults).map(clone);
    return this.send(res, 200, {
      expand: "schema,names",
      startAt,
      maxResults,
      total,
      issues: page,
    });
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  handleProject(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.projects.values()].map(clone));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.key !== "string" || !body.key) {
          return this.send(res, 400, jiraError([], { projectKey: "project key is required" }));
        }
        if (this.projects.has(body.key)) {
          return this.send(res, 400, jiraError([], { projectKey: "A project with that project key already exists." }));
        }
        this.projectCounter += 1;
        const id = String(this.projectCounter);
        const project = {
          id,
          key: body.key,
          name: body.name || body.key,
          projectTypeKey: body.projectTypeKey || "software",
          self: this._url(`/rest/api/3/project/${id}`),
          simplified: true,
          style: "next-gen",
        };
        this.projects.set(project.key, project);
        return this.send(res, 201, { id, key: project.key, self: project.self });
      }
      return this.send(res, 405, jiraError("method not allowed"));
    }

    // /rest/api/3/project/{idOrKey}
    const idOrKey = route[1];
    let project = this.projects.get(idOrKey);
    if (!project) {
      project = [...this.projects.values()].find((p) => p.id === String(idOrKey));
    }
    if (req.method === "GET") {
      if (!project) return this.send(res, 404, jiraError("No project could be found with key or id."));
      return this.send(res, 200, clone(project));
    }
    return this.send(res, 405, jiraError("method not allowed"));
  }

  // -------------------------------------------------------------------------
  // Control endpoints
  // -------------------------------------------------------------------------
  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, jiraError("not found"));
  }

  root() {
    return {
      name: "jira",
      version: "1",
      protocol: "jira-rest-v3",
      documentation: "/docs/jira.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth) || /^Basic\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, jiraError("Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, jiraError("Bad request body"));
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
