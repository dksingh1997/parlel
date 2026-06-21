import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/paypal — a dependency-free fake of the PayPal Orders v2 API.
//   POST /v1/oauth2/token            -> { access_token, ... }
//   POST /v2/checkout/orders         -> create order (CREATED)
//   GET  /v2/checkout/orders/:id     -> retrieve order
//   POST /v2/checkout/orders/:id/capture -> capture (COMPLETED)
//   POST /v2/payments                -> create a payment/capture record
// State is in-memory and ephemeral.
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

function token(len = 22) {
  return randomBytes(Math.ceil(len * 0.8)).toString("base64").replace(/[+/=]/g, "").slice(0, len).toUpperCase();
}

function paypalError(name, message, status = 400) {
  return { name, message, debug_id: token(20) };
}

export class PaypalServer {
  constructor(port = 4760, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.orders = new Map();
    this.payments = new Map();
    this.tokens = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, paypalError("INTERNAL_SERVER_ERROR", error.message || "Internal server error", 500));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, PayPal-Request-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-paypal");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // OAuth token exchange — uses Basic (client_id:secret).
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "oauth2" && parts[2] === "token") {
      if (this.requireAuth && !/^Basic\s+\S+/i.test(req.headers.authorization || "")) {
        return this.send(res, 401, paypalError("invalid_client", "Client Authentication failed", 401));
      }
      const access = `A21AA${token(60)}`;
      this.tokens.add(access);
      return this.send(res, 200, {
        scope: "https://uri.paypal.com/services/payments/payment",
        access_token: access,
        token_type: "Bearer",
        app_id: "APP-parlel",
        expires_in: 32400,
        nonce: token(40),
      });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, paypalError("AUTHENTICATION_FAILURE", "Authentication failed due to invalid authentication credentials.", 401));
    }

    // /v2/checkout/orders
    if (parts[0] === "v2" && parts[1] === "checkout" && parts[2] === "orders") {
      return this.handleOrders(req, res, parts.slice(3), body);
    }
    // /v2/payments
    if (parts[0] === "v2" && parts[1] === "payments") {
      return this.handlePayments(req, res, parts.slice(2), body);
    }

    return this.send(res, 404, paypalError("RESOURCE_NOT_FOUND", "The specified resource does not exist.", 404));
  }

  handleOrders(req, res, route, body) {
    if (route.length === 0) {
      if (req.method === "POST") {
        const id = token(17);
        const order = {
          id,
          status: "CREATED",
          intent: body.intent ?? "CAPTURE",
          purchase_units: clone(body.purchase_units) ?? [],
          create_time: new Date().toISOString(),
          links: [
            { href: `http://${this.host}:${this.port}/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
            { href: `http://${this.host}:${this.port}/v2/checkout/orders/${id}/capture`, rel: "capture", method: "POST" },
          ],
        };
        this.orders.set(id, order);
        return this.send(res, 201, clone(order));
      }
      return this.send(res, 405, paypalError("METHOD_NOT_ALLOWED", "Method not allowed.", 405));
    }

    const id = route[0];
    const order = this.orders.get(id);
    if (route.length === 1 && req.method === "GET") {
      if (!order) return this.send(res, 404, paypalError("RESOURCE_NOT_FOUND", "The specified resource does not exist.", 404));
      return this.send(res, 200, clone(order));
    }
    if (route.length === 2 && route[1] === "capture" && req.method === "POST") {
      if (!order) return this.send(res, 404, paypalError("RESOURCE_NOT_FOUND", "The specified resource does not exist.", 404));
      order.status = "COMPLETED";
      const captureId = token(17);
      const unit = (order.purchase_units && order.purchase_units[0]) || {};
      order.purchase_units = [
        {
          ...unit,
          payments: {
            captures: [
              {
                id: captureId,
                status: "COMPLETED",
                amount: unit.amount ?? { currency_code: "USD", value: "0.00" },
                final_capture: true,
                create_time: new Date().toISOString(),
              },
            ],
          },
        },
      ];
      return this.send(res, 201, clone(order));
    }
    return this.send(res, 404, paypalError("RESOURCE_NOT_FOUND", "The specified resource does not exist.", 404));
  }

  handlePayments(req, res, route, body) {
    if (route.length === 0 && req.method === "POST") {
      const id = token(17);
      const payment = {
        id,
        status: "COMPLETED",
        amount: clone(body.amount) ?? { currency_code: "USD", value: "0.00" },
        create_time: new Date().toISOString(),
        ...clone(body),
      };
      payment.id = id;
      this.payments.set(id, payment);
      return this.send(res, 201, clone(payment));
    }
    if (route.length === 2 && route[0] === "captures" && req.method === "GET") {
      const payment = this.payments.get(route[1]);
      if (!payment) return this.send(res, 404, paypalError("RESOURCE_NOT_FOUND", "The specified resource does not exist.", 404));
      return this.send(res, 200, clone(payment));
    }
    return this.send(res, 404, paypalError("RESOURCE_NOT_FOUND", "The specified resource does not exist.", 404));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, paypalError("RESOURCE_NOT_FOUND", "Not Found", 404));
  }

  root() {
    return {
      name: "paypal",
      version: "1.0",
      protocol: "paypal-orders-v2",
      documentation: "/docs/paypal.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth) || /^Basic\s+\S+/i.test(auth);
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
          this.send(res, 400, paypalError("INVALID_REQUEST", "Request is not well-formed.", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, paypalError("INVALID_REQUEST", "Request is not well-formed.", 400));
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
