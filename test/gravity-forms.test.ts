import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GravityFormsServer } from "../services/gravity-forms/src/server.js";

const PORT = 14854;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = Buffer.from("ck_consumer:cs_secret").toString("base64");
const AUTH = { Authorization: `Basic ${BASIC}` };

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

describe("Gravity Forms Service", () => {
  let server: GravityFormsServer;

  beforeAll(async () => {
    server = new GravityFormsServer(PORT);
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
      expect(root.body.name).toBe("gravity-forms");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing basic with 401", async () => {
      const response = await fetch(`${BASE_URL}/wp-json/gf/v2/forms`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Basic (consumer key/secret)", async () => {
      const result = await api("GET", "/wp-json/gf/v2/forms");
      expect(result.status).toBe(200);
    });
  });

  describe("Forms", () => {
    it("lists forms as an object keyed by id", async () => {
      const result = await api("GET", "/wp-json/gf/v2/forms");
      expect(result.status).toBe(200);
      const keys = Object.keys(result.body);
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(result.body[keys[0]].id).toBe(keys[0]);
    });

    it("retrieves a single form with {id,title,fields}", async () => {
      const result = await api("GET", "/wp-json/gf/v2/forms/1");
      expect(result.status).toBe(200);
      expect(result.body.id).toBe("1");
      expect(result.body.title).toBe("Contact Us");
      expect(Array.isArray(result.body.fields)).toBe(true);
    });

    it("404 unknown form", async () => {
      const result = await api("GET", "/wp-json/gf/v2/forms/999");
      expect(result.status).toBe(404);
    });
  });

  describe("Entries CRUD round-trip", () => {
    it("creates, lists and retrieves an entry", async () => {
      const created = await api("POST", "/wp-json/gf/v2/forms/1/entries", {
        "1": "Alice",
        "2": "alice@parlel.dev",
        "3": "Hello",
      });
      expect(created.status).toBe(201);
      const entryId = created.body.id;
      expect(entryId).toBeTruthy();
      expect(created.body["1"]).toBe("Alice");

      const list = await api("GET", "/wp-json/gf/v2/forms/1/entries");
      expect(list.body.entries.length).toBe(1);
      expect(list.body.total_count).toBe(1);

      const got = await api("GET", `/wp-json/gf/v2/entries/${entryId}`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(entryId);

      const deleted = await api("DELETE", `/wp-json/gf/v2/entries/${entryId}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/wp-json/gf/v2/entries/${entryId}`);
      expect(gone.status).toBe(404);
    });
  });
});
