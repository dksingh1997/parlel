import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ServicenowServer } from "../services/servicenow/src/server.js";

const PORT = 14784;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = Buffer.from("admin:pat-parlel").toString("base64");
const AUTH = { Authorization: `Basic ${BASIC}` };

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

describe("ServiceNow Service", () => {
  let server: ServicenowServer;

  beforeAll(async () => {
    server = new ServicenowServer(PORT);
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
      expect(root.body.name).toBe("servicenow");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const r = await fetch(`${BASE_URL}/api/now/table/incident`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/api/now/table/incident", undefined, {});
      expect(result.status).toBe(401);
      expect(result.body.status).toBe("failure");
    });
  });

  describe("Table API CRUD", () => {
    it("creates an incident wrapped in {result} with 32-hex sys_id", async () => {
      const result = await api("POST", "/api/now/table/incident", { short_description: "Email down", priority: "1" });
      expect(result.status).toBe(201);
      expect(result.body.result.sys_id).toMatch(/^[0-9a-f]{32}$/);
      expect(result.body.result.number).toMatch(/^INC/);
      expect(result.body.result.short_description).toBe("Email down");
    });
    it("reads a record by sys_id", async () => {
      const created = await api("POST", "/api/now/table/incident", { short_description: "Read me" });
      const got = await api("GET", `/api/now/table/incident/${created.body.result.sys_id}`);
      expect(got.status).toBe(200);
      expect(got.body.result.short_description).toBe("Read me");
    });
    it("returns 404 for unknown sys_id", async () => {
      const got = await api("GET", "/api/now/table/incident/00000000000000000000000000000000");
      expect(got.status).toBe(404);
    });
    it("lists records wrapped in {result} array", async () => {
      await api("POST", "/api/now/table/incident", { short_description: "I1" });
      const list = await api("GET", "/api/now/table/incident");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.result)).toBe(true);
      expect(list.body.result.length).toBe(1);
    });
    it("filters via sysparm_query", async () => {
      await api("POST", "/api/now/table/incident", { short_description: "A", priority: "1" });
      await api("POST", "/api/now/table/incident", { short_description: "B", priority: "2" });
      const list = await api("GET", "/api/now/table/incident?sysparm_query=priority=1");
      expect(list.body.result.length).toBe(1);
      expect(list.body.result[0].short_description).toBe("A");
    });
    it("updates a record via PUT", async () => {
      const created = await api("POST", "/api/now/table/incident", { short_description: "old" });
      const updated = await api("PUT", `/api/now/table/incident/${created.body.result.sys_id}`, { state: "2" });
      expect(updated.status).toBe(200);
      expect(updated.body.result.state).toBe("2");
    });
    it("patches a record via PATCH", async () => {
      const created = await api("POST", "/api/now/table/incident", { short_description: "old" });
      const patched = await api("PATCH", `/api/now/table/incident/${created.body.result.sys_id}`, { priority: "3" });
      expect(patched.status).toBe(200);
      expect(patched.body.result.priority).toBe("3");
    });
    it("deletes a record (204)", async () => {
      const created = await api("POST", "/api/now/table/incident", { short_description: "bye" });
      const del = await api("DELETE", `/api/now/table/incident/${created.body.result.sys_id}`);
      expect(del.status).toBe(204);
      const gone = await api("GET", `/api/now/table/incident/${created.body.result.sys_id}`);
      expect(gone.status).toBe(404);
    });
    it("supports arbitrary tables", async () => {
      const result = await api("POST", "/api/now/table/problem", { short_description: "root cause" });
      expect(result.status).toBe(201);
      expect(result.body.result.number).toMatch(/^PRB/);
    });
  });
});
