import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostmarkServer } from "../services/postmark/src/server.js";

const PORT = 14827;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel-server-token";
const AUTH = { "X-Postmark-Server-Token": TOKEN };

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
    From: "sender@parlel.dev",
    To: "recipient@parlel.dev",
    Subject: "Hello",
    HtmlBody: "<b>Hi</b>",
    TextBody: "Hi",
  };
}

describe("Postmark Service", () => {
  let server: PostmarkServer;

  beforeAll(async () => {
    server = new PostmarkServer(PORT);
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
      expect(root.body.name).toBe("postmark");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/email`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing server token with 401", async () => {
      const response = await fetch(`${BASE_URL}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validEmail()),
      });
      expect(response.status).toBe(401);
    });

    it("accepts X-Postmark-Server-Token", async () => {
      const result = await api("POST", "/email", validEmail());
      expect(result.status).toBe(200);
    });
  });

  describe("POST /email", () => {
    it("sends and returns the documented OK shape", async () => {
      const result = await api("POST", "/email", validEmail());
      expect(result.status).toBe(200);
      expect(result.body.ErrorCode).toBe(0);
      expect(result.body.Message).toBe("OK");
      expect(result.body.To).toBe("recipient@parlel.dev");
      expect(result.body.MessageID).toBeTruthy();
      expect(result.body.SubmittedAt).toBeTruthy();
    });

    it("captures the message for inspection", async () => {
      const result = await api("POST", "/email", validEmail());
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(1);
      expect(inbox.body.messages[0].body.Subject).toBe("Hello");
      const one = await api("GET", `/__parlel/messages/${result.body.MessageID}`);
      expect(one.status).toBe(200);
    });

    it("rejects invalid From with 422", async () => {
      const result = await api("POST", "/email", { To: "a@parlel.dev", Subject: "x" });
      expect(result.status).toBe(422);
      expect(result.body.ErrorCode).toBe(300);
    });
  });

  describe("POST /email/batch", () => {
    it("sends a batch and returns an array", async () => {
      const result = await api("POST", "/email/batch", [validEmail(), validEmail()]);
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
      expect(result.body.length).toBe(2);
      expect(result.body[0].ErrorCode).toBe(0);
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(2);
    });
  });

  describe("POST /email/withTemplate", () => {
    it("sends with a template id", async () => {
      const result = await api("POST", "/email/withTemplate", {
        From: "sender@parlel.dev",
        To: "recipient@parlel.dev",
        TemplateId: 12345,
        TemplateModel: { name: "Parlel" },
      });
      expect(result.status).toBe(200);
      expect(result.body.ErrorCode).toBe(0);
    });

    it("rejects when no template provided", async () => {
      const result = await api("POST", "/email/withTemplate", {
        From: "sender@parlel.dev",
        To: "recipient@parlel.dev",
      });
      expect(result.status).toBe(422);
    });
  });

  describe("GET /messages/outbound", () => {
    it("lists outbound messages", async () => {
      await api("POST", "/email", validEmail());
      const result = await api("GET", "/messages/outbound");
      expect(result.status).toBe(200);
      expect(result.body.TotalCount).toBe(1);
      expect(result.body.Messages[0].Status).toBe("Sent");
    });
  });

  describe("GET /server", () => {
    it("returns server metadata", async () => {
      const result = await api("GET", "/server");
      expect(result.status).toBe(200);
      expect(result.body.Name).toBeTruthy();
    });
  });

  describe("parlel inspection", () => {
    it("resets all state", async () => {
      await api("POST", "/email", validEmail());
      await api("POST", "/__parlel/reset");
      const inbox = await api("GET", "/__parlel/messages");
      expect(inbox.body.count).toBe(0);
    });
  });
});
