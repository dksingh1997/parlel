import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/gitlab — a dependency-free fake of the GitLab API v4.
//
// Speaks the wire protocol used by @gitbeaker/rest and the raw GitLab REST API
// so application code and AI agents can run against it with zero cost and zero
// side effects. State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// GitLab's exact missing-required-attribute envelope, e.g.
//   { "message": "400 (Bad request) \"title\" not given" }
// Source: https://docs.gitlab.com/api/rest/troubleshooting/#status-code-400
function missingAttr(field) {
  return { message: `400 (Bad request) "${field}" not given` };
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class GitlabServer {
  constructor(port = 4768, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.idCounter = 100;
    this.projects = new Map(); // id -> { project, issues, mrs, issueIid, mrIid }
    this.user = {
      id: 1,
      username: "parlel-user",
      name: "Parlel User",
      state: "active",
      avatar_url: "https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png",
      web_url: "https://gitlab.com/parlel-user",
      created_at: now(),
      bio: "",
      public_email: "parlel-user@parlel.dev",
      is_admin: false,
    };
    this._createProject({ name: "hello-world", path: "hello-world" });
  }

  _nextId() {
    this.idCounter += 1;
    return this.idCounter;
  }

  // The rich author/actor sub-object GitLab embeds on issues/MRs.
  // Source: https://docs.gitlab.com/api/issues/ example responses.
  _author() {
    return {
      id: this.user.id,
      username: this.user.username,
      name: this.user.name,
      state: this.user.state,
      avatar_url: this.user.avatar_url,
      web_url: this.user.web_url,
    };
  }

  _createProject(opts = {}) {
    const id = this._nextId();
    const path = opts.path || (opts.name || "project").toLowerCase().replace(/\s+/g, "-");
    const namespace = this.user.username;
    const project = {
      id,
      description: opts.description || null,
      name: opts.name || path,
      name_with_namespace: `${this.user.name} / ${opts.name || path}`,
      path,
      path_with_namespace: `${namespace}/${path}`,
      created_at: now(),
      default_branch: "main",
      visibility: opts.visibility || "private",
      web_url: `https://gitlab.com/${namespace}/${path}`,
      namespace: { id: this.user.id, name: this.user.name, path: namespace, kind: "user", full_path: namespace },
      star_count: 0,
      forks_count: 0,
      open_issues_count: 0,
    };
    this.projects.set(id, {
      project,
      issues: new Map(),
      mrs: new Map(),
      issueIid: 0,
      mrIid: 0,
    });
    return project;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message || "500 Internal Server Error" });
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, PRIVATE-TOKEN");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "X-Total, X-Total-Pages, X-Per-Page, X-Page, X-Next-Page, X-Prev-Page, Link");
    res.setHeader("server", "parlel-gitlab");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api" || parts[1] !== "v4") {
      return this.send(res, 404, { message: "404 Not Found" });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { message: "401 Unauthorized" });
    }

    const route = parts.slice(2);

    // GitLab accepts attributes via query string OR JSON/form body; merge them
    // (body wins on conflict). Source: https://docs.gitlab.com/api/rest/#request-payload
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const params = isPlainObject(body) ? { ...query, ...body } : body;

    if (route[0] === "user" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, clone(this.user));
    }

    if (route[0] === "projects") {
      return this.handleProjects(req, res, route.slice(1), params, query);
    }

    return this.send(res, 404, { message: "404 Not Found" });
  }

  handleProjects(req, res, route, body, query) {
    if (route.length === 0) {
      if (req.method === "GET") {
        const all = [...this.projects.values()].map((p) => clone(p.project));
        return this.sendPaginated(req, res, all, query);
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || (typeof body.name !== "string" && typeof body.path !== "string")) {
          return this.send(res, 400, missingAttr("name"));
        }
        const project = this._createProject(body);
        return this.send(res, 201, clone(project));
      }
      return this.send(res, 405, { message: "405 Method Not Allowed" });
    }

    const id = Number(route[0]);
    const entry = this.projects.get(id);
    if (!entry) return this.send(res, 404, { message: "404 Project Not Found" });

    // /projects/:id
    if (route.length === 1) {
      if (req.method === "GET") return this.send(res, 200, clone(entry.project));
      if (req.method === "PUT") {
        if (isPlainObject(body)) {
          if (typeof body.name === "string") entry.project.name = body.name;
          if (typeof body.description === "string") entry.project.description = body.description;
          if (typeof body.visibility === "string") entry.project.visibility = body.visibility;
          if (typeof body.default_branch === "string") entry.project.default_branch = body.default_branch;
        }
        return this.send(res, 200, clone(entry.project));
      }
      if (req.method === "DELETE") {
        this.projects.delete(id);
        return this.send(res, 202, { message: "202 Accepted" });
      }
      return this.send(res, 405, { message: "405 Method Not Allowed" });
    }

    if (route[1] === "issues") return this.handleIssues(req, res, entry, route.slice(2), body, query);
    if (route[1] === "merge_requests") return this.handleMrs(req, res, entry, route.slice(2), body, query);

    return this.send(res, 404, { message: "404 Not Found" });
  }

  handleIssues(req, res, entry, sub, body, query) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.sendPaginated(req, res, [...entry.issues.values()].map(clone), query);
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.title !== "string" || !body.title) {
          return this.send(res, 400, missingAttr("title"));
        }
        entry.issueIid += 1;
        const id = this._nextId();
        const timestamp = now();
        const issue = {
          id,
          iid: entry.issueIid,
          project_id: entry.project.id,
          title: body.title,
          description: typeof body.description === "string" ? body.description : null,
          state: "opened",
          created_at: timestamp,
          updated_at: timestamp,
          closed_at: null,
          closed_by: null,
          labels: Array.isArray(body.labels) ? body.labels : (typeof body.labels === "string" ? body.labels.split(",") : []),
          milestone: null,
          author: this._author(),
          type: "ISSUE",
          assignees: [],
          assignee: null,
          upvotes: 0,
          downvotes: 0,
          merge_requests_count: 0,
          user_notes_count: 0,
          due_date: null,
          confidential: body.confidential === true || body.confidential === "true",
          discussion_locked: null,
          issue_type: "issue",
          web_url: `${entry.project.web_url}/-/issues/${entry.issueIid}`,
          references: {
            short: `#${entry.issueIid}`,
            relative: `#${entry.issueIid}`,
            full: `${entry.project.path_with_namespace}#${entry.issueIid}`,
          },
          time_stats: {
            time_estimate: 0,
            total_time_spent: 0,
            human_time_estimate: null,
            human_total_time_spent: null,
          },
          task_completion_status: { count: 0, completed_count: 0 },
        };
        entry.issues.set(entry.issueIid, issue);
        entry.project.open_issues_count += 1;
        return this.send(res, 201, clone(issue));
      }
      return this.send(res, 405, { message: "405 Method Not Allowed" });
    }

    const iid = Number(sub[0]);
    const issue = entry.issues.get(iid);
    if (!issue) return this.send(res, 404, { message: "404 Issue Not Found" });
    if (req.method === "GET") return this.send(res, 200, clone(issue));
    if (req.method === "PUT") {
      if (isPlainObject(body)) {
        if (typeof body.title === "string") issue.title = body.title;
        if (typeof body.description === "string") issue.description = body.description;
        if (body.state_event === "close" && issue.state !== "closed") {
          issue.state = "closed";
          issue.closed_at = now();
          issue.closed_by = this._author();
          entry.project.open_issues_count = Math.max(0, entry.project.open_issues_count - 1);
        }
        if (body.state_event === "reopen" && issue.state !== "opened") {
          issue.state = "opened";
          issue.closed_at = null;
          issue.closed_by = null;
          entry.project.open_issues_count += 1;
        }
        issue.updated_at = now();
      }
      return this.send(res, 200, clone(issue));
    }
    return this.send(res, 405, { message: "405 Method Not Allowed" });
  }

  handleMrs(req, res, entry, sub, body, query) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.sendPaginated(req, res, [...entry.mrs.values()].map(clone), query);
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.title !== "string" || !body.title) {
          return this.send(res, 400, missingAttr("title"));
        }
        if (typeof body.source_branch !== "string" || !body.source_branch) {
          return this.send(res, 400, missingAttr("source_branch"));
        }
        if (typeof body.target_branch !== "string" || !body.target_branch) {
          return this.send(res, 400, missingAttr("target_branch"));
        }
        entry.mrIid += 1;
        const id = this._nextId();
        const timestamp = now();
        const mr = {
          id,
          iid: entry.mrIid,
          project_id: entry.project.id,
          title: body.title,
          description: typeof body.description === "string" ? body.description : null,
          state: "opened",
          merged: false,
          created_at: timestamp,
          updated_at: timestamp,
          merged_by: null,
          merged_at: null,
          closed_by: null,
          closed_at: null,
          target_branch: body.target_branch,
          source_branch: body.source_branch,
          source_project_id: entry.project.id,
          target_project_id: entry.project.id,
          labels: Array.isArray(body.labels) ? body.labels : (typeof body.labels === "string" ? body.labels.split(",") : []),
          draft: false,
          work_in_progress: false,
          milestone: null,
          author: this._author(),
          assignees: [],
          assignee: null,
          reviewers: [],
          merge_status: "can_be_merged",
          detailed_merge_status: "mergeable",
          sha: null,
          merge_commit_sha: null,
          user_notes_count: 0,
          upvotes: 0,
          downvotes: 0,
          web_url: `${entry.project.web_url}/-/merge_requests/${entry.mrIid}`,
          references: {
            short: `!${entry.mrIid}`,
            relative: `!${entry.mrIid}`,
            full: `${entry.project.path_with_namespace}!${entry.mrIid}`,
          },
          time_stats: {
            time_estimate: 0,
            total_time_spent: 0,
            human_time_estimate: null,
            human_total_time_spent: null,
          },
        };
        entry.mrs.set(entry.mrIid, mr);
        return this.send(res, 201, clone(mr));
      }
      return this.send(res, 405, { message: "405 Method Not Allowed" });
    }

    const iid = Number(sub[0]);
    const mr = entry.mrs.get(iid);
    if (!mr) return this.send(res, 404, { message: "404 Not Found" });
    if (req.method === "GET") return this.send(res, 200, clone(mr));
    if (req.method === "PUT") {
      if (isPlainObject(body)) {
        if (typeof body.title === "string") mr.title = body.title;
        if (typeof body.description === "string") mr.description = body.description;
        if (body.state_event === "close") { mr.state = "closed"; mr.closed_at = now(); mr.closed_by = this._author(); }
        if (body.state_event === "reopen") { mr.state = "opened"; mr.closed_at = null; mr.closed_by = null; }
        mr.updated_at = now();
      }
      return this.send(res, 200, clone(mr));
    }
    return this.send(res, 405, { message: "405 Method Not Allowed" });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "projects") {
      return this.send(res, 200, { ids: [...this.projects.keys()], count: this.projects.size });
    }
    return this.send(res, 404, { message: "404 Not Found" });
  }

  root() {
    return {
      name: "gitlab",
      version: "1",
      protocol: "gitlab-v4",
      api_url: `http://${this.host}:${this.port}/api/v4`,
      documentation: "/docs/gitlab.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    if (typeof req.headers["private-token"] === "string" && req.headers["private-token"]) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        const ct = (req.headers["content-type"] || "").toLowerCase();
        if (ct.includes("application/x-www-form-urlencoded")) {
          const out = {};
          for (const [k, v] of new URLSearchParams(data)) out[k] = v;
          return resolve(out);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { message: "400 Bad Request", error: "invalid JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "400 Bad Request" });
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body, headers) {
    res.statusCode = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    }
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }

  // Offset-based pagination matching GitLab: honors `page`/`per_page` query
  // params, slices the collection, and emits the X-* pagination headers + Link.
  // Source: https://docs.gitlab.com/api/rest/#offset-based-pagination
  sendPaginated(req, res, items, query = {}) {
    const total = items.length;
    let perPage = Number.parseInt(query.per_page, 10);
    if (!Number.isFinite(perPage) || perPage < 1) perPage = 20;
    if (perPage > 100) perPage = 100;
    let page = Number.parseInt(query.page, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;

    const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
    const startIdx = (page - 1) * perPage;
    const slice = items.slice(startIdx, startIdx + perPage);

    const nextPage = page < totalPages ? page + 1 : "";
    const prevPage = page > 1 ? page - 1 : "";

    const headers = {
      "X-Total": String(total),
      "X-Total-Pages": String(totalPages),
      "X-Per-Page": String(perPage),
      "X-Page": String(page),
      "X-Next-Page": String(nextPage),
      "X-Prev-Page": String(prevPage),
    };

    const base = `http://${this.host}:${this.port}${req.url.split("?")[0]}`;
    const link = (p, rel) =>
      `<${base}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
    const links = [];
    if (page > 1) links.push(link(page - 1, "prev"));
    if (page < totalPages) links.push(link(page + 1, "next"));
    if (totalPages > 0) {
      links.push(link(1, "first"));
      links.push(link(totalPages, "last"));
    }
    if (links.length) headers.Link = links.join(", ");

    return this.send(res, 200, slice, headers);
  }
}
