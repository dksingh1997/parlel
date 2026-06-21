import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { HubspotServer } from "../services/hubspot/src/server.js";

const PORT = 14777;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer pat-parlelTestToken" };

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

describe("Hubspot Service", () => {
  let server: HubspotServer;

  beforeAll(async () => {
    server = new HubspotServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("hubspot");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight OPTIONS", async () => {
      const response = await fetch(`${BASE_URL}/crm/v3/objects/contacts`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const result = await api("GET", "/crm/v3/objects/contacts", undefined, {});
      expect(result.status).toBe(401);
      expect(result.body.category).toBe("INVALID_AUTHENTICATION");
    });
  });

  describe("Contacts CRUD", () => {
    it("creates a contact (201) with proper shape", async () => {
      const result = await api("POST", "/crm/v3/objects/contacts", {
        properties: { email: "a@parlel.dev", firstname: "Ada" },
      });
      expect(result.status).toBe(201);
      expect(result.body.id).toBeTruthy();
      expect(result.body.properties.email).toBe("a@parlel.dev");
      expect(result.body.createdAt).toBeTruthy();
      expect(result.body.updatedAt).toBeTruthy();
      expect(result.body.archived).toBe(false);
    });

    it("rejects create without properties", async () => {
      const result = await api("POST", "/crm/v3/objects/contacts", {});
      expect(result.status).toBe(400);
    });

    it("reads a contact back", async () => {
      const created = await api("POST", "/crm/v3/objects/contacts", { properties: { email: "b@parlel.dev" } });
      const got = await api("GET", `/crm/v3/objects/contacts/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.properties.email).toBe("b@parlel.dev");
    });

    it("returns 404 for unknown contact", async () => {
      const got = await api("GET", "/crm/v3/objects/contacts/99999");
      expect(got.status).toBe(404);
    });

    it("lists contacts with results/paging shape", async () => {
      await api("POST", "/crm/v3/objects/contacts", { properties: { email: "c@parlel.dev" } });
      const list = await api("GET", "/crm/v3/objects/contacts");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.results)).toBe(true);
      expect(list.body.results.length).toBe(1);
    });

    it("paginates with paging.next.after", async () => {
      for (let i = 0; i < 3; i++) {
        await api("POST", "/crm/v3/objects/contacts", { properties: { email: `p${i}@parlel.dev` } });
      }
      const list = await api("GET", "/crm/v3/objects/contacts?limit=2");
      expect(list.body.results.length).toBe(2);
      expect(list.body.paging.next.after).toBe("2");
    });

    it("updates a contact via PATCH", async () => {
      const created = await api("POST", "/crm/v3/objects/contacts", { properties: { email: "d@parlel.dev" } });
      const patched = await api("PATCH", `/crm/v3/objects/contacts/${created.body.id}`, {
        properties: { firstname: "Updated" },
      });
      expect(patched.status).toBe(200);
      expect(patched.body.properties.firstname).toBe("Updated");
      expect(patched.body.properties.email).toBe("d@parlel.dev");
    });

    it("deletes a contact (204) then 404", async () => {
      const created = await api("POST", "/crm/v3/objects/contacts", { properties: { email: "e@parlel.dev" } });
      const del = await api("DELETE", `/crm/v3/objects/contacts/${created.body.id}`);
      expect(del.status).toBe(204);
      const gone = await api("GET", `/crm/v3/objects/contacts/${created.body.id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("Companies & Deals", () => {
    it("creates a company", async () => {
      const result = await api("POST", "/crm/v3/objects/companies", { properties: { name: "Parlel Inc" } });
      expect(result.status).toBe(201);
      expect(result.body.properties.name).toBe("Parlel Inc");
    });

    it("creates a deal", async () => {
      const result = await api("POST", "/crm/v3/objects/deals", { properties: { dealname: "Big Deal", amount: "1000" } });
      expect(result.status).toBe(201);
      expect(result.body.properties.dealname).toBe("Big Deal");
    });
  });

  describe("Search", () => {
    it("searches contacts by property EQ", async () => {
      await api("POST", "/crm/v3/objects/contacts", { properties: { email: "search@parlel.dev", firstname: "Sea" } });
      await api("POST", "/crm/v3/objects/contacts", { properties: { email: "other@parlel.dev" } });
      const result = await api("POST", "/crm/v3/objects/contacts/search", {
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: "search@parlel.dev" }] }],
      });
      expect(result.status).toBe(200);
      expect(result.body.total).toBe(1);
      expect(result.body.results[0].properties.firstname).toBe("Sea");
    });
  });

  describe("Duplicate create (409 CONFLICT)", () => {
    it("returns 409 CONFLICT when a contact email already exists", async () => {
      const first = await api("POST", "/crm/v3/objects/contacts", { properties: { email: "dup@parlel.dev" } });
      expect(first.status).toBe(201);
      const dup = await api("POST", "/crm/v3/objects/contacts", { properties: { email: "dup@parlel.dev" } });
      expect(dup.status).toBe(409);
      expect(dup.body.category).toBe("CONFLICT");
      expect(dup.body.message).toContain(first.body.id);
    });

    it("returns 409 CONFLICT when a company domain already exists", async () => {
      await api("POST", "/crm/v3/objects/companies", { properties: { name: "Acme", domain: "acme.com" } });
      const dup = await api("POST", "/crm/v3/objects/companies", { properties: { name: "Acme 2", domain: "acme.com" } });
      expect(dup.status).toBe(409);
      expect(dup.body.category).toBe("CONFLICT");
    });

    it("allows deals with identical names (no unique identifier)", async () => {
      await api("POST", "/crm/v3/objects/deals", { properties: { dealname: "Same" } });
      const second = await api("POST", "/crm/v3/objects/deals", { properties: { dealname: "Same" } });
      expect(second.status).toBe(201);
    });
  });

  describe("Batch operations", () => {
    it("batch creates contacts (201) with COMPLETE status", async () => {
      const result = await api("POST", "/crm/v3/objects/contacts/batch/create", {
        inputs: [
          { properties: { email: "batch1@parlel.dev", firstname: "B1" } },
          { properties: { email: "batch2@parlel.dev", firstname: "B2" } },
        ],
      });
      expect(result.status).toBe(201);
      expect(result.body.status).toBe("COMPLETE");
      expect(result.body.results.length).toBe(2);
      expect(result.body.results[0].id).toBeTruthy();
      expect(result.body.results[0].properties.email).toBe("batch1@parlel.dev");
      expect(result.body.startedAt).toBeTruthy();
      expect(result.body.completedAt).toBeTruthy();
    });

    it("batch reads contacts by id", async () => {
      const created = await api("POST", "/crm/v3/objects/contacts/batch/create", {
        inputs: [{ properties: { email: "r1@parlel.dev" } }, { properties: { email: "r2@parlel.dev" } }],
      });
      const ids = created.body.results.map((r: Json) => ({ id: r.id }));
      const read = await api("POST", "/crm/v3/objects/contacts/batch/read", { inputs: ids });
      expect(read.status).toBe(200);
      expect(read.body.status).toBe("COMPLETE");
      expect(read.body.results.length).toBe(2);
    });

    it("batch updates contacts", async () => {
      const created = await api("POST", "/crm/v3/objects/contacts/batch/create", {
        inputs: [{ properties: { email: "u1@parlel.dev" } }],
      });
      const id = created.body.results[0].id;
      const updated = await api("POST", "/crm/v3/objects/contacts/batch/update", {
        inputs: [{ id, properties: { firstname: "Updated" } }],
      });
      expect(updated.status).toBe(200);
      expect(updated.body.results[0].properties.firstname).toBe("Updated");
      expect(updated.body.results[0].properties.email).toBe("u1@parlel.dev");
    });

    it("batch archives contacts (204) then they are gone", async () => {
      const created = await api("POST", "/crm/v3/objects/contacts/batch/create", {
        inputs: [{ properties: { email: "a1@parlel.dev" } }],
      });
      const id = created.body.results[0].id;
      const archived = await api("POST", "/crm/v3/objects/contacts/batch/archive", { inputs: [{ id }] });
      expect(archived.status).toBe(204);
      const gone = await api("GET", `/crm/v3/objects/contacts/${id}`);
      expect(gone.status).toBe(404);
    });

    it("rejects batch without inputs (400)", async () => {
      const result = await api("POST", "/crm/v3/objects/contacts/batch/create", {});
      expect(result.status).toBe(400);
      expect(result.body.category).toBe("VALIDATION_ERROR");
    });

    it("returns 404 for an unknown batch op", async () => {
      const result = await api("POST", "/crm/v3/objects/contacts/batch/bogus", { inputs: [] });
      expect(result.status).toBe(404);
    });
  });
});
