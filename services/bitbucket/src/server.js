import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/bitbucket — a dependency-free fake of the Bitbucket Cloud API 2.0.
//
// Speaks the wire protocol used by raw REST clients and the bitbucket Node SDK
// so application code and AI agents can run against it with zero cost and zero
// side effects. State is in-memory, ephemeral and resettable. Collections use
// the paginated envelope { values, page, size, pagelen }.
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

function paginate(values) {
  return { values, page: 1, size: values.length, pagelen: 10 };
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class BitbucketServer {
  constructor(port = 4769, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.repos = new Map(); // key: workspace/slug
    this.workspace = "parlel-team";
    this.user = {
      type: "user",
      uuid: "{11111111-1111-1111-1111-111111111111}",
      username: "parlel-user",
      display_name: "Parlel User",
      nickname: "parlel",
      account_id: "parlel:0001",
      links: { self: { href: `https://api.bitbucket.org/2.0/users/parlel-user` } },
    };
    this._createRepo(this.workspace, "hello-world", { description: "Seeded repo" });
  }

  _repoObj(workspace, slug, opts = {}) {
    const fullName = `${workspace}/${slug}`;
    return {
      type: "repository",
      uuid: `{${randomUUID()}}`,
      name: opts.name || slug,
      full_name: fullName,
      slug,
      description: opts.description || "",
      is_private: opts.is_private !== false,
      fork_policy: "allow_forks",
      created_on: now(),
      updated_on: now(),
      mainbranch: { type: "branch", name: opts.mainbranch?.name || "main" },
      workspace: { type: "workspace", slug: workspace, name: workspace },
      scm: "git",
      links: { self: { href: `https://api.bitbucket.org/2.0/repositories/${fullName}` }, html: { href: `https://bitbucket.org/${fullName}` } },
    };
  }

  _createRepo(workspace, slug, opts = {}) {
    const repo = this._repoObj(workspace, slug, opts);
    this.repos.set(`${workspace}/${slug}`, { repo, pulls: new Map(), prCounter: 0 });
    return repo;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { type: "error", error: { message: error.message || "Internal server error" } });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-bitbucket");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "2.0") return this.send(res, 404, this.notFound());

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { type: "error", error: { message: "Access token expired or invalid." } });
    }

    const route = parts.slice(1);

    if (route[0] === "user" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, clone(this.user));
    }

    if (route[0] === "repositories") {
      return this.handleRepositories(req, res, route.slice(1), body);
    }

    return this.send(res, 404, this.notFound());
  }

  handleRepositories(req, res, route, body) {
    // /2.0/repositories/:workspace
    if (route.length === 1) {
      const workspace = route[0];
      if (req.method === "GET") {
        const values = [...this.repos.values()]
          .filter((r) => r.repo.workspace.slug === workspace)
          .map((r) => clone(r.repo));
        return this.send(res, 200, paginate(values));
      }
      return this.send(res, 405, this.notFound());
    }

    const workspace = route[0];
    const slug = route[1];
    const key = `${workspace}/${slug}`;

    // /2.0/repositories/:workspace/:repo
    if (route.length === 2) {
      if (req.method === "GET") {
        const entry = this.repos.get(key);
        if (!entry) return this.send(res, 404, this.notFound());
        return this.send(res, 200, clone(entry.repo));
      }
      if (req.method === "POST" || req.method === "PUT") {
        if (this.repos.has(key)) {
          const entry = this.repos.get(key);
          if (isPlainObject(body)) {
            if (typeof body.description === "string") entry.repo.description = body.description;
            entry.repo.updated_on = now();
          }
          return this.send(res, 200, clone(entry.repo));
        }
        const repo = this._createRepo(workspace, slug, body || {});
        return this.send(res, 201, clone(repo));
      }
      if (req.method === "DELETE") {
        this.repos.delete(key);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, this.notFound());
    }

    const entry = this.repos.get(key);
    if (!entry) return this.send(res, 404, this.notFound());

    // /2.0/repositories/:workspace/:repo/pullrequests
    if (route[2] === "pullrequests") {
      return this.handlePullRequests(req, res, entry, route.slice(3), body, workspace, slug);
    }

    return this.send(res, 404, this.notFound());
  }

  handlePullRequests(req, res, entry, sub, body, workspace, slug) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, paginate([...entry.pulls.values()].map(clone)));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.title !== "string" || !body.title) {
          return this.send(res, 400, { type: "error", error: { fields: { title: ["required"] }, message: "title is required" } });
        }
        entry.prCounter += 1;
        const id = entry.prCounter;
        const pr = {
          type: "pullrequest",
          id,
          title: body.title,
          description: typeof body.description === "string" ? body.description : "",
          state: "OPEN",
          author: { type: "user", uuid: this.user.uuid, display_name: this.user.display_name, nickname: this.user.nickname },
          source: { branch: { name: body.source?.branch?.name || "feature" } },
          destination: { branch: { name: body.destination?.branch?.name || entry.repo.mainbranch.name } },
          created_on: now(),
          updated_on: now(),
          comment_count: 0,
          task_count: 0,
          close_source_branch: Boolean(body.close_source_branch),
          links: {
            self: { href: `https://api.bitbucket.org/2.0/repositories/${workspace}/${slug}/pullrequests/${id}` },
            html: { href: `https://bitbucket.org/${workspace}/${slug}/pull-requests/${id}` },
          },
        };
        entry.pulls.set(id, pr);
        return this.send(res, 201, clone(pr));
      }
      return this.send(res, 405, this.notFound());
    }

    const id = Number(sub[0]);
    const pr = entry.pulls.get(id);
    if (!pr) return this.send(res, 404, this.notFound());
    if (req.method === "GET") return this.send(res, 200, clone(pr));
    if (req.method === "PUT") {
      if (isPlainObject(body)) {
        if (typeof body.title === "string") pr.title = body.title;
        if (typeof body.description === "string") pr.description = body.description;
        pr.updated_on = now();
      }
      return this.send(res, 200, clone(pr));
    }
    return this.send(res, 405, this.notFound());
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "repos") {
      return this.send(res, 200, { repos: [...this.repos.keys()], count: this.repos.size });
    }
    return this.send(res, 404, this.notFound());
  }

  notFound() {
    return { type: "error", error: { message: "Resource not found" } };
  }

  root() {
    return {
      name: "bitbucket",
      version: "1",
      protocol: "bitbucket-2.0",
      api_url: `http://${this.host}:${this.port}/2.0`,
      documentation: "/docs/bitbucket.md",
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
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { type: "error", error: { message: "Invalid JSON" } });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { type: "error", error: { message: "Invalid JSON" } });
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
