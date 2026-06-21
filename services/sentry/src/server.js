import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/sentry — a dependency-free fake of the Sentry API.
//
// Covers the management API (/api/0/...) used by sentry-cli / dashboards and
// the event ingest endpoint (/api/:project_id/store/) used by the SDKs.
// State is in-memory, ephemeral and resettable; ingested events are captured.
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

function eventId() {
  return randomBytes(16).toString("hex");
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class SentryServer {
  constructor(port = 4773, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.orgs = new Map(); // slug -> org
    this.projects = new Map(); // key org/project -> project
    this.issues = new Map(); // key org/project -> Map issueId -> issue
    this.events = []; // captured ingested events
    this.issueCounter = 1000;
    this._seed();
  }

  _seed() {
    const orgSlug = "parlel";
    this.orgs.set(orgSlug, {
      id: "1",
      slug: orgSlug,
      name: "Parlel",
      dateCreated: now(),
    });
    this._createProject(orgSlug, "hello-world");
  }

  _createProject(orgSlug, projectSlug, opts = {}) {
    const id = String(this.projects.size + 1);
    const project = {
      id,
      slug: projectSlug,
      name: opts.name || projectSlug,
      platform: opts.platform || "node",
      dateCreated: now(),
      isPublic: false,
      status: "active",
      organization: this.orgs.get(orgSlug) ? clone(this.orgs.get(orgSlug)) : { slug: orgSlug },
    };
    const key = `${orgSlug}/${projectSlug}`;
    this.projects.set(key, project);
    if (!this.issues.has(key)) this.issues.set(key, new Map());
    return project;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { detail: error.message || "Internal Error" });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Sentry-Auth");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-sentry");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api") return this.send(res, 404, { detail: "Not found" });

    // Event ingest: POST /api/:project_id/store/  (auth via X-Sentry-Auth or DSN; lenient)
    if (parts[1] !== "0" && parts[2] === "store") {
      return this.handleStore(req, res, parts[1], body);
    }

    // Management API: /api/0/...
    if (parts[1] === "0") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, { detail: "Authentication credentials were not provided." });
      }
      return this.handleApi(req, res, parts.slice(2), body, url);
    }

    return this.send(res, 404, { detail: "Not found" });
  }

  // POST /api/:project_id/store/
  handleStore(req, res, projectId, body) {
    if (req.method !== "POST") return this.send(res, 405, { detail: "Method not allowed" });
    const id = eventId();
    const event = {
      event_id: id,
      project_id: projectId,
      received_at: now(),
      payload: clone(body),
    };
    this.events.push(event);

    // Also surface as an issue under the seeded project for listing.
    const key = "parlel/hello-world";
    if (this.issues.has(key) && isPlainObject(body)) {
      this.issueCounter += 1;
      const issueId = String(this.issueCounter);
      const message = body.message || body.exception?.values?.[0]?.value || "Captured event";
      this.issues.get(key).set(issueId, {
        id: issueId,
        shortId: `HELLO-WORLD-${issueId}`,
        title: typeof message === "string" ? message : "Captured event",
        culprit: body.transaction || null,
        level: body.level || "error",
        status: "unresolved",
        count: "1",
        firstSeen: now(),
        lastSeen: now(),
        metadata: { value: typeof message === "string" ? message : "Captured event" },
      });
    }

    return this.send(res, 200, { id });
  }

  handleApi(req, res, route, body, url) {
    // GET /api/0/organizations/:org/projects/
    if (route[0] === "organizations" && route[2] === "projects" && req.method === "GET") {
      const org = route[1];
      const list = [...this.projects.entries()]
        .filter(([key]) => key.startsWith(`${org}/`))
        .map(([, p]) => clone(p));
      return this.send(res, 200, list);
    }

    // /api/0/projects/:org/:project/...
    if (route[0] === "projects") {
      const org = route[1];
      const project = route[2];
      const rest = route.slice(3);
      const key = `${org}/${project}`;

      // GET/POST /api/0/projects/:org/:project/
      if (rest.length === 0) {
        if (req.method === "GET") {
          const proj = this.projects.get(key);
          if (!proj) return this.send(res, 404, { detail: "The requested resource does not exist" });
          return this.send(res, 200, clone(proj));
        }
        if (req.method === "POST") {
          if (this.projects.has(key)) return this.send(res, 200, clone(this.projects.get(key)));
          if (!this.orgs.has(org)) this.orgs.set(org, { id: org, slug: org, name: org });
          const proj = this._createProject(org, project, isPlainObject(body) ? body : {});
          return this.send(res, 201, clone(proj));
        }
        return this.send(res, 405, { detail: "Method not allowed" });
      }

      // GET /api/0/projects/:org/:project/issues/
      if (rest[0] === "issues" && req.method === "GET") {
        const issues = this.issues.get(key);
        if (!issues) return this.send(res, 404, { detail: "The requested resource does not exist" });
        return this.send(res, 200, [...issues.values()].map(clone));
      }
    }

    return this.send(res, 404, { detail: "The requested resource does not exist" });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "events") {
      return this.send(res, 200, { events: clone(this.events), count: this.events.length });
    }
    return this.send(res, 404, { detail: "Not found" });
  }

  root() {
    return {
      name: "sentry",
      version: "1",
      protocol: "sentry-api",
      api_url: `http://${this.host}:${this.port}/api/0`,
      documentation: "/docs/sentry.md",
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
          this.send(res, 400, { detail: "Invalid JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { detail: "Invalid JSON" });
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
