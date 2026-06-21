import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/salesforce — a tiny, dependency-free fake of the Salesforce REST API.
//
// Wire conventions replicated (API version v59.0):
//   * GET    /services/data/v59.0/sobjects/{Object}/{id}
//   * POST   /services/data/v59.0/sobjects/{Object}   -> { id, success:true, errors:[] }
//   * PATCH  /services/data/v59.0/sobjects/{Object}/{id} -> 204
//   * DELETE /services/data/v59.0/sobjects/{Object}/{id} -> 204
//   * GET    /services/data/v59.0/query?q=SOQL -> { totalSize, done, records:[] }
//   * Bearer (OAuth) auth.
//   * Error envelope: [ { message, errorCode } ]
//   * Salesforce ids are 18-char alphanumeric, prefixed per object type.
//
// State is in-memory, ephemeral and resettable.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");
const API_VERSION = "v59.0";

const KEY_PREFIX = {
  Account: "001",
  Contact: "003",
  Lead: "00Q",
  Opportunity: "006",
  Case: "500",
  User: "005",
};

// Required fields per standard sObject (createable && !nillable &&
// !defaultedOnCreate), mirroring the real REST API's REQUIRED_FIELD_MISSING
// validation. Unknown / custom object types are not validated (no schema).
// Source: Salesforce REST API errorcodes.htm + Pipedream create-record gating.
const REQUIRED_FIELDS = {
  Account: ["Name"],
  Contact: ["LastName"],
  Lead: ["LastName", "Company"],
  Opportunity: ["Name", "StageName", "CloseDate"],
  Case: [],
  User: ["Username", "LastName", "Email", "Alias"],
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sfError(message, errorCode = "MALFORMED_QUERY") {
  return [{ message, errorCode }];
}

export class SalesforceServer {
  constructor(port = 4778, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.objects = new Map(); // ObjectName -> Map(id -> record)
    this.seq = 0;
  }

  _table(name) {
    if (!this.objects.has(name)) this.objects.set(name, new Map());
    return this.objects.get(name);
  }

  _newId(objectName) {
    this.seq += 1;
    const prefix = KEY_PREFIX[objectName] || "0XX";
    const tail = randomBytes(9).toString("hex").slice(0, 12);
    return `${prefix}${String(this.seq).padStart(3, "0")}${tail}`.slice(0, 18);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, sfError(error.message || "Internal server error", "INTERNAL_ERROR"));
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
    res.setHeader("server", "parlel-salesforce");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "services" || parts[1] !== "data") {
      return this.send(res, 404, sfError("not found", "NOT_FOUND"));
    }
    if (!this.isAuthorized(req)) {
      return this.send(res, 401, [{
        message: "Session expired or invalid",
        errorCode: "INVALID_SESSION_ID",
      }]);
    }

    // parts: services, data, v59.0, ...
    const ver = parts[2];
    const route = parts.slice(3);

    // GET /services/data/{ver}/query?q=...
    if (route[0] === "query" && req.method === "GET") {
      return this.query(res, url.searchParams.get("q") || "");
    }

    // /services/data/{ver}/sobjects/{Object}[/{id}]
    if (route[0] === "sobjects") {
      const objectName = route[1];
      if (!objectName) return this.send(res, 404, sfError("not found", "NOT_FOUND"));

      // POST collection -> create
      if (route.length === 2 && req.method === "POST") {
        return this.create(res, objectName, body);
      }
      if (route.length === 2) {
        return this.send(res, 405, [{ message: "method not allowed", errorCode: "METHOD_NOT_ALLOWED" }]);
      }

      // single record
      if (route.length === 3) {
        const id = route[2];
        const table = this._table(objectName);
        if (req.method === "GET") {
          const rec = table.get(id);
          if (!rec) return this.send(res, 404, [{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }]);
          // Honor the ?fields= projection like the real retrieve endpoint:
          // return only `attributes` + the requested fields.
          const fieldsParam = url.searchParams.get("fields");
          if (fieldsParam) {
            const wanted = fieldsParam.split(",").map((f) => f.trim()).filter(Boolean);
            const projected = { attributes: clone(rec.attributes) };
            for (const f of wanted) {
              if (Object.prototype.hasOwnProperty.call(rec, f)) projected[f] = clone(rec[f]);
            }
            return this.send(res, 200, projected);
          }
          return this.send(res, 200, clone(rec));
        }
        if (req.method === "PATCH") {
          const rec = table.get(id);
          if (!rec) return this.send(res, 404, [{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }]);
          Object.assign(rec, isPlainObject(body) ? clone(body) : {});
          rec.Id = id;
          rec.attributes = { type: objectName, url: `/services/data/${API_VERSION}/sobjects/${objectName}/${id}` };
          return this.send(res, 204, null);
        }
        if (req.method === "DELETE") {
          if (!table.has(id)) return this.send(res, 404, [{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }]);
          table.delete(id);
          return this.send(res, 204, null);
        }
        return this.send(res, 405, [{ message: "method not allowed", errorCode: "METHOD_NOT_ALLOWED" }]);
      }
    }

    return this.send(res, 404, sfError("not found", "NOT_FOUND"));
  }

  create(res, objectName, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 400, sfError("Invalid request body"));
    }
    // Real API enforces required fields for standard objects with a
    // REQUIRED_FIELD_MISSING envelope. Custom/unknown objects have no schema
    // here, so they are accepted as-is (documented design choice).
    const required = REQUIRED_FIELDS[objectName];
    if (required) {
      const missing = required.filter((f) => {
        const v = body[f];
        return v === undefined || v === null || v === "";
      });
      if (missing.length > 0) {
        return this.send(res, 400, [{
          message: `Required fields are missing: [${missing.join(", ")}]`,
          errorCode: "REQUIRED_FIELD_MISSING",
          fields: missing,
        }]);
      }
    }
    const id = this._newId(objectName);
    const record = {
      attributes: { type: objectName, url: `/services/data/${API_VERSION}/sobjects/${objectName}/${id}` },
      Id: id,
      ...clone(body),
    };
    this._table(objectName).set(id, record);
    return this.send(res, 201, { id, success: true, errors: [] });
  }

  query(res, soql) {
    // Parse a simple "SELECT ... FROM Object [WHERE Field = 'value']" query.
    const m = /from\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(soql);
    if (!m) {
      return this.send(res, 400, sfError(`unexpected token: '${soql}'`, "MALFORMED_QUERY"));
    }
    const objectName = m[1];
    const table = this._table(objectName);
    let records = Array.from(table.values());

    const whereMatch = /where\s+([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*'([^']*)'/i.exec(soql);
    if (whereMatch) {
      const field = whereMatch[1];
      const value = whereMatch[2];
      records = records.filter((r) => String(r[field]) === value);
    }

    const result = {
      totalSize: records.length,
      done: true,
      records: records.map(clone),
    };
    return this.send(res, 200, result);
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, sfError("not found", "NOT_FOUND"));
  }

  root() {
    return { name: "salesforce", version: API_VERSION, protocol: "salesforce-rest", documentation: "/docs/salesforce.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
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
          this.send(res, 400, sfError("Invalid JSON", "JSON_PARSER_ERROR"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, sfError("Invalid JSON", "JSON_PARSER_ERROR"));
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
