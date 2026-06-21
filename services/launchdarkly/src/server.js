import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/launchdarkly — a tiny, dependency-free fake of the LaunchDarkly REST
// API plus a minimal SDK eval endpoint. Feature flags CRUD under a project,
// projects listing, and GET /sdk/eval/:envKey/users/:base64user.
// Header auth: Authorization: api-key. State is in-memory and ephemeral.
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

export class LaunchdarklyServer {
  constructor(port = 4816, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // projectKey -> Map(flagKey -> flag)
    this.projects = new Map();
    this._seedDefaults();
  }

  _seedDefaults() {
    const flags = new Map();
    flags.set("parlel-flag", this._makeFlag({
      key: "parlel-flag",
      name: "Parlel Flag",
      kind: "boolean",
      variations: [{ value: true }, { value: false }],
    }));
    this.projects.set("default", { key: "default", name: "Default Project", flags });
  }

  _makeFlag(input) {
    const variations = Array.isArray(input.variations) && input.variations.length
      ? input.variations.map((v) => (isPlainObject(v) && "value" in v ? clone(v) : { value: v }))
      : [{ value: true }, { value: false }];
    return {
      key: input.key,
      name: input.name || input.key,
      description: input.description || "",
      kind: input.kind || "boolean",
      variations,
      _version: 1,
      creationDate: Date.now(),
      environments: {
        production: { on: false, archived: false, lastModified: Date.now(), _version: 1 },
        test: { on: true, archived: false, lastModified: Date.now(), _version: 1 },
      },
      temporary: input.temporary !== false,
      tags: Array.isArray(input.tags) ? clone(input.tags) : [],
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message || "Internal server error" });
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-launchdarkly");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // SDK eval: GET /sdk/eval/:envKey/users/:base64user
    if (parts[0] === "sdk" && parts[1] === "eval") {
      return this.sdkEval(res, parts);
    }

    if (parts[0] === "api" && parts[1] === "v2") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, { message: "invalid auth token", code: "unauthorized" });
      }
      const route = parts.slice(2);
      if (route[0] === "projects") {
        return this.handleProjects(req, res, route, body);
      }
      if (route[0] === "flags") {
        return this.handleFlags(req, res, route, body);
      }
    }

    return this.send(res, 404, { message: "not found", code: "not_found" });
  }

  handleProjects(req, res, route, body) {
    // GET /api/v2/projects
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, {
        items: Array.from(this.projects.values()).map((p) => ({
          key: p.key,
          name: p.name,
          _links: { self: { href: `/api/v2/projects/${p.key}` } },
        })),
        _links: { self: { href: "/api/v2/projects" } },
      });
    }
    return this.send(res, 405, { message: "method not allowed", code: "method_not_allowed" });
  }

  handleFlags(req, res, route, body) {
    // /api/v2/flags/:projectKey [/ :featureFlagKey ]
    const projectKey = route[1];
    if (!projectKey) return this.send(res, 404, { message: "project not found", code: "not_found" });
    let project = this.projects.get(projectKey);

    // List / create.
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!project) return this.send(res, 404, { message: "project not found", code: "not_found" });
        return this.send(res, 200, {
          items: Array.from(project.flags.values()).map(clone),
          _links: { self: { href: `/api/v2/flags/${projectKey}` } },
        });
      }
      if (req.method === "POST") {
        if (!project) {
          project = { key: projectKey, name: projectKey, flags: new Map() };
          this.projects.set(projectKey, project);
        }
        if (!isPlainObject(body) || typeof body.key !== "string" || !body.key) {
          return this.send(res, 400, { message: "key is required", code: "invalid_request" });
        }
        if (project.flags.has(body.key)) {
          return this.send(res, 409, { message: "flag already exists", code: "conflict" });
        }
        const flag = this._makeFlag(body);
        project.flags.set(flag.key, flag);
        return this.send(res, 201, clone(flag));
      }
      return this.send(res, 405, { message: "method not allowed", code: "method_not_allowed" });
    }

    // /api/v2/flags/:projectKey/:featureFlagKey
    if (route.length === 3) {
      if (!project) return this.send(res, 404, { message: "project not found", code: "not_found" });
      const flagKey = route[2];
      const flag = project.flags.get(flagKey);
      if (!flag) return this.send(res, 404, { message: "feature flag not found", code: "not_found" });

      if (req.method === "GET") return this.send(res, 200, clone(flag));
      if (req.method === "PATCH" || req.method === "PUT") {
        // Support semantic patch ({ instructions }) and JSON merge for name/description.
        if (isPlainObject(body)) {
          if (typeof body.name === "string") flag.name = body.name;
          if (typeof body.description === "string") flag.description = body.description;
          if (Array.isArray(body.instructions)) {
            for (const instr of body.instructions) {
              if (!isPlainObject(instr)) continue;
              if (instr.kind === "turnFlagOn" && flag.environments[instr.environmentKey]) {
                flag.environments[instr.environmentKey].on = true;
              }
              if (instr.kind === "turnFlagOff" && flag.environments[instr.environmentKey]) {
                flag.environments[instr.environmentKey].on = false;
              }
            }
          }
          if (Array.isArray(body.patch)) {
            // RFC6902 patch (subset): replace /name
            for (const op of body.patch) {
              if (op.op === "replace" && op.path === "/name") flag.name = op.value;
              if (op.op === "replace" && op.path === "/description") flag.description = op.value;
            }
          }
          flag._version += 1;
        }
        return this.send(res, 200, clone(flag));
      }
      if (req.method === "DELETE") {
        project.flags.delete(flagKey);
        return this.send(res, 204, null);
      }
    }

    return this.send(res, 405, { message: "method not allowed", code: "method_not_allowed" });
  }

  sdkEval(res, parts) {
    // GET /sdk/eval/:envKey/users/:base64user
    const flagsOut = {};
    const project = this.projects.get("default");
    if (project) {
      for (const [key, flag] of project.flags.entries()) {
        const env = flag.environments.production || Object.values(flag.environments)[0];
        const value = env && env.on
          ? (flag.variations[0]?.value ?? true)
          : (flag.variations[flag.variations.length - 1]?.value ?? false);
        flagsOut[key] = {
          value,
          variation: env && env.on ? 0 : flag.variations.length - 1,
          version: flag._version,
          trackEvents: false,
        };
      }
    }
    return this.send(res, 200, flagsOut);
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "flags") {
      const out = {};
      for (const [pk, p] of this.projects.entries()) {
        out[pk] = Array.from(p.flags.values()).map(clone);
      }
      return this.send(res, 200, { projects: out });
    }
    return this.send(res, 404, { message: "not found", code: "not_found" });
  }

  root() {
    return { name: "launchdarkly", version: "1.0", protocol: "launchdarkly", documentation: "/docs/launchdarkly.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    // LaunchDarkly uses Authorization: <api-key> (no scheme prefix).
    const auth = req.headers.authorization || "";
    return typeof auth === "string" && auth.trim().length > 0;
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
          this.send(res, 400, { message: "Malformed JSON", code: "invalid_request" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Bad request body", code: "invalid_request" });
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
