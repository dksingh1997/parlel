import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/netlify — a dependency-free fake of the Netlify API (api/v1).
//
// Speaks the wire protocol used by the netlify Node SDK and raw REST API so
// application code and AI agents can run against it with zero cost and zero
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

function genId() {
  return randomBytes(12).toString("hex");
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class NetlifyServer {
  constructor(port = 4771, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.sites = new Map(); // id -> { site, deploys: Map }
    this.user = {
      id: "parlel_user_0001",
      uid: "parlel_user_0001",
      full_name: "Parlel User",
      email: "parlel-user@parlel.dev",
      avatar_url: "https://www.gravatar.com/avatar/parlel",
      created_at: now(),
      site_count: 0,
    };
    this._createSite({ name: "hello-world" });
  }

  _createSite(opts = {}) {
    const id = genId();
    const name = opts.name || `site-${id.slice(0, 6)}`;
    const site = {
      id,
      site_id: id,
      name,
      custom_domain: opts.custom_domain || null,
      url: `https://${name}.netlify.app`,
      ssl_url: `https://${name}.netlify.app`,
      admin_url: `https://app.netlify.com/sites/${name}`,
      screenshot_url: null,
      created_at: now(),
      updated_at: now(),
      state: "current",
      account_slug: "parlel",
      default_domain: `${name}.netlify.app`,
      build_settings: {},
      published_deploy: null,
    };
    this.sites.set(id, { site, deploys: new Map() });
    return site;
  }

  _createDeploy(entry, opts = {}) {
    const id = genId();
    const site = entry.site;
    const deploy = {
      id,
      site_id: site.id,
      name: site.name,
      state: opts.state || "ready",
      url: site.url,
      ssl_url: site.ssl_url,
      deploy_url: `https://${id}--${site.name}.netlify.app`,
      deploy_ssl_url: `https://${id}--${site.name}.netlify.app`,
      admin_url: site.admin_url,
      created_at: now(),
      updated_at: now(),
      branch: opts.branch || "main",
      context: opts.context || "production",
      commit_ref: opts.commit_ref || null,
      title: opts.title || null,
      required: [],
    };
    entry.deploys.set(id, deploy);
    site.published_deploy = clone(deploy);
    return deploy;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { code: 500, message: error.message || "Internal server error" });
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
    res.setHeader("server", "parlel-netlify");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api" || parts[1] !== "v1") {
      return this.send(res, 404, { code: 404, message: "Not Found" });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { code: 401, message: "You must be authenticated" });
    }

    const route = parts.slice(2);

    if (route[0] === "user" && route.length === 1 && req.method === "GET") {
      this.user.site_count = this.sites.size;
      return this.send(res, 200, clone(this.user));
    }

    if (route[0] === "sites") {
      return this.handleSites(req, res, route.slice(1), body);
    }

    return this.send(res, 404, { code: 404, message: "Not Found" });
  }

  handleSites(req, res, sub, body) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.sites.values()].map((e) => clone(e.site)));
      }
      if (req.method === "POST") {
        const site = this._createSite(isPlainObject(body) ? body : {});
        return this.send(res, 201, clone(site));
      }
      return this.send(res, 405, { code: 405, message: "Method Not Allowed" });
    }

    const id = sub[0];
    const entry = this.sites.get(id) ||
      [...this.sites.values()].find((e) => e.site.name === id);
    if (!entry) return this.send(res, 404, { code: 404, message: "Not Found" });

    // /api/v1/sites/:id
    if (sub.length === 1) {
      if (req.method === "GET") return this.send(res, 200, clone(entry.site));
      if (req.method === "PUT" || req.method === "PATCH") {
        if (isPlainObject(body)) {
          if (typeof body.name === "string") entry.site.name = body.name;
          if (typeof body.custom_domain === "string") entry.site.custom_domain = body.custom_domain;
          entry.site.updated_at = now();
        }
        return this.send(res, 200, clone(entry.site));
      }
      if (req.method === "DELETE") {
        this.sites.delete(entry.site.id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, { code: 405, message: "Method Not Allowed" });
    }

    // /api/v1/sites/:id/deploys
    if (sub[1] === "deploys") {
      if (sub.length === 2) {
        if (req.method === "GET") {
          return this.send(res, 200, [...entry.deploys.values()].map(clone));
        }
        if (req.method === "POST") {
          const deploy = this._createDeploy(entry, isPlainObject(body) ? body : {});
          return this.send(res, 200, clone(deploy));
        }
        return this.send(res, 405, { code: 405, message: "Method Not Allowed" });
      }
      const deployId = sub[2];
      const deploy = entry.deploys.get(deployId);
      if (!deploy) return this.send(res, 404, { code: 404, message: "Not Found" });
      if (req.method === "GET") return this.send(res, 200, clone(deploy));
      return this.send(res, 405, { code: 405, message: "Method Not Allowed" });
    }

    return this.send(res, 404, { code: 404, message: "Not Found" });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "sites") {
      return this.send(res, 200, { ids: [...this.sites.keys()], count: this.sites.size });
    }
    return this.send(res, 404, { code: 404, message: "Not Found" });
  }

  root() {
    return {
      name: "netlify",
      version: "1",
      protocol: "netlify-v1",
      api_url: `http://${this.host}:${this.port}/api/v1`,
      documentation: "/docs/netlify.md",
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
          this.send(res, 400, { code: 400, message: "Invalid JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { code: 400, message: "Invalid JSON" });
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
