import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/vercel — a dependency-free fake of the Vercel REST API.
//
// Speaks the wire protocol used by the @vercel/client and raw Vercel REST API
// (versioned paths like /v9/projects, /v13/deployments, /v6/deployments,
// /v2/user). State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function genId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function vercelError(code, message, status = 400) {
  return { error: { code, message } };
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class VercelServer {
  constructor(port = 4770, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.projects = new Map(); // id -> project
    this.deployments = new Map(); // id -> deployment
    this.user = {
      uid: "parlel_user_0001",
      id: "parlel_user_0001",
      email: "parlel-user@parlel.dev",
      name: "Parlel User",
      username: "parlel-user",
      avatar: null,
      version: "northstar",
    };
    this._createProject({ name: "hello-world" });
  }

  _createProject(opts = {}) {
    const id = genId("prj");
    const ts = Date.now();
    const project = {
      id,
      name: opts.name,
      accountId: this.user.uid,
      createdAt: ts,
      updatedAt: ts,
      framework: opts.framework || null,
      latestDeployments: [],
      targets: {},
      live: false,
      nodeVersion: "20.x",
    };
    this.projects.set(id, project);
    this._projectByName ||= new Map();
    this._projectByName.set(opts.name, id);
    return project;
  }

  _createDeployment(opts = {}) {
    const id = genId("dpl");
    const ts = Date.now();
    const name = opts.name || "hello-world";
    const url = `${name}-${randomBytes(4).toString("hex")}.vercel.app`;
    const deployment = {
      id,
      uid: id,
      name,
      url,
      readyState: "READY",
      state: "READY",
      type: "LAMBDAS",
      createdAt: ts,
      created: ts,
      buildingAt: ts,
      ready: ts,
      creator: { uid: this.user.uid, username: this.user.username },
      target: opts.target || null,
      inspectorUrl: `https://vercel.com/${this.user.username}/${name}/${id}`,
      meta: opts.meta || {},
    };
    this.deployments.set(id, deployment);
    return deployment;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, vercelError("internal_server_error", error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-vercel");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 403, vercelError("forbidden", "Not authorized"));
    }

    const version = parts[0]; // v9, v13, v6, v2
    const resource = parts[1];

    // GET /v2/user
    if (version === "v2" && resource === "user" && req.method === "GET") {
      return this.send(res, 200, { user: clone(this.user) });
    }

    // Projects (v9/v10)
    if (resource === "projects") {
      return this.handleProjects(req, res, parts.slice(2), body);
    }

    // Deployments
    if (resource === "deployments") {
      if (version === "v13" && req.method === "POST" && parts.length === 2) {
        return this.createDeployment(res, body);
      }
      if (req.method === "GET" && parts.length === 2) {
        return this.listDeployments(res);
      }
      if (req.method === "GET" && parts.length === 3) {
        const dep = this.deployments.get(parts[2]) || [...this.deployments.values()].find((d) => d.url === parts[2]);
        if (!dep) return this.send(res, 404, vercelError("not_found", "Deployment not found"));
        return this.send(res, 200, clone(dep));
      }
    }

    return this.send(res, 404, vercelError("not_found", "The requested resource could not be found"));
  }

  handleProjects(req, res, sub, body) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, {
          projects: [...this.projects.values()].map(clone),
          pagination: { count: this.projects.size, next: null, prev: null },
        });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 400, vercelError("bad_request", "The `name` field is required"));
        }
        const project = this._createProject(body);
        return this.send(res, 200, clone(project));
      }
      return this.send(res, 405, vercelError("method_not_allowed", "Method not allowed"));
    }

    // /:idOrName
    const idOrName = sub[0];
    const id = this.projects.has(idOrName)
      ? idOrName
      : (this._projectByName && this._projectByName.get(idOrName));
    const project = id ? this.projects.get(id) : undefined;
    if (!project) return this.send(res, 404, vercelError("not_found", "Project not found"));

    if (req.method === "GET") return this.send(res, 200, clone(project));
    if (req.method === "PATCH") {
      if (isPlainObject(body)) {
        if (typeof body.name === "string") project.name = body.name;
        if (typeof body.framework === "string") project.framework = body.framework;
        project.updatedAt = Date.now();
      }
      return this.send(res, 200, clone(project));
    }
    if (req.method === "DELETE") {
      this.projects.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, vercelError("method_not_allowed", "Method not allowed"));
  }

  createDeployment(res, body) {
    if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
      return this.send(res, 400, vercelError("bad_request", "The `name` field is required"));
    }
    const deployment = this._createDeployment(body);
    return this.send(res, 200, clone(deployment));
  }

  listDeployments(res) {
    const deployments = [...this.deployments.values()].sort((a, b) => b.createdAt - a.createdAt).map(clone);
    return this.send(res, 200, { deployments, pagination: { count: deployments.length, next: null, prev: null } });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, vercelError("not_found", "Not found"));
  }

  root() {
    return {
      name: "vercel",
      version: "1",
      protocol: "vercel-rest",
      api_url: `http://${this.host}:${this.port}`,
      documentation: "/docs/vercel.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, vercelError("bad_request", "Invalid JSON body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, vercelError("bad_request", "Invalid JSON body"));
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
