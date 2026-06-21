import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/npm-registry — a dependency-free fake of the npm registry API.
//
// Speaks the wire protocol npm/pnpm/yarn use for install, view and publish:
//   GET  /:package            -> the packument { name, dist-tags, versions, ... }
//   GET  /:package/:version   -> a single version manifest
//   PUT  /:package            -> publish (npm publish)
//   GET  /-/v1/search?text=   -> registry search
// Scoped packages (@scope/name) are URL-encoded as %2f by clients and decoded
// here. State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shasum(str) {
  return createHash("sha1").update(str).digest("hex");
}

function integrity(str) {
  return "sha512-" + createHash("sha512").update(str).digest("base64");
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class NpmRegistryServer {
  constructor(port = 4776, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuthForPublish = options.requireAuthForPublish !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.packages = new Map(); // name -> packument
    this._seed();
  }

  _seed() {
    this._publishVersion("left-pad", "1.3.0", {
      description: "String left pad",
      main: "index.js",
    });
  }

  _emptyPackument(name) {
    return {
      _id: name,
      name,
      "dist-tags": {},
      versions: {},
      time: { created: now(), modified: now() },
      maintainers: [{ name: "parlel", email: "parlel@parlel.dev" }],
      readme: "",
    };
  }

  _publishVersion(name, version, manifest = {}) {
    let pkg = this.packages.get(name);
    if (!pkg) {
      pkg = this._emptyPackument(name);
      this.packages.set(name, pkg);
    }
    const tarballData = `${name}@${version}`;
    const versionObj = {
      name,
      version,
      ...manifest,
      _id: `${name}@${version}`,
      dist: {
        shasum: shasum(tarballData),
        integrity: integrity(tarballData),
        tarball: `http://${this.host}:${this.port}/${name}/-/${name.replace(/^@[^/]+\//, "")}-${version}.tgz`,
      },
    };
    pkg.versions[version] = versionObj;
    pkg["dist-tags"].latest = version;
    pkg.time[version] = now();
    pkg.time.modified = now();
    return versionObj;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: error.message || "Internal Server Error" });
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
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
    res.setHeader("server", "parlel-npm-registry");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    const rawPath = url.pathname;
    // Keep raw (still %2f-encoded) for scoped package routing, plus a decoded version.
    const decodedPath = decodeURIComponent(rawPath);

    if (req.method === "GET" && (rawPath === "/" || rawPath === "")) return this.send(res, 200, this.root());
    if (req.method === "GET" && decodedPath === "/health") return this.send(res, 200, { status: "ok" });

    if (decodedPath.startsWith("/__parlel")) return this.handleControl(req, res, decodedPath);

    // Registry search: GET /-/v1/search?text=
    if (req.method === "GET" && decodedPath === "/-/v1/search") {
      return this.handleSearch(res, url);
    }

    // Strip leading slash, decode %2f -> /
    const spec = decodeURIComponent(rawPath.replace(/^\//, ""));
    if (!spec) return this.send(res, 404, { error: "Not found" });

    // PUT /:package  -> publish
    if (req.method === "PUT") {
      const name = spec;
      return this.handlePublish(req, res, name, body);
    }

    if (req.method === "GET") {
      // Determine if last segment is a version: /:package/:version
      // For scoped packages, name has two segments (@scope/name). A version is the
      // trailing segment when it isn't part of the package name and looks like a version/tag.
      return this.handleGet(res, spec);
    }

    return this.send(res, 405, { error: "method not allowed" });
  }

  handleGet(res, spec) {
    // Direct packument hit.
    if (this.packages.has(spec)) {
      return this.send(res, 200, clone(this.packages.get(spec)));
    }

    // Try /:package/:version split.
    const segments = spec.split("/");
    let name;
    let version;
    if (spec.startsWith("@")) {
      // scoped: @scope/name OR @scope/name/version
      if (segments.length === 2) {
        name = spec;
      } else if (segments.length === 3) {
        name = `${segments[0]}/${segments[1]}`;
        version = segments[2];
      }
    } else {
      if (segments.length === 1) {
        name = spec;
      } else if (segments.length === 2) {
        name = segments[0];
        version = segments[1];
      }
    }

    const pkg = name && this.packages.get(name);
    if (!pkg) {
      return this.send(res, 404, { error: "Not found" });
    }
    if (!version) {
      return this.send(res, 200, clone(pkg));
    }
    // Resolve dist-tag or explicit version.
    const resolved = pkg["dist-tags"][version] || version;
    const versionObj = pkg.versions[resolved];
    if (!versionObj) {
      return this.send(res, 404, { error: "version not found" });
    }
    return this.send(res, 200, clone(versionObj));
  }

  handlePublish(req, res, name, body) {
    if (this.requireAuthForPublish && !this.isAuthorized(req)) {
      return this.send(res, 401, { error: "you must be logged in to publish packages" });
    }
    if (!isPlainObject(body) || !isPlainObject(body.versions) || typeof body.name !== "string") {
      return this.send(res, 400, { error: "invalid publish payload" });
    }

    const distTags = isPlainObject(body["dist-tags"]) ? body["dist-tags"] : {};
    for (const [version, manifest] of Object.entries(body.versions)) {
      const { dist, _id, ...rest } = isPlainObject(manifest) ? manifest : {};
      this._publishVersion(name, version, rest);
    }
    // Apply provided dist-tags (npm sends e.g. { latest: "1.0.0" }).
    const pkg = this.packages.get(name);
    for (const [tag, version] of Object.entries(distTags)) {
      if (pkg.versions[version]) pkg["dist-tags"][tag] = version;
    }

    return this.send(res, 201, { ok: true, id: name, success: true });
  }

  handleSearch(res, url) {
    const text = (url.searchParams.get("text") || "").toLowerCase();
    const size = Number(url.searchParams.get("size") || 20);
    const matches = [...this.packages.values()]
      .filter((pkg) => !text || pkg.name.toLowerCase().includes(text))
      .slice(0, size)
      .map((pkg) => {
        const latest = pkg["dist-tags"].latest;
        const v = latest ? pkg.versions[latest] : null;
        return {
          package: {
            name: pkg.name,
            version: latest || "0.0.0",
            description: (v && v.description) || "",
            date: pkg.time.modified,
            links: { npm: `http://${this.host}:${this.port}/${pkg.name}` },
            publisher: { username: "parlel" },
            maintainers: pkg.maintainers,
          },
          score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
          searchScore: 1,
        };
      });
    return this.send(res, 200, {
      objects: matches,
      total: matches.length,
      time: now(),
    });
  }

  handleControl(req, res, path) {
    if (req.method === "POST" && path === "/__parlel/reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/__parlel/packages") {
      return this.send(res, 200, { packages: [...this.packages.keys()], count: this.packages.size });
    }
    return this.send(res, 404, { error: "Not found" });
  }

  root() {
    return {
      name: "npm-registry",
      version: "1",
      protocol: "npm-registry",
      api_url: `http://${this.host}:${this.port}`,
      db_name: "registry",
      documentation: "/docs/npm-registry.md",
    };
  }

  isAuthorized(req) {
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
          this.send(res, 400, { error: "invalid JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { error: "invalid JSON" });
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
