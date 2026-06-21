import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/razorpay — a dependency-free fake of the Razorpay v1 API.
//   /v1/orders, /v1/payments (+/capture), /v1/refunds, /v1/customers
// Basic auth (key_id:key_secret). JSON request/response. Ids like order_...,
// pay_..., rfnd_..., cust_.... State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rid() {
  return randomBytes(10).toString("hex").slice(0, 14);
}

function rzpError(description, code = "BAD_REQUEST_ERROR", field) {
  const error = { code, description };
  if (field) error.field = field;
  return { error };
}

export class RazorpayServer {
  constructor(port = 4761, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.orders = new Map();
    this.payments = new Map();
    this.refunds = new Map();
    this.customers = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, rzpError(error.message || "Internal server error", "SERVER_ERROR"));
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
    res.setHeader("server", "parlel-razorpay");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v1") return this.send(res, 404, rzpError("The requested URL was not found on the server.", "NOT_FOUND"));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, rzpError("Authentication failed", "BAD_REQUEST_ERROR"));
    }

    const route = parts.slice(1);
    if (route[0] === "orders") return this.handleOrders(req, res, route, body);
    if (route[0] === "payments") return this.handlePayments(req, res, route, body);
    if (route[0] === "refunds") return this.handleRefunds(req, res, route, body);
    if (route[0] === "customers") return this.handleCustomers(req, res, route, body);

    return this.send(res, 404, rzpError("The requested URL was not found on the server.", "NOT_FOUND"));
  }

  collection(store, key = "items") {
    const items = Array.from(store.values()).map(clone);
    return { entity: "collection", count: items.length, items };
  }

  handleOrders(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        if (body.amount === undefined) return this.send(res, 400, rzpError("amount is required", "BAD_REQUEST_ERROR", "amount"));
        const id = `order_${rid()}`;
        const obj = {
          id,
          entity: "order",
          amount: Number(body.amount),
          amount_paid: 0,
          amount_due: Number(body.amount),
          currency: body.currency ?? "INR",
          receipt: body.receipt ?? null,
          status: "created",
          attempts: 0,
          notes: body.notes ?? {},
          created_at: now(),
        };
        this.orders.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.collection(this.orders));
      return this.send(res, 405, rzpError("Method not allowed"));
    }
    const id = route[1];
    const obj = this.orders.get(id);
    if (route.length === 2 && req.method === "GET") {
      if (!obj) return this.send(res, 400, rzpError("The id provided does not exist", "BAD_REQUEST_ERROR", "id"));
      return this.send(res, 200, clone(obj));
    }
    return this.send(res, 404, rzpError("Not found", "NOT_FOUND"));
  }

  handlePayments(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        const id = `pay_${rid()}`;
        const obj = {
          id,
          entity: "payment",
          amount: body.amount !== undefined ? Number(body.amount) : 0,
          currency: body.currency ?? "INR",
          status: "captured",
          order_id: body.order_id ?? null,
          method: body.method ?? "card",
          captured: true,
          email: body.email ?? null,
          contact: body.contact ?? null,
          notes: body.notes ?? {},
          created_at: now(),
        };
        this.payments.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.collection(this.payments));
      return this.send(res, 405, rzpError("Method not allowed"));
    }
    const id = route[1];
    const obj = this.payments.get(id);
    if (route.length === 2 && req.method === "GET") {
      if (!obj) return this.send(res, 400, rzpError("The id provided does not exist", "BAD_REQUEST_ERROR", "id"));
      return this.send(res, 200, clone(obj));
    }
    if (route.length === 3 && route[2] === "capture" && req.method === "POST") {
      if (!obj) return this.send(res, 400, rzpError("The id provided does not exist", "BAD_REQUEST_ERROR", "id"));
      obj.status = "captured";
      obj.captured = true;
      if (body.amount !== undefined) obj.amount = Number(body.amount);
      return this.send(res, 200, clone(obj));
    }
    return this.send(res, 404, rzpError("Not found", "NOT_FOUND"));
  }

  handleRefunds(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        const payment = body.payment_id ? this.payments.get(body.payment_id) : null;
        const id = `rfnd_${rid()}`;
        const obj = {
          id,
          entity: "refund",
          amount: body.amount !== undefined ? Number(body.amount) : (payment ? payment.amount : 0),
          currency: payment ? payment.currency : (body.currency ?? "INR"),
          payment_id: body.payment_id ?? null,
          status: "processed",
          notes: body.notes ?? {},
          created_at: now(),
        };
        if (payment) { payment.status = "refunded"; }
        this.refunds.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.collection(this.refunds));
      return this.send(res, 405, rzpError("Method not allowed"));
    }
    const id = route[1];
    const obj = this.refunds.get(id);
    if (route.length === 2 && req.method === "GET") {
      if (!obj) return this.send(res, 400, rzpError("The id provided does not exist", "BAD_REQUEST_ERROR", "id"));
      return this.send(res, 200, clone(obj));
    }
    return this.send(res, 404, rzpError("Not found", "NOT_FOUND"));
  }

  handleCustomers(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        const id = `cust_${rid()}`;
        const obj = {
          id,
          entity: "customer",
          name: body.name ?? null,
          email: body.email ?? null,
          contact: body.contact ?? null,
          gstin: body.gstin ?? null,
          notes: body.notes ?? {},
          created_at: now(),
        };
        this.customers.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.collection(this.customers));
      return this.send(res, 405, rzpError("Method not allowed"));
    }
    const id = route[1];
    const obj = this.customers.get(id);
    if (route.length === 2 && req.method === "GET") {
      if (!obj) return this.send(res, 400, rzpError("The id provided does not exist", "BAD_REQUEST_ERROR", "id"));
      return this.send(res, 200, clone(obj));
    }
    return this.send(res, 404, rzpError("Not found", "NOT_FOUND"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, rzpError("Not Found", "NOT_FOUND"));
  }

  root() {
    return {
      name: "razorpay",
      version: "1.0",
      protocol: "razorpay-v1",
      documentation: "/docs/razorpay.md",
    };
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
        const ct = (req.headers["content-type"] || "").toLowerCase();
        try {
          if (ct.includes("application/x-www-form-urlencoded")) {
            resolve(Object.fromEntries(new URLSearchParams(data)));
          } else {
            resolve(JSON.parse(data));
          }
        } catch {
          this.send(res, 400, rzpError("Invalid request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, rzpError("Invalid request body"));
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
