import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MailjetServer } from "../services/mailjet/src/server.js";

const PORT = 14829;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Basic ${Buffer.from("parlel-key:parlel-secret").toString("base64")}` };

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

function validSend(): Json {
  return {
    Messages: [
      {
        From: { Email: "sender@parlel.dev", Name: "Parlel" },
        To: [{ Email: "recipient@parlel.dev", Name: "Recipient" }],
        Subject: "Hello",
        TextPart: "Hi",
        HTMLPart: "<b>Hi</b>",
      },
    ],
  };
}

describe("Mailjet Service", () => {
  let server: MailjetServer;

  beforeAll(async () => {
    server = new MailjetServer(PORT);
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
      expect(root.body.name).toBe("mailjet");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v3.1/send`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/v3.1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSend()),
      });
      expect(response.status).toBe(401);
    });

    it("accepts Basic auth", async () => {
      const result = await api("POST", "/v3.1/send", validSend());
      expect(result.status).toBe(200);
    });
  });

  describe("POST /v3.1/send", () => {
    it("sends and returns the documented Messages shape", async () => {
      const result = await api("POST", "/v3.1/send", validSend());
      expect(result.status).toBe(200);
      expect(result.body.Messages[0].Status).toBe("success");
      const to = result.body.Messages[0].To[0];
      expect(to.Email).toBe("recipient@parlel.dev");
      expect(to.MessageID).toBeTruthy();
      expect(to.MessageUUID).toBeTruthy();
      expect(to.MessageHref).toContain("/message/");
    });

    it("captures the sent message for inspection", async () => {
      await api("POST", "/v3.1/send", validSend());
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
      expect(inbox.body.messages[0].body.Subject).toBe("Hello");
    });

    it("returns an error status for missing From", async () => {
      const result = await api("POST", "/v3.1/send", {
        Messages: [{ To: [{ Email: "r@parlel.dev" }], Subject: "x" }],
      });
      expect(result.status).toBe(400);
      expect(result.body.Messages[0].Status).toBe("error");
    });

    it("rejects body without Messages array", async () => {
      const result = await api("POST", "/v3.1/send", {});
      expect(result.status).toBe(400);
    });
  });

  describe("Contacts", () => {
    it("creates, reads and updates a contact", async () => {
      const created = await api("POST", "/v3/REST/contact", { Email: "c@parlel.dev", Name: "C" });
      expect(created.status).toBe(201);
      const id = created.body.Data[0].ID;

      const got = await api("GET", `/v3/REST/contact/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.Data[0].Email).toBe("c@parlel.dev");

      const byEmail = await api("GET", "/v3/REST/contact/c@parlel.dev");
      expect(byEmail.status).toBe(200);

      const updated = await api("PUT", `/v3/REST/contact/${id}`, { Name: "Updated" });
      expect(updated.body.Data[0].Name).toBe("Updated");

      const list = await api("GET", "/v3/REST/contact");
      expect(list.body.Count).toBe(1);
    });

    it("rejects invalid contact email", async () => {
      const result = await api("POST", "/v3/REST/contact", { Email: "bad" });
      expect(result.status).toBe(400);
    });
  });

  describe("Contact lists", () => {
    it("lists contact lists (seeded default present)", async () => {
      const result = await api("GET", "/v3/REST/contactslist");
      expect(result.status).toBe(200);
      expect(result.body.Count).toBeGreaterThanOrEqual(1);
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", "/v3.1/send", validSend());
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
