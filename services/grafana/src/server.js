import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/grafana — a tiny, dependency-free fake of the Grafana HTTP API.
//
// Speaks the Grafana HTTP API surface (dashboards, datasources, org, health).
// State is in-memory and ephemeral. Note: there are two distinct health
// endpoints — the parlel infra `GET /health` and the real Grafana
// `GET /api/health`. Both are kept (different paths).
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

function slugify(title) {
  return String(title || "dashboard")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "dashboard";
}

export class GrafanaServer {
  constructor(port = 4879, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.dashboards = new Map(); // uid -> { dashboard, meta }
    this.datasources = new Map(); // id -> datasource
    this.dashboardIdCounter = 0;
    this.datasourceIdCounter = 0;
    this.org = { id: 1, name: "Parlel Org" };
    this._seedDefaults();
  }

  _seedDefaults() {
    this.datasourceIdCounter += 1;
    const id = this.datasourceIdCounter;
    this.datasources.set(id, {
      id,
      uid: "parlel-prom",
      orgId: 1,
      name: "Prometheus",
      type: "prometheus",
      access: "proxy",
      url: "http://127.0.0.1:9090",
      isDefault: true,
    });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-grafana");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // parlel infra root + health (distinct from Grafana's /api/health).
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health" && parts.length === 1) {
      return this.send(res, 200, { status: "ok" });
    }
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api") {
      return this.send(res, 404, { message: "Not found" });
    }

    const route = parts.slice(1);

    // GET /api/health is UNAUTHENTICATED (real Grafana behavior).
    if (route[0] === "health" && req.method === "GET") {
      return this.send(res, 200, { commit: "parlel", database: "ok", version: "10.4.0" });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { message: "Unauthorized" });
    }

    // GET /api/org
    if (route[0] === "org" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, clone(this.org));
    }

    // Dashboards
    if (route[0] === "dashboards" && route[1] === "db") {
      if (req.method === "POST") return this.upsertDashboard(res, body);
    }
    if (route[0] === "dashboards" && route[1] === "uid" && route.length === 3) {
      const uid = route[2];
      if (req.method === "GET") {
        const entry = this.dashboards.get(uid);
        if (!entry) return this.send(res, 404, { message: "Dashboard not found" });
        return this.send(res, 200, { dashboard: clone(entry.dashboard), meta: clone(entry.meta) });
      }
      if (req.method === "DELETE") {
        const entry = this.dashboards.get(uid);
        if (!entry) return this.send(res, 404, { message: "Dashboard not found" });
        this.dashboards.delete(uid);
        return this.send(res, 200, { title: entry.dashboard.title, message: "Dashboard deleted", id: entry.dashboard.id });
      }
    }

    // Datasources
    if (route[0] === "datasources") {
      if (route.length === 1) {
        if (req.method === "GET") {
          return this.send(res, 200, Array.from(this.datasources.values()).map(clone));
        }
        if (req.method === "POST") return this.createDatasource(res, body);
      }
      if (route.length === 2) {
        const id = Number(route[1]);
        const ds = this.datasources.get(id);
        if (req.method === "GET") {
          if (!ds) return this.send(res, 404, { message: "Data source not found" });
          return this.send(res, 200, clone(ds));
        }
        if (req.method === "DELETE") {
          if (!ds) return this.send(res, 404, { message: "Data source not found" });
          this.datasources.delete(id);
          return this.send(res, 200, { message: "Data source deleted", id });
        }
      }
    }

    return this.send(res, 404, { message: "Not found" });
  }

  upsertDashboard(res, body) {
    if (!isPlainObject(body) || !isPlainObject(body.dashboard)) {
      return this.send(res, 400, { message: "dashboard field is required" });
    }
    const incoming = body.dashboard;
    let uid = incoming.uid;
    let existing = uid ? this.dashboards.get(uid) : null;

    let id;
    let version;
    if (existing) {
      id = existing.dashboard.id;
      version = (existing.dashboard.version || 1) + 1;
    } else {
      this.dashboardIdCounter += 1;
      id = this.dashboardIdCounter;
      version = 1;
      if (!uid) uid = randomUUID().replace(/-/g, "").slice(0, 12);
    }

    const title = incoming.title || "New dashboard";
    const slug = slugify(title);
    const dashboard = { ...clone(incoming), id, uid, version, title, slug };
    const url = `/d/${uid}/${slug}`;
    const meta = {
      type: "db",
      canSave: true,
      canEdit: true,
      slug,
      url,
      version,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    this.dashboards.set(uid, { dashboard, meta });

    return this.send(res, 200, {
      id,
      uid,
      url,
      status: "success",
      version,
      slug,
    });
  }

  createDatasource(res, body) {
    if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
      return this.send(res, 400, { message: "name is required" });
    }
    this.datasourceIdCounter += 1;
    const id = this.datasourceIdCounter;
    const ds = {
      id,
      uid: body.uid || randomUUID().replace(/-/g, "").slice(0, 12),
      orgId: 1,
      name: body.name,
      type: body.type || "prometheus",
      access: body.access || "proxy",
      url: body.url || "",
      isDefault: Boolean(body.isDefault),
    };
    this.datasources.set(id, ds);
    return this.send(res, 200, {
      id,
      message: "Datasource added",
      name: ds.name,
      datasource: clone(ds),
    });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { message: "not found" });
  }

  root() {
    return {
      name: "grafana",
      version: "1",
      protocol: "grafana-http",
      documentation: "/docs/grafana.md",
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
          this.send(res, 400, { message: "Bad request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Bad request body" });
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
