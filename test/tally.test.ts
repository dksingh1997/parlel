import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TallyServer } from "../services/tally/src/server.js";

const PORT = 14848;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "parlelTallyKey";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

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

describe("Tally Service", () => {
  let server: TallyServer;

  beforeAll(async () => {
    server = new TallyServer(PORT);
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
      expect(root.body.name).toBe("tally");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer with 401", async () => {
      const response = await fetch(`${BASE_URL}/forms`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Bearer", async () => {
      const result = await api("GET", "/forms");
      expect(result.status).toBe(200);
    });
  });

  describe("List envelope", () => {
    it("forms list uses {items,page,limit,total,hasMore}", async () => {
      const result = await api("GET", "/forms");
      expect(Array.isArray(result.body.items)).toBe(true);
      expect(result.body).toHaveProperty("page");
      expect(result.body).toHaveProperty("limit");
      expect(result.body).toHaveProperty("total");
      expect(result.body).toHaveProperty("hasMore");
    });

    it("lists workspaces", async () => {
      const result = await api("GET", "/workspaces");
      expect(result.status).toBe(200);
      expect(result.body.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Forms CRUD round-trip", () => {
    it("creates, retrieves a form", async () => {
      const created = await api("POST", "/forms", { name: "Waitlist" });
      expect(created.status).toBe(200);
      const id = created.body.id;
      expect(id).toBeTruthy();
      const got = await api("GET", `/forms/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("Waitlist");
    });

    it("404 unknown form", async () => {
      const result = await api("GET", "/forms/nope");
      expect(result.status).toBe(404);
    });
  });

  describe("Responses/submissions", () => {
    it("creates and lists responses", async () => {
      const created = await api("POST", "/forms", { name: "Survey" });
      const id = created.body.id;
      const sub = await api("POST", `/forms/${id}/submissions`, {
        responses: [{ questionId: "q1", answer: "yes" }],
      });
      expect(sub.status).toBe(200);

      const responses = await api("GET", `/forms/${id}/responses`);
      expect(responses.status).toBe(200);
      expect(responses.body.items.length).toBe(1);

      const submissions = await api("GET", `/forms/${id}/submissions`);
      expect(submissions.status).toBe(200);
      expect(submissions.body.items.length).toBe(1);
    });
  });
});
