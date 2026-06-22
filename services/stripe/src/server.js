import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/stripe — a tiny, dependency-free fake of the Stripe REST API.
//
// Stripe accepts application/x-www-form-urlencoded request bodies (including
// PHP-style bracket notation, e.g. metadata[key]=value) and returns JSON.
// This server speaks that wire protocol so application code and the official
// `stripe` SDK can run against it with zero cost. State is in-memory and
// ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_BODY = Symbol("bad-body");

function now() {
  return Math.floor(Date.now() / 1000);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function token(len = 24) {
  return randomBytes(Math.ceil(len * 0.8)).toString("base64").replace(/[+/=]/g, "").slice(0, len);
}

// Stripe error envelope. Stripe orders keys as type, code, doc_url, message, param.
function stripeError(message, type = "invalid_request_error", code, param, docUrl) {
  const error = { type };
  if (code) error.code = code;
  if (docUrl) error.doc_url = docUrl;
  error.message = message;
  if (param) error.param = param;
  return { error };
}

// -------------------------------------------------------------------------
// urlencoded body parser with bracket notation support.
//   a=1&b[c]=2&b[d][e]=3&items[0][id]=x  ->  { a:"1", b:{c:"2",d:{e:"3"}}, items:[{id:"x"}] }
// -------------------------------------------------------------------------
function parseFormEncoded(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const val = decodeURIComponent(rawVal.replace(/\+/g, " "));
    assignBracketPath(out, key, val);
  }
  return out;
}

function assignBracketPath(root, key, val) {
  // Parse "a[b][0][c]" into ["a","b","0","c"].
  const segments = [];
  const head = key.match(/^[^[]+/);
  if (!head) return;
  segments.push(head[0]);
  const rest = key.slice(head[0].length);
  const re = /\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    segments.push(m[1]);
  }

  let node = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    const nextSeg = segments[i + 1];
    const nextIsIndex = nextSeg !== undefined && /^\d+$/.test(nextSeg);

    if (last) {
      if (Array.isArray(node)) node.push(val);
      else node[seg] = val;
    } else {
      let child = Array.isArray(node) ? node[Number(seg)] : node[seg];
      if (child === undefined || typeof child !== "object") {
        child = nextIsIndex ? [] : {};
        if (Array.isArray(node)) node[Number(seg) || node.length] = child;
        else node[seg] = child;
      }
      node = child;
    }
  }
}

export class StripeServer {
  constructor(port = 4757, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.customers = new Map();
    this.charges = new Map();
    this.paymentIntents = new Map();
    this.refunds = new Map();
    this.products = new Map();
    this.prices = new Map();
    this.sessions = new Map();
    this.counter = 0;
  }

  nextId(prefix) {
    this.counter += 1;
    return `${prefix}_${token(24)}`;
  }

  // Preload fixture objects so a test can assume they already exist (e.g. a
  // customer to charge). Accepts { customers: [...], products: [...], prices: [...] }.
  // Each entry may include its own `id` (so tests can reference cus_test, etc.);
  // otherwise one is generated. Used by the Parlel control plane / fixtures.
  seed(data = {}) {
    const counts = { customers: 0, products: 0, prices: 0 };
    for (const c of data.customers || []) {
      const id = c.id || this.nextId("cus");
      this.customers.set(id, {
        id,
        object: "customer",
        created: now(),
        livemode: false,
        email: c.email ?? null,
        name: c.name ?? null,
        description: c.description ?? null,
        phone: c.phone ?? null,
        address: c.address ?? null,
        balance: c.balance !== undefined ? Number(c.balance) : 0,
        currency: null,
        default_source: null,
        delinquent: false,
        discount: null,
        invoice_prefix: c.invoice_prefix ?? null,
        invoice_settings: { custom_fields: null, default_payment_method: null, footer: null, rendering_options: null },
        shipping: c.shipping ?? null,
        tax_exempt: c.tax_exempt ?? "none",
        metadata: c.metadata ?? {},
      });
      counts.customers++;
    }
    for (const p of data.products || []) {
      const id = p.id || this.nextId("prod");
      this.products.set(id, {
        id,
        object: "product",
        active: p.active ?? true,
        created: now(),
        name: p.name ?? "Product",
        description: p.description ?? null,
        metadata: p.metadata ?? {},
      });
      counts.products++;
    }
    for (const pr of data.prices || []) {
      const id = pr.id || this.nextId("price");
      this.prices.set(id, {
        id,
        object: "price",
        active: pr.active ?? true,
        created: now(),
        currency: pr.currency ?? "usd",
        product: pr.product ?? null,
        unit_amount: pr.unit_amount !== undefined ? Number(pr.unit_amount) : null,
        metadata: pr.metadata ?? {},
      });
      counts.prices++;
    }
    return counts;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, stripeError(error.message || "Internal server error", "api_error"));
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
    if (body === SENTINEL_BAD_BODY) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Stripe-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-stripe");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (parts[0] !== "v1") return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));

    if (!this.isAuthorized(req)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Stripe"');
      return this.send(res, 401, stripeError(
        "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY').",
        "invalid_request_error",
        "authentication_required",
        undefined,
        "https://stripe.com/docs/api/authentication",
      ));
    }

    const route = parts.slice(1);
    const query = Object.fromEntries(url.searchParams.entries());

    try {
      if (route[0] === "customers") return this.handleCustomers(req, res, route, body, query);
      if (route[0] === "charges") return this.handleCharges(req, res, route, body, query);
      if (route[0] === "payment_intents") return this.handlePaymentIntents(req, res, route, body, query);
      if (route[0] === "refunds") return this.handleRefunds(req, res, route, body, query);
      if (route[0] === "products") return this.handleProducts(req, res, route, body, query);
      if (route[0] === "prices") return this.handlePrices(req, res, route, body, query);
      if (route[0] === "balance") return this.handleBalance(req, res, route);
      if (route[0] === "checkout" && route[1] === "sessions") return this.handleSessions(req, res, route, body, query);
    } catch (err) {
      return this.send(res, 400, stripeError(err.message || "Bad request"));
    }

    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  // ---- list helper -------------------------------------------------------
  // Stripe cursor pagination: limit (1-100, default 10) plus the mutually
  // exclusive cursors starting_after / ending_before referencing object ids in
  // insertion order. has_more reflects whether more objects exist beyond the
  // returned page. See https://docs.stripe.com/api/pagination.
  listResponse(store, urlPath, query) {
    const all = Array.from(store.values()).map(clone);

    let limit = query && query.limit !== undefined ? Number(query.limit) : 10;
    if (!Number.isFinite(limit)) limit = 10;
    limit = Math.min(100, Math.max(1, Math.trunc(limit)));

    const startingAfter = query && query.starting_after;
    const endingBefore = query && query.ending_before;

    let startIndex = 0;
    let endIndex = all.length;

    if (startingAfter) {
      const idx = all.findIndex((item) => item.id === startingAfter);
      if (idx !== -1) startIndex = idx + 1;
    }
    if (endingBefore) {
      const idx = all.findIndex((item) => item.id === endingBefore);
      if (idx !== -1) endIndex = idx;
    }

    const window = all.slice(startIndex, endIndex);

    let data;
    let has_more;
    if (endingBefore) {
      // Page backwards: take the last `limit` items before the cursor.
      data = window.slice(Math.max(0, window.length - limit));
      has_more = window.length > limit;
    } else {
      data = window.slice(0, limit);
      has_more = window.length > limit;
    }

    return { object: "list", data, has_more, url: urlPath };
  }

  // ---- customers ---------------------------------------------------------
  handleCustomers(req, res, route, body, query) {
    if (route.length === 1) {
      if (req.method === "POST") {
        const id = this.nextId("cus");
        const obj = {
          id,
          object: "customer",
          created: now(),
          livemode: false,
          email: body.email ?? null,
          name: body.name ?? null,
          description: body.description ?? null,
          phone: body.phone ?? null,
          address: body.address ?? null,
          balance: body.balance !== undefined ? Number(body.balance) : 0,
          currency: null,
          default_source: null,
          delinquent: false,
          discount: null,
          invoice_prefix: body.invoice_prefix ?? null,
          invoice_settings: {
            custom_fields: null,
            default_payment_method: null,
            footer: null,
            rendering_options: null,
          },
          shipping: body.shipping ?? null,
          tax_exempt: body.tax_exempt ?? "none",
          metadata: body.metadata ?? {},
        };
        this.customers.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.listResponse(this.customers, "/v1/customers", query));
      return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
    }
    const id = route[1];
    const obj = this.customers.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!obj) return this.notFound(res, "customer", id);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "POST") {
        if (!obj) return this.notFound(res, "customer", id);
        for (const k of ["email", "name", "description", "phone", "address", "shipping", "invoice_prefix", "tax_exempt"]) {
          if (body[k] !== undefined) obj[k] = body[k];
        }
        if (body.balance !== undefined) obj.balance = Number(body.balance);
        if (body.metadata !== undefined) obj.metadata = body.metadata;
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "DELETE") {
        if (!obj) return this.notFound(res, "customer", id);
        this.customers.delete(id);
        return this.send(res, 200, { id, object: "customer", deleted: true });
      }
    }
    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  // ---- charges -----------------------------------------------------------
  handleCharges(req, res, route, body, query) {
    if (route.length === 1) {
      if (req.method === "POST") {
        const id = this.nextId("ch");
        const obj = {
          id,
          object: "charge",
          created: now(),
          livemode: false,
          amount: body.amount !== undefined ? Number(body.amount) : 0,
          amount_captured: body.capture !== "false" ? (body.amount !== undefined ? Number(body.amount) : 0) : 0,
          amount_refunded: 0,
          currency: body.currency ?? "usd",
          customer: body.customer ?? null,
          description: body.description ?? null,
          status: "succeeded",
          paid: true,
          captured: body.capture !== "false",
          refunded: false,
          disputed: false,
          balance_transaction: null,
          payment_intent: body.payment_intent ?? null,
          payment_method: body.payment_method ?? null,
          payment_method_details: null,
          billing_details: {
            address: null,
            email: null,
            name: null,
            phone: null,
          },
          outcome: null,
          receipt_url: null,
          receipt_email: body.receipt_email ?? null,
          metadata: body.metadata ?? {},
        };
        this.charges.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.listResponse(this.charges, "/v1/charges", query));
      return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
    }
    const id = route[1];
    const obj = this.charges.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!obj) return this.notFound(res, "charge", id);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "POST") {
        if (!obj) return this.notFound(res, "charge", id);
        if (body.description !== undefined) obj.description = body.description;
        if (body.metadata !== undefined) obj.metadata = body.metadata;
        return this.send(res, 200, clone(obj));
      }
    }
    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  // ---- payment intents ---------------------------------------------------
  handlePaymentIntents(req, res, route, body, query) {
    if (route.length === 1) {
      if (req.method === "POST") {
        if (body.amount === undefined) {
          return this.send(res, 400, stripeError("Missing required param: amount.", "invalid_request_error", "parameter_missing", "amount"));
        }
        const id = this.nextId("pi");
        const obj = {
          id,
          object: "payment_intent",
          created: now(),
          livemode: false,
          amount: Number(body.amount),
          amount_received: 0,
          amount_capturable: 0,
          currency: body.currency ?? "usd",
          customer: body.customer ?? null,
          description: body.description ?? null,
          // Real default (automatic confirmation, no payment method yet) is
          // requires_payment_method. https://docs.stripe.com/api/payment_intents/object
          status: "requires_payment_method",
          capture_method: body.capture_method ?? "automatic",
          confirmation_method: body.confirmation_method ?? "automatic",
          payment_method_types: ["card"],
          client_secret: `${id}_secret_${token(16)}`,
          payment_method: body.payment_method ?? null,
          latest_charge: null,
          next_action: null,
          canceled_at: null,
          cancellation_reason: null,
          metadata: body.metadata ?? {},
        };
        if (body.confirm === "true") {
          obj.status = "succeeded";
          obj.amount_received = obj.amount;
        }
        this.paymentIntents.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.listResponse(this.paymentIntents, "/v1/payment_intents", query));
      return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
    }
    const id = route[1];
    const obj = this.paymentIntents.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!obj) return this.notFound(res, "payment_intent", id);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "POST") {
        if (!obj) return this.notFound(res, "payment_intent", id);
        for (const k of ["amount", "currency", "description", "customer", "payment_method"]) {
          if (body[k] !== undefined) obj[k] = k === "amount" ? Number(body[k]) : body[k];
        }
        if (body.metadata !== undefined) obj.metadata = body.metadata;
        return this.send(res, 200, clone(obj));
      }
    }
    if (route.length === 3 && route[2] === "confirm" && req.method === "POST") {
      if (!obj) return this.notFound(res, "payment_intent", id);
      if (body.payment_method !== undefined) obj.payment_method = body.payment_method;
      // Manual-capture intents move to requires_capture after confirmation;
      // automatic ones succeed immediately (no real card auth — by design).
      if (obj.capture_method === "manual") {
        obj.status = "requires_capture";
        obj.amount_capturable = obj.amount;
      } else {
        obj.status = "succeeded";
        obj.amount_received = obj.amount;
      }
      return this.send(res, 200, clone(obj));
    }
    if (route.length === 3 && route[2] === "capture" && req.method === "POST") {
      if (!obj) return this.notFound(res, "payment_intent", id);
      const captured = body.amount_to_capture !== undefined ? Number(body.amount_to_capture) : obj.amount;
      obj.status = "succeeded";
      obj.amount_received = captured;
      obj.amount_capturable = 0;
      return this.send(res, 200, clone(obj));
    }
    if (route.length === 3 && route[2] === "cancel" && req.method === "POST") {
      if (!obj) return this.notFound(res, "payment_intent", id);
      obj.status = "canceled";
      obj.canceled_at = now();
      obj.cancellation_reason = body.cancellation_reason ?? null;
      return this.send(res, 200, clone(obj));
    }
    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  // ---- refunds -----------------------------------------------------------
  handleRefunds(req, res, route, body, query) {
    if (route.length === 1) {
      if (req.method === "POST") {
        const charge = body.charge ? this.charges.get(body.charge) : null;
        const id = this.nextId("re");
        const obj = {
          id,
          object: "refund",
          created: now(),
          charge: body.charge ?? null,
          payment_intent: body.payment_intent ?? null,
          amount: body.amount !== undefined ? Number(body.amount) : (charge ? charge.amount : 0),
          currency: charge ? charge.currency : (body.currency ?? "usd"),
          status: "succeeded",
          reason: body.reason ?? null,
          balance_transaction: null,
          receipt_number: null,
          metadata: body.metadata ?? {},
        };
        if (charge) {
          charge.refunded = true;
          charge.amount_refunded = obj.amount;
        }
        this.refunds.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.listResponse(this.refunds, "/v1/refunds", query));
      return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
    }
    const id = route[1];
    const obj = this.refunds.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!obj) return this.notFound(res, "refund", id);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "POST") {
        // Real API only allows updating metadata on a refund.
        if (!obj) return this.notFound(res, "refund", id);
        if (body.metadata !== undefined) obj.metadata = body.metadata;
        return this.send(res, 200, clone(obj));
      }
    }
    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  // ---- products ----------------------------------------------------------
  handleProducts(req, res, route, body, query) {
    if (route.length === 1) {
      if (req.method === "POST") {
        if (!body.name) return this.send(res, 400, stripeError("Missing required param: name.", "invalid_request_error", "parameter_missing", "name"));
        const id = this.nextId("prod");
        const obj = {
          id,
          object: "product",
          created: now(),
          livemode: false,
          name: body.name,
          description: body.description ?? null,
          active: body.active === undefined ? true : body.active !== "false",
          metadata: body.metadata ?? {},
        };
        this.products.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.listResponse(this.products, "/v1/products", query));
      return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
    }
    const id = route[1];
    const obj = this.products.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!obj) return this.notFound(res, "product", id);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "POST") {
        if (!obj) return this.notFound(res, "product", id);
        if (body.name !== undefined) obj.name = body.name;
        if (body.description !== undefined) obj.description = body.description;
        if (body.active !== undefined) obj.active = body.active !== "false";
        if (body.metadata !== undefined) obj.metadata = body.metadata;
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "DELETE") {
        if (!obj) return this.notFound(res, "product", id);
        this.products.delete(id);
        return this.send(res, 200, { id, object: "product", deleted: true });
      }
    }
    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  // ---- prices ------------------------------------------------------------
  handlePrices(req, res, route, body, query) {
    if (route.length === 1) {
      if (req.method === "POST") {
        // Real API requires currency, a product reference, and an amount.
        // https://docs.stripe.com/api/prices/create
        if (body.currency === undefined) {
          return this.send(res, 400, stripeError("Missing required param: currency.", "invalid_request_error", "parameter_missing", "currency"));
        }
        if (body.product === undefined && body.product_data === undefined) {
          return this.send(res, 400, stripeError("Missing required param: product.", "invalid_request_error", "parameter_missing", "product"));
        }
        if (body.unit_amount === undefined && body.unit_amount_decimal === undefined && body.custom_unit_amount === undefined) {
          return this.send(res, 400, stripeError("Missing required param: unit_amount.", "invalid_request_error", "parameter_missing", "unit_amount"));
        }
        const id = this.nextId("price");
        const recurring = body.recurring ?? null;
        const obj = {
          id,
          object: "price",
          created: now(),
          livemode: false,
          active: body.active === undefined ? true : body.active !== "false",
          billing_scheme: "per_unit",
          currency: body.currency,
          nickname: body.nickname ?? null,
          product: body.product ?? null,
          recurring,
          tax_behavior: body.tax_behavior ?? "unspecified",
          type: recurring ? "recurring" : "one_time",
          unit_amount: body.unit_amount !== undefined ? Number(body.unit_amount) : null,
          unit_amount_decimal: body.unit_amount_decimal ?? (body.unit_amount !== undefined ? String(body.unit_amount) : null),
          metadata: body.metadata ?? {},
        };
        this.prices.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.listResponse(this.prices, "/v1/prices", query));
      return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
    }
    const id = route[1];
    const obj = this.prices.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!obj) return this.notFound(res, "price", id);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "POST") {
        if (!obj) return this.notFound(res, "price", id);
        if (body.active !== undefined) obj.active = body.active !== "false";
        if (body.metadata !== undefined) obj.metadata = body.metadata;
        return this.send(res, 200, clone(obj));
      }
    }
    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  // ---- balance -----------------------------------------------------------
  handleBalance(req, res, route) {
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, {
        object: "balance",
        livemode: false,
        available: [{ amount: 0, currency: "usd", source_types: { card: 0 } }],
        pending: [{ amount: 0, currency: "usd", source_types: { card: 0 } }],
      });
    }
    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  // ---- checkout sessions -------------------------------------------------
  handleSessions(req, res, route, body, query) {
    // route = ["checkout","sessions", ...]
    if (route.length === 2) {
      if (req.method === "POST") {
        const id = this.nextId("cs");
        const obj = {
          id,
          object: "checkout.session",
          created: now(),
          livemode: false,
          mode: body.mode ?? "payment",
          status: "open",
          payment_status: "unpaid",
          currency: body.currency ?? "usd",
          customer: body.customer ?? null,
          customer_email: body.customer_email ?? null,
          client_reference_id: body.client_reference_id ?? null,
          amount_subtotal: null,
          amount_total: null,
          payment_intent: null,
          payment_method_types: ["card"],
          expires_at: now() + 24 * 60 * 60,
          success_url: body.success_url ?? null,
          cancel_url: body.cancel_url ?? null,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          line_items: body.line_items ?? null,
          metadata: body.metadata ?? {},
        };
        this.sessions.set(id, obj);
        return this.send(res, 200, clone(obj));
      }
      if (req.method === "GET") return this.send(res, 200, this.listResponse(this.sessions, "/v1/checkout/sessions", query));
      return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
    }
    const id = route[2];
    const obj = this.sessions.get(id);
    if (route.length === 3 && req.method === "GET") {
      if (!obj) return this.notFound(res, "checkout.session", id);
      return this.send(res, 200, clone(obj));
    }
    if (route.length === 4 && route[3] === "expire" && req.method === "POST") {
      if (!obj) return this.notFound(res, "checkout.session", id);
      obj.status = "expired";
      return this.send(res, 200, clone(obj));
    }
    return this.send(res, 404, stripeError("Unrecognized request URL.", "invalid_request_error"));
  }

  notFound(res, resource, id) {
    return this.send(res, 404, stripeError(
      `No such ${resource}: '${id}'`,
      "invalid_request_error",
      "resource_missing",
      "id",
    ));
  }

  // ---- parlel control ----------------------------------------------------
  handleControl(req, res, parts, body = {}) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "POST" && parts[1] === "seed") {
      const counts = this.seed(body || {});
      return this.send(res, 200, { ok: true, seeded: counts });
    }
    return this.send(res, 404, stripeError("not found"));
  }

  root() {
    return {
      name: "stripe",
      version: "1.0",
      protocol: "stripe-v1",
      documentation: "/docs/stripe.md",
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
          if (ct.includes("application/json")) {
            resolve(JSON.parse(data));
          } else {
            // Stripe default: application/x-www-form-urlencoded (incl. brackets).
            resolve(parseFormEncoded(data));
          }
        } catch {
          this.send(res, 400, stripeError("Invalid request body"));
          resolve(SENTINEL_BAD_BODY);
        }
      });
      req.on("error", () => {
        this.send(res, 400, stripeError("Invalid request body"));
        resolve(SENTINEL_BAD_BODY);
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
