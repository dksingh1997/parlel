import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FormstackServer } from "../services/formstack/src/server.js";

const PORT = 14853;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlelFormstackToken";
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

describe("Formstack Service", () => {
  let server: FormstackServer;

  beforeAll(async () => {
    server = new FormstackServer(PORT);
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
      expect(root.body.name).toBe("formstack");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer with 401", async () => {
      const response = await fetch(`${BASE_URL}/api/v2/form.json`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Bearer", async () => {
      const result = await api("GET", "/api/v2/form.json");
      expect(result.status).toBe(200);
    });
  });

  describe("Forms list shape", () => {
    it("lists forms with {forms,total,page,per_page}", async () => {
      const result = await api("GET", "/api/v2/form.json");
      expect(Array.isArray(result.body.forms)).toBe(true);
      expect(result.body).toHaveProperty("total");
      expect(result.body).toHaveProperty("page");
      expect(result.body).toHaveProperty("per_page");
    });

    it("retrieves a single form by id", async () => {
      const list = await api("GET", "/api/v2/form.json");
      const id = list.body.forms[0].id;
      const result = await api("GET", `/api/v2/form/${id}.json`);
      expect(result.status).toBe(200);
      expect(result.body.id).toBe(id);
      expect(Array.isArray(result.body.fields)).toBe(true);
    });

    it("404 unknown form", async () => {
      const result = await api("GET", "/api/v2/form/0.json");
      expect(result.status).toBe(404);
    });
  });

  describe("Submissions CRUD round-trip", () => {
    it("creates, lists and retrieves a submission", async () => {
      const list = await api("GET", "/api/v2/form.json");
      const formId = list.body.forms[0].id;

      const created = await api("POST", `/api/v2/form/${formId}/submission.json`, {
        field_1: "Alice",
        field_2: "alice@parlel.dev",
      });
      expect(created.status).toBe(200);
      const subId = created.body.id;
      expect(subId).toBeTruthy();

      const subs = await api("GET", `/api/v2/form/${formId}/submission.json`);
      expect(subs.body.submissions.length).toBe(1);

      const got = await api("GET", `/api/v2/submission/${subId}.json`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(subId);

      const deleted = await api("DELETE", `/api/v2/submission/${subId}.json`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/api/v2/submission/${subId}.json`);
      expect(gone.status).toBe(404);
    });
  });
});
