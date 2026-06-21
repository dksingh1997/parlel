import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/square — a dependency-free fake of the Square API (v2).
//   /v2/payments, /v2/customers, /v2/orders, /v2/locations
// Bearer auth. JSON. Single responses are wrapped in the singular key
// ({ payment: {...} }) and lists in the plural key ({ payments: [...] }).
// Errors use { errors: [{ category, code, detail }] }. State is in-memory and
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

function sqId() {
  return randomBytes(16).toString("base64").replace(/[+/=]/g, "").slice(0, 22).toUpperCase();
}

function squareError(code, detail, category = "INVALID_REQUEST_ERROR", field) {
  const error = { category, code, detail };
  if (field) error.field = field;
  return { errors: [error] };
}

export class SquareServer {
  constructor(port = 4766, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.payments = new Map();
    this.customers = new Map();
    this.orders = new Map();
    this.idempotency = new Map();
    this.locations = [
      {
        id: "L_PARLEL_MAIN",
        name: "Parlel Test Location",
        status: "ACTIVE",
        currency: "USD",
        country: "US",
        type: "PHYSICAL",
        created_at: nowIso(),
      },
    ];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, squareError("INTERNAL_SERVER_ERROR", error.message || "Internal server error", "API_ERROR"));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Square-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-square");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v2") return this.send(res, 404, squareError("NOT_FOUND", "Resource not found", "INVALID_REQUEST_ERROR"));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, squareError("UNAUTHORIZED", "This request could not be authorized.", "AUTHENTICATION_ERROR"));
    }

    const route = parts.slice(1);
    if (route[0] === "payments") return this.handlePayments(req, res, route, body);
    if (route[0] === "customers") return this.handleCustomers(req, res, route, body);
    if (route[0] === "orders") return this.handleOrders(req, res, route, body);
    if (route[0] === "locations") return this.handleLocations(req, res, route);

    return this.send(res, 404, squareError("NOT_FOUND", "Resource not found", "INVALID_REQUEST_ERROR"));
  }

  handlePayments(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        if (!body.idempotency_key) {
          return this.send(res, 400, squareError("MISSING_REQUIRED_PARAMETER", "Missing required parameter.", "INVALID_REQUEST_ERROR", "idempotency_key"));
        }
        if (this.idempotency.has(body.idempotency_key)) {
          return this.send(res, 200, clone(this.idempotency.get(body.idempotency_key)));
        }
        const id = sqId();
        const payment = {
          id,
          status: "COMPLETED",
          amount_money: body.amount_money ?? { amount: 0, currency: "USD" },
          source_type: "CARD",
          location_id: body.location_id ?? this.locations[0].id,
          order_id: body.order_id ?? null,
          customer_id: body.customer_id ?? null,
          reference_id: body.reference_id ?? null,
          note: body.note ?? null,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        this.payments.set(id, payment);
        const response = { payment: clone(payment) };
        this.idempotency.set(body.idempotency_key, response);
        return this.send(res, 200, response);
      }
      if (req.method === "GET") {
        return this.send(res, 200, { payments: Array.from(this.payments.values()).map(clone) });
      }
      return this.send(res, 405, squareError("METHOD_NOT_ALLOWED", "Method not allowed", "INVALID_REQUEST_ERROR"));
    }
    const id = route[1];
    const payment = this.payments.get(id);
    if (route.length === 2 && req.method === "GET") {
      if (!payment) return this.send(res, 404, squareError("NOT_FOUND", "Payment not found", "INVALID_REQUEST_ERROR"));
      return this.send(res, 200, { payment: clone(payment) });
    }
    return this.send(res, 404, squareError("NOT_FOUND", "Resource not found", "INVALID_REQUEST_ERROR"));
  }

  handleCustomers(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        const id = sqId();
        const customer = {
          id,
          given_name: body.given_name ?? null,
          family_name: body.family_name ?? null,
          email_address: body.email_address ?? null,
          phone_number: body.phone_number ?? null,
          reference_id: body.reference_id ?? null,
          created_at: nowIso(),
          updated_at: nowIso(),
          version: 0,
        };
        this.customers.set(id, customer);
        return this.send(res, 200, { customer: clone(customer) });
      }
      if (req.method === "GET") {
        return this.send(res, 200, { customers: Array.from(this.customers.values()).map(clone) });
      }
      return this.send(res, 405, squareError("METHOD_NOT_ALLOWED", "Method not allowed", "INVALID_REQUEST_ERROR"));
    }
    const id = route[1];
    const customer = this.customers.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!customer) return this.send(res, 404, squareError("NOT_FOUND", "Customer not found", "INVALID_REQUEST_ERROR"));
        return this.send(res, 200, { customer: clone(customer) });
      }
      if (req.method === "PUT") {
        if (!customer) return this.send(res, 404, squareError("NOT_FOUND", "Customer not found", "INVALID_REQUEST_ERROR"));
        Object.assign(customer, isPlainObject(body) ? clone(body) : {}, { id, updated_at: nowIso(), version: (customer.version || 0) + 1 });
        return this.send(res, 200, { customer: clone(customer) });
      }
      if (req.method === "DELETE") {
        if (!customer) return this.send(res, 404, squareError("NOT_FOUND", "Customer not found", "INVALID_REQUEST_ERROR"));
        this.customers.delete(id);
        return this.send(res, 200, {});
      }
    }
    return this.send(res, 404, squareError("NOT_FOUND", "Resource not found", "INVALID_REQUEST_ERROR"));
  }

  handleOrders(req, res, route, body) {
    if (route.length === 1 && req.method === "POST") {
      const id = sqId();
      const incoming = isPlainObject(body.order) ? body.order : {};
      const order = {
        id,
        location_id: incoming.location_id ?? this.locations[0].id,
        line_items: incoming.line_items ?? [],
        state: "OPEN",
        version: 1,
        total_money: incoming.total_money ?? { amount: 0, currency: "USD" },
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      this.orders.set(id, order);
      return this.send(res, 200, { order: clone(order) });
    }
    if (route.length === 2 && route[1] && req.method === "GET") {
      const order = this.orders.get(route[1]);
      if (!order) return this.send(res, 404, squareError("NOT_FOUND", "Order not found", "INVALID_REQUEST_ERROR"));
      return this.send(res, 200, { order: clone(order) });
    }
    // POST /v2/orders/search
    if (route.length === 2 && route[1] === "search" && req.method === "POST") {
      return this.send(res, 200, { orders: Array.from(this.orders.values()).map(clone) });
    }
    return this.send(res, 404, squareError("NOT_FOUND", "Resource not found", "INVALID_REQUEST_ERROR"));
  }

  handleLocations(req, res, route) {
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { locations: clone(this.locations) });
    }
    if (route.length === 2 && req.method === "GET") {
      const loc = this.locations.find((l) => l.id === route[1]);
      if (!loc) return this.send(res, 404, squareError("NOT_FOUND", "Location not found", "INVALID_REQUEST_ERROR"));
      return this.send(res, 200, { location: clone(loc) });
    }
    return this.send(res, 404, squareError("NOT_FOUND", "Resource not found", "INVALID_REQUEST_ERROR"));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, squareError("NOT_FOUND", "Not Found", "INVALID_REQUEST_ERROR"));
  }

  root() {
    return {
      name: "square",
      version: "1.0",
      protocol: "square-v2",
      documentation: "/docs/square.md",
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
          this.send(res, 400, squareError("BAD_REQUEST", "Invalid request body", "INVALID_REQUEST_ERROR"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, squareError("BAD_REQUEST", "Invalid request body", "INVALID_REQUEST_ERROR"));
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
