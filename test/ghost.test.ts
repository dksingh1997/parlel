import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GhostServer } from "../services/ghost/src/server.js";

const PORT = 14845;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_AUTH = { Authorization: "Ghost parlelJwtToken" };
const KEY = "parlelContentKey";

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function createPost(post: Json) {
  return api("POST", "/ghost/api/admin/posts/", { posts: [post] }, ADMIN_AUTH);
}

describe("Ghost Service", () => {
  let server: GhostServer;

  beforeAll(async () => {
    server = new GhostServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await api("GET", "/");
      expect(root.body.name).toBe("ghost");
      const health = await api("GET", "/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("auth", () => {
    it("Content API 401 without ?key=", async () => {
      const r = await api("GET", "/ghost/api/content/posts/");
      expect(r.status).toBe(401);
    });

    it("Admin API 401 without Bearer/Ghost auth", async () => {
      const r = await api("POST", "/ghost/api/admin/posts/", { posts: [{ title: "x" }] });
      expect(r.status).toBe(401);
    });
  });

  describe("Admin API — posts", () => {
    it("creates a post with the Ghost post shape", async () => {
      const r = await createPost({ title: "Hello Ghost", html: "<p>Body</p>", status: "published" });
      expect(r.status).toBe(201);
      const post = r.body.posts[0];
      expect(post.id).toBeTruthy();
      expect(post.uuid).toBeTruthy();
      expect(post.title).toBe("Hello Ghost");
      expect(post.slug).toBe("hello-ghost");
      expect(post.html).toBe("<p>Body</p>");
      expect(post.status).toBe("published");
    });

    it("rejects post creation without a title (422)", async () => {
      const r = await createPost({ html: "<p>no title</p>" });
      expect(r.status).toBe(422);
    });

    it("lists posts (admin sees drafts too)", async () => {
      await createPost({ title: "Draft", status: "draft" });
      await createPost({ title: "Pub", status: "published" });
      const r = await api("GET", "/ghost/api/admin/posts/", undefined, ADMIN_AUTH);
      expect(r.status).toBe(200);
      expect(r.body.posts.length).toBe(2);
      expect(r.body.meta.pagination.total).toBe(2);
    });

    it("updates a post via PUT", async () => {
      const created = await createPost({ title: "v1", status: "draft" });
      const id = created.body.posts[0].id;
      const r = await api("PUT", `/ghost/api/admin/posts/${id}`, { posts: [{ title: "v2", status: "published" }] }, ADMIN_AUTH);
      expect(r.status).toBe(200);
      expect(r.body.posts[0].title).toBe("v2");
      expect(r.body.posts[0].status).toBe("published");
      expect(r.body.posts[0].published_at).toBeTruthy();
    });

    it("deletes a post", async () => {
      const created = await createPost({ title: "d" });
      const id = created.body.posts[0].id;
      const del = await api("DELETE", `/ghost/api/admin/posts/${id}`, undefined, ADMIN_AUTH);
      expect(del.status).toBe(204);
      const after = await api("GET", `/ghost/api/admin/posts/${id}`, undefined, ADMIN_AUTH);
      expect(after.status).toBe(404);
    });

    it("gets the admin site", async () => {
      const r = await api("GET", "/ghost/api/admin/site/", undefined, ADMIN_AUTH);
      expect(r.status).toBe(200);
      expect(r.body.site.title).toBeTruthy();
    });
  });

  describe("Content API — posts", () => {
    it("lists only published posts with the {posts,meta} wrapper", async () => {
      await createPost({ title: "Draft", status: "draft" });
      await createPost({ title: "Published", status: "published" });
      const r = await api("GET", `/ghost/api/content/posts/?key=${KEY}`);
      expect(r.status).toBe(200);
      expect(r.body.posts.length).toBe(1);
      expect(r.body.posts[0].title).toBe("Published");
      expect(r.body.meta.pagination.total).toBe(1);
    });

    it("gets a published post by id", async () => {
      const created = await createPost({ title: "Readable", status: "published" });
      const id = created.body.posts[0].id;
      const r = await api("GET", `/ghost/api/content/posts/${id}/?key=${KEY}`);
      expect(r.status).toBe(200);
      expect(r.body.posts[0].id).toBe(id);
    });

    it("404 for a draft via content API", async () => {
      const created = await createPost({ title: "Hidden", status: "draft" });
      const id = created.body.posts[0].id;
      const r = await api("GET", `/ghost/api/content/posts/${id}/?key=${KEY}`);
      expect(r.status).toBe(404);
    });
  });

  describe("reset", () => {
    it("clears posts", async () => {
      await createPost({ title: "r", status: "published" });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const r = await api("GET", `/ghost/api/content/posts/?key=${KEY}`);
      expect(r.body.posts.length).toBe(0);
    });
  });
});
