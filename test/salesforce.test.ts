import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SalesforceServer } from "../services/salesforce/src/server.js";

const PORT = 14778;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer pat-parlelTestToken" };
const V = "v59.0";

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

describe("Salesforce Service", () => {
  let server: SalesforceServer;

  beforeAll(async () => {
    server = new SalesforceServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("salesforce");
      expect(health.body).toEqual({ status: "ok" });
    });
    it("supports CORS preflight OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/services/data/${V}/sobjects/Account`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", `/services/data/${V}/sobjects/Account/001abc`, undefined, {});
      expect(result.status).toBe(401);
      expect(result.body[0].errorCode).toBe("INVALID_SESSION_ID");
    });
  });

  describe("sObject CRUD", () => {
    it("creates an Account (201) returning {id,success,errors}", async () => {
      const result = await api("POST", `/services/data/${V}/sobjects/Account`, { Name: "Parlel Inc" });
      expect(result.status).toBe(201);
      expect(result.body.success).toBe(true);
      expect(result.body.errors).toEqual([]);
      expect(result.body.id).toBeTruthy();
      expect(result.body.id.startsWith("001")).toBe(true);
    });

    it("reads a record back", async () => {
      const created = await api("POST", `/services/data/${V}/sobjects/Account`, { Name: "Read Co" });
      const got = await api("GET", `/services/data/${V}/sobjects/Account/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.Name).toBe("Read Co");
      expect(got.body.attributes.type).toBe("Account");
    });

    it("honors the ?fields= projection on retrieve", async () => {
      const created = await api("POST", `/services/data/${V}/sobjects/Account`, {
        Name: "Proj Co",
        Industry: "Tech",
        Phone: "555-0100",
      });
      const got = await api("GET", `/services/data/${V}/sobjects/Account/${created.body.id}?fields=Name,Industry`);
      expect(got.status).toBe(200);
      expect(got.body.Name).toBe("Proj Co");
      expect(got.body.Industry).toBe("Tech");
      // Non-requested fields are omitted; attributes always present.
      expect(got.body.Phone).toBeUndefined();
      expect(got.body.attributes.type).toBe("Account");
    });

    it("enforces required fields on standard-object create (400 REQUIRED_FIELD_MISSING)", async () => {
      const result = await api("POST", `/services/data/${V}/sobjects/Account`, {});
      expect(result.status).toBe(400);
      expect(result.body[0].errorCode).toBe("REQUIRED_FIELD_MISSING");
      expect(result.body[0].fields).toEqual(["Name"]);
      expect(result.body[0].message).toContain("Name");
    });

    it("reports all missing required fields for multi-field objects", async () => {
      const result = await api("POST", `/services/data/${V}/sobjects/Lead`, { LastName: "Hopper" });
      expect(result.status).toBe(400);
      expect(result.body[0].errorCode).toBe("REQUIRED_FIELD_MISSING");
      expect(result.body[0].fields).toEqual(["Company"]);
    });

    it("accepts arbitrary/custom object types without required-field validation", async () => {
      const result = await api("POST", `/services/data/${V}/sobjects/Widget__c`, { Color__c: "blue" });
      expect(result.status).toBe(201);
      expect(result.body.success).toBe(true);
    });

    it("returns 404 for unknown record", async () => {
      const got = await api("GET", `/services/data/${V}/sobjects/Account/001doesnotexist`);
      expect(got.status).toBe(404);
    });

    it("updates a record via PATCH (204)", async () => {
      const created = await api("POST", `/services/data/${V}/sobjects/Account`, { Name: "Old" });
      const patched = await api("PATCH", `/services/data/${V}/sobjects/Account/${created.body.id}`, { Name: "New" });
      expect(patched.status).toBe(204);
      const got = await api("GET", `/services/data/${V}/sobjects/Account/${created.body.id}`);
      expect(got.body.Name).toBe("New");
    });

    it("deletes a record (204) then 404", async () => {
      const created = await api("POST", `/services/data/${V}/sobjects/Contact`, { LastName: "Lovelace" });
      const del = await api("DELETE", `/services/data/${V}/sobjects/Contact/${created.body.id}`);
      expect(del.status).toBe(204);
      const gone = await api("GET", `/services/data/${V}/sobjects/Contact/${created.body.id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("SOQL query", () => {
    it("returns {totalSize,done,records}", async () => {
      await api("POST", `/services/data/${V}/sobjects/Account`, { Name: "Acme" });
      await api("POST", `/services/data/${V}/sobjects/Account`, { Name: "Globex" });
      const q = encodeURIComponent("SELECT Id, Name FROM Account");
      const result = await api("GET", `/services/data/${V}/query?q=${q}`);
      expect(result.status).toBe(200);
      expect(result.body.totalSize).toBe(2);
      expect(result.body.done).toBe(true);
      expect(result.body.records.length).toBe(2);
    });

    it("filters with WHERE clause", async () => {
      await api("POST", `/services/data/${V}/sobjects/Account`, { Name: "Acme" });
      await api("POST", `/services/data/${V}/sobjects/Account`, { Name: "Globex" });
      const q = encodeURIComponent("SELECT Id, Name FROM Account WHERE Name = 'Acme'");
      const result = await api("GET", `/services/data/${V}/query?q=${q}`);
      expect(result.body.totalSize).toBe(1);
      expect(result.body.records[0].Name).toBe("Acme");
    });

    it("rejects malformed query with 400", async () => {
      const result = await api("GET", `/services/data/${V}/query?q=${encodeURIComponent("not a query")}`);
      expect(result.status).toBe(400);
    });
  });
});
