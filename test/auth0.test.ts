import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Auth0Server } from "../services/auth0/src/server.js";

const PORT = 14817;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-mgmt-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

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

describe("Auth0 Service", () => {
  let server: Auth0Server;

  beforeAll(async () => {
    server = new Auth0Server(PORT);
    await server.start();
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await api("GET", "/", undefined, {});
      const health = await api("GET", "/health", undefined, {});
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("auth0");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("POST /oauth/token", () => {
    it("issues a client_credentials token", async () => {
      const r = await api("POST", "/oauth/token", {
        grant_type: "client_credentials",
        client_id: "parlel",
        client_secret: "parlel",
        audience: "https://parlel/api/v2/",
      }, {});
      expect(r.status).toBe(200);
      expect(r.body.token_type).toBe("Bearer");
      expect(r.body.expires_in).toBe(86400);
      expect(r.body.access_token.split(".")).toHaveLength(3);
    });

    it("issues a password grant token and id_token", async () => {
      const r = await api("POST", "/oauth/token", {
        grant_type: "password",
        username: "pw@parlel.dev",
        password: "secret",
      }, {});
      expect(r.status).toBe(200);
      expect(r.body.access_token).toBeTruthy();
      expect(r.body.id_token).toBeTruthy();
    });

    it("rejects missing grant_type", async () => {
      const r = await api("POST", "/oauth/token", {}, {});
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_request");
    });
  });

  describe("Management API auth", () => {
    it("rejects /api/v2/users without bearer (401)", async () => {
      const r = await api("GET", "/api/v2/users", undefined, {});
      expect(r.status).toBe(401);
    });
  });

  describe("Users CRUD", () => {
    it("creates and reads a user round-trip", async () => {
      const created = await api("POST", "/api/v2/users", {
        email: "alice@parlel.dev",
        password: "Passw0rd!",
        connection: "Username-Password-Authentication",
      });
      expect(created.status).toBe(201);
      expect(created.body.user_id).toMatch(/^auth0\|/);
      expect(created.body.email).toBe("alice@parlel.dev");
      expect(created.body.password).toBeUndefined();

      const got = await api("GET", `/api/v2/users/${created.body.user_id}`);
      expect(got.status).toBe(200);
      expect(got.body.email).toBe("alice@parlel.dev");
    });

    it("lists users", async () => {
      await api("POST", "/api/v2/users", { email: "list@parlel.dev", password: "x" });
      const list = await api("GET", "/api/v2/users");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body.length).toBe(1);
    });

    it("patches and deletes a user", async () => {
      const created = await api("POST", "/api/v2/users", { email: "patch@parlel.dev", password: "x" });
      const id = created.body.user_id;
      const patched = await api("PATCH", `/api/v2/users/${id}`, { email_verified: true, name: "Patched" });
      expect(patched.body.email_verified).toBe(true);
      expect(patched.body.name).toBe("Patched");
      const del = await api("DELETE", `/api/v2/users/${id}`);
      expect(del.status).toBe(204);
      const gone = await api("GET", `/api/v2/users/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects invalid email", async () => {
      const r = await api("POST", "/api/v2/users", { email: "not-email" });
      expect(r.status).toBe(400);
    });

    it("rejects duplicate email (409)", async () => {
      await api("POST", "/api/v2/users", { email: "dup@parlel.dev" });
      const r = await api("POST", "/api/v2/users", { email: "dup@parlel.dev" });
      expect(r.status).toBe(409);
    });
  });

  describe("Clients", () => {
    it("lists seeded clients", async () => {
      const r = await api("GET", "/api/v2/clients");
      expect(r.status).toBe(200);
      expect(r.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /userinfo", () => {
    it("returns sub/email for a password-grant token", async () => {
      const tok = await api("POST", "/oauth/token", {
        grant_type: "password",
        username: "info@parlel.dev",
        password: "x",
      }, {});
      const r = await api("GET", "/userinfo", undefined, { Authorization: `Bearer ${tok.body.access_token}` });
      expect(r.status).toBe(200);
      expect(r.body.sub).toBeTruthy();
      expect(r.body.email).toBe("info@parlel.dev");
    });

    it("rejects userinfo without bearer", async () => {
      const r = await api("GET", "/userinfo", undefined, {});
      expect(r.status).toBe(401);
    });
  });
});
