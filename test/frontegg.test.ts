import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FronteggServer } from "../services/frontegg/src/server.js";

const PORT = 14824;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer vendor-token" };

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

describe("Frontegg Service", () => {
  let server: FronteggServer;

  beforeAll(async () => {
    server = new FronteggServer(PORT);
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
      expect(root.body.name).toBe("frontegg");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Vendor token", () => {
    it("issues a vendor token", async () => {
      const r = await api("POST", "/auth/vendor", { clientId: "parlel", secret: "parlel" }, {});
      expect(r.status).toBe(200);
      expect(r.body.tokenType).toBe("Bearer");
      expect(r.body.token.split(".")).toHaveLength(3);
      expect(r.body.expiresIn).toBe(3600);
    });

    it("rejects vendor token with missing credentials (401)", async () => {
      const r = await api("POST", "/auth/vendor", {}, {});
      expect(r.status).toBe(401);
    });
  });

  describe("User login", () => {
    it("logs in a user and returns accessToken", async () => {
      const r = await api("POST", "/identity/resources/auth/v1/user", { email: "login@parlel.dev", password: "x" }, {});
      expect(r.status).toBe(200);
      expect(r.body.accessToken.split(".")).toHaveLength(3);
      expect(r.body.email).toBe("login@parlel.dev");
    });

    it("rejects invalid email (400)", async () => {
      const r = await api("POST", "/identity/resources/auth/v1/user", { email: "bad" }, {});
      expect(r.status).toBe(400);
    });
  });

  describe("Authentication (vendor bearer)", () => {
    it("rejects users list without bearer (401)", async () => {
      const r = await api("GET", "/identity/resources/users/v1", undefined, {});
      expect(r.status).toBe(401);
    });
  });

  describe("Users CRUD", () => {
    it("creates and reads a user round-trip", async () => {
      const created = await api("POST", "/identity/resources/users/v1", {
        email: "fe@parlel.dev",
        name: "Front Egg",
      });
      expect(created.status).toBe(201);
      expect(created.body.id).toBeTruthy();
      expect(created.body.email).toBe("fe@parlel.dev");
      expect(created.body.tenantId).toBeTruthy();
      expect(created.body.password).toBeUndefined();

      const got = await api("GET", `/identity/resources/users/v1/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("Front Egg");
    });

    it("lists users with items envelope", async () => {
      await api("POST", "/identity/resources/users/v1", { email: "l@parlel.dev" });
      const list = await api("GET", "/identity/resources/users/v1");
      expect(Array.isArray(list.body.items)).toBe(true);
      expect(list.body.items.length).toBe(1);
    });

    it("updates and deletes a user", async () => {
      const created = await api("POST", "/identity/resources/users/v1", { email: "u@parlel.dev" });
      const id = created.body.id;
      const upd = await api("PUT", `/identity/resources/users/v1/${id}`, { name: "Updated" });
      expect(upd.body.name).toBe("Updated");
      const del = await api("DELETE", `/identity/resources/users/v1/${id}`);
      expect(del.status).toBe(200);
      const gone = await api("GET", `/identity/resources/users/v1/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Tenants", () => {
    it("lists seeded tenants and creates a tenant", async () => {
      const list = await api("GET", "/identity/resources/tenants/v1");
      expect(list.body.length).toBeGreaterThanOrEqual(1);
      const created = await api("POST", "/identity/resources/tenants/v1", { name: "New Tenant" });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe("New Tenant");
    });
  });
});
