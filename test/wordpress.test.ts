import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WordpressServer } from "../services/wordpress/src/server.js";

const PORT = 14844;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = "Basic " + Buffer.from("parlel:apppassword").toString("base64");
const AUTH = { Authorization: BASIC };
const WP = "/wp-json/wp/v2";

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("WordPress Service", () => {
  let server: WordpressServer;

  beforeAll(async () => {
    server = new WordpressServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await api("GET", "/");
      expect(root.body.name).toBe("wordpress");
      const health = await api("GET", "/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("auth", () => {
    it("401 creating a post without basic auth", async () => {
      const r = await api("POST", `${WP}/posts`, { title: "x", content: "y" });
      expect(r.status).toBe(401);
    });

    it("401 for users/me without auth", async () => {
      const r = await api("GET", `${WP}/users/me`);
      expect(r.status).toBe(401);
    });

    it("users/me with auth returns the current user", async () => {
      const r = await api("GET", `${WP}/users/me`, undefined, AUTH);
      expect(r.status).toBe(200);
      expect(r.body.slug).toBe("parlel");
      expect(r.body.roles).toContain("administrator");
    });
  });

  describe("posts CRUD", () => {
    it("creates a post with rendered title/content shape", async () => {
      const r = await api("POST", `${WP}/posts`, { title: "Hello World", content: "Body", status: "publish" }, AUTH);
      expect(r.status).toBe(201);
      expect(r.body.id).toBeTruthy();
      expect(r.body.title.rendered).toBe("Hello World");
      expect(r.body.content.rendered).toBe("Body");
      expect(r.body.status).toBe("publish");
      expect(r.body.slug).toBe("hello-world");
    });

    it("lists posts (public, no auth) and sets X-WP-Total", async () => {
      await api("POST", `${WP}/posts`, { title: "A", content: "a" }, AUTH);
      await api("POST", `${WP}/posts`, { title: "B", content: "b" }, AUTH);
      const r = await api("GET", `${WP}/posts`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBe(2);
      expect(r.headers.get("x-wp-total")).toBe("2");
    });

    it("gets a single post", async () => {
      const created = await api("POST", `${WP}/posts`, { title: "G", content: "g" }, AUTH);
      const r = await api("GET", `${WP}/posts/${created.body.id}`);
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(created.body.id);
    });

    it("updates a post via POST", async () => {
      const created = await api("POST", `${WP}/posts`, { title: "v1", content: "c" }, AUTH);
      const r = await api("POST", `${WP}/posts/${created.body.id}`, { title: "v2" }, AUTH);
      expect(r.status).toBe(200);
      expect(r.body.title.rendered).toBe("v2");
    });

    it("deletes a post (force)", async () => {
      const created = await api("POST", `${WP}/posts`, { title: "d", content: "d" }, AUTH);
      const del = await api("DELETE", `${WP}/posts/${created.body.id}?force=true`, undefined, AUTH);
      expect(del.status).toBe(200);
      expect(del.body.deleted).toBe(true);
      const after = await api("GET", `${WP}/posts/${created.body.id}`);
      expect(after.status).toBe(404);
    });

    it("404 for unknown post", async () => {
      const r = await api("GET", `${WP}/posts/99999`);
      expect(r.status).toBe(404);
    });
  });

  describe("pages", () => {
    it("creates and lists pages", async () => {
      const created = await api("POST", `${WP}/pages`, { title: "About", content: "about" }, AUTH);
      expect(created.status).toBe(201);
      expect(created.body.type).toBe("page");
      const list = await api("GET", `${WP}/pages`);
      expect(list.body.length).toBe(1);
    });
  });

  describe("categories", () => {
    it("lists the seeded Uncategorized category", async () => {
      const r = await api("GET", `${WP}/categories`);
      expect(r.status).toBe(200);
      expect(r.body.some((c: Json) => c.slug === "uncategorized")).toBe(true);
    });

    it("creates a category", async () => {
      const r = await api("POST", `${WP}/categories`, { name: "News" }, AUTH);
      expect(r.status).toBe(201);
      expect(r.body.name).toBe("News");
      expect(r.body.slug).toBe("news");
    });

    it("401 creating a category without auth", async () => {
      const r = await api("POST", `${WP}/categories`, { name: "x" });
      expect(r.status).toBe(401);
    });
  });

  describe("reset", () => {
    it("clears posts", async () => {
      await api("POST", `${WP}/posts`, { title: "r", content: "r" }, AUTH);
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const r = await api("GET", `${WP}/posts`);
      expect(r.body.length).toBe(0);
    });
  });
});
