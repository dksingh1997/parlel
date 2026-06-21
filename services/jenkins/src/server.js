import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/jenkins — a tiny, dependency-free fake of the Jenkins REST API.
//
// Speaks the JSON REST surface used by Jenkins clients (the `/api/json` tree,
// job build triggers, crumb issuer). State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

export class JenkinsServer {
  constructor(port = 4877, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.jobs = new Map();
    this.crumb = "parlel-crumb-token-0000000000000000";
    this._seedDefaults();
  }

  _seedDefaults() {
    this._createJob("parlel-demo");
  }

  _createJob(name) {
    const job = {
      name,
      url: `http://${this.host}:${this.port}/job/${encodeURIComponent(name)}/`,
      buildable: true,
      nextBuildNumber: 1,
      builds: [],
      color: "notbuilt",
    };
    this.jobs.set(name, job);
    return job;
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Jenkins-Crumb");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-jenkins");
    res.setHeader("X-Jenkins", "2.440.1");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Jenkins"');
      return this.send(res, 401, { message: "Authentication required" });
    }

    // GET /crumbIssuer/api/json
    if (parts[0] === "crumbIssuer" && parts[1] === "api" && parts[2] === "json" && req.method === "GET") {
      return this.send(res, 200, {
        _class: "hudson.security.csrf.DefaultCrumbIssuer",
        crumb: this.crumb,
        crumbRequestField: "Jenkins-Crumb",
      });
    }

    // GET /api/json — root info
    if (parts[0] === "api" && parts[1] === "json" && parts.length === 2 && req.method === "GET") {
      return this.send(res, 200, this.rootApi());
    }

    // POST /createItem?name=...
    if (parts[0] === "createItem" && req.method === "POST") {
      const name = url.searchParams.get("name");
      if (!name) return this.send(res, 400, { message: "name query parameter required" });
      if (this.jobs.has(name)) {
        return this.send(res, 400, { message: `A job already exists with the name '${name}'` });
      }
      this._createJob(name);
      return this.send(res, 200, null);
    }

    // /job/:name/...
    if (parts[0] === "job") {
      const name = parts[1];
      const rest = parts.slice(2);
      const job = this.jobs.get(name);

      // POST /job/:name/build  -> 201 with Location header
      if (rest[0] === "build" && req.method === "POST") {
        if (!job) return this.send(res, 404, { message: "Job not found" });
        const number = job.nextBuildNumber;
        job.nextBuildNumber += 1;
        const build = {
          number,
          url: `http://${this.host}:${this.port}/job/${encodeURIComponent(name)}/${number}/`,
          result: "SUCCESS",
          building: false,
          timestamp: Date.now(),
          duration: 1000,
          fullDisplayName: `${name} #${number}`,
        };
        job.builds.unshift(build);
        job.color = "blue";
        const queueId = 100 + number;
        res.setHeader("Location", `http://${this.host}:${this.port}/queue/item/${queueId}/`);
        return this.send(res, 201, null);
      }

      // GET /job/:name/lastBuild/api/json
      if (rest[0] === "lastBuild" && rest[1] === "api" && rest[2] === "json" && req.method === "GET") {
        if (!job) return this.send(res, 404, { message: "Job not found" });
        const last = job.builds[0];
        if (!last) return this.send(res, 404, { message: "No builds" });
        return this.send(res, 200, {
          _class: "hudson.model.FreeStyleBuild",
          ...clone(last),
        });
      }

      // GET /job/:name/api/json
      if (rest[0] === "api" && rest[1] === "json" && req.method === "GET") {
        if (!job) return this.send(res, 404, { message: "Job not found" });
        return this.send(res, 200, {
          _class: "hudson.model.FreeStyleProject",
          name: job.name,
          url: job.url,
          buildable: job.buildable,
          color: job.color,
          nextBuildNumber: job.nextBuildNumber,
          builds: job.builds.map((b) => ({
            _class: "hudson.model.FreeStyleBuild",
            number: b.number,
            url: b.url,
          })),
          lastBuild: job.builds[0]
            ? { _class: "hudson.model.FreeStyleBuild", number: job.builds[0].number, url: job.builds[0].url }
            : null,
        });
      }
    }

    return this.send(res, 404, { message: "Not Found" });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { message: "not found" });
  }

  rootApi() {
    return {
      _class: "hudson.model.Hudson",
      mode: "NORMAL",
      nodeDescription: "the master Jenkins node",
      nodeName: "",
      numExecutors: 2,
      jobs: Array.from(this.jobs.values()).map((j) => ({
        _class: "hudson.model.FreeStyleProject",
        name: j.name,
        url: j.url,
        color: j.color,
      })),
      quietingDown: false,
      useSecurity: true,
    };
  }

  root() {
    return {
      name: "jenkins",
      version: "1",
      protocol: "jenkins-rest",
      documentation: "/docs/jenkins.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Basic\s+(\S+)/i.test(auth)) {
      const encoded = auth.replace(/^Basic\s+/i, "");
      try {
        const decoded = Buffer.from(encoded, "base64").toString();
        // Accept any non-empty user:apiToken pair.
        const [user, token] = decoded.split(":");
        return Boolean(user) && Boolean(token);
      } catch {
        return false;
      }
    }
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    return false;
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
        const ct = (req.headers["content-type"] || "").toLowerCase();
        if (ct.includes("application/json")) {
          try {
            resolve(JSON.parse(data));
          } catch {
            this.send(res, 400, { message: "Invalid JSON body" });
            resolve(SENTINEL_BAD_JSON);
          }
          return;
        }
        // Jenkins build POSTs are often form-encoded or empty; keep raw.
        resolve({ _raw: data });
      });
      req.on("error", () => {
        resolve({});
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
