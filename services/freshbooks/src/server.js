import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/freshbooks — a tiny, dependency-free fake of the FreshBooks API.
//
// Bearer-authenticated JSON API. Accounting resources nest their payload as
// { response: { result: { <resource>: {...} } } } for a single object and
// { response: { result: { <resource>s: [...], page, pages, per_page, total } } }
// for a list. State is in-memory and ephemeral.
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

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function fbError(message, status = 422) {
  return {
    status,
    body: {
      response: {
        errors: [{ message, errno: status }],
      },
    },
  };
}

export class FreshbooksServer {
  constructor(port = 4872, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.clients = new Map(); // id -> client
    this.invoices = new Map();
    this.counter = 1000;
  }

  nextId() {
    this.counter += 1;
    return this.counter;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, fbError(error.message || "error", 500).body);
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
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-freshbooks");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, fbError("not found", 404).body);
    }

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, { response: { errors: [{ message: "The server could not verify that you are authorized", errno: 1001 }] } });
    }

    // GET /auth/api/v1/users/me
    if (parts[0] === "auth" && parts[1] === "api" && parts[2] === "v1" && parts[3] === "users" && parts[4] === "me") {
      return this.send(res, 200, {
        response: {
          id: 1,
          first_name: "Parlel",
          last_name: "Tester",
          email: "owner@parlel.dev",
          business_memberships: [
            { business: { id: 99, name: "Parlel Inc", account_id: "parlelAcct" }, role: "owner" },
          ],
        },
      });
    }

    // /accounting/account/:accountId/users/clients ...
    if (parts[0] === "accounting" && parts[1] === "account" && parts[3] === "users" && parts[4] === "clients") {
      return this.handleClients(req, res, parts, body);
    }

    // /accounting/account/:accountId/invoices/invoices ...
    if (parts[0] === "accounting" && parts[1] === "account" && parts[3] === "invoices" && parts[4] === "invoices") {
      return this.handleInvoices(req, res, parts, body);
    }

    return this.send(res, 404, fbError("not found", 404).body);
  }

  listEnvelope(name, items) {
    return {
      response: {
        result: {
          [name]: items.map(clone),
          page: 1,
          pages: 1,
          per_page: 15,
          total: items.length,
        },
      },
    };
  }

  handleClients(req, res, parts, body) {
    // parts: accounting account :acct users clients [:id]
    if (parts.length === 5) {
      if (req.method === "GET") {
        return this.send(res, 200, this.listEnvelope("clients", Array.from(this.clients.values())));
      }
      if (req.method === "POST") return this.createClient(res, body);
      return this.send(res, 405, fbError("method not allowed", 405).body);
    }
    if (parts.length === 6) {
      const id = Number(parts[5]);
      const client = this.clients.get(id);
      if (!client) return this.send(res, 404, fbError("client not found", 404).body);
      if (req.method === "GET") return this.send(res, 200, { response: { result: { client: clone(client) } } });
      if (req.method === "PUT") {
        const payload = (body && body.client) || {};
        for (const k of ["fname", "lname", "email", "organization"]) {
          if (typeof payload[k] === "string") client[k] = payload[k];
        }
        client.updated = now();
        return this.send(res, 200, { response: { result: { client: clone(client) } } });
      }
      if (req.method === "DELETE") {
        client.vis_state = 1;
        return this.send(res, 200, { response: { result: { client: clone(client) } } });
      }
      return this.send(res, 405, fbError("method not allowed", 405).body);
    }
    return this.send(res, 404, fbError("not found", 404).body);
  }

  createClient(res, body) {
    const payload = (isPlainObject(body) && body.client) || {};
    if (!payload.fname && !payload.email && !payload.organization) {
      return this.send(res, 422, fbError("Client requires fname, email or organization").body);
    }
    const id = this.nextId();
    const client = {
      id,
      accounting_systemid: "parlelAcct",
      fname: payload.fname || "",
      lname: payload.lname || "",
      organization: payload.organization || "",
      email: payload.email || "",
      vis_state: 0,
      updated: now(),
    };
    this.clients.set(id, client);
    return this.send(res, 200, { response: { result: { client: clone(client) } } });
  }

  handleInvoices(req, res, parts, body) {
    if (parts.length === 5) {
      if (req.method === "GET") {
        return this.send(res, 200, this.listEnvelope("invoices", Array.from(this.invoices.values())));
      }
      if (req.method === "POST") return this.createInvoice(res, body);
      return this.send(res, 405, fbError("method not allowed", 405).body);
    }
    if (parts.length === 6) {
      const id = Number(parts[5]);
      const invoice = this.invoices.get(id);
      if (!invoice) return this.send(res, 404, fbError("invoice not found", 404).body);
      if (req.method === "GET") return this.send(res, 200, { response: { result: { invoice: clone(invoice) } } });
      return this.send(res, 405, fbError("method not allowed", 405).body);
    }
    return this.send(res, 404, fbError("not found", 404).body);
  }

  createInvoice(res, body) {
    const payload = (isPlainObject(body) && body.invoice) || {};
    if (!payload.customerid) {
      return this.send(res, 422, fbError("invoice requires customerid").body);
    }
    const id = this.nextId();
    const invoice = {
      id,
      invoice_number: `INV-${id}`,
      customerid: payload.customerid,
      create_date: now().slice(0, 10),
      status: 1,
      amount: { amount: payload.amount || "0.00", code: payload.currency_code || "USD" },
      lines: payload.lines || [],
      vis_state: 0,
    };
    this.invoices.set(id, invoice);
    return this.send(res, 200, { response: { result: { invoice: clone(invoice) } } });
  }

  root() {
    return { name: "freshbooks", version: "1", protocol: "freshbooks-http", documentation: "/docs/freshbooks.md" };
  }

  isAuthorized(req) {
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
          this.send(res, 400, fbError("malformed JSON body", 400).body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, fbError("malformed body", 400).body);
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
