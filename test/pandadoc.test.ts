import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PandadocServer } from "../services/pandadoc/src/server.js";

const PORT = 14851;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelPandaKey";
const AUTH = { Authorization: `API-Key ${API_KEY}` };

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

describe("PandaDoc Service", () => {
  let server: PandadocServer;

  beforeAll(async () => {
    server = new PandadocServer(PORT);
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
      expect(root.body.name).toBe("pandadoc");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing API-Key with 401", async () => {
      const response = await fetch(`${BASE_URL}/public/v1/documents`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Authorization: API-Key", async () => {
      const result = await api("GET", "/public/v1/documents");
      expect(result.status).toBe(200);
    });
  });

  describe("Templates", () => {
    it("lists templates in {results:[]}", async () => {
      const result = await api("GET", "/public/v1/templates");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.results)).toBe(true);
      expect(result.body.results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Documents CRUD round-trip", () => {
    it("creates a document -> document.uploaded", async () => {
      const created = await api("POST", "/public/v1/documents", {
        name: "Service Agreement",
        recipients: [{ email: "client@parlel.dev", first_name: "Client" }],
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("document.uploaded");
      expect(created.body.id).toBeTruthy();
    });

    it("creates, retrieves, lists and sends a document", async () => {
      const created = await api("POST", "/public/v1/documents", {
        name: "NDA",
        recipients: [{ email: "client@parlel.dev" }],
      });
      const id = created.body.id;

      const got = await api("GET", `/public/v1/documents/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("NDA");

      const list = await api("GET", "/public/v1/documents");
      expect(list.body.results.length).toBe(1);

      const sent = await api("POST", `/public/v1/documents/${id}/send`, { subject: "Please sign" });
      expect(sent.status).toBe(200);
      expect(sent.body.status).toBe("document.sent");
    });

    it("rejects document creation without name/template/url (400)", async () => {
      const result = await api("POST", "/public/v1/documents", {});
      expect(result.status).toBe(400);
    });

    it("404 unknown document", async () => {
      const result = await api("GET", "/public/v1/documents/nope");
      expect(result.status).toBe(404);
    });
  });
});
