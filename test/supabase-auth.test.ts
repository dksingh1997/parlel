import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SupabaseServer } from "../services/supabase/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

let PORT = 0;
let BASE_URL = "";

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

describe("Supabase Auth (GoTrue)", () => {
  let server: SupabaseServer;

  beforeAll(async () => {
    PORT = await getFreePort();
    BASE_URL = `http://127.0.0.1:${PORT}`;
    server = new SupabaseServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 300));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.users.clear();
    server.authUsersByEmail.clear();
    server.authPasswords.clear();
    server.authSessions.clear();
    server.authRefreshTokens.clear();
  });

  describe("POST /auth/v1/signup", () => {
    it("signs up a user and returns a full session", async () => {
      const r = await api("POST", "/auth/v1/signup", { email: "su@parlel.dev", password: "Secret1!" });
      expect(r.status).toBe(200);
      expect(r.body.access_token.split(".")).toHaveLength(3);
      expect(r.body.token_type).toBe("bearer");
      expect(r.body.refresh_token).toBeTruthy();
      expect(r.body.expires_in).toBe(3600);
      expect(r.body.user.email).toBe("su@parlel.dev");
      expect(r.body.user.role).toBe("authenticated");
    });

    it("rejects signup without email (422)", async () => {
      const r = await api("POST", "/auth/v1/signup", { password: "x" });
      expect(r.status).toBe(422);
    });
  });

  describe("POST /auth/v1/token?grant_type=password", () => {
    it("returns a session for valid credentials", async () => {
      await api("POST", "/auth/v1/signup", { email: "pw@parlel.dev", password: "right" });
      const r = await api("POST", "/auth/v1/token?grant_type=password", { email: "pw@parlel.dev", password: "right" });
      expect(r.status).toBe(200);
      expect(r.body.access_token).toBeTruthy();
      expect(r.body.token_type).toBe("bearer");
      expect(r.body.user.email).toBe("pw@parlel.dev");
    });

    it("rejects wrong password (400 invalid_grant)", async () => {
      await api("POST", "/auth/v1/signup", { email: "wp@parlel.dev", password: "right" });
      const r = await api("POST", "/auth/v1/token?grant_type=password", { email: "wp@parlel.dev", password: "wrong" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_grant");
    });

    it("rejects unknown email (400)", async () => {
      const r = await api("POST", "/auth/v1/token?grant_type=password", { email: "nope@parlel.dev", password: "x" });
      expect(r.status).toBe(400);
    });

    it("exchanges a refresh token", async () => {
      const up = await api("POST", "/auth/v1/signup", { email: "rt@parlel.dev", password: "x" });
      const refresh_token = up.body.refresh_token;
      const r = await api("POST", "/auth/v1/token?grant_type=refresh_token", { refresh_token });
      expect(r.status).toBe(200);
      expect(r.body.access_token).toBeTruthy();
      expect(r.body.user.email).toBe("rt@parlel.dev");
    });
  });

  describe("GET /auth/v1/user", () => {
    it("returns the user for a valid bearer token", async () => {
      const up = await api("POST", "/auth/v1/signup", { email: "gu@parlel.dev", password: "x" });
      const token = up.body.access_token;
      const r = await api("GET", "/auth/v1/user", undefined, { Authorization: `Bearer ${token}` });
      expect(r.status).toBe(200);
      expect(r.body.email).toBe("gu@parlel.dev");
      expect(r.body.id).toBe(up.body.user.id);
    });

    it("rejects missing/invalid bearer (401)", async () => {
      const r = await api("GET", "/auth/v1/user");
      expect(r.status).toBe(401);
      const bad = await api("GET", "/auth/v1/user", undefined, { Authorization: "Bearer nope" });
      expect(bad.status).toBe(401);
    });
  });

  describe("POST /auth/v1/logout", () => {
    it("revokes the session so /user returns 401", async () => {
      const up = await api("POST", "/auth/v1/signup", { email: "lo@parlel.dev", password: "x" });
      const token = up.body.access_token;
      const out = await api("POST", "/auth/v1/logout", {}, { Authorization: `Bearer ${token}` });
      expect(out.status).toBe(204);
      const after = await api("GET", "/auth/v1/user", undefined, { Authorization: `Bearer ${token}` });
      expect(after.status).toBe(401);
    });
  });

  describe("REST still works (no regression)", () => {
    it("inserts and selects rows via /rest/v1", async () => {
      const ins = await api("POST", "/rest/v1/todos", { title: "Ship it" });
      expect(ins.status).toBe(201);
      const sel = await api("GET", "/rest/v1/todos");
      expect(sel.status).toBe(200);
      expect(Array.isArray(sel.body)).toBe(true);
      expect(sel.body.length).toBe(1);
    });
  });
});
