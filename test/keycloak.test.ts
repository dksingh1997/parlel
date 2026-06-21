import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { KeycloakServer } from "../services/keycloak/src/server.js";

const PORT = 14822;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REALM = "parlel";
const AUTH = { Authorization: "Bearer admin-token" };

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

async function form(path: string, params: Record<string, string>) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Keycloak Service", () => {
  let server: KeycloakServer;

  beforeAll(async () => {
    server = new KeycloakServer(PORT);
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
      expect(root.body.name).toBe("keycloak");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Token endpoint", () => {
    it("issues a token via client_credentials", async () => {
      const r = await form(`/realms/${REALM}/protocol/openid-connect/token`, {
        grant_type: "client_credentials",
        client_id: "admin-cli",
        client_secret: "parlel",
      });
      expect(r.status).toBe(200);
      expect(r.body.token_type).toBe("Bearer");
      expect(r.body.expires_in).toBe(300);
      expect(r.body.access_token.split(".")).toHaveLength(3);
      expect(r.body.refresh_token).toBeTruthy();
    });

    it("issues a token via password grant", async () => {
      const r = await form(`/realms/${REALM}/protocol/openid-connect/token`, {
        grant_type: "password",
        client_id: "admin-cli",
        username: "pw@parlel.dev",
        password: "secret",
      });
      expect(r.status).toBe(200);
      expect(r.body.access_token).toBeTruthy();
    });

    it("rejects missing grant_type", async () => {
      const r = await form(`/realms/${REALM}/protocol/openid-connect/token`, { client_id: "admin-cli" });
      expect(r.status).toBe(400);
    });
  });

  describe("Admin auth", () => {
    it("rejects admin users without bearer (401)", async () => {
      const r = await api("GET", `/admin/realms/${REALM}/users`, undefined, {});
      expect(r.status).toBe(401);
    });
  });

  describe("Users CRUD", () => {
    it("creates (201 + Location) and reads a user round-trip", async () => {
      const created = await api("POST", `/admin/realms/${REALM}/users`, {
        username: "kcuser",
        email: "kc@parlel.dev",
        firstName: "Kc",
        lastName: "User",
        enabled: true,
      });
      expect(created.status).toBe(201);
      const location = created.headers.get("location")!;
      expect(location).toContain("/users/");
      const id = location.split("/users/")[1];

      const got = await api("GET", `/admin/realms/${REALM}/users/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.username).toBe("kcuser");
      expect(got.body.email).toBe("kc@parlel.dev");
      expect(got.body.enabled).toBe(true);
    });

    it("lists users", async () => {
      await api("POST", `/admin/realms/${REALM}/users`, { username: "list1" });
      const list = await api("GET", `/admin/realms/${REALM}/users`);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body.length).toBe(1);
    });

    it("updates and deletes a user", async () => {
      const created = await api("POST", `/admin/realms/${REALM}/users`, { username: "upd", email: "u@parlel.dev" });
      const id = created.headers.get("location")!.split("/users/")[1];
      const upd = await api("PUT", `/admin/realms/${REALM}/users/${id}`, { firstName: "Updated", enabled: false });
      expect(upd.status).toBe(204);
      const got = await api("GET", `/admin/realms/${REALM}/users/${id}`);
      expect(got.body.firstName).toBe("Updated");
      expect(got.body.enabled).toBe(false);
      const del = await api("DELETE", `/admin/realms/${REALM}/users/${id}`);
      expect(del.status).toBe(204);
      const gone = await api("GET", `/admin/realms/${REALM}/users/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects duplicate username (409)", async () => {
      await api("POST", `/admin/realms/${REALM}/users`, { username: "dup" });
      const r = await api("POST", `/admin/realms/${REALM}/users`, { username: "dup" });
      expect(r.status).toBe(409);
    });

    it("rejects user without username (400)", async () => {
      const r = await api("POST", `/admin/realms/${REALM}/users`, { email: "x@parlel.dev" });
      expect(r.status).toBe(400);
    });
  });

  describe("Clients", () => {
    it("lists seeded clients", async () => {
      const r = await api("GET", `/admin/realms/${REALM}/clients`);
      expect(r.status).toBe(200);
      expect(r.body.length).toBeGreaterThanOrEqual(1);
    });
  });
});
