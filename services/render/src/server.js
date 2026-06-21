import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/render — a tiny, dependency-free fake of the Render API v1.
//
// Speaks the Render REST API v1 surface (services, deploys, owners). State is
// in-memory and ephemeral. List endpoints return arrays of { <resource>, cursor }
// objects, matching Render's cursor-pagination shape.
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

function rid(prefix) {
  return `${prefix}-${randomBytes(12).toString("hex").slice(0, 20)}`;
}

function cursor() {
  return randomBytes(9).toString("base64").replace(/[+/=]/g, "");
}

export class RenderServer {
  constructor(port = 4881, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.services = new Map(); // id -> service
    this.deploys = new Map(); // serviceId -> [deploys]
    this.owner = { id: rid("usr"), name: "Parlel", email: "parlel@parlel.dev", type: "user" };
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
    res.setHeader("server", "parlel-render");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v1") {
      return this.send(res, 404, { message: "Not found" });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { message: "Unauthorized" });
    }

    const route = parts.slice(1);

    // GET /v1/owners
    if (route[0] === "owners" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, [{ owner: clone(this.owner), cursor: cursor() }]);
    }

    // /v1/services
    if (route[0] === "services") {
      if (route.length === 1) {
        if (req.method === "GET") {
          const items = Array.from(this.services.values()).map((s) => ({ service: clone(s), cursor: cursor() }));
          return this.send(res, 200, items);
        }
        if (req.method === "POST") return this.createService(res, body);
      }

      const id = route[1];
      const service = this.services.get(id);

      // /v1/services/:id
      if (route.length === 2) {
        if (!service) return this.send(res, 404, { message: "Service not found" });
        if (req.method === "GET") return this.send(res, 200, clone(service));
        if (req.method === "PATCH") {
          if (isPlainObject(body)) {
            if (typeof body.name === "string") service.name = body.name;
            if (isPlainObject(body.serviceDetails)) {
              service.serviceDetails = { ...service.serviceDetails, ...body.serviceDetails };
            }
          }
          service.updatedAt = now();
          return this.send(res, 200, clone(service));
        }
        if (req.method === "DELETE") {
          this.services.delete(id);
          this.deploys.delete(id);
          return this.send(res, 204, null);
        }
      }

      // /v1/services/:id/deploys
      if (route[2] === "deploys") {
        if (!service) return this.send(res, 404, { message: "Service not found" });
        const list = this.deploys.get(id) || [];
        if (route.length === 3) {
          if (req.method === "POST") return this.createDeploy(res, id, body);
          if (req.method === "GET") {
            return this.send(res, 200, list.map((d) => ({ deploy: clone(d), cursor: cursor() })));
          }
        }
        if (route.length === 4 && req.method === "GET") {
          const deployId = route[3];
          const deploy = list.find((d) => d.id === deployId);
          if (!deploy) return this.send(res, 404, { message: "Deploy not found" });
          return this.send(res, 200, clone(deploy));
        }
      }
    }

    return this.send(res, 404, { message: "Not found" });
  }

  createService(res, body) {
    if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
      return this.send(res, 400, { message: "name is required" });
    }
    const id = rid("srv");
    const createdAt = now();
    const type = body.type || "web_service";
    const service = {
      id,
      type,
      name: body.name,
      ownerId: this.owner.id,
      repo: body.repo || "https://github.com/parlel/demo",
      branch: body.branch || "main",
      autoDeploy: body.autoDeploy || "yes",
      createdAt,
      updatedAt: createdAt,
      suspended: "not_suspended",
      slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      serviceDetails: isPlainObject(body.serviceDetails) ? clone(body.serviceDetails) : { env: "node" },
    };
    this.services.set(id, service);
    this.deploys.set(id, []);
    // Render returns the service wrapped alongside a deployId on creation.
    return this.send(res, 201, { service: clone(service), deployId: rid("dep") });
  }

  createDeploy(res, serviceId, body) {
    const id = rid("dep");
    const createdAt = now();
    const deploy = {
      id,
      commit: {
        id: randomBytes(20).toString("hex"),
        message: (isPlainObject(body) && body.commitMessage) || "Triggered via API",
        createdAt,
      },
      status: "created",
      trigger: "api",
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
    };
    const list = this.deploys.get(serviceId) || [];
    list.unshift(deploy);
    this.deploys.set(serviceId, list);
    return this.send(res, 201, clone(deploy));
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
      name: "render",
      version: "1",
      protocol: "render-v1",
      documentation: "/docs/render.md",
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
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { message: "Invalid JSON body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Invalid JSON body" });
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
