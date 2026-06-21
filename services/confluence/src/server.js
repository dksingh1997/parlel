import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/confluence — a tiny, dependency-free fake of the Confluence Cloud
// REST API.
//
// Speaks the /wiki/rest/api wire protocol. Basic/Bearer auth. Content carries
// { id, type: "page", status, title, space, body, ... } and lists carry
// { results, size, _links }. State is in-memory and ephemeral.
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

// Confluence error envelope: { statusCode, message }
function confError(statusCode, message) {
  return { statusCode, message };
}

export class ConfluenceServer {
  constructor(port = 4795, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.content = new Map();
    this.spaces = new Map();
    this.idCounter = 100000;
    this._seedDefaults();
  }

  _nextId() {
    this.idCounter += 1;
    return String(this.idCounter);
  }

  _seedDefaults() {
    const spaceId = this._nextId();
    this.spaces.set("PARLEL", {
      id: Number(spaceId),
      key: "PARLEL",
      name: "Parlel Space",
      type: "global",
      status: "current",
      _links: { webui: "/spaces/PARLEL" },
    });
    this.defaultSpace = "PARLEL";
  }

  _link(path) {
    return path;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, confError(500, error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-confluence");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!(parts[0] === "wiki" && parts[1] === "rest" && parts[2] === "api")) {
      return this.send(res, 404, confError(404, "Not found"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, confError(401, "Unauthorized; scope does not match"));
    }

    const route = parts.slice(3);

    if (route[0] === "content") return this.handleContent(req, res, route, body, url);
    if (route[0] === "space") return this.handleSpace(req, res, route, url);

    return this.send(res, 404, confError(404, "Not found"));
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------
  handleContent(req, res, route, body, url) {
    if (route.length === 1) {
      if (req.method === "GET") {
        const spaceKey = url.searchParams.get("spaceKey");
        const type = url.searchParams.get("type");
        let results = [...this.content.values()];
        if (spaceKey) results = results.filter((c) => c.space && c.space.key === spaceKey);
        if (type) results = results.filter((c) => c.type === type);
        results = results.map(clone);
        return this.send(res, 200, {
          results,
          start: 0,
          limit: 25,
          size: results.length,
          _links: { base: this._link("/wiki"), self: this._link("/wiki/rest/api/content") },
        });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.title !== "string" || !body.title) {
          return this.send(res, 400, confError(400, "com.atlassian.confluence.api.service.exceptions.BadRequestException: title is required"));
        }
        const spaceKey = isPlainObject(body.space) && body.space.key ? body.space.key : this.defaultSpace;
        const space = this.spaces.get(spaceKey) || this.spaces.get(this.defaultSpace);
        const id = this._nextId();
        const content = {
          id,
          type: body.type || "page",
          status: body.status || "current",
          title: body.title,
          space: { id: space.id, key: space.key, name: space.name, type: space.type },
          version: { number: 1, when: new Date().toISOString() },
          body: isPlainObject(body.body)
            ? clone(body.body)
            : { storage: { value: "", representation: "storage" } },
          _links: { webui: `/spaces/${space.key}/pages/${id}`, self: this._link(`/wiki/rest/api/content/${id}`) },
        };
        this.content.set(id, content);
        return this.send(res, 200, clone(content));
      }
      return this.send(res, 405, confError(405, "Method not allowed"));
    }

    const id = route[1];
    const content = this.content.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!content) return this.send(res, 404, confError(404, "No content found with id"));
        return this.send(res, 200, clone(content));
      }
      if (req.method === "PUT") {
        if (!content) return this.send(res, 404, confError(404, "No content found with id"));
        if (isPlainObject(body)) {
          if (typeof body.title === "string") content.title = body.title;
          if (isPlainObject(body.body)) content.body = clone(body.body);
          if (typeof body.status === "string") content.status = body.status;
          const nextVersion = isPlainObject(body.version) && Number.isFinite(body.version.number)
            ? body.version.number
            : content.version.number + 1;
          content.version = { number: nextVersion, when: new Date().toISOString() };
        }
        return this.send(res, 200, clone(content));
      }
      if (req.method === "DELETE") {
        if (!content) return this.send(res, 404, confError(404, "No content found with id"));
        this.content.delete(id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, confError(405, "Method not allowed"));
    }
    return this.send(res, 404, confError(404, "Not found"));
  }

  // -------------------------------------------------------------------------
  // Space
  // -------------------------------------------------------------------------
  handleSpace(req, res, route, url) {
    if (route.length === 1 && req.method === "GET") {
      const results = [...this.spaces.values()].map(clone);
      return this.send(res, 200, {
        results,
        start: 0,
        limit: 25,
        size: results.length,
        _links: { base: this._link("/wiki"), self: this._link("/wiki/rest/api/space") },
      });
    }
    if (route.length === 2 && req.method === "GET") {
      const space = this.spaces.get(route[1]);
      if (!space) return this.send(res, 404, confError(404, "No space found"));
      return this.send(res, 200, clone(space));
    }
    return this.send(res, 404, confError(404, "Not found"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, confError(404, "Not found"));
  }

  root() {
    return {
      name: "confluence",
      version: "1",
      protocol: "confluence-rest",
      documentation: "/docs/confluence.md",
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
          this.send(res, 400, confError(400, "Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, confError(400, "Bad request body"));
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
