import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { LaunchdarklyServer } from "../services/launchdarkly/src/server.js";

const PORT = 14816;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `api-parlelTestKey` };

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

describe("Launchdarkly Service", () => {
  let server: LaunchdarklyServer;

  beforeAll(async () => {
    server = new LaunchdarklyServer(PORT);
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
      expect(root.body.name).toBe("launchdarkly");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/api/v2/flags/default`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization", async () => {
      const response = await fetch(`${BASE_URL}/api/v2/flags/default`);
      expect(response.status).toBe(401);
    });
  });

  describe("Projects", () => {
    it("lists projects", async () => {
      const result = await api("GET", "/api/v2/projects");
      expect(result.status).toBe(200);
      expect(result.body.items.length).toBeGreaterThanOrEqual(1);
      expect(result.body.items[0].key).toBe("default");
    });
  });

  describe("Flags CRUD", () => {
    it("lists seeded flags for a project", async () => {
      const result = await api("GET", "/api/v2/flags/default");
      expect(result.status).toBe(200);
      expect(result.body.items.length).toBeGreaterThanOrEqual(1);
      expect(result.body.items[0].key).toBe("parlel-flag");
    });

    it("creates a flag with {key,name,kind,variations,environments}", async () => {
      const created = await api("POST", "/api/v2/flags/default", {
        key: "new-feature",
        name: "New Feature",
        kind: "boolean",
        variations: [{ value: true }, { value: false }],
      });
      expect(created.status).toBe(201);
      expect(created.body.key).toBe("new-feature");
      expect(created.body.kind).toBe("boolean");
      expect(created.body.variations.length).toBe(2);
      expect(created.body.environments).toBeDefined();
    });

    it("rejects flag creation without a key", async () => {
      const result = await api("POST", "/api/v2/flags/default", { name: "no key" });
      expect(result.status).toBe(400);
    });

    it("rejects duplicate flag keys with 409", async () => {
      await api("POST", "/api/v2/flags/default", { key: "dup", variations: [{ value: 1 }, { value: 2 }] });
      const again = await api("POST", "/api/v2/flags/default", { key: "dup", variations: [{ value: 1 }, { value: 2 }] });
      expect(again.status).toBe(409);
    });

    it("retrieves, patches and deletes a flag", async () => {
      await api("POST", "/api/v2/flags/default", { key: "toggle", variations: [{ value: true }, { value: false }] });
      const got = await api("GET", "/api/v2/flags/default/toggle");
      expect(got.status).toBe(200);

      const patched = await api("PATCH", "/api/v2/flags/default/toggle", {
        patch: [{ op: "replace", path: "/name", value: "Renamed Toggle" }],
      });
      expect(patched.status).toBe(200);
      expect(patched.body.name).toBe("Renamed Toggle");

      const turnedOn = await api("PATCH", "/api/v2/flags/default/toggle", {
        instructions: [{ kind: "turnFlagOn", environmentKey: "production" }],
      });
      expect(turnedOn.body.environments.production.on).toBe(true);

      const deleted = await api("DELETE", "/api/v2/flags/default/toggle");
      expect(deleted.status).toBe(204);
      const gone = await api("GET", "/api/v2/flags/default/toggle");
      expect(gone.status).toBe(404);
    });

    it("returns 404 for an unknown flag", async () => {
      const result = await api("GET", "/api/v2/flags/default/nope");
      expect(result.status).toBe(404);
    });
  });

  describe("SDK eval endpoint", () => {
    it("evaluates flags for a user (no auth required)", async () => {
      const user = Buffer.from(JSON.stringify({ key: "user-1" })).toString("base64");
      const response = await fetch(`${BASE_URL}/sdk/eval/test-env/users/${user}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body["parlel-flag"]).toBeDefined();
      expect(body["parlel-flag"]).toHaveProperty("value");
      expect(body["parlel-flag"]).toHaveProperty("variation");
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/api/v2/flags/default", { key: "temp", variations: [{ value: true }, { value: false }] });
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/api/v2/flags/default");
      expect(after.body.items.length).toBe(1); // back to seeded default
    });
  });
});
