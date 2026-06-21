import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/calendly — a tiny, dependency-free fake of the Calendly API v2.
//
// Users (/users/me), event types, scheduled events, and scheduling links.
// Calendly wraps single resources in { resource } and collections in
// { collection, pagination }. Bearer auth. State is in-memory and ephemeral.
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

export class CalendlyServer {
  constructor(port = 4813, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.base = `https://api.calendly.com`;
    this.server = null;
    this.reset();
  }

  reset() {
    this.userUuid = "parlel-user";
    this.eventTypes = new Map();
    this.scheduledEvents = new Map();
    this.schedulingLinks = [];
    this._seedDefaults();
  }

  _uri(kind, uuid) {
    return `${this.base}/${kind}/${uuid}`;
  }

  _seedDefaults() {
    const etUuid = "et-default";
    this.eventTypes.set(etUuid, {
      uri: this._uri("event_types", etUuid),
      name: "30 Minute Meeting",
      active: true,
      slug: "30min",
      scheduling_url: `https://calendly.com/parlel/30min`,
      duration: 30,
      kind: "solo",
      profile: { type: "User", name: "Parlel", owner: this._uri("users", this.userUuid) },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { title: "Internal Server Error", message: error.message || "error" });
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
    res.setHeader("server", "parlel-calendly");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { title: "Unauthenticated", message: "The access token is invalid" });
    }

    // GET /users/me  or /users/:uuid
    if (parts[0] === "users" && parts.length === 2 && req.method === "GET") {
      return this.send(res, 200, { resource: this._userResource() });
    }

    // GET /event_types?user=
    if (parts[0] === "event_types") {
      if (parts.length === 1 && req.method === "GET") {
        return this.send(res, 200, {
          collection: Array.from(this.eventTypes.values()).map(clone),
          pagination: { count: this.eventTypes.size, next_page: null, next_page_token: null },
        });
      }
      if (parts.length === 2 && req.method === "GET") {
        const et = this.eventTypes.get(parts[1]);
        if (!et) return this.send(res, 404, { title: "Resource Not Found", message: "not found" });
        return this.send(res, 200, { resource: clone(et) });
      }
    }

    // /scheduled_events
    if (parts[0] === "scheduled_events") {
      return this.handleScheduledEvents(req, res, parts, body, url);
    }

    // POST /scheduling_links
    if (parts[0] === "scheduling_links" && req.method === "POST") {
      return this.createSchedulingLink(res, body);
    }

    return this.send(res, 404, { title: "Resource Not Found", message: "not found" });
  }

  _userResource() {
    return {
      uri: this._uri("users", this.userUuid),
      name: "Parlel User",
      slug: "parlel",
      email: "user@parlel.dev",
      scheduling_url: "https://calendly.com/parlel",
      timezone: "America/New_York",
      current_organization: this._uri("organizations", "parlel-org"),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  handleScheduledEvents(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, {
          collection: Array.from(this.scheduledEvents.values()).map(clone),
          pagination: { count: this.scheduledEvents.size, next_page: null, next_page_token: null },
        });
      }
      if (req.method === "POST") {
        const uuid = randomUUID();
        const ev = {
          uri: this._uri("scheduled_events", uuid),
          name: isPlainObject(body) ? body.name || "Parlel Meeting" : "Parlel Meeting",
          status: "active",
          start_time: isPlainObject(body) && body.start_time ? body.start_time : new Date(Date.now() + 86400000).toISOString(),
          end_time: isPlainObject(body) && body.end_time ? body.end_time : new Date(Date.now() + 86400000 + 1800000).toISOString(),
          event_type: isPlainObject(body) && body.event_type ? body.event_type : this._uri("event_types", "et-default"),
          location: isPlainObject(body) ? body.location || { type: "physical", location: "Parlel HQ" } : { type: "physical" },
          invitees_counter: { total: 0, active: 0, limit: 1 },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        this.scheduledEvents.set(uuid, ev);
        return this.send(res, 201, { resource: clone(ev) });
      }
    }
    // /scheduled_events/:uuid
    if (parts.length === 2 && req.method === "GET") {
      const ev = this.scheduledEvents.get(parts[1]);
      if (!ev) return this.send(res, 404, { title: "Resource Not Found", message: "not found" });
      return this.send(res, 200, { resource: clone(ev) });
    }
    return this.send(res, 405, { title: "Method Not Allowed", message: "method not allowed" });
  }

  createSchedulingLink(res, body) {
    if (!isPlainObject(body) || typeof body.owner !== "string") {
      return this.send(res, 400, { title: "Invalid Argument", message: "owner is required" });
    }
    const link = {
      booking_url: `https://calendly.com/d/${randomUUID().slice(0, 12)}`,
      owner: body.owner,
      owner_type: body.owner_type || "EventType",
    };
    this.schedulingLinks.push(link);
    return this.send(res, 201, { resource: clone(link) });
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "scheduled_events") {
      return this.send(res, 200, {
        scheduled_events: Array.from(this.scheduledEvents.values()).map(clone),
        count: this.scheduledEvents.size,
      });
    }
    return this.send(res, 404, { title: "Resource Not Found", message: "not found" });
  }

  root() {
    return { name: "calendly", version: "1.0", protocol: "calendly-v2", documentation: "/docs/calendly.md" };
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
          this.send(res, 400, { title: "Invalid Payload", message: "Malformed JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { title: "Invalid Payload", message: "Bad request body" });
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
