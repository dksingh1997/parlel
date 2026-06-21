import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WebflowServer } from "../services/webflow/src/server.js";

const PORT = 14843;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlelToken" };
const COLLECTION = "blog-posts";

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Webflow Service", () => {
  let server: WebflowServer;

  beforeAll(async () => {
    server = new WebflowServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await api("GET", "/");
      expect(root.body.name).toBe("webflow");
      const health = await api("GET", "/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("auth", () => {
    it("401 without bearer", async () => {
      const r = await fetch(`${BASE_URL}/v2/sites`);
      expect(r.status).toBe(401);
    });
  });

  describe("sites", () => {
    it("lists sites", async () => {
      const r = await api("GET", "/v2/sites");
      expect(r.status).toBe(200);
      expect(r.body.sites.length).toBeGreaterThanOrEqual(1);
    });

    it("gets a site by id", async () => {
      const r = await api("GET", "/v2/sites/parlel-site");
      expect(r.status).toBe(200);
      expect(r.body.id).toBe("parlel-site");
    });

    it("404 for unknown site", async () => {
      const r = await api("GET", "/v2/sites/nope");
      expect(r.status).toBe(404);
    });
  });

  describe("collections", () => {
    it("gets a collection", async () => {
      const r = await api("GET", `/v2/collections/${COLLECTION}`);
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(COLLECTION);
    });
  });

  describe("collection items CRUD", () => {
    it("creates an item (202) with cmsLocaleId + fieldData", async () => {
      const r = await api("POST", `/v2/collections/${COLLECTION}/items`, {
        fieldData: { name: "Post One", slug: "post-one" },
      });
      expect(r.status).toBe(202);
      expect(r.body.id).toBeTruthy();
      expect(r.body.cmsLocaleId).toBeTruthy();
      expect(r.body.fieldData.name).toBe("Post One");
    });

    it("lists items with pagination wrapper", async () => {
      await api("POST", `/v2/collections/${COLLECTION}/items`, { fieldData: { name: "A", slug: "a" } });
      await api("POST", `/v2/collections/${COLLECTION}/items`, { fieldData: { name: "B", slug: "b" } });
      const r = await api("GET", `/v2/collections/${COLLECTION}/items`);
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBe(2);
      expect(r.body.pagination.total).toBe(2);
      expect(typeof r.body.pagination.limit).toBe("number");
      expect(typeof r.body.pagination.offset).toBe("number");
    });

    it("gets a single item", async () => {
      const created = await api("POST", `/v2/collections/${COLLECTION}/items`, { fieldData: { name: "G", slug: "g" } });
      const r = await api("GET", `/v2/collections/${COLLECTION}/items/${created.body.id}`);
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(created.body.id);
    });

    it("patches an item", async () => {
      const created = await api("POST", `/v2/collections/${COLLECTION}/items`, { fieldData: { name: "v1", slug: "v" } });
      const r = await api("PATCH", `/v2/collections/${COLLECTION}/items/${created.body.id}`, {
        fieldData: { name: "v2" },
      });
      expect(r.status).toBe(200);
      expect(r.body.fieldData.name).toBe("v2");
      expect(r.body.fieldData.slug).toBe("v");
    });

    it("deletes an item", async () => {
      const created = await api("POST", `/v2/collections/${COLLECTION}/items`, { fieldData: { name: "d", slug: "d" } });
      const del = await api("DELETE", `/v2/collections/${COLLECTION}/items/${created.body.id}`);
      expect(del.status).toBe(204);
      const after = await api("GET", `/v2/collections/${COLLECTION}/items/${created.body.id}`);
      expect(after.status).toBe(404);
    });

    it("404 listing items of unknown collection", async () => {
      const r = await api("GET", "/v2/collections/unknown/items");
      expect(r.status).toBe(404);
    });
  });

  describe("reset", () => {
    it("clears items", async () => {
      await api("POST", `/v2/collections/${COLLECTION}/items`, { fieldData: { name: "r", slug: "r" } });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const r = await api("GET", `/v2/collections/${COLLECTION}/items`);
      expect(r.body.pagination.total).toBe(0);
    });
  });
});
