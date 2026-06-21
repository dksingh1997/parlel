import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/servicenow — a tiny, dependency-free fake of the ServiceNow Table API.
//
// Wire conventions replicated:
//   * Base path /api/now/table/{tableName}  (e.g. incident, problem, change_request).
//   * Basic auth (or Bearer).
//   * Single record wrapped:  { result: {...} }.
//   * Collections wrapped:    { result: [...] }.
//   * sys_id is a 32-char hex string. Records carry sys_id, sys_created_on, etc.
//   * Convenience number field (INC0010001, ...) for known ITSM tables.
//   * Error envelope: { error: { message, detail }, status: "failure" }.
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

const NUMBER_PREFIX = {
  incident: "INC",
  problem: "PRB",
  change_request: "CHG",
  sc_request: "REQ",
  task: "TASK",
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowStr() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sysId() {
  return randomBytes(16).toString("hex"); // 32 hex chars
}

function snError(message, detail = null, status = 400) {
  return { error: { message, detail }, status: "failure" };
}

export class ServicenowServer {
  constructor(port = 4784, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.tables = new Map(); // tableName -> Map(sys_id -> record)
    this.numberSeq = new Map(); // tableName -> int
  }

  _table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  _nextNumber(tableName) {
    const prefix = NUMBER_PREFIX[tableName] || "REC";
    const n = (this.numberSeq.get(tableName) || 0) + 1;
    this.numberSeq.set(tableName, n);
    return `${prefix}${String(n).padStart(7, "0")}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, snError(error.message || "Internal server error", null, 500));
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
    res.setHeader("server", "parlel-servicenow");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "api" || parts[1] !== "now" || parts[2] !== "table") {
      return this.send(res, 404, snError("Not found", "Resource not found", 404));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { error: { message: "User Not Authenticated", detail: "Required to provide Auth information" }, status: "failure" });
    }

    const tableName = parts[3];
    if (!tableName) {
      return this.send(res, 404, snError("Not found", "No table specified", 404));
    }
    const table = this._table(tableName);

    // /api/now/table/{tableName}
    if (parts.length === 4) {
      if (req.method === "GET") return this.list(res, table, url);
      if (req.method === "POST") return this.create(res, tableName, table, body);
      return this.send(res, 405, snError("Method not allowed", null, 405));
    }

    // /api/now/table/{tableName}/{sys_id}
    if (parts.length === 5) {
      const id = parts[4];
      const rec = table.get(id);
      if (req.method === "GET") {
        if (!rec) return this.send(res, 404, snError("No Record found", `Record doesn't exist or ACL restricts the record retrieval`, 404));
        return this.send(res, 200, { result: clone(rec) });
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        if (!rec) return this.send(res, 404, snError("No Record found", `Record doesn't exist or ACL restricts the record retrieval`, 404));
        Object.assign(rec, isPlainObject(body) ? clone(body) : {});
        rec.sys_id = id;
        rec.sys_updated_on = nowStr();
        return this.send(res, 200, { result: clone(rec) });
      }
      if (req.method === "DELETE") {
        if (!rec) return this.send(res, 404, snError("No Record found", `Record doesn't exist or ACL restricts the record retrieval`, 404));
        table.delete(id);
        return this.send(res, 204, null);
      }
      return this.send(res, 405, snError("Method not allowed", null, 405));
    }

    return this.send(res, 404, snError("Not found", "Resource not found", 404));
  }

  create(res, tableName, table, body) {
    const payload = isPlainObject(body) ? body : {};
    const id = sysId();
    const ts = nowStr();
    const rec = {
      sys_id: id,
      number: this._nextNumber(tableName),
      sys_created_on: ts,
      sys_updated_on: ts,
      ...clone(payload),
    };
    rec.sys_id = id;
    table.set(id, rec);
    return this.send(res, 201, { result: clone(rec) });
  }

  list(res, table, url) {
    let records = Array.from(table.values());

    // sysparm_query: field=value^field2=value2
    const query = url.searchParams.get("sysparm_query");
    if (query) {
      const clauses = query.split("^").filter(Boolean);
      for (const clause of clauses) {
        const m = /^([A-Za-z0-9_.]+)=(.*)$/.exec(clause);
        if (m) {
          const [, field, value] = m;
          records = records.filter((r) => String(r[field]) === value);
        }
      }
    }

    const limit = Number(url.searchParams.get("sysparm_limit"));
    if (Number.isFinite(limit) && limit > 0) {
      const offset = Number(url.searchParams.get("sysparm_offset")) || 0;
      records = records.slice(offset, offset + limit);
    }

    return this.send(res, 200, { result: records.map(clone) });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, snError("Not found", null, 404));
  }

  root() {
    return { name: "servicenow", version: "1", protocol: "servicenow-table-api", documentation: "/docs/servicenow.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Basic\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, snError("Bad Request", "Invalid JSON body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, snError("Bad Request", "Invalid JSON body"));
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
