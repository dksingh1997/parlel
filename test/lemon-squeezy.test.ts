import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { LemonSqueezyServer } from "../services/lemon-squeezy/src/server.js";

const PORT = 14873;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-token", Accept: "application/vnd.api+json" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/vnd.api+json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Lemon Squeezy Service", () => {
  let server: LemonSqueezyServer;

  beforeAll(async () => {
    server = new LemonSqueezyServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("class is named LemonSqueezyServer on the right port", () => {
    expect(server.constructor.name).toBe("LemonSqueezyServer");
    expect(server.port).toBe(PORT);
  });

  it("returns root and health", async () => {
    const root = await api("GET", "/");
    const health = await api("GET", "/health");
    expect(root.body.name).toBe("lemon-squeezy");
    expect(health.body).toEqual({ status: "ok" });
  });

  it("requires bearer auth", async () => {
    const result = await api("GET", "/v1/products", undefined, {});
    expect(result.status).toBe(401);
  });

  it("returns the authenticated user (JSON:API single)", async () => {
    const result = await api("GET", "/v1/users/me");
    expect(result.status).toBe(200);
    expect(result.body.data.type).toBe("users");
    expect(result.body.data.attributes.email).toBe("owner@parlel.dev");
  });

  it("lists products as a JSON:API collection", async () => {
    const result = await api("GET", "/v1/products");
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.data)).toBe(true);
    expect(result.body.data[0].type).toBe("products");
    expect(result.body.data[0]).toHaveProperty("id");
    expect(result.body.data[0]).toHaveProperty("attributes");
    expect(result.body.meta.page).toHaveProperty("total");
  });

  it("retrieves a single product", async () => {
    const list = await api("GET", "/v1/products");
    const id = list.body.data[0].id;
    const result = await api("GET", `/v1/products/${id}`);
    expect(result.status).toBe(200);
    expect(result.body.data.id).toBe(id);
    expect(result.body.data.type).toBe("products");
  });

  it("lists orders, subscriptions and stores", async () => {
    const orders = await api("GET", "/v1/orders");
    expect(orders.body.data[0].type).toBe("orders");
    const subs = await api("GET", "/v1/subscriptions");
    expect(subs.body.data[0].type).toBe("subscriptions");
    const stores = await api("GET", "/v1/stores");
    expect(stores.body.data[0].type).toBe("stores");
  });

  it("creates and lists a checkout", async () => {
    const created = await api("POST", "/v1/checkouts", {
      data: {
        type: "checkouts",
        attributes: { custom_price: 5000, checkout_data: { email: "x@parlel.dev" } },
        relationships: { store: { data: { type: "stores", id: "1" } } },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.type).toBe("checkouts");
    expect(created.body.data.attributes.url).toMatch(/checkout/);

    const listed = await api("GET", "/v1/checkouts");
    expect(listed.body.data.length).toBe(1);
  });

  it("returns 404 for unknown product", async () => {
    const result = await api("GET", "/v1/products/99999");
    expect(result.status).toBe(404);
  });
});
