import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SparkpostServer } from "../services/sparkpost/src/server.js";

const PORT = 14830;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "parlel-sparkpost-key" };

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

function validTransmission(): Json {
  return {
    content: { from: "sender@parlel.dev", subject: "Hello", html: "<b>Hi</b>" },
    recipients: [{ address: { email: "recipient@parlel.dev" } }],
  };
}

describe("SparkPost Service", () => {
  let server: SparkpostServer;

  beforeAll(async () => {
    server = new SparkpostServer(PORT);
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
      expect(root.body.name).toBe("sparkpost");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/transmissions`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/transmissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validTransmission()),
      });
      expect(response.status).toBe(401);
    });

    it("accepts raw Authorization header (no Bearer)", async () => {
      const result = await api("POST", "/api/v1/transmissions", validTransmission());
      expect(result.status).toBe(200);
    });
  });

  describe("POST /api/v1/transmissions", () => {
    it("sends and returns the documented results shape", async () => {
      const result = await api("POST", "/api/v1/transmissions", validTransmission());
      expect(result.status).toBe(200);
      expect(result.body.results.total_accepted_recipients).toBe(1);
      expect(result.body.results.total_rejected_recipients).toBe(0);
      expect(result.body.results.id).toBeTruthy();
    });

    it("captures the sent message for inspection", async () => {
      await api("POST", "/api/v1/transmissions", validTransmission());
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
      expect(inbox.body.messages[0].body.content.subject).toBe("Hello");
    });

    it("rejects missing content.from", async () => {
      const result = await api("POST", "/api/v1/transmissions", {
        content: { subject: "x" },
        recipients: [{ address: { email: "r@parlel.dev" } }],
      });
      expect(result.status).toBe(422);
    });

    it("rejects missing recipients", async () => {
      const result = await api("POST", "/api/v1/transmissions", {
        content: { from: "f@parlel.dev", subject: "x" },
      });
      expect(result.status).toBe(422);
    });

    it("lists and retrieves a transmission", async () => {
      const created = await api("POST", "/api/v1/transmissions", validTransmission());
      const id = created.body.results.id;
      const list = await api("GET", "/api/v1/transmissions");
      expect(list.body.results.length).toBe(1);
      const got = await api("GET", `/api/v1/transmissions/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.results.id).toBe(id);
    });
  });

  describe("Templates", () => {
    it("creates and lists a template", async () => {
      const created = await api("POST", "/api/v1/templates", {
        id: "welcome",
        name: "Welcome",
        content: { from: "f@parlel.dev", subject: "Hi", html: "<p>Hi</p>" },
      });
      expect(created.status).toBe(200);
      expect(created.body.results.id).toBe("welcome");
      const list = await api("GET", "/api/v1/templates");
      expect(list.body.results.length).toBe(1);
    });
  });

  describe("GET /api/v1/account", () => {
    it("returns account info", async () => {
      const result = await api("GET", "/api/v1/account");
      expect(result.status).toBe(200);
      expect(result.body.results.company_name).toBeTruthy();
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", "/api/v1/transmissions", validTransmission());
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
