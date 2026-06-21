import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/recurly — a tiny, dependency-free fake of the Recurly API v3.
//
// Basic-authenticated (api key as the username) JSON API. Objects carry an
// `object` discriminator; lists use { object: "list", has_more, data: [] }.
// State is in-memory and ephemeral.
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

function now() {
  return new Date().toISOString();
}

function recurlyError(type, message, status = 400) {
  return { status, body: { error: { type, message } } };
}

function list(data) {
  return { object: "list", has_more: false, data: data.map(clone) };
}

export class RecurlyServer {
  constructor(port = 4870, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.accounts = new Map(); // id -> account
    this.accountByCode = new Map();
    this.subscriptions = new Map();
    this.plans = new Map();
    this.purchases = new Map();
    this.counter = 0;
    this._seed();
  }

  nextId() {
    this.counter += 1;
    return token(13);
  }

  _seed() {
    const planId = this.nextId();
    const plan = {
      object: "plan",
      id: planId,
      code: "basic",
      name: "Basic Plan",
      state: "active",
      currencies: [{ currency: "USD", unit_amount: 10.0 }],
      interval_unit: "months",
      interval_length: 1,
      created_at: now(),
      updated_at: now(),
    };
    this.plans.set(planId, plan);
    this.planByCode = new Map([["basic", plan]]);
  }

  resolveAccount(idOrCode) {
    if (this.accounts.has(idOrCode)) return this.accounts.get(idOrCode);
    if (idOrCode.startsWith("code-")) {
      const code = idOrCode.slice(5);
      return this.accountByCode.get(code);
    }
    return this.accountByCode.get(idOrCode);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, recurlyError("internal_server_error", error.message || "error", 500).body);
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-recurly");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, recurlyError("not_found", "not found", 404).body);
    }

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, recurlyError("unauthorized", "Invalid API key", 401).body);
    }

    // /accounts ...
    if (parts[0] === "accounts") return this.handleAccounts(req, res, parts, body);
    // /plans ...
    if (parts[0] === "plans") return this.handlePlans(req, res, parts, body);
    // /purchases
    if (parts[0] === "purchases" && parts.length === 1 && req.method === "POST") {
      return this.purchase(res, body);
    }

    return this.send(res, 404, recurlyError("not_found", "not found", 404).body);
  }

  handleAccounts(req, res, parts, body) {
    // /accounts
    if (parts.length === 1) {
      if (req.method === "GET") return this.send(res, 200, list(Array.from(this.accounts.values())));
      if (req.method === "POST") return this.createAccount(res, body);
      return this.send(res, 405, recurlyError("method_not_allowed", "method not allowed", 405).body);
    }
    // /accounts/:id
    const account = this.resolveAccount(parts[1]);
    if (parts.length === 2) {
      if (!account) return this.send(res, 404, recurlyError("not_found", "account not found", 404).body);
      if (req.method === "GET") return this.send(res, 200, clone(account));
      if (req.method === "PUT" || req.method === "PATCH") {
        if (isPlainObject(body)) {
          if (typeof body.email === "string") account.email = body.email;
          if (typeof body.first_name === "string") account.first_name = body.first_name;
          if (typeof body.last_name === "string") account.last_name = body.last_name;
          account.updated_at = now();
        }
        return this.send(res, 200, clone(account));
      }
      if (req.method === "DELETE") {
        account.state = "inactive";
        account.updated_at = now();
        return this.send(res, 200, clone(account));
      }
      return this.send(res, 405, recurlyError("method_not_allowed", "method not allowed", 405).body);
    }
    // /accounts/:id/subscriptions
    if (parts.length === 3 && parts[2] === "subscriptions") {
      if (!account) return this.send(res, 404, recurlyError("not_found", "account not found", 404).body);
      if (req.method === "GET") {
        const subs = Array.from(this.subscriptions.values()).filter((s) => s.account.id === account.id);
        return this.send(res, 200, list(subs));
      }
      if (req.method === "POST") return this.createSubscription(res, account, body);
      return this.send(res, 405, recurlyError("method_not_allowed", "method not allowed", 405).body);
    }
    return this.send(res, 404, recurlyError("not_found", "not found", 404).body);
  }

  createAccount(res, body) {
    if (!isPlainObject(body) || typeof body.code !== "string" || !body.code) {
      return this.send(res, 422, recurlyError("validation", "code is required", 422).body);
    }
    if (this.accountByCode.has(body.code)) {
      return this.send(res, 422, recurlyError("validation", "account code already exists", 422).body);
    }
    const id = this.nextId();
    const account = {
      object: "account",
      id,
      code: body.code,
      state: "active",
      email: body.email || null,
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      company: body.company || null,
      created_at: now(),
      updated_at: now(),
    };
    this.accounts.set(id, account);
    this.accountByCode.set(body.code, account);
    return this.send(res, 201, clone(account));
  }

  createSubscription(res, account, body) {
    const planCode = body && (body.plan_code || (body.plan && body.plan.code));
    if (!planCode || !this.planByCode.has(planCode)) {
      return this.send(res, 422, recurlyError("validation", "valid plan_code is required", 422).body);
    }
    const plan = this.planByCode.get(planCode);
    const id = this.nextId();
    const subscription = {
      object: "subscription",
      id,
      uuid: token(32),
      account: { id: account.id, code: account.code, object: "account" },
      plan: { id: plan.id, code: plan.code, name: plan.name, object: "plan" },
      state: "active",
      currency: body.currency || "USD",
      quantity: body.quantity || 1,
      unit_amount: plan.currencies[0].unit_amount,
      current_period_started_at: now(),
      created_at: now(),
      updated_at: now(),
    };
    this.subscriptions.set(id, subscription);
    return this.send(res, 201, clone(subscription));
  }

  handlePlans(req, res, parts, body) {
    if (parts.length === 1) {
      if (req.method === "GET") return this.send(res, 200, list(Array.from(this.plans.values())));
      if (req.method === "POST") return this.createPlan(res, body);
      return this.send(res, 405, recurlyError("method_not_allowed", "method not allowed", 405).body);
    }
    if (parts.length === 2 && req.method === "GET") {
      const plan = this.plans.get(parts[1]) || this.planByCode.get(parts[1].replace(/^code-/, ""));
      if (!plan) return this.send(res, 404, recurlyError("not_found", "plan not found", 404).body);
      return this.send(res, 200, clone(plan));
    }
    return this.send(res, 404, recurlyError("not_found", "not found", 404).body);
  }

  createPlan(res, body) {
    if (!isPlainObject(body) || typeof body.code !== "string" || !body.code) {
      return this.send(res, 422, recurlyError("validation", "code is required", 422).body);
    }
    const id = this.nextId();
    const plan = {
      object: "plan",
      id,
      code: body.code,
      name: body.name || body.code,
      state: "active",
      currencies: Array.isArray(body.currencies) ? body.currencies : [{ currency: "USD", unit_amount: 0 }],
      interval_unit: body.interval_unit || "months",
      interval_length: body.interval_length || 1,
      created_at: now(),
      updated_at: now(),
    };
    this.plans.set(id, plan);
    this.planByCode.set(body.code, plan);
    return this.send(res, 201, clone(plan));
  }

  purchase(res, body) {
    if (!isPlainObject(body) || !body.account || !body.currency) {
      return this.send(res, 422, recurlyError("validation", "account and currency are required", 422).body);
    }
    const id = this.nextId();
    const charged = {
      object: "invoice_collection",
      charge_invoice: {
        object: "invoice",
        id,
        state: "paid",
        currency: body.currency,
        total: 10.0,
        account: { code: body.account.code || null, object: "account" },
        created_at: now(),
      },
    };
    this.purchases.set(id, charged);
    return this.send(res, 201, clone(charged));
  }

  root() {
    return { name: "recurly", version: "1", protocol: "recurly-v3", documentation: "/docs/recurly.md" };
  }

  isAuthorized(req) {
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
          this.send(res, 400, recurlyError("bad_request", "malformed JSON body", 400).body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, recurlyError("bad_request", "malformed body", 400).body);
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
