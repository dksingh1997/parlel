import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NetlifyServer } from "../services/netlify/src/server.js";

const PORT = 14771;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer nfp_parlelTestKey" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Netlify Service", () => {
  let server: NetlifyServer;

  beforeAll(async () => {
    server = new NetlifyServer(PORT);
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
    it("starts on configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("netlify");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const res = await fetch(`${BASE_URL}/api/v1/user`);
      expect(res.status).toBe(401);
    });

    it("accepts Bearer auth", async () => {
      const res = await api("GET", "/api/v1/user");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/v1/user", () => {
    it("returns the current user", async () => {
      const res = await api("GET", "/api/v1/user");
      expect(res.status).toBe(200);
      expect(res.body.email).toBe("parlel-user@parlel.dev");
      expect(res.body.id).toBeTruthy();
    });
  });

  describe("Sites", () => {
    it("lists seeded sites", async () => {
      const res = await api("GET", "/api/v1/sites");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it("creates a site", async () => {
      const res = await api("POST", "/api/v1/sites", { name: "my-site" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("my-site");
      expect(res.body.url).toContain("netlify.app");
    });

    it("gets and updates a site", async () => {
      const created = await api("POST", "/api/v1/sites", { name: "edit-site" });
      const id = created.body.id;
      const got = await api("GET", `/api/v1/sites/${id}`);
      expect(got.body.name).toBe("edit-site");
      const updated = await api("PATCH", `/api/v1/sites/${id}`, { custom_domain: "example.com" });
      expect(updated.body.custom_domain).toBe("example.com");
    });

    it("404 for unknown site", async () => {
      const res = await api("GET", "/api/v1/sites/does-not-exist");
      expect(res.status).toBe(404);
    });
  });

  describe("Deploys", () => {
    it("creates and lists deploys for a site", async () => {
      const list = await api("GET", "/api/v1/sites");
      const id = list.body[0].id;
      const created = await api("POST", `/api/v1/sites/${id}/deploys`, { branch: "main" });
      expect(created.status).toBe(200);
      expect(created.body.state).toBe("ready");
      expect(created.body.site_id).toBe(id);

      const deploys = await api("GET", `/api/v1/sites/${id}/deploys`);
      expect(deploys.body.length).toBe(1);

      const got = await api("GET", `/api/v1/sites/${id}/deploys/${created.body.id}`);
      expect(got.body.id).toBe(created.body.id);
    });
  });
});
