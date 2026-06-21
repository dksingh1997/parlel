import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ShopifyServer } from "../services/shopify/src/server.js";

const PORT = 14758;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `/admin/api/2024-01`;
const AUTH = { "X-Shopify-Access-Token": "shpat_parlelTestToken" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Shopify Service", () => {
  let server: ShopifyServer;

  beforeAll(async () => {
    server = new ShopifyServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("shopify");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects requests without access token", async () => {
      const response = await fetch(`${BASE_URL}${API}/products.json`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts X-Shopify-Access-Token", async () => {
      const result = await api("GET", `${API}/products.json`);
      expect(result.status).toBe(200);
    });
  });

  describe("Products", () => {
    it("creates a product wrapped in { product }", async () => {
      const result = await api("POST", `${API}/products.json`, { product: { title: "Snowboard", vendor: "Parlel" } });
      expect(result.status).toBe(201);
      expect(result.body.product.id).toBeTruthy();
      expect(result.body.product.title).toBe("Snowboard");
      expect(result.body.product.created_at).toBeTruthy();
    });

    it("enriches a created product with server-derived fields", async () => {
      const result = await api("POST", `${API}/products.json`, { product: { title: "Burton Custom Freestyle 151" } });
      const p = result.body.product;
      // handle is slugified from title; status/published_scope/tags default.
      expect(p.handle).toBe("burton-custom-freestyle-151");
      expect(p.status).toBe("active");
      expect(p.published_scope).toBe("web");
      expect(p.tags).toBe("");
      // a default variant + option are synthesized like the real API.
      expect(Array.isArray(p.variants)).toBe(true);
      expect(p.variants.length).toBe(1);
      expect(p.variants[0].title).toBe("Default Title");
      expect(p.variants[0].price).toBe("0.00");
      expect(p.variants[0].admin_graphql_api_id).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
      expect(Array.isArray(p.options)).toBe(true);
      expect(p.options[0].name).toBe("Title");
      expect(p.images).toEqual([]);
      expect(p.image).toBeNull();
      expect(p.admin_graphql_api_id).toMatch(/^gid:\/\/shopify\/Product\//);
    });

    it("rejects a product without a title with 422 { errors: { title: [...] } }", async () => {
      const result = await api("POST", `${API}/products.json`, { product: { body_html: "A mystery!" } });
      expect(result.status).toBe(422);
      expect(result.body.errors).toEqual({ title: ["can't be blank"] });
    });

    it("lists products under { products }", async () => {
      await api("POST", `${API}/products.json`, { product: { title: "A" } });
      await api("POST", `${API}/products.json`, { product: { title: "B" } });
      const list = await api("GET", `${API}/products.json`);
      expect(Array.isArray(list.body.products)).toBe(true);
      expect(list.body.products.length).toBe(2);
    });

    it("honors ids, since_id and limit list filters", async () => {
      const a = await api("POST", `${API}/products.json`, { product: { title: "A" } });
      const b = await api("POST", `${API}/products.json`, { product: { title: "B" } });
      const c = await api("POST", `${API}/products.json`, { product: { title: "C" } });
      const idA = a.body.product.id;
      const idB = b.body.product.id;
      const idC = c.body.product.id;

      const byIds = await api("GET", `${API}/products.json?ids=${idA},${idC}`);
      expect(byIds.body.products.map((p: Json) => p.id).sort()).toEqual([idA, idC].sort());

      const sinceA = await api("GET", `${API}/products.json?since_id=${idA}`);
      expect(sinceA.body.products.map((p: Json) => p.id).sort()).toEqual([idB, idC].sort());

      const limited = await api("GET", `${API}/products.json?limit=1`);
      expect(limited.body.products.length).toBe(1);
    });

    it("returns a count under { count }", async () => {
      await api("POST", `${API}/products.json`, { product: { title: "A" } });
      await api("POST", `${API}/products.json`, { product: { title: "B" } });
      const count = await api("GET", `${API}/products/count.json`);
      expect(count.status).toBe(200);
      expect(count.body).toEqual({ count: 2 });
    });

    it("retrieves, updates and deletes a product", async () => {
      const created = await api("POST", `${API}/products.json`, { product: { title: "X" } });
      const id = created.body.product.id;
      const got = await api("GET", `${API}/products/${id}.json`);
      expect(got.body.product.id).toBe(id);
      const updated = await api("PUT", `${API}/products/${id}.json`, { product: { title: "Renamed" } });
      expect(updated.body.product.title).toBe("Renamed");
      const deleted = await api("DELETE", `${API}/products/${id}.json`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `${API}/products/${id}.json`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Orders", () => {
    it("creates and lists orders", async () => {
      const created = await api("POST", `${API}/orders.json`, { order: { email: "buyer@parlel.dev" } });
      expect(created.status).toBe(201);
      const list = await api("GET", `${API}/orders.json`);
      expect(list.body.orders.length).toBe(1);
    });
  });

  describe("Customers", () => {
    it("creates and lists customers", async () => {
      const created = await api("POST", `${API}/customers.json`, { customer: { first_name: "Jane", email: "j@parlel.dev" } });
      expect(created.status).toBe(201);
      expect(created.body.customer.first_name).toBe("Jane");
      const list = await api("GET", `${API}/customers.json`);
      expect(list.body.customers.length).toBe(1);
    });

    it("enriches a created customer with server-derived fields", async () => {
      const created = await api("POST", `${API}/customers.json`, {
        customer: { first_name: "Steve", last_name: "Lastnameson", email: "steve@example.com" },
      });
      const c = created.body.customer;
      expect(c.state).toBe("enabled");
      expect(c.total_spent).toBe("0.00");
      expect(c.orders_count).toBe(0);
      expect(c.tax_exempt).toBe(false);
      expect(c.verified_email).toBe(false);
      expect(c.tags).toBe("");
      expect(c.admin_graphql_api_id).toMatch(/^gid:\/\/shopify\/Customer\//);
      expect(c.email_marketing_consent.state).toBe("not_subscribed");
    });

    it("rejects a customer with no email or name with 422", async () => {
      const result = await api("POST", `${API}/customers.json`, { customer: { email: null, first_name: null, last_name: null } });
      expect(result.status).toBe(422);
      expect(result.body.errors).toBeTypeOf("object");
    });

    it("rejects a duplicate email with 422 { errors: { email: [...] } }", async () => {
      await api("POST", `${API}/customers.json`, { customer: { email: "dup@example.com", first_name: "A" } });
      const result = await api("POST", `${API}/customers.json`, { customer: { email: "dup@example.com", first_name: "B" } });
      expect(result.status).toBe(422);
      expect(result.body.errors).toEqual({ email: ["has already been taken"] });
    });
  });

  describe("Shop", () => {
    it("returns shop info", async () => {
      const result = await api("GET", `${API}/shop.json`);
      expect(result.status).toBe(200);
      expect(result.body.shop.myshopify_domain).toContain(".myshopify.com");
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", `${API}/products.json`, { product: { title: "A" } });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await api("GET", `${API}/products.json`);
      expect(list.body.products.length).toBe(0);
    });
  });
});
