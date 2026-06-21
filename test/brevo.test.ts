import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BrevoServer } from "../services/brevo/src/server.js";

const PORT = 14828;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { "api-key": "xkeysib-parlel" };

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

function validEmail(): Json {
  return {
    sender: { email: "sender@parlel.dev", name: "Parlel" },
    to: [{ email: "recipient@parlel.dev" }],
    subject: "Hello",
    htmlContent: "<b>Hi</b>",
  };
}

describe("Brevo Service", () => {
  let server: BrevoServer;

  beforeAll(async () => {
    server = new BrevoServer(PORT);
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
      expect(root.body.name).toBe("brevo");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v3/smtp/email`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing api-key with 401", async () => {
      const response = await fetch(`${BASE_URL}/v3/smtp/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validEmail()),
      });
      expect(response.status).toBe(401);
    });

    it("accepts api-key header", async () => {
      const result = await api("POST", "/v3/smtp/email", validEmail());
      expect(result.status).toBe(201);
    });
  });

  describe("POST /v3/smtp/email", () => {
    it("sends and returns messageId", async () => {
      const result = await api("POST", "/v3/smtp/email", validEmail());
      expect(result.status).toBe(201);
      expect(result.body.messageId).toBeTruthy();
    });

    it("captures the message for inspection", async () => {
      await api("POST", "/v3/smtp/email", validEmail());
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
      expect(inbox.body.messages[0].body.subject).toBe("Hello");
    });

    it("rejects missing sender", async () => {
      const result = await api("POST", "/v3/smtp/email", { to: [{ email: "a@parlel.dev" }], subject: "x" });
      expect(result.status).toBe(400);
    });

    it("rejects missing recipients", async () => {
      const result = await api("POST", "/v3/smtp/email", { sender: { email: "a@parlel.dev" }, subject: "x" });
      expect(result.status).toBe(400);
    });
  });

  describe("Contacts CRUD", () => {
    it("creates, reads, updates and deletes a contact", async () => {
      const created = await api("POST", "/v3/contacts", { email: "c@parlel.dev", attributes: { FNAME: "C" } });
      expect(created.status).toBe(201);
      expect(created.body.id).toBeTruthy();

      const got = await api("GET", "/v3/contacts/c@parlel.dev");
      expect(got.status).toBe(200);
      expect(got.body.email).toBe("c@parlel.dev");

      const updated = await api("PUT", "/v3/contacts/c@parlel.dev", { attributes: { FNAME: "Updated" } });
      expect(updated.status).toBe(204);

      const list = await api("GET", "/v3/contacts");
      expect(list.body.count).toBe(1);

      const deleted = await api("DELETE", "/v3/contacts/c@parlel.dev");
      expect(deleted.status).toBe(204);
      const gone = await api("GET", "/v3/contacts/c@parlel.dev");
      expect(gone.status).toBe(404);
    });

    it("rejects invalid contact email", async () => {
      const result = await api("POST", "/v3/contacts", { email: "bad" });
      expect(result.status).toBe(400);
    });
  });

  describe("Templates", () => {
    it("creates a template", async () => {
      const result = await api("POST", "/v3/smtp/templates", {
        templateName: "Welcome",
        subject: "Hi",
        htmlContent: "<p>Hi</p>",
      });
      expect(result.status).toBe(201);
      expect(result.body.id).toBeTruthy();
    });
  });

  describe("GET /v3/account", () => {
    it("returns account info", async () => {
      const result = await api("GET", "/v3/account");
      expect(result.status).toBe(200);
      expect(result.body.email).toBeTruthy();
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", "/v3/smtp/email", validEmail());
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
