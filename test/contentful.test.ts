import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ContentfulServer } from "../services/contentful/src/server.js";

const PORT = 14841;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlelToken" };
const SPACE = "parlel";
const ENV = "master";
const PREFIX = `/spaces/${SPACE}/environments/${ENV}`;

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

describe("Contentful Service", () => {
  let server: ContentfulServer;

  beforeAll(async () => {
    server = new ContentfulServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await api("GET", "/");
      expect(root.body.name).toBe("contentful");
      const health = await api("GET", "/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("auth", () => {
    it("401 without bearer", async () => {
      const r = await fetch(`${BASE_URL}${PREFIX}/entries`);
      expect(r.status).toBe(401);
      expect((await r.json()).sys.id).toBe("AccessTokenInvalid");
    });
  });

  describe("content types", () => {
    it("lists content types with Array envelope", async () => {
      const r = await api("GET", `${PREFIX}/content_types`);
      expect(r.status).toBe(200);
      expect(r.body.sys.type).toBe("Array");
      expect(r.body.items.length).toBeGreaterThanOrEqual(1);
    });

    it("gets a single content type", async () => {
      const r = await api("GET", `${PREFIX}/content_types/blogPost`);
      expect(r.status).toBe(200);
      expect(r.body.sys.id).toBe("blogPost");
    });
  });

  describe("entries CRUD", () => {
    it("creates an entry (PUT with explicit id)", async () => {
      const r = await api("PUT", `${PREFIX}/entries/post-1`, {
        fields: { title: { "en-US": "Hello" }, body: { "en-US": "World" } },
      }, { ...AUTH, "X-Contentful-Content-Type": "blogPost" });
      expect(r.status).toBe(201);
      expect(r.body.sys.id).toBe("post-1");
      expect(r.body.sys.type).toBe("Entry");
      expect(r.body.fields.title["en-US"]).toBe("Hello");
      expect(r.body.sys.contentType.sys.id).toBe("blogPost");
    });

    it("creates an entry (POST, generated id)", async () => {
      const r = await api("POST", `${PREFIX}/entries`, {
        fields: { title: { "en-US": "Generated" } },
      }, { ...AUTH, "X-Contentful-Content-Type": "blogPost" });
      expect(r.status).toBe(201);
      expect(r.body.sys.id).toBeTruthy();
    });

    it("gets an entry", async () => {
      await api("PUT", `${PREFIX}/entries/get-me`, { fields: { title: { "en-US": "G" } } });
      const r = await api("GET", `${PREFIX}/entries/get-me`);
      expect(r.status).toBe(200);
      expect(r.body.sys.id).toBe("get-me");
    });

    it("404 for unknown entry", async () => {
      const r = await api("GET", `${PREFIX}/entries/nope`);
      expect(r.status).toBe(404);
    });

    it("lists entries with total/skip/limit", async () => {
      await api("PUT", `${PREFIX}/entries/e1`, { fields: { title: { "en-US": "1" } } });
      await api("PUT", `${PREFIX}/entries/e2`, { fields: { title: { "en-US": "2" } } });
      const r = await api("GET", `${PREFIX}/entries`);
      expect(r.status).toBe(200);
      expect(r.body.sys.type).toBe("Array");
      expect(r.body.total).toBe(2);
      expect(r.body.skip).toBe(0);
      expect(typeof r.body.limit).toBe("number");
    });

    it("filters entries by content_type", async () => {
      await api("PUT", `${PREFIX}/entries/e1`, { fields: { title: { "en-US": "1" } } },
        { ...AUTH, "X-Contentful-Content-Type": "blogPost" });
      const r = await api("GET", `${PREFIX}/entries?content_type=blogPost`);
      expect(r.body.total).toBe(1);
    });

    it("updates an entry via PUT", async () => {
      await api("PUT", `${PREFIX}/entries/up`, { fields: { title: { "en-US": "v1" } } });
      const r = await api("PUT", `${PREFIX}/entries/up`, { fields: { title: { "en-US": "v2" } } });
      expect(r.status).toBe(200);
      expect(r.body.fields.title["en-US"]).toBe("v2");
      expect(r.body.sys.version).toBeGreaterThan(1);
    });

    it("deletes an entry", async () => {
      await api("PUT", `${PREFIX}/entries/del`, { fields: {} });
      const d = await api("DELETE", `${PREFIX}/entries/del`);
      expect(d.status).toBe(204);
      const after = await api("GET", `${PREFIX}/entries/del`);
      expect(after.status).toBe(404);
    });
  });

  describe("reset", () => {
    it("clears entries", async () => {
      await api("PUT", `${PREFIX}/entries/r`, { fields: {} });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const r = await api("GET", `${PREFIX}/entries`);
      expect(r.body.total).toBe(0);
    });
  });
});
