import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NotionServer } from "../services/notion/src/server.js";

const PORT = 14794;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer secret_parlelTestKey", "Notion-Version": "2022-06-28" };
const AUTH_NO_VERSION = { Authorization: "Bearer secret_parlelTestKey" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Notion Service", () => {
  let server: NotionServer;

  beforeAll(async () => {
    server = new NotionServer(PORT);
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
      expect(root.body.name).toBe("notion");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing authorization with 401", async () => {
      const response = await fetch(`${BASE_URL}/v1/users/me`);
      expect(response.status).toBe(401);
    });

    it("accepts Bearer auth and returns the bot user", async () => {
      const me = await api("GET", "/v1/users/me");
      expect(me.status).toBe(200);
      expect(me.body.object).toBe("user");
      expect(me.body.type).toBe("bot");
    });

    it("returns the real unauthorized error envelope", async () => {
      const response = await fetch(`${BASE_URL}/v1/users/me`);
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body).toMatchObject({ object: "error", status: 401, code: "unauthorized" });
      expect(body.message).toBe("API token is invalid.");
    });

    it("exposes bot workspace metadata (owner, workspace_id, workspace_limits)", async () => {
      const me = await api("GET", "/v1/users/me");
      expect(me.body.bot.owner).toBeTruthy();
      expect(me.body.bot.workspace_id).toBeTruthy();
      expect(me.body.bot.workspace_limits).toHaveProperty("max_file_upload_size_in_bytes");
      expect(me.body.bot.workspace_name).toBe("Parlel");
    });
  });

  describe("Notion-Version header", () => {
    it("rejects a /v1 request with no Notion-Version header (400 missing_version)", async () => {
      const me = await api("GET", "/v1/users/me", undefined, AUTH_NO_VERSION);
      expect(me.status).toBe(400);
      expect(me.body).toMatchObject({ object: "error", status: 400, code: "missing_version" });
    });

    it("accepts any Notion-Version value", async () => {
      const me = await api("GET", "/v1/users/me", undefined, {
        Authorization: "Bearer secret_parlelTestKey",
        "Notion-Version": "2099-01-01",
      });
      expect(me.status).toBe(200);
    });

    it("checks auth before version (missing both -> 401)", async () => {
      const response = await fetch(`${BASE_URL}/v1/users/me`);
      expect(response.status).toBe(401);
    });
  });

  describe("Malformed request body", () => {
    it("returns 400 invalid_json for unparseable JSON", async () => {
      const response = await fetch(`${BASE_URL}/v1/pages`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "{ not json",
      });
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ object: "error", status: 400, code: "invalid_json" });
      expect(body.message).toBe("Error parsing JSON body.");
    });
  });

  describe("Pages", () => {
    it("creates a page with object:page shape", async () => {
      const dbId = server.defaultDatabase;
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: dbId },
        properties: { Name: { title: [{ text: { content: "My page" } }] } },
      });
      expect(created.status).toBe(200);
      expect(created.body.object).toBe("page");
      expect(created.body.id).toBeTruthy();
      expect(created.body.parent.database_id).toBe(dbId);
    });

    it("returns the full page object shape with server-generated fields", async () => {
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: { Name: { title: [{ text: { content: "Shape" } }] } },
      });
      const page = created.body;
      // parent is normalized with an explicit type discriminator
      expect(page.parent.type).toBe("database_id");
      // server-generated fields the real API always returns
      expect(page.created_by).toMatchObject({ object: "user" });
      expect(page.last_edited_by).toMatchObject({ object: "user" });
      expect(page.cover).toBeNull();
      expect(page.icon).toBeNull();
      expect(page.public_url).toBeNull();
      expect(page.archived).toBe(false);
      expect(page.in_trash).toBe(false);
      expect(typeof page.created_time).toBe("string");
      expect(typeof page.last_edited_time).toBe("string");
      expect(page.url).toContain("notion.so/");
    });

    it("mirrors archived and in_trash on patch", async () => {
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: { Name: { title: [{ text: { content: "Trash me" } }] } },
      });
      const id = created.body.id;
      const viaArchived = await api("PATCH", `/v1/pages/${id}`, { archived: true });
      expect(viaArchived.body.archived).toBe(true);
      expect(viaArchived.body.in_trash).toBe(true);
      const viaInTrash = await api("PATCH", `/v1/pages/${id}`, { in_trash: false });
      expect(viaInTrash.body.archived).toBe(false);
      expect(viaInTrash.body.in_trash).toBe(false);
    });

    it("rejects page without parent", async () => {
      const created = await api("POST", "/v1/pages", { properties: {} });
      expect(created.status).toBe(400);
    });

    it("rejects a page whose parent database does not exist (404)", async () => {
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: "00000000-0000-0000-0000-000000000000" },
        properties: { Name: { title: [{ text: { content: "Orphan" } }] } },
      });
      expect(created.status).toBe(404);
    });

    it("rejects a property not in the database schema (400)", async () => {
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: {
          Name: { title: [{ text: { content: "Ok" } }] },
          Nonexistent: { rich_text: [{ text: { content: "nope" } }] },
        },
      });
      expect(created.status).toBe(400);
    });

    it("rejects a property whose value shape mismatches its type (400)", async () => {
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: {
          Name: { title: [{ text: { content: "Ok" } }] },
          // Status is a `select` in the schema; sending rich_text is invalid.
          Status: { rich_text: [{ text: { content: "wrong" } }] },
        },
      });
      expect(created.status).toBe(400);
    });

    it("rejects a db-parented page missing its title property (400)", async () => {
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: { Status: { select: { name: "open" } } },
      });
      expect(created.status).toBe(400);
    });

    it("accepts a valid select property matching the schema", async () => {
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: {
          Name: { title: [{ text: { content: "Valid" } }] },
          Status: { select: { name: "open" } },
        },
      });
      expect(created.status).toBe(200);
    });

    it("retrieves and patches a page", async () => {
      const created = await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: { Name: { title: [{ text: { content: "X" } }] } },
      });
      const id = created.body.id;
      const got = await api("GET", `/v1/pages/${id}`);
      expect(got.body.id).toBe(id);
      const patched = await api("PATCH", `/v1/pages/${id}`, { archived: true });
      expect(patched.body.archived).toBe(true);
    });
  });

  describe("Databases", () => {
    it("retrieves the default database", async () => {
      const got = await api("GET", `/v1/databases/${server.defaultDatabase}`);
      expect(got.status).toBe(200);
      expect(got.body.object).toBe("database");
    });

    it("queries a database and returns a list shape", async () => {
      await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: { Name: { title: [{ text: { content: "row" } }] } },
      });
      const result = await api("POST", `/v1/databases/${server.defaultDatabase}/query`, {});
      expect(result.status).toBe(200);
      expect(result.body.object).toBe("list");
      expect(result.body.results.length).toBe(1);
      expect(result.body.has_more).toBe(false);
      expect(result.body).toHaveProperty("next_cursor");
    });
  });

  describe("Search", () => {
    it("returns a list object", async () => {
      const result = await api("POST", "/v1/search", { query: "Parlel" });
      expect(result.status).toBe(200);
      expect(result.body.object).toBe("list");
      expect(Array.isArray(result.body.results)).toBe(true);
    });
  });

  describe("Control", () => {
    it("resets state", async () => {
      await api("POST", "/v1/pages", {
        parent: { database_id: server.defaultDatabase },
        properties: {},
      });
      await api("POST", "/__parlel/reset");
      const result = await api("POST", `/v1/databases/${server.defaultDatabase}/query`, {});
      expect(result.body.results).toEqual([]);
    });
  });
});
