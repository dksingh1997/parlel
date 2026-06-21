import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/heroku — a tiny, dependency-free fake of the Heroku Platform API v3.
//
// Speaks the Heroku Platform API v3 surface (apps, config-vars, dynos,
// account). State is in-memory and ephemeral. Requires the v3 Accept header.
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

const NAME_RE = /^[a-z][a-z0-9-]{1,29}$/;

function herokuError(id, message) {
  return { id, message };
}

export class HerokuServer {
  constructor(port = 4883, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.apps = new Map(); // id -> app
    this.appsByName = new Map();
    this.configVars = new Map(); // appId -> { KEY: VALUE }
    this.dynos = new Map(); // appId -> [dynos]
    this.account = {
      id: randomUUID(),
      email: "parlel@parlel.dev",
      name: "Parlel",
      created_at: now(),
      updated_at: now(),
    };
    this._counter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, herokuError("internal_server_error", error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-heroku");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, herokuError("unauthorized", "There were no credentials in the request."));
    }

    // GET /account
    if (parts[0] === "account" && parts.length === 1 && req.method === "GET") {
      return this.send(res, 200, clone(this.account));
    }

    // /apps
    if (parts[0] === "apps") {
      if (parts.length === 1) {
        if (req.method === "GET") {
          return this.send(res, 200, Array.from(this.apps.values()).map(clone));
        }
        if (req.method === "POST") return this.createApp(res, body);
      }

      const ident = parts[1];
      const app = this.findApp(ident);

      // /apps/:id_or_name
      if (parts.length === 2) {
        if (!app) return this.send(res, 404, herokuError("not_found", "Couldn't find that app."));
        if (req.method === "GET") return this.send(res, 200, clone(app));
        if (req.method === "PATCH") {
          if (isPlainObject(body)) {
            if (typeof body.name === "string") this.renameApp(app, body.name);
            if (typeof body.maintenance === "boolean") app.maintenance = body.maintenance;
          }
          app.updated_at = now();
          return this.send(res, 200, clone(app));
        }
        if (req.method === "DELETE") {
          this.apps.delete(app.id);
          this.appsByName.delete(app.name);
          this.configVars.delete(app.id);
          this.dynos.delete(app.id);
          return this.send(res, 200, clone(app));
        }
      }

      if (!app) return this.send(res, 404, herokuError("not_found", "Couldn't find that app."));

      // /apps/:app/config-vars
      if (parts[2] === "config-vars" && parts.length === 3) {
        const vars = this.configVars.get(app.id) || {};
        if (req.method === "GET") return this.send(res, 200, clone(vars));
        if (req.method === "PATCH") {
          if (isPlainObject(body)) {
            for (const [k, v] of Object.entries(body)) {
              if (v === null) delete vars[k];
              else vars[k] = String(v);
            }
          }
          this.configVars.set(app.id, vars);
          return this.send(res, 200, clone(vars));
        }
      }

      // /apps/:app/dynos
      if (parts[2] === "dynos" && parts.length === 3) {
        const list = this.dynos.get(app.id) || [];
        if (req.method === "GET") return this.send(res, 200, list.map(clone));
        if (req.method === "POST") return this.createDyno(res, app, body);
      }
    }

    return this.send(res, 404, herokuError("not_found", "Not found."));
  }

  createApp(res, body) {
    this._counter += 1;
    let name = isPlainObject(body) && typeof body.name === "string" ? body.name : `parlel-app-${this._counter}`;
    if (!NAME_RE.test(name)) {
      return this.send(res, 422, herokuError("invalid_params", "Name must start with a letter and can only contain lowercase letters, numbers, and dashes."));
    }
    if (this.appsByName.has(name)) {
      return this.send(res, 422, herokuError("invalid_params", "Name is already taken"));
    }
    const id = randomUUID();
    const created = now();
    const app = {
      id,
      name,
      web_url: `https://${name}.herokuapp.com/`,
      git_url: `https://git.heroku.com/${name}.git`,
      region: { id: randomUUID(), name: "us" },
      stack: { id: randomUUID(), name: "heroku-22" },
      created_at: created,
      updated_at: created,
      released_at: created,
      maintenance: false,
      owner: { id: this.account.id, email: this.account.email },
      build_stack: { id: randomUUID(), name: "heroku-22" },
    };
    this.apps.set(id, app);
    this.appsByName.set(name, app);
    this.configVars.set(id, {});
    this.dynos.set(id, []);
    return this.send(res, 201, clone(app));
  }

  createDyno(res, app, body) {
    const id = randomUUID();
    const created = now();
    const dyno = {
      id,
      name: `run.${1000 + (this.dynos.get(app.id) || []).length + 1}`,
      command: (isPlainObject(body) && body.command) || "bash",
      type: (isPlainObject(body) && body.type) || "run",
      size: (isPlainObject(body) && body.size) || "standard-1X",
      state: "up",
      app: { id: app.id, name: app.name },
      created_at: created,
      updated_at: created,
      attach_url: null,
    };
    const list = this.dynos.get(app.id) || [];
    list.push(dyno);
    this.dynos.set(app.id, list);
    return this.send(res, 201, clone(dyno));
  }

  findApp(ident) {
    if (this.apps.has(ident)) return this.apps.get(ident);
    if (this.appsByName.has(ident)) return this.appsByName.get(ident);
    return null;
  }

  renameApp(app, newName) {
    if (!NAME_RE.test(newName) || (this.appsByName.has(newName) && this.appsByName.get(newName) !== app)) {
      return;
    }
    this.appsByName.delete(app.name);
    app.name = newName;
    app.web_url = `https://${newName}.herokuapp.com/`;
    app.git_url = `https://git.heroku.com/${newName}.git`;
    this.appsByName.set(newName, app);
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, herokuError("not_found", "not found"));
  }

  root() {
    return {
      name: "heroku",
      version: "3",
      protocol: "heroku-platform-v3",
      documentation: "/docs/heroku.md",
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
          this.send(res, 400, herokuError("bad_request", "Request body must be valid JSON."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, herokuError("bad_request", "Request body must be valid JSON."));
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
