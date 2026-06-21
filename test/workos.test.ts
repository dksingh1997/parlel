import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WorkosServer } from "../services/workos/src/server.js";

const PORT = 14821;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer sk_test_parlel" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("WorkOS Service", () => {
  let server: WorkosServer;

  beforeAll(async () => {
    server = new WorkosServer(PORT);
    await server.start();
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });
    it("returns root and health", async () => {
      const root = await api("GET", "/", undefined, {});
      const health = await api("GET", "/health", undefined, {});
      expect(root.body.name).toBe("workos");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects user list without bearer (401)", async () => {
      const r = await api("GET", "/user_management/users", undefined, {});
      expect(r.status).toBe(401);
    });
  });

  describe("User Management", () => {
    it("creates and reads a user round-trip", async () => {
      const created = await api("POST", "/user_management/users", {
        email: "wos@parlel.dev",
        first_name: "Wo",
        last_name: "S",
      });
      expect(created.status).toBe(201);
      expect(created.body.object).toBe("user");
      expect(created.body.id).toMatch(/^user_/);
      expect(created.body.email).toBe("wos@parlel.dev");

      const got = await api("GET", `/user_management/users/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.first_name).toBe("Wo");
    });

    it("lists users in a list envelope", async () => {
      await api("POST", "/user_management/users", { email: "l@parlel.dev" });
      const list = await api("GET", "/user_management/users");
      expect(list.body.object).toBe("list");
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.list_metadata).toBeDefined();
      expect(list.body.data.length).toBe(1);
    });

    it("updates and deletes a user", async () => {
      const created = await api("POST", "/user_management/users", { email: "u@parlel.dev" });
      const id = created.body.id;
      const upd = await api("PUT", `/user_management/users/${id}`, { first_name: "Updated" });
      expect(upd.body.first_name).toBe("Updated");
      const del = await api("DELETE", `/user_management/users/${id}`);
      expect(del.status).toBe(200);
      const gone = await api("GET", `/user_management/users/${id}`);
      expect(gone.status).toBe(404);
    });

    it("authenticates and returns an access_token", async () => {
      const r = await api("POST", "/user_management/authenticate", {
        email: "auth@parlel.dev",
        password: "x",
        client_id: "client_parlel",
      });
      expect(r.status).toBe(200);
      expect(r.body.access_token.split(".")).toHaveLength(3);
      expect(r.body.user.email).toBe("auth@parlel.dev");
    });

    it("rejects invalid email (422)", async () => {
      const r = await api("POST", "/user_management/users", { email: "bad" });
      expect(r.status).toBe(422);
    });
  });

  describe("Organizations", () => {
    it("creates and lists organizations", async () => {
      const created = await api("POST", "/organizations", { name: "Acme", domains: ["acme.com"] });
      expect(created.status).toBe(201);
      expect(created.body.id).toMatch(/^org_/);
      const list = await api("GET", "/organizations");
      expect(list.body.object).toBe("list");
      expect(list.body.data.length).toBe(1);
    });
  });

  describe("SSO", () => {
    it("redirects on /sso/authorize", async () => {
      const r = await api("GET", "/sso/authorize?client_id=client_parlel&redirect_uri=http://127.0.0.1/cb", undefined, {});
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toContain("code=");
    });

    it("exchanges sso token for a profile", async () => {
      const r = await api("POST", "/sso/token", { code: "abc", client_id: "client_parlel" });
      expect(r.status).toBe(200);
      expect(r.body.profile.object).toBe("profile");
      expect(r.body.access_token).toBeTruthy();
    });
  });
});
