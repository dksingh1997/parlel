import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { JotformServer } from "../services/jotform/src/server.js";

const PORT = 14846;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelTestKey";
const AUTH = { APIKEY: API_KEY };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
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

describe("Jotform Service", () => {
  let server: JotformServer;

  beforeAll(async () => {
    server = new JotformServer(PORT);
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
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("jotform");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/user`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  describe("Authentication", () => {
    it("rejects requests with no api key (401)", async () => {
      const response = await fetch(`${BASE_URL}/user`, { method: "GET" });
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body.responseCode).toBe(401);
    });

    it("accepts APIKEY header auth", async () => {
      const result = await api("GET", "/user");
      expect(result.status).toBe(200);
    });

    it("accepts ?apiKey= query auth", async () => {
      const response = await fetch(`${BASE_URL}/user?apiKey=${API_KEY}`, { method: "GET" });
      expect(response.status).toBe(200);
    });
  });

  describe("Response envelope", () => {
    it("wraps GET /user in {responseCode,message,content}", async () => {
      const result = await api("GET", "/user");
      expect(result.body.responseCode).toBe(200);
      expect(result.body.message).toBe("success");
      expect(result.body.content.username).toBe("parlel");
    });
  });

  describe("Forms", () => {
    it("lists user forms", async () => {
      const result = await api("GET", "/user/forms");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.content)).toBe(true);
      expect(result.body.content.length).toBeGreaterThanOrEqual(1);
    });

    it("retrieves a single form", async () => {
      const list = await api("GET", "/user/forms");
      const id = list.body.content[0].id;
      const result = await api("GET", `/form/${id}`);
      expect(result.status).toBe(200);
      expect(result.body.content.id).toBe(id);
    });

    it("404s for an unknown form", async () => {
      const result = await api("GET", "/form/000");
      expect(result.status).toBe(404);
      expect(result.body.responseCode).toBe(404);
    });
  });

  describe("Questions", () => {
    it("lists form questions as a keyed object", async () => {
      const list = await api("GET", "/user/forms");
      const id = list.body.content[0].id;
      const result = await api("GET", `/form/${id}/questions`);
      expect(result.status).toBe(200);
      expect(typeof result.body.content).toBe("object");
      expect(Object.keys(result.body.content).length).toBeGreaterThanOrEqual(3);
    });

    it("adds a question via POST", async () => {
      const list = await api("GET", "/user/forms");
      const id = list.body.content[0].id;
      const result = await api("POST", `/form/${id}/questions`, {
        question: { type: "control_phone", text: "Phone", name: "phone" },
      });
      expect(result.status).toBe(200);
      const keys = Object.keys(result.body.content);
      expect(result.body.content[keys[0]].text).toBe("Phone");
    });
  });

  describe("Submissions CRUD round-trip", () => {
    it("creates and retrieves a submission", async () => {
      const list = await api("GET", "/user/forms");
      const formId = list.body.content[0].id;
      const created = await api("POST", `/form/${formId}/submissions`, {
        answers: { "1": { answer: "Alice" }, "2": { answer: "alice@parlel.dev" } },
      });
      expect(created.status).toBe(200);
      const subId = created.body.content.submissionID;
      expect(subId).toBeTruthy();

      const got = await api("GET", `/submission/${subId}`);
      expect(got.status).toBe(200);
      expect(got.body.content.id).toBe(subId);
      expect(got.body.content.answers["1"].answer).toBe("Alice");

      const formSubs = await api("GET", `/form/${formId}/submissions`);
      expect(formSubs.body.content.length).toBe(1);
    });

    it("deletes a submission", async () => {
      const list = await api("GET", "/user/forms");
      const formId = list.body.content[0].id;
      const created = await api("POST", `/form/${formId}/submissions`, { answers: {} });
      const subId = created.body.content.submissionID;
      const deleted = await api("DELETE", `/submission/${subId}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/submission/${subId}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      const list = await api("GET", "/user/forms");
      const formId = list.body.content[0].id;
      await api("POST", `/form/${formId}/submissions`, { answers: {} });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const subs = await api("GET", "/__parlel/submissions");
      expect(subs.body.count).toBe(0);
    });
  });
});
