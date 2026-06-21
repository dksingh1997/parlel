import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/xero — a dependency-free fake of the Xero Accounting API 2.0.
//   /api.xro/2.0/Invoices, /Contacts, /Accounts  (GET / PUT create / POST update)
// Bearer auth. Responses are wrapped in the plural element name, e.g.
// { Invoices: [...] }. State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Xero date serialization: /Date(ms+0000)/
function xeroDate() {
  return `/Date(${Date.now()}+0000)/`;
}

function xeroError(message, type = "ValidationException") {
  return {
    ErrorNumber: 10,
    Type: type,
    Message: message,
  };
}

// element name (singular) -> { plural, idField }
const RESOURCES = {
  invoices: { singular: "Invoice", plural: "Invoices", idField: "InvoiceID" },
  contacts: { singular: "Contact", plural: "Contacts", idField: "ContactID" },
  accounts: { singular: "Account", plural: "Accounts", idField: "AccountID" },
};

export class XeroServer {
  constructor(port = 4763, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.stores = {
      Invoices: new Map(),
      Contacts: new Map(),
      Accounts: new Map(),
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, xeroError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Xero-Tenant-Id, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-xero");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Expect /api.xro/2.0/<Resource>...
    if (parts[0] !== "api.xro" || parts[1] !== "2.0") {
      return this.send(res, 404, xeroError("Resource not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { Title: "Unauthorized", Status: 401, Detail: "AuthenticationUnsuccessful" });
    }

    const resourceKey = (parts[2] || "").toLowerCase();
    const meta = RESOURCES[resourceKey];
    if (!meta) return this.send(res, 404, xeroError(`Unknown resource: ${parts[2]}`));

    return this.handleResource(req, res, meta, parts.slice(2), body);
  }

  handleResource(req, res, meta, route, body) {
    const store = this.stores[meta.plural];

    // GET list or by id
    if (req.method === "GET") {
      if (route.length === 2) {
        const record = store.get(route[1]);
        if (!record) return this.send(res, 404, xeroError("Resource not found"));
        return this.send(res, 200, { [meta.plural]: [clone(record)] });
      }
      return this.send(res, 200, { [meta.plural]: Array.from(store.values()).map(clone) });
    }

    // PUT = create new; POST = create or update
    if (req.method === "PUT" || req.method === "POST") {
      const incoming = this.extractItems(body, meta);
      const result = [];
      for (const item of incoming) {
        const existingId = item[meta.idField];
        if (req.method === "POST" && existingId && store.has(existingId)) {
          const existing = store.get(existingId);
          Object.assign(existing, clone(item), { UpdatedDateUTC: xeroDate() });
          result.push(clone(existing));
        } else {
          const id = existingId || randomUUID();
          const record = {
            ...clone(item),
            [meta.idField]: id,
            UpdatedDateUTC: xeroDate(),
          };
          if (meta.plural === "Invoices") {
            if (record.Status === undefined) record.Status = "DRAFT";
            if (record.InvoiceNumber === undefined) record.InvoiceNumber = `INV-${id.slice(0, 8)}`;
          }
          if (meta.plural === "Contacts" && record.ContactStatus === undefined) record.ContactStatus = "ACTIVE";
          store.set(id, record);
          result.push(clone(record));
        }
      }
      const status = req.method === "PUT" ? 200 : 200;
      return this.send(res, status, { [meta.plural]: result });
    }

    return this.send(res, 405, xeroError("Method not allowed"));
  }

  extractItems(body, meta) {
    if (!isPlainObject(body)) return [];
    if (Array.isArray(body[meta.plural])) return body[meta.plural].filter(isPlainObject);
    if (isPlainObject(body[meta.singular])) return [body[meta.singular]];
    // A bare object (single resource) is also accepted.
    if (Object.keys(body).length > 0) return [body];
    return [];
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, xeroError("Not Found"));
  }

  root() {
    return {
      name: "xero",
      version: "1.0",
      protocol: "xero-accounting-2.0",
      documentation: "/docs/xero.md",
    };
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
          this.send(res, 400, xeroError("Invalid request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, xeroError("Invalid request body"));
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

const SENTINEL_BAD_JSON = Symbol("bad-json");
