import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/braintree — a tiny, dependency-free fake of the Braintree GraphQL API.
//
// Braintree's modern API is a single GraphQL endpoint (POST /graphql). This
// server implements a minimal-but-real GraphQL dispatch: it parses the incoming
// query to discover the top-level field (operation) being requested and routes
// to a resolver. Responses follow the GraphQL shape { data: {...} } (and
// { errors: [...] } on failure). Bearer-authenticated. State is in-memory.
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

function token(len = 16) {
  return randomBytes(Math.ceil(len * 0.8)).toString("base64").replace(/[+/=]/g, "").slice(0, len);
}

// Discover the first top-level field name following `query {` / `mutation {`.
// Strips leading query/mutation keyword, operation name, and variable
// declarations, then reads the first field identifier (before any `(` or `{`).
function topLevelField(query) {
  if (typeof query !== "string") return null;
  // Remove comments.
  let q = query.replace(/#[^\n]*/g, " ");
  // Strip the leading operation keyword + optional name + optional var defs.
  const m = q.match(/^\s*(query|mutation|subscription)?\s*[A-Za-z0-9_]*\s*(\([^)]*\))?\s*\{/);
  let rest;
  if (m) {
    rest = q.slice(m.index + m[0].length);
  } else {
    // Anonymous shorthand `{ field ... }`.
    const brace = q.indexOf("{");
    if (brace === -1) return null;
    rest = q.slice(brace + 1);
  }
  const fieldMatch = rest.match(/\s*([A-Za-z_][A-Za-z0-9_]*)/);
  return fieldMatch ? fieldMatch[1] : null;
}

export class BraintreeServer {
  constructor(port = 4868, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.customers = new Map();
    this.transactions = new Map();
    this.counter = 0;
  }

  nextId(prefix) {
    this.counter += 1;
    return `${prefix}_${token(12)}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { errors: [{ message: error.message || "error" }] });
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-braintree");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, { errors: [{ message: "not found" }] });
    }

    if (parts[0] === "graphql" && req.method === "POST") {
      if (this.requireAuth && !this.isAuthorized(req)) {
        return this.send(res, 401, { errors: [{ message: "Authentication credentials are invalid." }] });
      }
      return this.graphql(res, body);
    }

    return this.send(res, 404, { errors: [{ message: "not found" }] });
  }

  graphql(res, body) {
    if (!isPlainObject(body) || typeof body.query !== "string") {
      return this.send(res, 422, { errors: [{ message: "query is required" }] });
    }
    const field = topLevelField(body.query);
    const vars = isPlainObject(body.variables) ? body.variables : {};

    switch (field) {
      case "ping":
        return this.send(res, 200, { data: { ping: "pong" } });
      case "chargeCreditCard":
        return this.chargeCreditCard(res, vars);
      case "createCustomer":
        return this.createCustomer(res, vars);
      case "transaction":
        return this.transaction(res, vars);
      case "customer":
        return this.customer(res, vars);
      default:
        return this.send(res, 422, {
          errors: [{ message: `Cannot query field "${field || "?"}" on type "Query".` }],
        });
    }
  }

  chargeCreditCard(res, vars) {
    const input = vars.input || {};
    const amount = input.transaction && input.transaction.amount ? String(input.transaction.amount) : "10.00";
    const id = this.nextId("txn");
    const transaction = {
      id,
      legacyId: token(8),
      status: "SUBMITTED_FOR_SETTLEMENT",
      amount: { value: amount, currencyCode: input.transaction && input.transaction.currencyCode ? input.transaction.currencyCode : "USD" },
      paymentMethodSnapshot: { __typename: "CreditCardDetails", last4: "1111", brandCode: "VISA" },
      createdAt: new Date().toISOString(),
    };
    this.transactions.set(id, transaction);
    return this.send(res, 200, {
      data: {
        chargeCreditCard: {
          transaction: clone(transaction),
        },
      },
    });
  }

  createCustomer(res, vars) {
    const input = vars.input || {};
    const c = input.customer || {};
    const id = this.nextId("cust");
    const customer = {
      id,
      legacyId: token(8),
      firstName: c.firstName || null,
      lastName: c.lastName || null,
      email: c.email || null,
      company: c.company || null,
      createdAt: new Date().toISOString(),
    };
    this.customers.set(id, customer);
    return this.send(res, 200, {
      data: {
        createCustomer: {
          customer: clone(customer),
        },
      },
    });
  }

  transaction(res, vars) {
    const id = vars.id;
    const t = this.transactions.get(id);
    if (!t) {
      return this.send(res, 200, { data: { node: null, transaction: null } });
    }
    return this.send(res, 200, { data: { transaction: clone(t), node: clone(t) } });
  }

  customer(res, vars) {
    const id = vars.id;
    const c = this.customers.get(id);
    if (!c) return this.send(res, 200, { data: { customer: null } });
    return this.send(res, 200, { data: { customer: clone(c) } });
  }

  root() {
    return { name: "braintree", version: "1", protocol: "braintree-graphql", documentation: "/docs/braintree.md" };
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
          this.send(res, 400, { errors: [{ message: "malformed JSON body" }] });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { errors: [{ message: "malformed body" }] });
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
