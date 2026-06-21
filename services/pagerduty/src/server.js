import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/pagerduty — a dependency-free fake of the PagerDuty REST API v2 plus
// the Events API v2 (/v2/enqueue).
//
// REST API auth: `Authorization: Token token=<key>` and the
// `Accept: application/vnd.pagerduty+json;version=2` header. Events API uses a
// `routing_key` in the JSON body. State is in-memory, ephemeral and resettable.
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

function pdId() {
  return "P" + randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class PagerdutyServer {
  constructor(port = 4774, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.incidents = new Map();
    this.services = new Map();
    this.users = new Map();
    this.enqueued = []; // captured Events API v2 events
    this._seed();
  }

  _seed() {
    const userId = "PUSER01";
    this.users.set(userId, {
      id: userId,
      type: "user",
      summary: "Parlel User",
      name: "Parlel User",
      email: "parlel-user@parlel.dev",
      role: "admin",
      self: `https://api.pagerduty.com/users/${userId}`,
      html_url: `https://parlel.pagerduty.com/users/${userId}`,
    });
    const svcId = "PSVC01";
    this.services.set(svcId, {
      id: svcId,
      type: "service",
      summary: "Parlel Service",
      name: "Parlel Service",
      status: "active",
      self: `https://api.pagerduty.com/services/${svcId}`,
      html_url: `https://parlel.pagerduty.com/services/${svcId}`,
      created_at: now(),
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: { message: error.message || "Internal Server Error", code: 5000 } });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-pagerduty");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Events API v2: POST /v2/enqueue (routing_key auth in body)
    if (parts[0] === "v2" && parts[1] === "enqueue" && req.method === "POST") {
      return this.handleEnqueue(res, body);
    }

    // REST API v2 — requires Token auth.
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { error: { message: "Caller did not supply credentials or did not provide the correct credentials.", code: 2006 } });
    }

    if (parts[0] === "incidents") return this.handleIncidents(req, res, parts.slice(1), body);
    if (parts[0] === "services") return this.handleServices(req, res, parts.slice(1), body);
    if (parts[0] === "users") return this.handleUsers(req, res, parts.slice(1), body);

    return this.send(res, 404, { error: { message: "Not Found", code: 2100 } });
  }

  // POST /v2/enqueue — Events API v2.
  handleEnqueue(res, body) {
    if (!isPlainObject(body) || typeof body.routing_key !== "string" || !body.routing_key) {
      return this.send(res, 400, { status: "invalid event", message: "Event object is invalid", errors: ["routing_key is required"] });
    }
    if (typeof body.event_action !== "string") {
      return this.send(res, 400, { status: "invalid event", message: "Event object is invalid", errors: ["event_action is required"] });
    }
    const dedupKey = typeof body.dedup_key === "string" && body.dedup_key
      ? body.dedup_key
      : randomBytes(16).toString("hex");
    this.enqueued.push({ received_at: now(), event: clone(body), dedup_key: dedupKey });
    return this.send(res, 202, { status: "success", message: "Event processed", dedup_key: dedupKey });
  }

  handleIncidents(req, res, sub, body) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, { incidents: [...this.incidents.values()].map(clone), limit: 25, offset: 0, more: false });
      }
      if (req.method === "POST") {
        const inc = isPlainObject(body) ? body.incident : null;
        if (!isPlainObject(inc) || typeof inc.title !== "string" || !inc.title) {
          return this.send(res, 400, { error: { message: "Invalid Input Provided", code: 2001, errors: ["incident.title is required"] } });
        }
        const id = pdId();
        const incident = {
          id,
          type: "incident",
          summary: inc.title,
          incident_number: this.incidents.size + 1,
          title: inc.title,
          status: "triggered",
          urgency: inc.urgency || "high",
          created_at: now(),
          service: inc.service || { id: "PSVC01", type: "service_reference" },
          self: `https://api.pagerduty.com/incidents/${id}`,
          html_url: `https://parlel.pagerduty.com/incidents/${id}`,
        };
        this.incidents.set(id, incident);
        return this.send(res, 201, { incident: clone(incident) });
      }
      return this.send(res, 405, { error: { message: "Method Not Allowed", code: 2101 } });
    }

    const id = sub[0];
    const incident = this.incidents.get(id);
    if (!incident) return this.send(res, 404, { error: { message: "Not Found", code: 2100 } });
    if (req.method === "GET") return this.send(res, 200, { incident: clone(incident) });
    if (req.method === "PUT") {
      const inc = isPlainObject(body) ? body.incident : null;
      if (isPlainObject(inc)) {
        if (typeof inc.title === "string") incident.title = incident.summary = inc.title;
        if (inc.status === "acknowledged" || inc.status === "resolved" || inc.status === "triggered") {
          incident.status = inc.status;
        }
      }
      return this.send(res, 200, { incident: clone(incident) });
    }
    return this.send(res, 405, { error: { message: "Method Not Allowed", code: 2101 } });
  }

  handleServices(req, res, sub, body) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, { services: [...this.services.values()].map(clone), limit: 25, offset: 0, more: false });
      }
      if (req.method === "POST") {
        const svc = isPlainObject(body) ? body.service : null;
        if (!isPlainObject(svc) || typeof svc.name !== "string" || !svc.name) {
          return this.send(res, 400, { error: { message: "Invalid Input Provided", code: 2001, errors: ["service.name is required"] } });
        }
        const id = pdId();
        const service = {
          id,
          type: "service",
          summary: svc.name,
          name: svc.name,
          status: "active",
          created_at: now(),
          self: `https://api.pagerduty.com/services/${id}`,
          html_url: `https://parlel.pagerduty.com/services/${id}`,
        };
        this.services.set(id, service);
        return this.send(res, 201, { service: clone(service) });
      }
      return this.send(res, 405, { error: { message: "Method Not Allowed", code: 2101 } });
    }

    const id = sub[0];
    const service = this.services.get(id);
    if (!service) return this.send(res, 404, { error: { message: "Not Found", code: 2100 } });
    if (req.method === "GET") return this.send(res, 200, { service: clone(service) });
    return this.send(res, 405, { error: { message: "Method Not Allowed", code: 2101 } });
  }

  handleUsers(req, res, sub, body) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        return this.send(res, 200, { users: [...this.users.values()].map(clone), limit: 25, offset: 0, more: false });
      }
      if (req.method === "POST") {
        const u = isPlainObject(body) ? body.user : null;
        if (!isPlainObject(u) || typeof u.name !== "string" || !u.name || typeof u.email !== "string") {
          return this.send(res, 400, { error: { message: "Invalid Input Provided", code: 2001, errors: ["user.name and user.email are required"] } });
        }
        const id = pdId();
        const user = {
          id,
          type: "user",
          summary: u.name,
          name: u.name,
          email: u.email,
          role: u.role || "user",
          self: `https://api.pagerduty.com/users/${id}`,
          html_url: `https://parlel.pagerduty.com/users/${id}`,
        };
        this.users.set(id, user);
        return this.send(res, 201, { user: clone(user) });
      }
      return this.send(res, 405, { error: { message: "Method Not Allowed", code: 2101 } });
    }

    const id = sub[0];
    const user = this.users.get(id);
    if (!user) return this.send(res, 404, { error: { message: "Not Found", code: 2100 } });
    if (req.method === "GET") return this.send(res, 200, { user: clone(user) });
    return this.send(res, 405, { error: { message: "Method Not Allowed", code: 2101 } });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "events") {
      return this.send(res, 200, { events: clone(this.enqueued), count: this.enqueued.length });
    }
    return this.send(res, 404, { error: { message: "Not Found", code: 2100 } });
  }

  root() {
    return {
      name: "pagerduty",
      version: "1",
      protocol: "pagerduty-v2",
      api_url: `http://${this.host}:${this.port}`,
      documentation: "/docs/pagerduty.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Token\s+token=\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, { error: { message: "Invalid JSON", code: 2001 } });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { error: { message: "Invalid JSON", code: 2001 } });
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
