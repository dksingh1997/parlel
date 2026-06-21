import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TypeformServer } from "../services/typeform/src/server.js";

const PORT = 14812;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Bearer parlelTestToken` };

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

describe("Typeform Service", () => {
  let server: TypeformServer;

  beforeAll(async () => {
    server = new TypeformServer(PORT);
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
      expect(root.body.name).toBe("typeform");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}/forms`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer token", async () => {
      const response = await fetch(`${BASE_URL}/forms`);
      expect(response.status).toBe(401);
    });
  });

  describe("GET /me", () => {
    it("returns the authenticated user", async () => {
      const result = await api("GET", "/me");
      expect(result.status).toBe(200);
      expect(result.body.email).toBeTruthy();
    });
  });

  describe("Forms CRUD", () => {
    it("lists forms in the {total_items,page_count,items} shape", async () => {
      const result = await api("GET", "/forms");
      expect(result.status).toBe(200);
      expect(typeof result.body.total_items).toBe("number");
      expect(typeof result.body.page_count).toBe("number");
      expect(Array.isArray(result.body.items)).toBe(true);
      expect(result.body.items.length).toBeGreaterThanOrEqual(1);
    });

    it("creates a form with {id,title,fields,_links}", async () => {
      const created = await api("POST", "/forms", {
        title: "Feedback",
        fields: [{ title: "Your name?", type: "short_text", ref: "name" }],
      });
      expect(created.status).toBe(201);
      expect(created.body.id).toBeTruthy();
      expect(created.body.title).toBe("Feedback");
      expect(created.body.fields.length).toBe(1);
      expect(created.body._links.display).toContain(created.body.id);
    });

    it("rejects form creation without a title", async () => {
      const result = await api("POST", "/forms", { fields: [] });
      expect(result.status).toBe(400);
    });

    it("retrieves, updates and deletes a form", async () => {
      const created = await api("POST", "/forms", { title: "Survey", fields: [] });
      const id = created.body.id;
      const got = await api("GET", `/forms/${id}`);
      expect(got.body.title).toBe("Survey");
      const updated = await api("PUT", `/forms/${id}`, { title: "Survey v2" });
      expect(updated.body.title).toBe("Survey v2");
      const deleted = await api("DELETE", `/forms/${id}`);
      expect(deleted.status).toBe(204);
      const gone = await api("GET", `/forms/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Responses", () => {
    it("lists responses for a form", async () => {
      const created = await api("POST", "/forms", { title: "RForm", fields: [] });
      const id = created.body.id;
      const empty = await api("GET", `/forms/${id}/responses`);
      expect(empty.status).toBe(200);
      expect(empty.body.total_items).toBe(0);

      await api("POST", `/forms/${id}/responses`, { answers: [{ field: { ref: "name" }, type: "text", text: "Alice" }] });
      const list = await api("GET", `/forms/${id}/responses`);
      expect(list.body.total_items).toBe(1);
      expect(list.body.items[0].answers[0].text).toBe("Alice");
    });

    it("returns 404 for responses of an unknown form", async () => {
      const result = await api("GET", "/forms/nope/responses");
      expect(result.status).toBe(404);
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", "/forms", { title: "X", fields: [] });
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/forms");
      expect(after.body.count).toBe(1); // back to seeded default
    });
  });
});
