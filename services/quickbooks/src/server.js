import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/quickbooks — a dependency-free fake of the QuickBooks Online v3 API.
//   /v3/company/:realmId/customer   (GET :id / POST create-or-update)
//   /v3/company/:realmId/invoice    (GET :id / POST create-or-update)
//   /v3/company/:realmId/query      (GET ?query=... / POST raw SQL-ish)
// Bearer auth. JSON. Entities are wrapped (e.g. { Customer: {...} }); queries
// respond with { QueryResponse: { Customer: [...] } }. State is in-memory and
// ephemeral.
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function qbError(message, code = "2010") {
  return {
    Fault: {
      Error: [{ Message: message, code, Detail: message }],
      type: "ValidationFault",
    },
    time: nowIso(),
  };
}

const ENTITY_NAMES = {
  customer: "Customer",
  invoice: "Invoice",
  item: "Item",
  payment: "Payment",
};

export class QuickbooksServer {
  constructor(port = 4762, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // store: entityName -> Map(id -> record)
    this.stores = {
      Customer: new Map(),
      Invoice: new Map(),
      Item: new Map(),
      Payment: new Map(),
    };
    this.counter = 0;
  }

  nextId() {
    this.counter += 1;
    return String(this.counter);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, qbError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-quickbooks");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Expect /v3/company/:realmId/<resource>...
    if (parts[0] !== "v3" || parts[1] !== "company") {
      return this.send(res, 404, qbError("Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, qbError("AuthenticationFailed", "3200"));
    }

    const realmId = parts[2];
    const resource = (parts[3] || "").toLowerCase();
    const route = parts.slice(3);

    if (resource === "query") return this.handleQuery(req, res, url, body);

    const entity = ENTITY_NAMES[resource];
    if (!entity) return this.send(res, 404, qbError(`Unsupported resource: ${resource}`));

    return this.handleEntity(req, res, entity, route, body);
  }

  handleEntity(req, res, entity, route, body) {
    const store = this.stores[entity];

    // GET /v3/company/:realm/customer/:id
    if (route.length === 2 && req.method === "GET") {
      const record = store.get(route[1]);
      if (!record) return this.send(res, 404, qbError(`Object Not Found: ${route[1]}`, "610"));
      return this.send(res, 200, { [entity]: clone(record), time: nowIso() });
    }

    // POST /v3/company/:realm/customer  -> create or update (sparse if Id given)
    if (route.length === 1 && req.method === "POST") {
      const payload = isPlainObject(body) ? body : {};
      if (payload.Id && store.has(payload.Id)) {
        const existing = store.get(payload.Id);
        Object.assign(existing, clone(payload));
        existing.MetaData = { ...(existing.MetaData || {}), LastUpdatedTime: nowIso() };
        existing.SyncToken = String(Number(existing.SyncToken || "0") + 1);
        return this.send(res, 200, { [entity]: clone(existing), time: nowIso() });
      }
      const id = this.nextId();
      const record = {
        ...clone(payload),
        Id: id,
        SyncToken: "0",
        sparse: false,
        MetaData: { CreateTime: nowIso(), LastUpdatedTime: nowIso() },
      };
      if (entity === "Invoice" && record.DocNumber === undefined) record.DocNumber = `INV-${id}`;
      store.set(id, record);
      return this.send(res, 200, { [entity]: clone(record), time: nowIso() });
    }

    return this.send(res, 404, qbError("Not Found"));
  }

  handleQuery(req, res, url, body) {
    let query = "";
    if (req.method === "GET") query = url.searchParams.get("query") || "";
    else if (typeof body === "string") query = body;
    else if (isPlainObject(body) && typeof body.query === "string") query = body.query;

    const m = /from\s+([a-z]+)/i.exec(query);
    const entityName = m ? cap(m[1].toLowerCase()) : null;
    const entity = entityName && this.stores[entityName] ? entityName : null;
    const QueryResponse = { startPosition: 1, maxResults: 0 };
    if (entity) {
      const items = Array.from(this.stores[entity].values()).map(clone);
      QueryResponse[entity] = items;
      QueryResponse.maxResults = items.length;
    }
    return this.send(res, 200, { QueryResponse, time: nowIso() });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, qbError("Not Found"));
  }

  root() {
    return {
      name: "quickbooks",
      version: "1.0",
      protocol: "quickbooks-online-v3",
      documentation: "/docs/quickbooks.md",
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
        const ct = (req.headers["content-type"] || "").toLowerCase();
        if (ct.includes("application/text") || ct.includes("text/plain")) {
          return resolve(data);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          // QBO query can be sent as a raw string body.
          resolve(data);
        }
      });
      req.on("error", () => {
        this.send(res, 400, qbError("Bad request body"));
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

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

const SENTINEL_BAD_JSON = Symbol("bad-json");
