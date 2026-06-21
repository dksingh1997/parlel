import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OktaServer } from "../services/okta/src/server.js";

const PORT = 14819;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "SSWS parlel" };

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

describe("Okta Service", () => {
  let server: OktaServer;

  beforeAll(async () => {
    server = new OktaServer(PORT);
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
      expect(root.body.name).toBe("okta");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects without SSWS token (401)", async () => {
      const r = await api("GET", "/api/v1/users", undefined, {});
      expect(r.status).toBe(401);
      expect(r.body.errorCode).toBe("E0000011");
    });
    it("rejects Bearer (must be SSWS)", async () => {
      const r = await api("GET", "/api/v1/users", undefined, { Authorization: "Bearer foo" });
      expect(r.status).toBe(401);
    });
  });

  describe("Users", () => {
    it("creates and reads a user round-trip", async () => {
      const created = await api("POST", "/api/v1/users?activate=false", {
        profile: { login: "joe@parlel.dev", email: "joe@parlel.dev", firstName: "Joe", lastName: "Q" },
      });
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(/^00u/);
      expect(created.body.profile.email).toBe("joe@parlel.dev");
      expect(created.body.status).toBeTruthy();

      const got = await api("GET", `/api/v1/users/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.profile.firstName).toBe("Joe");
    });

    it("activates a user via lifecycle", async () => {
      const created = await api("POST", "/api/v1/users", {
        profile: { login: "act@parlel.dev", email: "act@parlel.dev" },
      });
      const id = created.body.id;
      const act = await api("POST", `/api/v1/users/${id}/lifecycle/activate`, {});
      expect(act.status).toBe(200);
      const got = await api("GET", `/api/v1/users/${id}`);
      expect(got.body.status).toBe("ACTIVE");
    });

    it("updates a user profile via POST", async () => {
      const created = await api("POST", "/api/v1/users", {
        profile: { login: "u@parlel.dev", email: "u@parlel.dev" },
      });
      const id = created.body.id;
      const upd = await api("POST", `/api/v1/users/${id}`, { profile: { firstName: "Updated" } });
      expect(upd.body.profile.firstName).toBe("Updated");
    });

    it("deactivates then deletes a user", async () => {
      const created = await api("POST", "/api/v1/users", {
        profile: { login: "del@parlel.dev", email: "del@parlel.dev" },
      });
      const id = created.body.id;
      const first = await api("DELETE", `/api/v1/users/${id}`); // deactivate
      expect(first.status).toBe(200);
      const second = await api("DELETE", `/api/v1/users/${id}`); // delete
      expect(second.status).toBe(204);
      const gone = await api("GET", `/api/v1/users/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects invalid email", async () => {
      const r = await api("POST", "/api/v1/users", { profile: { login: "x", email: "bad" } });
      expect(r.status).toBe(400);
    });
  });

  describe("Groups", () => {
    it("lists seeded groups and creates a group", async () => {
      const list = await api("GET", "/api/v1/groups");
      expect(list.body.length).toBeGreaterThanOrEqual(1);
      const created = await api("POST", "/api/v1/groups", { profile: { name: "Engineers" } });
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(/^00g/);
      expect(created.body.profile.name).toBe("Engineers");
    });
  });

  describe("Primary auth (/api/v1/authn)", () => {
    it("returns SUCCESS + sessionToken", async () => {
      const r = await api("POST", "/api/v1/authn", { username: "login@parlel.dev", password: "secret" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("SUCCESS");
      expect(r.body.sessionToken).toBeTruthy();
    });

    it("rejects missing credentials (401)", async () => {
      const r = await api("POST", "/api/v1/authn", { username: "x" });
      expect(r.status).toBe(401);
    });
  });
});
