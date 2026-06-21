import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { StytchServer } from "../services/stytch/src/server.js";

const PORT = 14823;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = "Basic " + Buffer.from("project-test-parlel:secret-test-parlel").toString("base64");
const AUTH = { Authorization: BASIC };

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

describe("Stytch Service", () => {
  let server: StytchServer;

  beforeAll(async () => {
    server = new StytchServer(PORT);
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
      expect(root.body.name).toBe("stytch");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects user list without basic auth (401)", async () => {
      const r = await api("GET", "/v1/users", undefined, {});
      expect(r.status).toBe(401);
      expect(r.body.error_type).toBe("unauthorized_credentials");
    });
  });

  describe("Magic links", () => {
    it("login_or_create returns user_id + user_created", async () => {
      const r = await api("POST", "/v1/magic_links/email/login_or_create", { email: "ml@parlel.dev" });
      expect(r.status).toBe(200);
      expect(r.body.status_code).toBe(200);
      expect(r.body.user_id).toMatch(/^user-test-/);
      expect(r.body.user_created).toBe(true);
      const again = await api("POST", "/v1/magic_links/email/login_or_create", { email: "ml@parlel.dev" });
      expect(again.body.user_created).toBe(false);
    });

    it("rejects invalid email", async () => {
      const r = await api("POST", "/v1/magic_links/email/login_or_create", { email: "bad" });
      expect(r.status).toBe(400);
    });
  });

  describe("Passwords", () => {
    it("creates a password user and authenticates round-trip", async () => {
      const created = await api("POST", "/v1/passwords", { email: "pw@parlel.dev", password: "Sup3rSecret!" });
      expect(created.status).toBe(200);
      expect(created.body.user_id).toBeTruthy();
      expect(created.body.session_token).toBeTruthy();

      const auth = await api("POST", "/v1/passwords/authenticate", {
        email: "pw@parlel.dev",
        password: "Sup3rSecret!",
        session_duration_minutes: 60,
      });
      expect(auth.status).toBe(200);
      expect(auth.body.user_id).toBe(created.body.user_id);
      expect(auth.body.session_token).toBeTruthy();
    });

    it("rejects wrong password (401)", async () => {
      await api("POST", "/v1/passwords", { email: "wp@parlel.dev", password: "right" });
      const r = await api("POST", "/v1/passwords/authenticate", { email: "wp@parlel.dev", password: "wrong" });
      expect(r.status).toBe(401);
    });

    it("rejects duplicate email", async () => {
      await api("POST", "/v1/passwords", { email: "dup@parlel.dev", password: "x" });
      const r = await api("POST", "/v1/passwords", { email: "dup@parlel.dev", password: "x" });
      expect(r.status).toBe(400);
      expect(r.body.error_type).toBe("duplicate_email");
    });
  });

  describe("Users", () => {
    it("creates, reads and deletes a user", async () => {
      const created = await api("POST", "/v1/users", { email: "u@parlel.dev" });
      expect(created.status).toBe(200);
      const id = created.body.user_id;
      const got = await api("GET", `/v1/users/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.user_id).toBe(id);
      const del = await api("DELETE", `/v1/users/${id}`);
      expect(del.status).toBe(200);
      const gone = await api("GET", `/v1/users/${id}`);
      expect(gone.status).toBe(404);
    });

    it("lists users with results envelope", async () => {
      await api("POST", "/v1/users", { email: "list@parlel.dev" });
      const list = await api("GET", "/v1/users");
      expect(Array.isArray(list.body.results)).toBe(true);
      expect(list.body.results.length).toBe(1);
    });
  });

  describe("Sessions", () => {
    it("authenticates a session token", async () => {
      const created = await api("POST", "/v1/passwords", { email: "s@parlel.dev", password: "x" });
      const token = created.body.session_token;
      const r = await api("POST", "/v1/sessions/authenticate", { session_token: token });
      expect(r.status).toBe(200);
      expect(r.body.session.user_id).toBe(created.body.user_id);
    });

    it("rejects unknown session token (404)", async () => {
      const r = await api("POST", "/v1/sessions/authenticate", { session_token: "nope" });
      expect(r.status).toBe(404);
    });
  });
});
