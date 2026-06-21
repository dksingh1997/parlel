import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BitbucketServer } from "../services/bitbucket/src/server.js";

const PORT = 14769;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer bbp_parlelTestKey" };

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

describe("Bitbucket Service", () => {
  let server: BitbucketServer;

  beforeAll(async () => {
    server = new BitbucketServer(PORT);
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
      expect(root.body.name).toBe("bitbucket");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const res = await fetch(`${BASE_URL}/2.0/user`);
      expect(res.status).toBe(401);
    });

    it("accepts Bearer and Basic auth", async () => {
      const basic = Buffer.from("user:pass").toString("base64");
      const a = await api("GET", "/2.0/user", undefined, { Authorization: "Bearer x" });
      const b = await api("GET", "/2.0/user", undefined, { Authorization: `Basic ${basic}` });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    });
  });

  describe("GET /2.0/user", () => {
    it("returns the current user", async () => {
      const res = await api("GET", "/2.0/user");
      expect(res.status).toBe(200);
      expect(res.body.username).toBe("parlel-user");
      expect(res.body.uuid).toBeTruthy();
    });
  });

  describe("Repositories", () => {
    it("lists workspace repos with paginated envelope", async () => {
      const res = await api("GET", "/2.0/repositories/parlel-team");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.values)).toBe(true);
      expect(res.body).toHaveProperty("page");
      expect(res.body).toHaveProperty("size");
      expect(res.body).toHaveProperty("pagelen");
      expect(res.body.values.length).toBeGreaterThanOrEqual(1);
    });

    it("gets a seeded repo", async () => {
      const res = await api("GET", "/2.0/repositories/parlel-team/hello-world");
      expect(res.status).toBe(200);
      expect(res.body.full_name).toBe("parlel-team/hello-world");
    });

    it("creates a repo", async () => {
      const res = await api("POST", "/2.0/repositories/parlel-team/new-repo", { description: "x" });
      expect(res.status).toBe(201);
      expect(res.body.full_name).toBe("parlel-team/new-repo");
      expect(res.body.uuid).toBeTruthy();
    });

    it("404 for unknown repo", async () => {
      const res = await api("GET", "/2.0/repositories/parlel-team/nope");
      expect(res.status).toBe(404);
    });
  });

  describe("Pull requests", () => {
    it("creates and lists pull requests", async () => {
      const created = await api("POST", "/2.0/repositories/parlel-team/hello-world/pullrequests", {
        title: "Add feature",
        source: { branch: { name: "feature" } },
        destination: { branch: { name: "main" } },
      });
      expect(created.status).toBe(201);
      expect(created.body.state).toBe("OPEN");
      expect(created.body.id).toBe(1);
      expect(created.body.source.branch.name).toBe("feature");

      const list = await api("GET", "/2.0/repositories/parlel-team/hello-world/pullrequests");
      expect(list.body.values.length).toBe(1);

      const got = await api("GET", "/2.0/repositories/parlel-team/hello-world/pullrequests/1");
      expect(got.body.title).toBe("Add feature");
    });

    it("rejects PR without title", async () => {
      const res = await api("POST", "/2.0/repositories/parlel-team/hello-world/pullrequests", {});
      expect(res.status).toBe(400);
    });
  });
});
