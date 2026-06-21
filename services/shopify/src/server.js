import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/shopify — a dependency-free fake of the Shopify Admin REST API
// (2024-01). Resources are wrapped (e.g. { "product": {...} }) and listed
// under a plural key (e.g. { "products": [...] }). Auth via the
// X-Shopify-Access-Token header. State is in-memory and ephemeral.
//
// Fidelity notes (matched to shopify.dev Admin REST reference):
//   - Required-field validation returns 422 with the field-keyed envelope
//     { "errors": { "title": ["can't be blank"] } } (products: title;
//     customers: email-or-name + unique email).
//   - Create responses are enriched with server-derived fields the real API
//     adds (product: handle/status/default variant+option/images; customer:
//     state/total_spent/orders_count/consent objects).
//   - List endpoints honor ids / limit (<=250) / since_id query params, and
//     /<resource>/count.json returns { "count": N }.
// ---------------------------------------------------------------------------

const API_VERSION = "2024-01";

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

// Shopify uses two error envelopes:
//   - a string for auth/routing/not-found (`{ "errors": "Not Found" }`)
//   - a field-keyed object (or bare array) for 422 validation
//     (`{ "errors": { "title": ["can't be blank"] } }`)
function shopifyError(message) {
  return { errors: message };
}

function validationError(fields) {
  return { errors: fields };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class ShopifyServer {
  constructor(port = 4758, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.products = new Map();
    this.orders = new Map();
    this.customers = new Map();
    this.counter = 1000000000;
    this.shop = {
      id: 1,
      name: "Parlel Test Shop",
      email: "owner@parlel.dev",
      domain: "parlel-test.myshopify.com",
      myshopify_domain: "parlel-test.myshopify.com",
      currency: "USD",
      plan_name: "partner_test",
      created_at: nowIso(),
    };
  }

  nextId() {
    this.counter += 1;
    return this.counter;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, shopifyError(error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Headers", "X-Shopify-Access-Token, Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-shopify");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Expect /admin/api/2024-01/<resource>.json...
    if (parts[0] !== "admin" || parts[1] !== "api" || parts[2] !== API_VERSION) {
      return this.send(res, 404, shopifyError("Not Found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, shopifyError("[API] Invalid API key or access token (unrecognized login or wrong password)"));
    }

    // route after the version prefix, with trailing ".json" stripped.
    const route = parts.slice(3).map((p) => p.replace(/\.json$/, ""));
    const resource = route[0];

    if (resource === "shop") return this.handleShop(req, res, route);
    if (resource === "products") return this.handleCrud(req, res, route, body, url, this.products, "product", "products");
    if (resource === "orders") return this.handleCrud(req, res, route, body, url, this.orders, "order", "orders");
    if (resource === "customers") return this.handleCrud(req, res, route, body, url, this.customers, "customer", "customers");

    return this.send(res, 404, shopifyError("Not Found"));
  }

  handleShop(req, res, route) {
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { shop: clone(this.shop) });
    }
    return this.send(res, 404, shopifyError("Not Found"));
  }

  handleCrud(req, res, route, body, url, store, singular, plural) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, { [plural]: this.queryList(store, url) });
      }
      if (req.method === "POST") {
        const payload = isPlainObject(body) && isPlainObject(body[singular]) ? body[singular] : {};
        const errors = this.validate(singular, payload, store, null);
        if (errors) return this.send(res, 422, validationError(errors));
        const id = this.nextId();
        const record = this.buildRecord(singular, payload, id);
        store.set(id, record);
        return this.send(res, 201, { [singular]: clone(record) });
      }
      return this.send(res, 405, shopifyError("Method Not Allowed"));
    }

    // /<resource>/count
    if (route.length === 2 && route[1] === "count") {
      if (req.method === "GET") {
        return this.send(res, 200, { count: this.queryList(store, url).length });
      }
      return this.send(res, 405, shopifyError("Method Not Allowed"));
    }

    const id = Number(route[1]);
    const record = store.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!record) return this.send(res, 404, shopifyError("Not Found"));
        return this.send(res, 200, { [singular]: clone(record) });
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        if (!record) return this.send(res, 404, shopifyError("Not Found"));
        const payload = isPlainObject(body) && isPlainObject(body[singular]) ? body[singular] : {};
        const errors = this.validate(singular, { ...record, ...payload }, store, id);
        if (errors) return this.send(res, 422, validationError(errors));
        Object.assign(record, clone(payload), { id, updated_at: nowIso() });
        return this.send(res, 200, { [singular]: clone(record) });
      }
      if (req.method === "DELETE") {
        if (!record) return this.send(res, 404, shopifyError("Not Found"));
        store.delete(id);
        return this.send(res, 200, {});
      }
    }
    return this.send(res, 404, shopifyError("Not Found"));
  }

  // List with the real query-param filters Shopify honors: ids, limit, since_id.
  queryList(store, url) {
    let records = Array.from(store.values()).map(clone);
    const params = url.searchParams;

    const idsParam = params.get("ids");
    if (idsParam) {
      const wanted = new Set(idsParam.split(",").map((s) => Number(s.trim())));
      records = records.filter((r) => wanted.has(r.id));
    }

    const sinceId = params.get("since_id");
    if (sinceId) {
      const since = Number(sinceId);
      records = records.filter((r) => r.id > since);
    }

    const limitParam = params.get("limit");
    if (limitParam) {
      const limit = Math.min(Math.max(Number(limitParam) || 0, 0), 250);
      if (limit > 0) records = records.slice(0, limit);
    }

    return records;
  }

  // Required-field validation matching Shopify's 422 envelope shapes.
  validate(singular, payload, store, selfId) {
    if (singular === "product") {
      const title = payload && payload.title;
      if (title === undefined || title === null || String(title).trim() === "") {
        return { title: ["can't be blank"] };
      }
      return null;
    }
    if (singular === "customer") {
      const hasEmail = payload && typeof payload.email === "string" && payload.email.trim() !== "";
      const hasName =
        (payload && typeof payload.first_name === "string" && payload.first_name.trim() !== "") ||
        (payload && typeof payload.last_name === "string" && payload.last_name.trim() !== "");
      if (!hasEmail && !hasName) {
        return { base: ["Email or name is required"] };
      }
      if (hasEmail) {
        for (const existing of store.values()) {
          if (existing.id !== selfId && existing.email && existing.email.toLowerCase() === payload.email.toLowerCase()) {
            return { email: ["has already been taken"] };
          }
        }
      }
      return null;
    }
    return null;
  }

  // Build a record enriched with the server-derived fields the real API returns.
  buildRecord(singular, payload, id) {
    const base = {
      ...clone(payload),
      id,
      admin_graphql_api_id: `gid://shopify/${cap(singular)}/${id}`,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    if (singular === "product") {
      const variantId = this.nextId();
      const optionId = this.nextId();
      return {
        ...base,
        body_html: base.body_html ?? null,
        vendor: base.vendor ?? "",
        product_type: base.product_type ?? "",
        handle: base.handle ?? slugify(base.title),
        published_at: base.published_at ?? null,
        template_suffix: base.template_suffix ?? null,
        published_scope: base.published_scope ?? "web",
        tags: base.tags ?? "",
        status: base.status ?? "active",
        variants: Array.isArray(base.variants) && base.variants.length
          ? base.variants
          : [{
              id: variantId,
              product_id: id,
              title: "Default Title",
              price: "0.00",
              position: 1,
              inventory_policy: "deny",
              compare_at_price: null,
              option1: "Default Title",
              option2: null,
              option3: null,
              created_at: base.created_at,
              updated_at: base.updated_at,
              taxable: true,
              barcode: null,
              fulfillment_service: "manual",
              grams: 0,
              inventory_management: null,
              requires_shipping: true,
              sku: null,
              weight: 0,
              weight_unit: "lb",
              inventory_item_id: variantId,
              inventory_quantity: 0,
              admin_graphql_api_id: `gid://shopify/ProductVariant/${variantId}`,
            }],
        options: Array.isArray(base.options) && base.options.length
          ? base.options
          : [{ id: optionId, product_id: id, name: "Title", position: 1, values: ["Default Title"] }],
        images: Array.isArray(base.images) ? base.images : [],
        image: base.image ?? null,
      };
    }

    if (singular === "customer") {
      return {
        ...base,
        first_name: base.first_name ?? null,
        last_name: base.last_name ?? null,
        email: base.email ?? null,
        phone: base.phone ?? null,
        state: base.state ?? "enabled",
        note: base.note ?? null,
        verified_email: base.verified_email ?? false,
        tax_exempt: base.tax_exempt ?? false,
        tags: base.tags ?? "",
        currency: base.currency ?? this.shop.currency,
        orders_count: 0,
        total_spent: "0.00",
        last_order_id: null,
        last_order_name: null,
        multipass_identifier: null,
        addresses: Array.isArray(base.addresses) ? base.addresses : [],
        tax_exemptions: Array.isArray(base.tax_exemptions) ? base.tax_exemptions : [],
        email_marketing_consent: base.email_marketing_consent ?? {
          state: "not_subscribed",
          opt_in_level: "single_opt_in",
          consent_updated_at: null,
        },
        sms_marketing_consent: base.sms_marketing_consent ?? null,
      };
    }

    if (singular === "order") {
      const number = id % 100000;
      return {
        ...base,
        name: base.name ?? `#${1000 + (number % 9000)}`,
        currency: base.currency ?? this.shop.currency,
        financial_status: base.financial_status ?? "pending",
        fulfillment_status: base.fulfillment_status ?? null,
        total_price: base.total_price ?? "0.00",
        line_items: Array.isArray(base.line_items) ? base.line_items : [],
      };
    }

    return base;
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, shopifyError("Not Found"));
  }

  root() {
    return {
      name: "shopify",
      version: "1.0",
      protocol: "shopify-admin-rest",
      documentation: "/docs/shopify.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const tokenHeader = req.headers["x-shopify-access-token"];
    if (typeof tokenHeader === "string" && tokenHeader.length > 0) return true;
    // Basic auth (private app key:password) is also accepted by Shopify.
    return /^Basic\s+\S+/i.test(req.headers.authorization || "");
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
          this.send(res, 400, shopifyError("Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, shopifyError("Bad request body"));
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
