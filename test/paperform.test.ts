import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PaperformServer } from "../services/paperform/src/server.js";

const PORT = 14855;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlelPaperformKey";
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

describe("Paperform Service", () => {
  let server: PaperformServer;

  beforeAll(async () => {
    server = new PaperformServer(PORT);
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
      expect(root.body.name).toBe("paperform");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer with 401", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/forms`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Bearer", async () => {
      const result = await api("GET", "/api/v1/forms");
      expect(result.status).toBe(200);
    });
  });

  describe("Results-wrapper shape", () => {
    it("lists forms as {results:{forms:[]}}", async () => {
      const result = await api("GET", "/api/v1/forms");
      expect(result.status).toBe(200);
      expect(result.body.results).toBeTruthy();
      expect(Array.isArray(result.body.results.forms)).toBe(true);
      expect(result.body.results.forms.length).toBeGreaterThanOrEqual(1);
    });

    it("retrieves a single form as {results:{form}}", async () => {
      const list = await api("GET", "/api/v1/forms");
      const id = list.body.results.forms[0].id;
      const result = await api("GET", `/api/v1/forms/${id}`);
      expect(result.status).toBe(200);
      expect(result.body.results.form.id).toBe(id);
    });

    it("lists fields as {results:{fields:[]}}", async () => {
      const list = await api("GET", "/api/v1/forms");
      const id = list.body.results.forms[0].id;
      const result = await api("GET", `/api/v1/forms/${id}/fields`);
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.results.fields)).toBe(true);
    });

    it("404 unknown form", async () => {
      const result = await api("GET", "/api/v1/forms/nope");
      expect(result.status).toBe(404);
    });
  });

  describe("Submissions CRUD round-trip", () => {
    it("creates, lists and retrieves a submission", async () => {
      const list = await api("GET", "/api/v1/forms");
      const formId = list.body.results.forms[0].id;

      const created = await api("POST", `/api/v1/forms/${formId}/submissions`, {
        data: { name: "Alice", email: "alice@parlel.dev" },
      });
      expect(created.status).toBe(201);
      const subId = created.body.results.submission.id;
      expect(subId).toBeTruthy();

      const subs = await api("GET", `/api/v1/forms/${formId}/submissions`);
      expect(subs.body.results.submissions.length).toBe(1);

      const got = await api("GET", `/api/v1/submissions/${subId}`);
      expect(got.status).toBe(200);
      expect(got.body.results.submission.id).toBe(subId);
      expect(got.body.results.submission.data.name).toBe("Alice");
    });
  });
});
