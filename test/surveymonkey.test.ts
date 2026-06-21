import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SurveymonkeyServer } from "../services/surveymonkey/src/server.js";

const PORT = 14847;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelTestToken";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

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

describe("SurveyMonkey Service", () => {
  let server: SurveymonkeyServer;

  beforeAll(async () => {
    server = new SurveymonkeyServer(PORT);
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
      expect(root.body.name).toBe("surveymonkey");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/v3/surveys`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer with 401", async () => {
      const response = await fetch(`${BASE_URL}/v3/surveys`, { method: "GET" });
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body.error).toBeTruthy();
    });

    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/v3/surveys");
      expect(result.status).toBe(200);
    });
  });

  describe("Users", () => {
    it("GET /v3/users/me", async () => {
      const result = await api("GET", "/v3/users/me");
      expect(result.status).toBe(200);
      expect(result.body.username).toBe("parlel");
    });
  });

  describe("Surveys list envelope", () => {
    it("lists surveys with {data,per_page,page,total,links}", async () => {
      const result = await api("GET", "/v3/surveys");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.data)).toBe(true);
      expect(result.body).toHaveProperty("per_page");
      expect(result.body).toHaveProperty("page");
      expect(result.body).toHaveProperty("total");
      expect(result.body).toHaveProperty("links");
    });
  });

  describe("Surveys CRUD round-trip", () => {
    it("creates, retrieves, updates, details and deletes a survey", async () => {
      const created = await api("POST", "/v3/surveys", { title: "Net Promoter" });
      expect(created.status).toBe(201);
      const id = created.body.id;
      expect(id).toBeTruthy();

      const got = await api("GET", `/v3/surveys/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.title).toBe("Net Promoter");

      const updated = await api("PATCH", `/v3/surveys/${id}`, { title: "NPS 2024" });
      expect(updated.body.title).toBe("NPS 2024");

      const details = await api("GET", `/v3/surveys/${id}/details`);
      expect(details.status).toBe(200);
      expect(Array.isArray(details.body.pages)).toBe(true);

      const deleted = await api("DELETE", `/v3/surveys/${id}`);
      expect(deleted.status).toBe(200);
      const gone = await api("GET", `/v3/surveys/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Responses", () => {
    it("creates and lists responses for a survey", async () => {
      const created = await api("POST", "/v3/surveys", { title: "Feedback" });
      const id = created.body.id;
      const resp = await api("POST", `/v3/surveys/${id}/responses`, {
        pages: [{ id: "1", questions: [] }],
      });
      expect(resp.status).toBe(201);
      const rid = resp.body.id;

      const list = await api("GET", `/v3/surveys/${id}/responses`);
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBe(1);

      const one = await api("GET", `/v3/surveys/${id}/responses/${rid}`);
      expect(one.status).toBe(200);
      expect(one.body.id).toBe(rid);
    });
  });
});
