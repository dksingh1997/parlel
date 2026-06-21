import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/github — a dependency-free fake of the GitHub REST v3 + GraphQL API.
//
// Speaks the wire protocol used by @octokit/rest and the gh CLI so application
// code and AI agents can run against it with zero cost and zero side effects.
// State is in-memory, ephemeral and resettable. Response shapes are faithful
// to GitHub v3 (id, node_id, html_url, owner objects, etc.).
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

function nodeId(kind, id) {
  return Buffer.from(`010:${kind}${id}`).toString("base64");
}

function ghError(message, status = 422, errors) {
  const body = { message, documentation_url: "https://docs.github.com/rest" };
  if (errors) body.errors = errors;
  return body;
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class GithubServer {
  constructor(port = 4767, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.idCounter = 1000;
    this.repos = new Map(); // key: owner/name
    this.user = {
      login: "parlel-user",
      id: 1,
      node_id: nodeId("User", 1),
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      html_url: "https://github.com/parlel-user",
      type: "User",
      name: "Parlel User",
      company: "Parlel",
      public_repos: 0,
      followers: 0,
      following: 0,
      created_at: now(),
      updated_at: now(),
    };
    // Seed a default repo.
    this._createRepo("parlel-user", "hello-world", { description: "Seeded repo", private: false });
  }

  _nextId() {
    this.idCounter += 1;
    return this.idCounter;
  }

  _ownerObj(login) {
    return {
      login,
      id: login === this.user.login ? this.user.id : (this._loginIds ||= new Map()).get(login) || this._assignLoginId(login),
      node_id: nodeId("User", login),
      avatar_url: `https://avatars.githubusercontent.com/${login}`,
      html_url: `https://github.com/${login}`,
      type: "User",
    };
  }

  _assignLoginId(login) {
    this._loginIds ||= new Map();
    const id = this._nextId();
    this._loginIds.set(login, id);
    return id;
  }

  _createRepo(owner, name, opts = {}) {
    const id = this._nextId();
    const repo = {
      id,
      node_id: nodeId("Repository", id),
      name,
      full_name: `${owner}/${name}`,
      private: Boolean(opts.private),
      owner: this._ownerObj(owner),
      html_url: `https://github.com/${owner}/${name}`,
      description: opts.description || null,
      fork: false,
      url: `https://api.github.com/repos/${owner}/${name}`,
      default_branch: "main",
      visibility: opts.private ? "private" : "public",
      created_at: now(),
      updated_at: now(),
      pushed_at: now(),
      stargazers_count: 0,
      watchers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
    };
    this.repos.set(`${owner}/${name}`, {
      repo,
      issues: new Map(),
      pulls: new Map(),
      issueCounter: 0,
      contents: new Map(),
    });
    return repo;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, ghError(error.message || "Internal server error", 500));
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
    res.setHeader("X-GitHub-Media-Type", "github.v3; format=json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-github");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] === "graphql") {
      if (!this.isAuthorized(req)) return this.unauthorized(res);
      return this.handleGraphql(req, res, body);
    }

    if (!this.isAuthorized(req)) return this.unauthorized(res);

    // GET /user
    if (req.method === "GET" && parts[0] === "user" && parts.length === 1) {
      this.user.public_repos = this.repos.size;
      return this.send(res, 200, clone(this.user));
    }

    // GET /user/repos  | POST /user/repos (create authenticated user repo)
    if (parts[0] === "user" && parts[1] === "repos" && parts.length === 2) {
      if (req.method === "GET") {
        const owned = [...this.repos.values()]
          .filter((r) => r.repo.owner.login === this.user.login)
          .map((r) => clone(r.repo));
        return this.send(res, 200, owned);
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 422, ghError("Repository creation failed.", 422, [
            { resource: "Repository", field: "name", code: "missing_field" },
          ]));
        }
        const key = `${this.user.login}/${body.name}`;
        if (this.repos.has(key)) {
          return this.send(res, 422, ghError("Repository creation failed.", 422, [
            { resource: "Repository", field: "name", code: "custom", message: "name already exists on this account" },
          ]));
        }
        const repo = this._createRepo(this.user.login, body.name, body);
        return this.send(res, 201, clone(repo));
      }
    }

    // /repos/:owner/:repo/...
    if (parts[0] === "repos") {
      return this.handleRepos(req, res, parts.slice(1), body, url);
    }

    return this.send(res, 404, ghError("Not Found", 404));
  }

  handleRepos(req, res, route, body, url) {
    const [owner, name, ...rest] = route;
    if (!owner || !name) return this.send(res, 404, ghError("Not Found", 404));
    const key = `${owner}/${name}`;

    // GET/PATCH /repos/:owner/:repo
    if (rest.length === 0) {
      if (req.method === "GET") {
        const entry = this.repos.get(key);
        if (!entry) return this.send(res, 404, ghError("Not Found", 404));
        return this.send(res, 200, clone(entry.repo));
      }
      // Real GitHub has no "create repo by path" endpoint. Repo creation is
      // POST /user/repos or POST /orgs/:org/repos; POST /repos/:owner/:repo 404s.
      if (req.method === "PATCH") {
        const entry = this.repos.get(key);
        if (!entry) return this.send(res, 404, ghError("Not Found", 404));
        if (isPlainObject(body)) {
          if (typeof body.description === "string") entry.repo.description = body.description;
          if (typeof body.private === "boolean") entry.repo.private = body.private;
          if (typeof body.default_branch === "string") entry.repo.default_branch = body.default_branch;
          entry.repo.updated_at = now();
        }
        return this.send(res, 200, clone(entry.repo));
      }
      // No POST/other method on /repos/:owner/:repo — real API 404s here.
      return this.send(res, 404, ghError("Not Found", 404));
    }

    const entry = this.repos.get(key);
    if (!entry) return this.send(res, 404, ghError("Not Found", 404));

    // Issues
    if (rest[0] === "issues") {
      return this.handleIssues(req, res, entry, rest.slice(1), body, owner, name);
    }
    // Pulls
    if (rest[0] === "pulls") {
      return this.handlePulls(req, res, entry, rest.slice(1), body, owner, name);
    }
    // Contents
    if (rest[0] === "contents") {
      const filePath = rest.slice(1).join("/");
      return this.handleContents(req, res, entry, filePath, body, owner, name);
    }

    return this.send(res, 404, ghError("Not Found", 404));
  }

  _issueObj(entry, owner, name, data) {
    entry.issueCounter += 1;
    const id = this._nextId();
    const number = entry.issueCounter;
    const base = `https://api.github.com/repos/${owner}/${name}/issues/${number}`;
    return {
      id,
      node_id: nodeId("Issue", id),
      url: base,
      repository_url: `https://api.github.com/repos/${owner}/${name}`,
      labels_url: `${base}/labels{/name}`,
      comments_url: `${base}/comments`,
      events_url: `${base}/events`,
      html_url: `https://github.com/${owner}/${name}/issues/${number}`,
      number,
      state: "open",
      state_reason: null,
      title: data.title,
      body: typeof data.body === "string" ? data.body : null,
      user: this._ownerObj(this.user.login),
      labels: Array.isArray(data.labels)
        ? data.labels.map((l) => (typeof l === "string" ? { name: l } : l))
        : [],
      assignee: null,
      assignees: [],
      milestone: null,
      locked: false,
      active_lock_reason: null,
      comments: 0,
      pull_request: undefined,
      closed_at: null,
      created_at: now(),
      updated_at: now(),
      author_association: "OWNER",
      timeline_url: `${base}/timeline`,
      reactions: {
        url: `${base}/reactions`,
        total_count: 0,
        "+1": 0,
        "-1": 0,
        laugh: 0,
        hooray: 0,
        confused: 0,
        heart: 0,
        rocket: 0,
        eyes: 0,
      },
    };
  }

  handleIssues(req, res, entry, sub, body, owner, name) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        const list = [...entry.issues.values()]
          .filter((i) => !i._pull) // issues endpoint returns issues (PRs technically appear, but keep separate)
          .map(clone);
        return this.send(res, 200, list);
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.title !== "string" || !body.title) {
          return this.send(res, 422, ghError("Validation Failed", 422, [
            { resource: "Issue", field: "title", code: "missing_field" },
          ]));
        }
        const issue = this._issueObj(entry, owner, name, body);
        entry.issues.set(issue.number, issue);
        entry.repo.open_issues_count += 1;
        return this.send(res, 201, clone(issue));
      }
      return this.send(res, 405, ghError("Method Not Allowed", 405));
    }

    const number = Number(sub[0]);
    const issue = entry.issues.get(number);
    if (!issue) return this.send(res, 404, ghError("Not Found", 404));

    if (req.method === "GET") return this.send(res, 200, clone(issue));
    if (req.method === "PATCH") {
      if (isPlainObject(body)) {
        if (typeof body.title === "string") issue.title = body.title;
        if (typeof body.body === "string") issue.body = body.body;
        if (body.state === "open" || body.state === "closed") {
          if (issue.state !== body.state) {
            if (body.state === "closed") {
              issue.closed_at = now();
              issue.state_reason = body.state_reason || "completed";
              entry.repo.open_issues_count = Math.max(0, entry.repo.open_issues_count - 1);
            } else {
              issue.closed_at = null;
              issue.state_reason = null;
              entry.repo.open_issues_count += 1;
            }
          }
          issue.state = body.state;
        }
        issue.updated_at = now();
      }
      return this.send(res, 200, clone(issue));
    }
    return this.send(res, 405, ghError("Method Not Allowed", 405));
  }

  _pullObj(entry, owner, name, data) {
    entry.issueCounter += 1;
    const id = this._nextId();
    const number = entry.issueCounter;
    return {
      id,
      node_id: nodeId("PullRequest", id),
      number,
      state: "open",
      locked: false,
      title: data.title,
      user: this._ownerObj(this.user.login),
      body: typeof data.body === "string" ? data.body : null,
      html_url: `https://github.com/${owner}/${name}/pull/${number}`,
      url: `https://api.github.com/repos/${owner}/${name}/pulls/${number}`,
      head: { ref: data.head || "feature", sha: randomBytes(20).toString("hex") },
      base: { ref: data.base || entry.repo.default_branch, sha: randomBytes(20).toString("hex") },
      merged: false,
      mergeable: true,
      draft: Boolean(data.draft),
      comments: 0,
      commits: 1,
      additions: 0,
      deletions: 0,
      changed_files: 0,
      created_at: now(),
      updated_at: now(),
      closed_at: null,
      merged_at: null,
    };
  }

  handlePulls(req, res, entry, sub, body, owner, name) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, [...entry.pulls.values()].map(clone));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.title !== "string" || !body.title) {
          return this.send(res, 422, ghError("Validation Failed", 422, [
            { resource: "PullRequest", field: "title", code: "missing_field" },
          ]));
        }
        const pull = this._pullObj(entry, owner, name, body);
        entry.pulls.set(pull.number, pull);
        return this.send(res, 201, clone(pull));
      }
      return this.send(res, 405, ghError("Method Not Allowed", 405));
    }

    const number = Number(sub[0]);
    const pull = entry.pulls.get(number);
    if (!pull) return this.send(res, 404, ghError("Not Found", 404));

    if (req.method === "GET") return this.send(res, 200, clone(pull));
    if (req.method === "PATCH") {
      if (isPlainObject(body)) {
        if (typeof body.title === "string") pull.title = body.title;
        if (typeof body.body === "string") pull.body = body.body;
        if (body.state === "open" || body.state === "closed") pull.state = body.state;
        pull.updated_at = now();
      }
      return this.send(res, 200, clone(pull));
    }
    return this.send(res, 405, ghError("Method Not Allowed", 405));
  }

  handleContents(req, res, entry, filePath, body, owner, name) {
    if (req.method === "GET") {
      const stored = entry.contents.get(filePath);
      if (!stored) return this.send(res, 404, ghError("Not Found", 404));
      return this.send(res, 200, clone(stored));
    }
    if (req.method === "PUT") {
      // Create or update file contents. Real API requires BOTH `message` and
      // `content`; omitting either returns 422 Invalid request.
      if (!isPlainObject(body) || typeof body.content !== "string" || typeof body.message !== "string" || !body.message) {
        return this.send(res, 422, ghError("Invalid request.\n\nFor 'links/0/schema', nil is not an object.", 422));
      }
      const existing = entry.contents.get(filePath);
      const raw = Buffer.from(body.content, "base64");
      const sha = createHash("sha1").update(raw).digest("hex");
      const branch = entry.repo.default_branch;
      const contentUrl = `https://api.github.com/repos/${owner}/${name}/contents/${filePath}`;
      const gitUrl = `https://api.github.com/repos/${owner}/${name}/git/blobs/${sha}`;
      const htmlUrl = `https://github.com/${owner}/${name}/blob/${branch}/${filePath}`;
      const content = {
        type: "file",
        name: filePath.split("/").pop(),
        path: filePath,
        sha,
        size: raw.length,
        content: body.content,
        encoding: "base64",
        url: contentUrl,
        git_url: gitUrl,
        html_url: htmlUrl,
        download_url: `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${filePath}`,
        _links: {
          self: contentUrl,
          git: gitUrl,
          html: htmlUrl,
        },
      };
      entry.contents.set(filePath, content);
      const commitSha = randomBytes(20).toString("hex");
      const treeSha = randomBytes(20).toString("hex");
      const author = {
        name: this.user.name,
        email: `${this.user.login}@parlel.dev`,
        date: now(),
      };
      const commit = {
        sha: commitSha,
        node_id: nodeId("Commit", commitSha),
        url: `https://api.github.com/repos/${owner}/${name}/git/commits/${commitSha}`,
        html_url: `https://github.com/${owner}/${name}/commit/${commitSha}`,
        author,
        committer: author,
        message: body.message,
        tree: {
          sha: treeSha,
          url: `https://api.github.com/repos/${owner}/${name}/git/trees/${treeSha}`,
        },
        parents: existing
          ? [{
              sha: randomBytes(20).toString("hex"),
              url: `https://api.github.com/repos/${owner}/${name}/git/commits/parent`,
              html_url: `https://github.com/${owner}/${name}/commit/parent`,
            }]
          : [],
        verification: {
          verified: false,
          reason: "unsigned",
          signature: null,
          payload: null,
        },
      };
      return this.send(res, existing ? 200 : 201, { content: clone(content), commit });
    }
    return this.send(res, 405, ghError("Method Not Allowed", 405));
  }

  // -------------------------------------------------------------------------
  // Minimal but real GraphQL handler covering viewer + repository basics.
  // -------------------------------------------------------------------------
  handleGraphql(req, res, body) {
    if (!isPlainObject(body) || typeof body.query !== "string") {
      return this.send(res, 400, { errors: [{ message: "A query attribute must be specified and must be a string." }] });
    }
    const query = body.query;
    const data = {};

    if (/viewer\s*\{/.test(query)) {
      const viewer = {};
      if (/\blogin\b/.test(query)) viewer.login = this.user.login;
      if (/\bid\b/.test(query)) viewer.id = this.user.node_id;
      if (/\bname\b/.test(query)) viewer.name = this.user.name;
      if (/\bemail\b/.test(query)) viewer.email = `${this.user.login}@parlel.dev`;
      if (Object.keys(viewer).length === 0) viewer.login = this.user.login;
      data.viewer = viewer;
    }

    // repository(owner: "x", name: "y") { name ... }
    const repoMatch = query.match(/repository\s*\(\s*owner:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*\)/);
    if (repoMatch) {
      const key = `${repoMatch[1]}/${repoMatch[2]}`;
      const entry = this.repos.get(key);
      data.repository = entry
        ? {
            id: entry.repo.node_id,
            name: entry.repo.name,
            nameWithOwner: entry.repo.full_name,
            description: entry.repo.description,
            url: entry.repo.html_url,
            isPrivate: entry.repo.private,
          }
        : null;
    }

    if (Object.keys(data).length === 0) {
      return this.send(res, 200, { data: null, errors: [{ message: "Unsupported query in parlel GitHub GraphQL fake." }] });
    }
    return this.send(res, 200, { data });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "repos") {
      return this.send(res, 200, { repos: [...this.repos.keys()], count: this.repos.size });
    }
    return this.send(res, 404, ghError("Not Found", 404));
  }

  root() {
    return {
      name: "github",
      version: "1",
      protocol: "github-v3",
      current_user_url: `http://${this.host}:${this.port}/user`,
      graphql_url: `http://${this.host}:${this.port}/graphql`,
      documentation: "/docs/github.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth) || /^token\s+\S+/i.test(auth);
  }

  unauthorized(res) {
    return this.send(res, 401, ghError("Requires authentication", 401));
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, ghError("Problems parsing JSON", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, ghError("Problems parsing JSON", 400));
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
