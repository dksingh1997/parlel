import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FirebaseAuthServer } from "../services/firebase-auth/src/server.js";

const PORT = 14820;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const KEY = "parlel";

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

describe("Firebase Auth Service", () => {
  let server: FirebaseAuthServer;

  beforeAll(async () => {
    server = new FirebaseAuthServer(PORT);
    await server.start();
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });
    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("firebase-auth");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects client endpoint without ?key= (401)", async () => {
      const r = await api("POST", "/v1/accounts:signUp", { email: "a@parlel.dev", password: "x" });
      expect(r.status).toBe(401);
    });
    it("rejects admin create without Bearer (401)", async () => {
      const r = await api("POST", "/v1/projects/parlel/accounts", { email: "a@parlel.dev" });
      expect(r.status).toBe(401);
    });
  });

  describe("signUp + signIn round-trip", () => {
    it("signs up a new user with idToken/refreshToken/localId", async () => {
      const r = await api("POST", `/v1/accounts:signUp?key=${KEY}`, { email: "new@parlel.dev", password: "Secret1!" });
      expect(r.status).toBe(200);
      expect(r.body.idToken.split(".")).toHaveLength(3);
      expect(r.body.refreshToken).toBeTruthy();
      expect(r.body.localId).toBeTruthy();
      expect(r.body.email).toBe("new@parlel.dev");
    });

    it("rejects duplicate email (EMAIL_EXISTS)", async () => {
      await api("POST", `/v1/accounts:signUp?key=${KEY}`, { email: "dup@parlel.dev", password: "x" });
      const r = await api("POST", `/v1/accounts:signUp?key=${KEY}`, { email: "dup@parlel.dev", password: "x" });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe("EMAIL_EXISTS");
    });

    it("signs in with the same password", async () => {
      await api("POST", `/v1/accounts:signUp?key=${KEY}`, { email: "si@parlel.dev", password: "pw1" });
      const r = await api("POST", `/v1/accounts:signInWithPassword?key=${KEY}`, { email: "si@parlel.dev", password: "pw1" });
      expect(r.status).toBe(200);
      expect(r.body.registered).toBe(true);
      expect(r.body.idToken).toBeTruthy();
    });

    it("rejects wrong password (INVALID_PASSWORD)", async () => {
      await api("POST", `/v1/accounts:signUp?key=${KEY}`, { email: "wp@parlel.dev", password: "right" });
      const r = await api("POST", `/v1/accounts:signInWithPassword?key=${KEY}`, { email: "wp@parlel.dev", password: "wrong" });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe("INVALID_PASSWORD");
    });

    it("rejects sign in for unknown email (EMAIL_NOT_FOUND)", async () => {
      const r = await api("POST", `/v1/accounts:signInWithPassword?key=${KEY}`, { email: "nope@parlel.dev", password: "x" });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe("EMAIL_NOT_FOUND");
    });
  });

  describe("lookup / update / delete", () => {
    it("looks up by idToken and updates the profile", async () => {
      const up = await api("POST", `/v1/accounts:signUp?key=${KEY}`, { email: "lu@parlel.dev", password: "x" });
      const idToken = up.body.idToken;

      const look = await api("POST", `/v1/accounts:lookup?key=${KEY}`, { idToken });
      expect(look.status).toBe(200);
      expect(look.body.users[0].email).toBe("lu@parlel.dev");

      const upd = await api("POST", `/v1/accounts:update?key=${KEY}`, { idToken, displayName: "Lookup User", emailVerified: true });
      expect(upd.status).toBe(200);
      expect(upd.body.displayName).toBe("Lookup User");
      expect(upd.body.emailVerified).toBe(true);
    });

    it("deletes an account", async () => {
      const up = await api("POST", `/v1/accounts:signUp?key=${KEY}`, { email: "dl@parlel.dev", password: "x" });
      const idToken = up.body.idToken;
      const del = await api("POST", `/v1/accounts:delete?key=${KEY}`, { idToken });
      expect(del.status).toBe(200);
      const look = await api("POST", `/v1/accounts:lookup?key=${KEY}`, { idToken });
      expect(look.status).toBe(400);
    });
  });

  describe("admin create", () => {
    it("creates a user via admin endpoint (Bearer)", async () => {
      const r = await api("POST", "/v1/projects/parlel/accounts", { email: "admin@parlel.dev", password: "x" }, { Authorization: "Bearer owner-token" });
      expect(r.status).toBe(200);
      expect(r.body.localId).toBeTruthy();
      expect(r.body.email).toBe("admin@parlel.dev");
    });
  });
});
