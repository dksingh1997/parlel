import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NpmRegistryServer } from "../services/npm-registry/src/server.js";

const PORT = 14776;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer npm_parlelTestKey" };

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

describe("npm Registry Service", () => {
  let server: NpmRegistryServer;

  beforeAll(async () => {
    server = new NpmRegistryServer(PORT);
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
      expect(root.body.name).toBe("npm-registry");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Packument", () => {
    it("returns a faithful packument shape", async () => {
      const res = await api("GET", "/left-pad");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("left-pad");
      expect(res.body["dist-tags"].latest).toBe("1.3.0");
      expect(res.body.versions["1.3.0"]).toBeTruthy();
      expect(res.body.versions["1.3.0"].dist.tarball).toContain(".tgz");
      expect(res.body.versions["1.3.0"].dist.integrity).toMatch(/^sha512-/);
    });

    it("404 for unknown package", async () => {
      const res = await api("GET", "/does-not-exist");
      expect(res.status).toBe(404);
    });
  });

  describe("Single version", () => {
    it("returns a specific version manifest", async () => {
      const res = await api("GET", "/left-pad/1.3.0");
      expect(res.status).toBe(200);
      expect(res.body.version).toBe("1.3.0");
      expect(res.body._id).toBe("left-pad@1.3.0");
    });

    it("resolves a dist-tag", async () => {
      const res = await api("GET", "/left-pad/latest");
      expect(res.status).toBe(200);
      expect(res.body.version).toBe("1.3.0");
    });

    it("404 for unknown version", async () => {
      const res = await api("GET", "/left-pad/9.9.9");
      expect(res.status).toBe(404);
    });
  });

  describe("Publish", () => {
    it("requires auth to publish", async () => {
      const res = await api("PUT", "/my-pkg", {
        name: "my-pkg",
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: "my-pkg", version: "1.0.0" } },
      });
      expect(res.status).toBe(401);
    });

    it("publishes a new package", async () => {
      const res = await api("PUT", "/my-pkg", {
        name: "my-pkg",
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: "my-pkg", version: "1.0.0", description: "test" } },
      }, AUTH);
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const packument = await api("GET", "/my-pkg");
      expect(packument.body["dist-tags"].latest).toBe("1.0.0");
      expect(packument.body.versions["1.0.0"].description).toBe("test");
    });

    it("publishes a scoped package", async () => {
      const res = await api("PUT", "/@parlel%2futil", {
        name: "@parlel/util",
        "dist-tags": { latest: "0.1.0" },
        versions: { "0.1.0": { name: "@parlel/util", version: "0.1.0" } },
      }, AUTH);
      expect(res.status).toBe(201);

      const packument = await api("GET", "/@parlel%2futil");
      expect(packument.status).toBe(200);
      expect(packument.body.name).toBe("@parlel/util");

      const version = await api("GET", "/@parlel%2futil/0.1.0");
      expect(version.status).toBe(200);
      expect(version.body.version).toBe("0.1.0");
    });
  });

  describe("Search", () => {
    it("searches packages by text", async () => {
      const res = await api("GET", "/-/v1/search?text=left-pad");
      expect(res.status).toBe(200);
      expect(res.body.objects.length).toBeGreaterThanOrEqual(1);
      expect(res.body.objects[0].package.name).toBe("left-pad");
      expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    it("returns empty objects for no matches", async () => {
      const res = await api("GET", "/-/v1/search?text=zzzznomatch");
      expect(res.status).toBe(200);
      expect(res.body.objects.length).toBe(0);
    });
  });
});
