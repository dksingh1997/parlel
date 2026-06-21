import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { HerokuServer } from "../services/heroku/src/server.js";

const PORT = 14883;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = {
  Authorization: "Bearer parlelTestKey",
  Accept: "application/vnd.heroku+json; version=3",
};

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
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

describe("Heroku Service", () => {
  let server: HerokuServer;

  beforeAll(async () => {
    server = new HerokuServer(PORT);
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
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("heroku");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer with 401", async () => {
      const res = await fetch(`${BASE_URL}/apps`, {
        headers: { Accept: "application/vnd.heroku+json; version=3" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts bearer auth", async () => {
      const result = await api("GET", "/apps");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
    });
  });

  describe("Account", () => {
    it("returns the account", async () => {
      const result = await api("GET", "/account");
      expect(result.status).toBe(200);
      expect(result.body.email).toBeTruthy();
    });
  });

  describe("Apps", () => {
    it("creates an app with the v3 shape", async () => {
      const result = await api("POST", "/apps", { name: "parlel-demo-app" });
      expect(result.status).toBe(201);
      expect(result.body.name).toBe("parlel-demo-app");
      expect(result.body.web_url).toContain("parlel-demo-app");
      expect(result.body.id).toBeTruthy();
      expect(result.body.created_at).toBeTruthy();
    });

    it("rejects duplicate app names (422)", async () => {
      await api("POST", "/apps", { name: "dup-app" });
      const result = await api("POST", "/apps", { name: "dup-app" });
      expect(result.status).toBe(422);
    });

    it("gets an app by name or id, patches and deletes it", async () => {
      const created = await api("POST", "/apps", { name: "lifecycle-app" });
      const byName = await api("GET", "/apps/lifecycle-app");
      expect(byName.status).toBe(200);
      const byId = await api("GET", `/apps/${created.body.id}`);
      expect(byId.status).toBe(200);

      const patched = await api("PATCH", "/apps/lifecycle-app", { name: "renamed-app" });
      expect(patched.status).toBe(200);
      expect(patched.body.name).toBe("renamed-app");

      const deleted = await api("DELETE", "/apps/renamed-app");
      expect(deleted.status).toBe(200);
      const gone = await api("GET", "/apps/renamed-app");
      expect(gone.status).toBe(404);
    });

    it("returns 404 for unknown app", async () => {
      const result = await api("GET", "/apps/does-not-exist");
      expect(result.status).toBe(404);
    });
  });

  describe("Config vars", () => {
    it("sets and gets config vars", async () => {
      await api("POST", "/apps", { name: "config-app" });
      const patched = await api("PATCH", "/apps/config-app/config-vars", { FOO: "bar", BAZ: "qux" });
      expect(patched.status).toBe(200);
      expect(patched.body.FOO).toBe("bar");

      const got = await api("GET", "/apps/config-app/config-vars");
      expect(got.body.BAZ).toBe("qux");

      const removed = await api("PATCH", "/apps/config-app/config-vars", { FOO: null });
      expect(removed.body.FOO).toBeUndefined();
      expect(removed.body.BAZ).toBe("qux");
    });
  });

  describe("Dynos", () => {
    it("creates and lists dynos", async () => {
      await api("POST", "/apps", { name: "dyno-app" });
      const created = await api("POST", "/apps/dyno-app/dynos", { command: "rails console", type: "run" });
      expect(created.status).toBe(201);
      expect(created.body.state).toBe("up");

      const list = await api("GET", "/apps/dyno-app/dynos");
      expect(list.status).toBe(200);
      expect(list.body.length).toBe(1);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/apps", { name: "temp-app" });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const list = await api("GET", "/apps");
      expect(list.body.length).toBe(0);
    });
  });
});
