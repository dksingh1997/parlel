import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/lemon-squeezy — a tiny, dependency-free fake of the Lemon Squeezy API.
//
// JSON:API. Bearer-authenticated, expects Accept: application/vnd.api+json.
// Single resource: { data: { type, id, attributes: {...} }, jsonapi }.
// Collection: { data: [...], meta: { page: {...} }, links }.
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

function now() {
  return new Date().toISOString();
}

function lsError(title, detail, status = 422) {
  return {
    status,
    body: {
      jsonapi: { version: "1.0" },
      errors: [{ status: String(status), title, detail }],
    },
  };
}

export class LemonSqueezyServer {
  constructor(port = 4873, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.products = new Map();
    this.orders = new Map();
    this.checkouts = new Map();
    this.subscriptions = new Map();
    this.stores = new Map();
    this.counter = 0;
    this._seed();
  }

  nextId() {
    this.counter += 1;
    return String(this.counter);
  }

  _seed() {
    const storeId = this.nextId();
    this.stores.set(storeId, {
      type: "stores", id: storeId,
      attributes: { name: "Parlel Store", slug: "parlel", domain: "parlel.lemonsqueezy.com", currency: "USD", created_at: now(), updated_at: now() },
    });
    const productId = this.nextId();
    this.products.set(productId, {
      type: "products", id: productId,
      attributes: { store_id: Number(storeId), name: "Pro Plan", slug: "pro-plan", price: 2900, status: "published", created_at: now(), updated_at: now() },
    });
    const orderId = this.nextId();
    this.orders.set(orderId, {
      type: "orders", id: orderId,
      attributes: { store_id: Number(storeId), identifier: randomBytes(16).toString("hex"), order_number: 1, user_email: "buyer@parlel.dev", total: 2900, status: "paid", created_at: now(), updated_at: now() },
    });
    const subId = this.nextId();
    this.subscriptions.set(subId, {
      type: "subscriptions", id: subId,
      attributes: { store_id: Number(storeId), product_id: Number(productId), user_email: "buyer@parlel.dev", status: "active", created_at: now(), updated_at: now() },
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, lsError("server_error", error.message || "error", 500).body);
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

    res.setHeader("Content-Type", "application/vnd.api+json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-lemon-squeezy");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, lsError("not_found", "not found", 404).body);
    }

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, lsError("unauthenticated", "Bearer token required", 401).body);
    }

    if (parts[0] !== "v1") return this.send(res, 404, lsError("not_found", "not found", 404).body);
    const route = parts.slice(1);

    if (route[0] === "users" && route[1] === "me" && req.method === "GET") {
      return this.send(res, 200, this.single({
        type: "users", id: "1",
        attributes: { name: "Parlel Tester", email: "owner@parlel.dev", color: "#7047EB", created_at: now(), updated_at: now() },
      }, false));
    }

    const collections = {
      products: this.products,
      orders: this.orders,
      checkouts: this.checkouts,
      subscriptions: this.subscriptions,
      stores: this.stores,
    };

    const name = route[0];
    if (!(name in collections)) {
      return this.send(res, 404, lsError("not_found", `unknown resource /${name}`, 404).body);
    }
    const store = collections[name];

    // POST /v1/checkouts
    if (name === "checkouts" && route.length === 1 && req.method === "POST") {
      return this.createCheckout(res, body);
    }

    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, this.list(Array.from(store.values())));
    }
    if (route.length === 2 && req.method === "GET") {
      const item = store.get(route[1]);
      if (!item) return this.send(res, 404, lsError("not_found", `${name} not found`, 404).body);
      return this.send(res, 200, this.single(item));
    }

    return this.send(res, 404, lsError("not_found", "not found", 404).body);
  }

  single(resource, withSelf = true) {
    const out = { jsonapi: { version: "1.0" }, data: clone(resource) };
    if (withSelf) {
      out.data.links = { self: `http://${this.host}:${this.port}/v1/${resource.type}/${resource.id}` };
      out.links = { self: out.data.links.self };
    }
    return out;
  }

  list(items) {
    return {
      jsonapi: { version: "1.0" },
      meta: { page: { currentPage: 1, from: items.length ? 1 : 0, lastPage: 1, perPage: 60, to: items.length, total: items.length } },
      data: items.map(clone),
      links: { first: `http://${this.host}:${this.port}/v1`, last: `http://${this.host}:${this.port}/v1` },
    };
  }

  createCheckout(res, body) {
    const data = (isPlainObject(body) && body.data) || {};
    const attrs = data.attributes || {};
    const id = this.nextId();
    const uuid = randomBytes(16).toString("hex");
    const checkout = {
      type: "checkouts",
      id,
      attributes: {
        store_id: attrs.store_id || (data.relationships && data.relationships.store ? Number(data.relationships.store.data.id) : 1),
        variant_id: attrs.variant_id || null,
        custom_price: attrs.custom_price || null,
        checkout_data: attrs.checkout_data || {},
        url: `https://parlel.lemonsqueezy.com/checkout/${uuid}`,
        created_at: now(),
        updated_at: now(),
      },
    };
    this.checkouts.set(id, checkout);
    return this.send(res, 201, this.single(checkout));
  }

  root() {
    return { name: "lemon-squeezy", version: "1", protocol: "lemonsqueezy-jsonapi", documentation: "/docs/lemon-squeezy.md" };
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
          this.send(res, 400, lsError("bad_request", "malformed JSON body", 400).body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, lsError("bad_request", "malformed body", 400).body);
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
