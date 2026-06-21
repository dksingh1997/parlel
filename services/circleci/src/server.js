import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/circleci — a tiny, dependency-free fake of the CircleCI API v2.
//
// Speaks the wire protocol used by the official CircleCI REST API v2 so that
// application code and AI agents can run against it with zero cost. State is
// in-memory, ephemeral, and deterministic.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

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

// Deterministic uuid derived from a seed string (so ids are stable per run).
function seededUuid(seed) {
  const h = createHash("sha256").update(seed).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "4" + h.slice(13, 16),
    "8" + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

function ccError(message) {
  return { message };
}

export class CircleciServer {
  constructor(port = 4876, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.pipelines = new Map();
    this.workflows = new Map();
    this.jobs = new Map();
    this.pipelineCounter = 0;
    this.idSeed = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, ccError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Circle-Token, Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-circleci");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api" || parts[1] !== "v2") {
      return this.send(res, 404, ccError("Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, ccError("Authentication failed."));
    }

    const route = parts.slice(2);

    // GET /api/v2/me
    if (req.method === "GET" && route[0] === "me" && route.length === 1) {
      return this.send(res, 200, {
        id: seededUuid("me"),
        login: "parlel",
        name: "Parlel CI User",
      });
    }

    // GET /api/v2/project/:project-slug
    // POST /api/v2/project/:project-slug/pipeline
    if (route[0] === "project") {
      // project slug is gh/org/repo -> route[1], route[2], route[3]
      const slugParts = route.slice(1);
      // The trailing "pipeline" is the action; the slug is everything before it.
      if (slugParts[slugParts.length - 1] === "pipeline" && req.method === "POST") {
        const slug = slugParts.slice(0, -1).join("/");
        return this.createPipeline(res, slug, body);
      }
      if (slugParts[slugParts.length - 1] === "pipeline" && req.method === "GET") {
        const slug = slugParts.slice(0, -1).join("/");
        const items = Array.from(this.pipelines.values()).filter((p) => p.project_slug === slug);
        return this.send(res, 200, { items: items.map(clone), next_page_token: null });
      }
      // GET /api/v2/project/:project-slug (metadata)
      if (req.method === "GET") {
        const slug = slugParts.join("/");
        const [vcs = "gh", org = "parlel", repo = "demo"] = slugParts;
        return this.send(res, 200, {
          slug,
          name: repo,
          id: seededUuid("project:" + slug),
          organization_name: org,
          organization_slug: `${vcs}/${org}`,
          organization_id: seededUuid("org:" + org),
          vcs_info: {
            vcs_url: `https://github.com/${org}/${repo}`,
            provider: vcs === "gh" ? "GitHub" : "Bitbucket",
            default_branch: "main",
          },
        });
      }
    }

    // GET /api/v2/pipeline/:id
    // GET /api/v2/pipeline/:id/workflow
    if (route[0] === "pipeline") {
      const id = route[1];
      if (route[2] === "workflow" && req.method === "GET") {
        const items = Array.from(this.workflows.values()).filter((w) => w.pipeline_id === id);
        return this.send(res, 200, { items: items.map(clone), next_page_token: null });
      }
      if (route.length === 2 && req.method === "GET") {
        const pipeline = this.pipelines.get(id);
        if (!pipeline) return this.send(res, 404, ccError("Pipeline not found"));
        return this.send(res, 200, clone(pipeline));
      }
    }

    // GET /api/v2/workflow/:id
    if (route[0] === "workflow") {
      const id = route[1];
      if (route[2] === "job" && req.method === "GET") {
        const items = Array.from(this.jobs.values()).filter((j) => j.workflow_id === id);
        return this.send(res, 200, { items: items.map(clone), next_page_token: null });
      }
      if (route.length === 2 && req.method === "GET") {
        const workflow = this.workflows.get(id);
        if (!workflow) return this.send(res, 404, ccError("Workflow not found"));
        return this.send(res, 200, clone(workflow));
      }
    }

    return this.send(res, 404, ccError("Not Found"));
  }

  createPipeline(res, slug, body) {
    this.pipelineCounter += 1;
    this.idSeed += 1;
    const number = this.pipelineCounter;
    const id = seededUuid(`pipeline:${slug}:${number}`);
    const created_at = now();
    const branch = (isPlainObject(body) && body.branch) || "main";
    const pipeline = {
      id,
      state: "created",
      number,
      created_at,
      updated_at: created_at,
      project_slug: slug,
      vcs: { branch, revision: createHash("sha1").update(id).digest("hex") },
      trigger: { type: "api", actor: { login: "parlel" } },
    };
    this.pipelines.set(id, pipeline);

    // Spawn a deterministic workflow + job for the pipeline.
    const workflowId = seededUuid(`workflow:${id}`);
    const workflow = {
      id: workflowId,
      name: "build-and-test",
      status: "success",
      pipeline_id: id,
      pipeline_number: number,
      project_slug: slug,
      created_at,
      stopped_at: created_at,
    };
    this.workflows.set(workflowId, workflow);

    const jobId = seededUuid(`job:${workflowId}`);
    this.jobs.set(jobId, {
      id: jobId,
      workflow_id: workflowId,
      name: "build",
      status: "success",
      type: "build",
      job_number: 1,
    });

    return this.send(res, 201, { id, state: "created", number, created_at });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, ccError("not found"));
  }

  root() {
    return {
      name: "circleci",
      version: "2",
      protocol: "circleci-v2",
      documentation: "/docs/circleci.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const token = req.headers["circle-token"];
    if (typeof token === "string" && token.length > 0) return true;
    // Some clients send it as a Basic auth username.
    const auth = req.headers.authorization || "";
    return /^Basic\s+\S+/i.test(auth);
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
          this.send(res, 400, ccError("Invalid JSON body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, ccError("Invalid JSON body"));
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
