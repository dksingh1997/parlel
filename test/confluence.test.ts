import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ConfluenceServer } from "../services/confluence/src/server.js";

const PORT = 14795;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Basic ${Buffer.from("parlel@example.com:token").toString("base64")}` };

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

function newPage(title = "My Page"): Json {
  return {
    type: "page",
    title,
    space: { key: "PARLEL" },
    body: { storage: { value: "<p>hi</p>", representation: "storage" } },
  };
}

describe("Confluence Service", () => {
  let server: ConfluenceServer;

  beforeAll(async () => {
    server = new ConfluenceServer(PORT);
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
      expect(root.body.name).toBe("confluence");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const response = await fetch(`${BASE_URL}/wiki/rest/api/space`);
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth", async () => {
      const list = await api("GET", "/wiki/rest/api/space");
      expect(list.status).toBe(200);
    });

    it("accepts Bearer auth", async () => {
      const list = await api("GET", "/wiki/rest/api/space", undefined, { Authorization: "Bearer abc" });
      expect(list.status).toBe(200);
    });
  });

  describe("Content CRUD", () => {
    it("creates content with page shape", async () => {
      const created = await api("POST", "/wiki/rest/api/content", newPage("Hello"));
      expect(created.status).toBe(200);
      expect(created.body.id).toBeTruthy();
      expect(created.body.type).toBe("page");
      expect(created.body.status).toBe("current");
      expect(created.body.space.key).toBe("PARLEL");
    });

    it("rejects content without title", async () => {
      const created = await api("POST", "/wiki/rest/api/content", { space: { key: "PARLEL" } });
      expect(created.status).toBe(400);
    });

    it("lists content with results/size/_links", async () => {
      await api("POST", "/wiki/rest/api/content", newPage("A"));
      await api("POST", "/wiki/rest/api/content", newPage("B"));
      const list = await api("GET", "/wiki/rest/api/content");
      expect(list.body.size).toBe(2);
      expect(list.body.results.length).toBe(2);
      expect(list.body._links).toBeTruthy();
    });

    it("retrieves, updates and deletes content", async () => {
      const created = await api("POST", "/wiki/rest/api/content", newPage("Before"));
      const id = created.body.id;
      const got = await api("GET", `/wiki/rest/api/content/${id}`);
      expect(got.body.title).toBe("Before");
      const updated = await api("PUT", `/wiki/rest/api/content/${id}`, {
        title: "After",
        version: { number: 2 },
      });
      expect(updated.body.title).toBe("After");
      expect(updated.body.version.number).toBe(2);
      const deleted = await api("DELETE", `/wiki/rest/api/content/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/wiki/rest/api/content/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Spaces", () => {
    it("lists spaces (seeded default)", async () => {
      const list = await api("GET", "/wiki/rest/api/space");
      expect(list.body.results.length).toBeGreaterThanOrEqual(1);
      expect(list.body.results[0].key).toBe("PARLEL");
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await api("POST", "/wiki/rest/api/content", newPage());
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/wiki/rest/api/content");
      expect(list.body.size).toBe(0);
    });
  });
});
