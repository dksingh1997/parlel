import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PipedriveServer } from "../services/pipedrive/src/server.js";

const PORT = 14779;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "pat-parlelTestToken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Pipedrive Service", () => {
  let server: PipedriveServer;

  beforeAll(async () => {
    server = new PipedriveServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => expect(server.port).toBe(PORT));
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("pipedrive");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const r = await fetch(`${BASE_URL}/v1/persons`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/v1/persons", undefined, {});
      expect(result.status).toBe(401);
      expect(result.body.success).toBe(false);
    });
    it("accepts ?api_token= query auth", async () => {
      const result = await api("GET", `/v1/persons?api_token=${TOKEN}`, undefined, {});
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
    it("accepts Bearer auth", async () => {
      const result = await api("GET", "/v1/persons");
      expect(result.status).toBe(200);
    });
  });

  describe("Persons CRUD", () => {
    it("creates a person (201) with envelope", async () => {
      const result = await api("POST", "/v1/persons", { name: "Ada Lovelace" });
      expect(result.status).toBe(201);
      expect(result.body.success).toBe(true);
      expect(result.body.data.id).toBeTruthy();
      expect(result.body.data.name).toBe("Ada Lovelace");
    });
    it("rejects person without name", async () => {
      const result = await api("POST", "/v1/persons", {});
      expect(result.status).toBe(400);
      expect(result.body.success).toBe(false);
    });
    it("reads a person back", async () => {
      const created = await api("POST", "/v1/persons", { name: "Grace" });
      const got = await api("GET", `/v1/persons/${created.body.data.id}`);
      expect(got.status).toBe(200);
      expect(got.body.data.name).toBe("Grace");
    });
    it("returns 404 for unknown person", async () => {
      const got = await api("GET", "/v1/persons/99999");
      expect(got.status).toBe(404);
    });
    it("lists persons with pagination envelope", async () => {
      await api("POST", "/v1/persons", { name: "P1" });
      const list = await api("GET", "/v1/persons");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.additional_data.pagination).toBeTruthy();
    });
    it("updates a person via PUT", async () => {
      const created = await api("POST", "/v1/persons", { name: "Old" });
      const updated = await api("PUT", `/v1/persons/${created.body.data.id}`, { name: "New" });
      expect(updated.status).toBe(200);
      expect(updated.body.data.name).toBe("New");
    });
    it("deletes a person", async () => {
      const created = await api("POST", "/v1/persons", { name: "Bye" });
      const del = await api("DELETE", `/v1/persons/${created.body.data.id}`);
      expect(del.status).toBe(200);
      const gone = await api("GET", `/v1/persons/${created.body.data.id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Deals, Organizations, Leads", () => {
    it("creates a deal", async () => {
      const result = await api("POST", "/v1/deals", { title: "Big Deal" });
      expect(result.status).toBe(201);
      expect(result.body.data.title).toBe("Big Deal");
    });
    it("creates an organization", async () => {
      const result = await api("POST", "/v1/organizations", { name: "Parlel Inc" });
      expect(result.status).toBe(201);
      expect(result.body.data.name).toBe("Parlel Inc");
    });
    it("creates a lead with uuid id", async () => {
      const result = await api("POST", "/v1/leads", { title: "Hot Lead" });
      expect(result.status).toBe(201);
      expect(typeof result.body.data.id).toBe("string");
      const got = await api("GET", `/v1/leads/${result.body.data.id}`);
      expect(got.status).toBe(200);
    });
  });
});
