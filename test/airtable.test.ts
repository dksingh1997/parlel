import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AirtableServer } from "../services/airtable/src/server.js";

const PORT = 14611;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer keyParlel" };

type Json = Record<string, any>;

async function airtable(method: string, path: string, body?: Json): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...AUTH,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function createRecord(fields: Json, table = "Tasks") {
  const result = await airtable("POST", `/v0/appTest/${encodeURIComponent(table)}`, { fields });
  expect(result.status).toBe(200);
  return result.body;
}

describe("Airtable Service", () => {
  let server: AirtableServer;

  beforeAll(async () => {
    server = new AirtableServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("has resettable ephemeral state", async () => {
      await createRecord({ Name: "Persist only in memory" });
      expect(server.bases.get("appTest")?.tables.get("Tasks")?.records.size).toBe(1);
      server.reset();
      expect(server.bases.size).toBe(0);
    });

    it("returns root and health JSON", async () => {
      const root = await airtable("GET", "/");
      const health = await airtable("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("airtable");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight-style OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/v0/appTest/Tasks`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication and Errors", () => {
    it("returns Airtable-shaped auth errors for missing credentials", async () => {
      const response = await fetch(`${BASE_URL}/v0/appTest/Tasks`);
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body).toEqual({ error: { type: "AUTHENTICATION_REQUIRED", message: "Authentication required" } });
    });

    it("returns Airtable-shaped not found errors", async () => {
      const result = await airtable("GET", "/v0/appTest/Tasks/recMissing");
      expect(result.status).toBe(404);
      expect(result.body.error.type).toBe("NOT_FOUND");
    });

    it("returns method not allowed for unsupported table methods", async () => {
      const result = await airtable("HEAD", "/v0/appTest/Tasks");
      expect(result.status).toBe(405);
    });

    it("accepts legacy api_key query authentication", async () => {
      const response = await fetch(`${BASE_URL}/v0/appTest/Tasks?api_key=keyParlel`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.records).toEqual([]);
    });

    it("allows query-authenticated writes", async () => {
      const response = await fetch(`${BASE_URL}/v0/appTest/Tasks?api_key=keyParlel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { Name: "Query auth" } }),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.fields.Name).toBe("Query auth");
    });
  });

  describe("Create Operations", () => {
    it("creates one record with Airtable record framing", async () => {
      const record = await createRecord({ Name: "Ship", Done: false, Count: 1 });
      expect(record.id).toMatch(/^rec[0-9A-Za-z]{14}$/);
      expect(record.createdTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record.fields).toEqual({ Name: "Ship", Done: false, Count: 1 });
    });

    it("creates records in batches", async () => {
      const result = await airtable("POST", "/v0/appTest/Tasks", {
        records: [{ fields: { Name: "A" } }, { fields: { Name: "B" } }],
      });
      expect(result.status).toBe(200);
      expect(result.body.records.map((record: Json) => record.fields.Name)).toEqual(["A", "B"]);
    });

    it("rejects missing fields and batches over Airtable's 10 record limit", async () => {
      const missingFields = await airtable("POST", "/v0/appTest/Tasks", { Name: "No envelope" });
      const tooMany = await airtable("POST", "/v0/appTest/Tasks", {
        records: Array.from({ length: 11 }, (_, index) => ({ fields: { Name: String(index) } })),
      });
      expect(missingFields.status).toBe(422);
      expect(missingFields.body.error.type).toBe("INVALID_REQUEST_BODY");
      expect(tooMany.status).toBe(422);
      expect(tooMany.body.error.type).toBe("INVALID_REQUEST_UNKNOWN");
    });
  });

  describe("Read and Select Operations", () => {
    it("finds a record by id", async () => {
      const created = await createRecord({ Name: "Find me" });
      const result = await airtable("GET", `/v0/appTest/Tasks/${created.id}`);
      expect(result.status).toBe(200);
      expect(result.body).toEqual(created);
    });

    it("lists records with pagination offset and page size", async () => {
      await createRecord({ Name: "A" });
      await createRecord({ Name: "B" });
      await createRecord({ Name: "C" });
      const page1 = await airtable("GET", "/v0/appTest/Tasks?pageSize=2");
      const page2 = await airtable("GET", `/v0/appTest/Tasks?pageSize=2&offset=${page1.body.offset}`);
      expect(page1.status).toBe(200);
      expect(page1.body.records.map((record: Json) => record.fields.Name)).toEqual(["A", "B"]);
      expect(page1.body.offset).toBe("2");
      expect(page2.body.records.map((record: Json) => record.fields.Name)).toEqual(["C"]);
      expect(page2.body.offset).toBeUndefined();
    });

    it("lists records with maxRecords", async () => {
      await createRecord({ Name: "A" });
      await createRecord({ Name: "B" });
      const result = await airtable("GET", "/v0/appTest/Tasks?maxRecords=1");
      expect(result.body.records).toHaveLength(1);
    });

    it("projects requested fields from fields[] query params", async () => {
      await createRecord({ Name: "A", Secret: "hidden" });
      const result = await airtable("GET", "/v0/appTest/Tasks?fields%5B%5D=Name");
      expect(result.body.records[0].fields).toEqual({ Name: "A" });
    });

    it("sorts records using airtable client sort query format", async () => {
      await createRecord({ Name: "A", Rank: 2 });
      await createRecord({ Name: "B", Rank: 1 });
      const result = await airtable("GET", "/v0/appTest/Tasks?sort%5B0%5D%5Bfield%5D=Rank&sort%5B0%5D%5Bdirection%5D=asc");
      expect(result.body.records.map((record: Json) => record.fields.Name)).toEqual(["B", "A"]);
    });

    it("filters records by common filterByFormula expressions", async () => {
      await createRecord({ Name: "Alpha", Done: true, Rank: 2 });
      await createRecord({ Name: "Beta", Done: false, Rank: 1 });
      const equality = await airtable("GET", `/v0/appTest/Tasks?filterByFormula=${encodeURIComponent("{Done} = true")}`);
      const and = await airtable("GET", `/v0/appTest/Tasks?filterByFormula=${encodeURIComponent("AND({Rank} > 1, SEARCH('alp', {Name}))")}`);
      expect(equality.body.records.map((record: Json) => record.fields.Name)).toEqual(["Alpha"]);
      expect(and.body.records.map((record: Json) => record.fields.Name)).toEqual(["Alpha"]);
    });

    it("supports POST listRecords-style listing through method=list", async () => {
      await createRecord({ Name: "A", Rank: 1 });
      await createRecord({ Name: "B", Rank: 2 });
      const result = await airtable("POST", "/v0/appTest/Tasks?method=list", {
        fields: ["Name"],
        maxRecords: 1,
        filterByFormula: "{Rank} = 2",
      });
      expect(result.status).toBe(200);
      expect(result.body.records).toHaveLength(1);
      expect(result.body.records[0].fields).toEqual({ Name: "B" });
    });

    it("supports POST /listRecords as a list alias", async () => {
      await createRecord({ Name: "A" });
      const result = await airtable("POST", "/v0/appTest/Tasks/listRecords", { pageSize: 1 });
      expect(result.status).toBe(200);
      expect(result.body.records[0].fields.Name).toBe("A");
    });
  });

  describe("Update and Replace Operations", () => {
    it("updates one record with PATCH merge semantics", async () => {
      const created = await createRecord({ Name: "Original", Keep: true });
      const result = await airtable("PATCH", `/v0/appTest/Tasks/${created.id}`, { fields: { Name: "Updated" } });
      expect(result.status).toBe(200);
      expect(result.body.fields).toEqual({ Name: "Updated", Keep: true });
    });

    it("replaces one record with PUT replace semantics", async () => {
      const created = await createRecord({ Name: "Original", Remove: true });
      const result = await airtable("PUT", `/v0/appTest/Tasks/${created.id}`, { fields: { Name: "Replacement" } });
      expect(result.body.fields).toEqual({ Name: "Replacement" });
    });

    it("updates records in batches", async () => {
      const a = await createRecord({ Name: "A", Count: 1 });
      const b = await createRecord({ Name: "B", Count: 1 });
      const result = await airtable("PATCH", "/v0/appTest/Tasks", {
        records: [{ id: a.id, fields: { Count: 2 } }, { id: b.id, fields: { Count: 3 } }],
      });
      expect(result.status).toBe(200);
      expect(result.body.records.map((record: Json) => record.fields.Count)).toEqual([2, 3]);
    });

    it("replaces records in batches", async () => {
      const a = await createRecord({ Name: "A", Remove: true });
      const result = await airtable("PUT", "/v0/appTest/Tasks", {
        records: [{ id: a.id, fields: { Name: "Only" } }],
      });
      expect(result.body.records[0].fields).toEqual({ Name: "Only" });
    });

    it("rejects malformed batch updates and missing record updates", async () => {
      const malformed = await airtable("PATCH", "/v0/appTest/Tasks", { records: [{ fields: { Name: "No id" } }] });
      const missing = await airtable("PATCH", "/v0/appTest/Tasks/recMissing", { fields: { Name: "Missing" } });
      expect(malformed.status).toBe(422);
      expect(malformed.body.error.type).toBe("INVALID_REQUEST_BODY");
      expect(missing.status).toBe(404);
      expect(missing.body.error.type).toBe("NOT_FOUND");
    });
  });

  describe("Delete Operations", () => {
    it("deletes one record", async () => {
      const created = await createRecord({ Name: "Delete" });
      const result = await airtable("DELETE", `/v0/appTest/Tasks/${created.id}`);
      const find = await airtable("GET", `/v0/appTest/Tasks/${created.id}`);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ id: created.id, deleted: true });
      expect(find.status).toBe(404);
    });

    it("deletes records in batches with records[] query params", async () => {
      const a = await createRecord({ Name: "A" });
      const b = await createRecord({ Name: "B" });
      const result = await airtable("DELETE", `/v0/appTest/Tasks?records%5B%5D=${a.id}&records%5B%5D=${b.id}`);
      expect(result.status).toBe(200);
      expect(result.body.records).toEqual([{ id: a.id, deleted: true }, { id: b.id, deleted: true }]);
    });

    it("rejects malformed and over-limit batch deletes", async () => {
      const missingIds = await airtable("DELETE", "/v0/appTest/Tasks");
      const tooManyIds = Array.from({ length: 11 }, (_, index) => `records%5B%5D=rec${index}`).join("&");
      const tooMany = await airtable("DELETE", `/v0/appTest/Tasks?${tooManyIds}`);
      expect(missingIds.status).toBe(422);
      expect(missingIds.body.error.type).toBe("INVALID_REQUEST_BODY");
      expect(tooMany.status).toBe(422);
      expect(tooMany.body.error.type).toBe("INVALID_REQUEST_UNKNOWN");
    });
  });
});
