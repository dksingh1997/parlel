import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { LoopsServer } from "../services/loops/src/server.js";

const PORT = 14834;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlel-loops-key" };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, body?: any, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Loops Service", () => {
  let server: LoopsServer;

  beforeAll(async () => {
    server = new LoopsServer(PORT);
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

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("loops");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v1/transactional`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/v1/transactional`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionalId: "x", email: "a@parlel.dev" }),
      });
      expect(response.status).toBe(401);
    });

    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/v1/api-key");
      expect(result.status).toBe(200);
    });
  });

  describe("POST /v1/transactional", () => {
    it("sends and returns success", async () => {
      const result = await api("POST", "/v1/transactional", {
        transactionalId: "tmpl_welcome",
        email: "recipient@parlel.dev",
        dataVariables: { name: "Parlel" },
      });
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });

    it("captures the sent email for inspection", async () => {
      await api("POST", "/v1/transactional", { transactionalId: "tmpl_x", email: "r@parlel.dev" });
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
      expect(inbox.body.messages[0].body.transactionalId).toBe("tmpl_x");
    });

    it("rejects missing transactionalId", async () => {
      const result = await api("POST", "/v1/transactional", { email: "r@parlel.dev" });
      expect(result.status).toBe(400);
    });

    it("rejects invalid email", async () => {
      const result = await api("POST", "/v1/transactional", { transactionalId: "x", email: "bad" });
      expect(result.status).toBe(400);
    });
  });

  describe("Contacts", () => {
    it("creates, finds and updates a contact", async () => {
      const created = await api("POST", "/v1/contacts/create", { email: "c@parlel.dev", firstName: "C" });
      expect(created.status).toBe(200);
      expect(created.body.success).toBe(true);

      const found = await api("GET", "/v1/contacts/find?email=c@parlel.dev");
      expect(found.status).toBe(200);
      expect(Array.isArray(found.body)).toBe(true);
      expect(found.body[0].email).toBe("c@parlel.dev");

      const updated = await api("PUT", "/v1/contacts/update", { email: "c@parlel.dev", firstName: "Updated" });
      expect(updated.body.success).toBe(true);

      const refound = await api("GET", "/v1/contacts/find?email=c@parlel.dev");
      expect(refound.body[0].firstName).toBe("Updated");
    });

    it("returns empty array when contact not found", async () => {
      const found = await api("GET", "/v1/contacts/find?email=none@parlel.dev");
      expect(found.status).toBe(200);
      expect(found.body).toEqual([]);
    });

    it("update upserts a missing contact", async () => {
      const updated = await api("PUT", "/v1/contacts/update", { email: "new@parlel.dev", firstName: "New" });
      expect(updated.status).toBe(200);
      const found = await api("GET", "/v1/contacts/find?email=new@parlel.dev");
      expect(found.body.length).toBe(1);
    });
  });

  describe("Events", () => {
    it("sends an event", async () => {
      const result = await api("POST", "/v1/events/send", {
        email: "c@parlel.dev",
        eventName: "signup",
      });
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });

    it("rejects event missing eventName", async () => {
      const result = await api("POST", "/v1/events/send", { email: "c@parlel.dev" });
      expect(result.status).toBe(400);
    });
  });

  describe("GET /v1/api-key", () => {
    it("validates the api key", async () => {
      const result = await api("GET", "/v1/api-key");
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", "/v1/transactional", { transactionalId: "x", email: "r@parlel.dev" });
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
