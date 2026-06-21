import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/cloudflare — a dependency-free fake of the Cloudflare API v4.
//
// Speaks the wire protocol used by the cloudflare Node SDK and raw REST API.
// Every API response uses the Cloudflare envelope:
//   { success, errors, messages, result, result_info? }
// State is in-memory, ephemeral and resettable.
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

function hexId(len = 32) {
  return randomBytes(len / 2).toString("hex");
}

function envelope(result, extra = {}) {
  return { success: true, errors: [], messages: [], result, ...extra };
}

function failure(code, message, status) {
  return { status, body: { success: false, errors: [{ code, message }], messages: [], result: null } };
}

const SENTINEL_BAD_JSON = Symbol("bad-json");

export class CloudflareServer {
  constructor(port = 4772, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.zones = new Map(); // id -> { zone, records: Map }
    this.user = {
      id: hexId(),
      email: "parlel-user@parlel.dev",
      username: "parlel-user",
      first_name: "Parlel",
      last_name: "User",
      telephone: null,
      country: null,
      created_on: now(),
      modified_on: now(),
      two_factor_authentication_enabled: false,
      suspended: false,
    };
    this._createZone({ name: "parlel.dev" });
  }

  _createZone(opts = {}) {
    const id = hexId();
    const zone = {
      id,
      name: opts.name,
      status: "active",
      paused: false,
      type: opts.type || "full",
      development_mode: 0,
      name_servers: ["alice.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      created_on: now(),
      modified_on: now(),
      activated_on: now(),
      account: { id: this.user.id, name: "Parlel Account" },
      meta: { step: 4, custom_certificate_quota: 0, page_rule_quota: 3 },
    };
    this.zones.set(id, { zone, records: new Map() });
    return zone;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { success: false, errors: [{ code: 0, message: error.message }], messages: [], result: null });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Auth-Key, X-Auth-Email");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-cloudflare");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "client" || parts[1] !== "v4") {
      return this.send(res, 404, { success: false, errors: [{ code: 7000, message: "No route for that URI" }], messages: [], result: null });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null });
    }

    const route = parts.slice(2);

    if (route[0] === "user" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, envelope(clone(this.user)));
    }

    if (route[0] === "zones") {
      return this.handleZones(req, res, route.slice(1), body);
    }

    return this.send(res, 404, { success: false, errors: [{ code: 7000, message: "No route for that URI" }], messages: [], result: null });
  }

  handleZones(req, res, sub, body) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        const result = [...this.zones.values()].map((z) => clone(z.zone));
        return this.send(res, 200, envelope(result, {
          result_info: { page: 1, per_page: 20, count: result.length, total_count: result.length, total_pages: 1 },
        }));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
          return this.send(res, 400, { success: false, errors: [{ code: 1004, message: "Validation failed: name is required" }], messages: [], result: null });
        }
        const zone = this._createZone(body);
        return this.send(res, 200, envelope(clone(zone)));
      }
      return this.send(res, 405, { success: false, errors: [{ code: 7003, message: "Method not allowed" }], messages: [], result: null });
    }

    const id = sub[0];
    const entry = this.zones.get(id);
    if (!entry) {
      return this.send(res, 404, { success: false, errors: [{ code: 1003, message: "Zone not found" }], messages: [], result: null });
    }

    // /client/v4/zones/:id
    if (sub.length === 1) {
      if (req.method === "GET") return this.send(res, 200, envelope(clone(entry.zone)));
      if (req.method === "PATCH") {
        if (isPlainObject(body)) {
          if (typeof body.paused === "boolean") entry.zone.paused = body.paused;
          entry.zone.modified_on = now();
        }
        return this.send(res, 200, envelope(clone(entry.zone)));
      }
      if (req.method === "DELETE") {
        this.zones.delete(id);
        return this.send(res, 200, envelope({ id }));
      }
      return this.send(res, 405, { success: false, errors: [{ code: 7003, message: "Method not allowed" }], messages: [], result: null });
    }

    // /client/v4/zones/:id/dns_records
    if (sub[1] === "dns_records") {
      return this.handleDnsRecords(req, res, entry, sub.slice(2), body);
    }

    return this.send(res, 404, { success: false, errors: [{ code: 7000, message: "No route for that URI" }], messages: [], result: null });
  }

  handleDnsRecords(req, res, entry, sub, body) {
    if (sub.length === 0) {
      if (req.method === "GET") {
        const result = [...entry.records.values()].map(clone);
        return this.send(res, 200, envelope(result, {
          result_info: { page: 1, per_page: 100, count: result.length, total_count: result.length, total_pages: 1 },
        }));
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.type !== "string" || typeof body.name !== "string" || body.content === undefined) {
          return this.send(res, 400, { success: false, errors: [{ code: 9000, message: "Validation failed: type, name and content are required" }], messages: [], result: null });
        }
        const id = hexId();
        const record = {
          id,
          zone_id: entry.zone.id,
          zone_name: entry.zone.name,
          type: body.type,
          name: body.name,
          content: String(body.content),
          proxiable: true,
          proxied: Boolean(body.proxied),
          ttl: typeof body.ttl === "number" ? body.ttl : 1,
          locked: false,
          created_on: now(),
          modified_on: now(),
        };
        entry.records.set(id, record);
        return this.send(res, 200, envelope(clone(record)));
      }
      return this.send(res, 405, { success: false, errors: [{ code: 7003, message: "Method not allowed" }], messages: [], result: null });
    }

    const id = sub[0];
    const record = entry.records.get(id);
    if (!record) {
      return this.send(res, 404, { success: false, errors: [{ code: 81044, message: "Record not found" }], messages: [], result: null });
    }
    if (req.method === "GET") return this.send(res, 200, envelope(clone(record)));
    if (req.method === "PUT" || req.method === "PATCH") {
      if (isPlainObject(body)) {
        if (typeof body.type === "string") record.type = body.type;
        if (typeof body.name === "string") record.name = body.name;
        if (body.content !== undefined) record.content = String(body.content);
        if (typeof body.ttl === "number") record.ttl = body.ttl;
        if (typeof body.proxied === "boolean") record.proxied = body.proxied;
        record.modified_on = now();
      }
      return this.send(res, 200, envelope(clone(record)));
    }
    if (req.method === "DELETE") {
      entry.records.delete(id);
      return this.send(res, 200, envelope({ id }));
    }
    return this.send(res, 405, { success: false, errors: [{ code: 7003, message: "Method not allowed" }], messages: [], result: null });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "zones") {
      return this.send(res, 200, { ids: [...this.zones.keys()], count: this.zones.size });
    }
    return this.send(res, 404, { success: false, errors: [{ code: 7000, message: "No route" }], messages: [], result: null });
  }

  root() {
    return {
      name: "cloudflare",
      version: "1",
      protocol: "cloudflare-v4",
      api_url: `http://${this.host}:${this.port}/client/v4`,
      documentation: "/docs/cloudflare.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    if (req.headers["x-auth-key"] && req.headers["x-auth-email"]) return true;
    return false;
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
          this.send(res, 400, { success: false, errors: [{ code: 6003, message: "Invalid JSON" }], messages: [], result: null });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { success: false, errors: [{ code: 6003, message: "Invalid JSON" }], messages: [], result: null });
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
