import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SignnowServer } from "../services/signnow/src/server.js";

const PORT = 14852;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlelBearerToken";
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

describe("SignNow Service", () => {
  let server: SignnowServer;

  beforeAll(async () => {
    server = new SignnowServer(PORT);
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

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("signnow");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("OAuth token", () => {
    it("issues an access token via POST /oauth2/token", async () => {
      const basic = Buffer.from("clientId:clientSecret").toString("base64");
      const result = await api(
        "POST",
        "/oauth2/token",
        { username: "user@parlel.dev", password: "pw", grant_type: "password" },
        { Authorization: `Basic ${basic}` },
      );
      expect(result.status).toBe(200);
      expect(result.body.access_token).toBeTruthy();
      expect(result.body.token_type).toBe("bearer");
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer with 401", async () => {
      const response = await fetch(`${BASE_URL}/user`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Bearer", async () => {
      const result = await api("GET", "/user");
      expect(result.status).toBe(200);
      expect(result.body.primary_email).toBe("user@parlel.dev");
    });
  });

  describe("Documents CRUD round-trip", () => {
    it("uploads, retrieves, invites and deletes a document", async () => {
      const created = await api("POST", "/document", { document_name: "agreement.pdf" });
      expect(created.status).toBe(200);
      const id = created.body.id;
      expect(id).toBeTruthy();

      const got = await api("GET", `/document/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.document_name).toBe("agreement.pdf");

      const invited = await api("POST", `/document/${id}/invite`, {
        to: [{ email: "signer@parlel.dev", role: "Signer 1" }],
        from: "user@parlel.dev",
      });
      expect(invited.status).toBe(200);
      expect(invited.body.status).toBe("success");

      const afterInvite = await api("GET", `/document/${id}`);
      expect(afterInvite.body.status).toBe("pending");
      expect(afterInvite.body.invites.length).toBe(1);

      const deleted = await api("DELETE", `/document/${id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/document/${id}`);
      expect(gone.status).toBe(404);
    });

    it("404 unknown document", async () => {
      const result = await api("GET", "/document/nope");
      expect(result.status).toBe(404);
    });
  });
});
