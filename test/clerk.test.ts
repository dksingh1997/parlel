import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ClerkServer } from "../services/clerk/src/server.js";

const PORT = 14818;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer sk_test_parlel" };

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

describe("Clerk Service", () => {
  let server: ClerkServer;

  beforeAll(async () => {
    server = new ClerkServer(PORT);
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
      expect(root.body.name).toBe("clerk");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without bearer (401)", async () => {
      const r = await api("GET", "/v1/users", undefined, {});
      expect(r.status).toBe(401);
      expect(r.body.errors[0].code).toBe("authentication_invalid");
    });
  });

  describe("Users CRUD", () => {
    it("creates and reads a user round-trip", async () => {
      const created = await api("POST", "/v1/users", {
        email_address: ["jane@parlel.dev"],
        first_name: "Jane",
        password: "Sup3rSecret!",
      });
      expect(created.status).toBe(200);
      expect(created.body.object).toBe("user");
      expect(created.body.id).toMatch(/^user_/);
      expect(created.body.email_addresses[0].email_address).toBe("jane@parlel.dev");

      const got = await api("GET", `/v1/users/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.first_name).toBe("Jane");
    });

    it("lists users", async () => {
      await api("POST", "/v1/users", { email_address: ["a@parlel.dev"] });
      const list = await api("GET", "/v1/users");
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body.length).toBe(1);
    });

    it("patches and deletes a user", async () => {
      const created = await api("POST", "/v1/users", { email_address: ["b@parlel.dev"] });
      const id = created.body.id;
      const patched = await api("PATCH", `/v1/users/${id}`, { first_name: "Bob" });
      expect(patched.body.first_name).toBe("Bob");
      const del = await api("DELETE", `/v1/users/${id}`);
      expect(del.body.deleted).toBe(true);
      const gone = await api("GET", `/v1/users/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects invalid email (422)", async () => {
      const r = await api("POST", "/v1/users", { email_address: ["bad"] });
      expect(r.status).toBe(422);
    });
  });

  describe("Sessions", () => {
    it("verifies a session", async () => {
      const r = await api("POST", "/v1/sessions/sess_abc123/verify", {});
      expect(r.status).toBe(200);
      expect(r.body.object).toBe("session");
      expect(r.body.status).toBe("active");
    });

    it("lists sessions", async () => {
      await api("POST", "/v1/sessions/sess_x/verify", {});
      const r = await api("GET", "/v1/sessions");
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBe(1);
    });
  });

  describe("Organizations", () => {
    it("creates and lists organizations", async () => {
      const created = await api("POST", "/v1/organizations", { name: "Acme" });
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(/^org_/);
      const list = await api("GET", "/v1/organizations");
      expect(list.body.data.length).toBe(1);
      expect(list.body.total_count).toBe(1);
    });

    it("rejects org without name (422)", async () => {
      const r = await api("POST", "/v1/organizations", {});
      expect(r.status).toBe(422);
    });
  });
});
