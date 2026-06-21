import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NocodbServer } from "../services/nocodb/src/server.js";

const PORT = 14612;
const BASE_URL = `http://127.0.0.1:${PORT}`;

type HttpResponse = {
  status: number;
  headers: Headers;
  data: any;
};

async function http(method: string, path: string, data?: unknown): Promise<HttpResponse> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    data: text ? JSON.parse(text) : null,
  };
}

describe("NocoDB Service", () => {
  let server: NocodbServer;
  let baseId: string;
  let tableId: string;
  let columnId: string;
  let viewId: string;
  let recordId: number;

  beforeAll(async () => {
    server = new NocodbServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("should start on port", () => {
      expect(server.port).toBe(PORT);
    });

    it("should have empty in-memory state initially", () => {
      expect(server.bases.size).toBe(0);
      expect(server.tables.size).toBe(0);
    });

    it("GET /", async () => {
      const result = await http("GET", "/");
      expect(result.status).toBe(200);
      expect(result.data).toMatchObject({ name: "nocodb", protocol: "nocodb-rest" });
    });

    it("GET /health", async () => {
      const result = await http("GET", "/health");
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ status: "ok" });
    });

    it("HEAD /health", async () => {
      const result = await http("HEAD", "/health");
      expect(result.status).toBe(200);
      expect(result.data).toBeNull();
    });

    it("OPTIONS preflight", async () => {
      const result = await http("OPTIONS", "/api/v2/tables/tbl_1/records");
      expect(result.status).toBe(204);
      expect(result.headers.get("access-control-allow-methods")).toContain("PATCH");
    });
  });

  describe("Auth", () => {
    it("POST signin", async () => {
      const result = await http("POST", "/api/v1/auth/user/signin", { email: "agent@parlel.local", password: "secret" });
      expect(result.status).toBe(200);
      expect(result.data.token).toBe("parlel-token");
      expect(result.data.user.email).toBe("agent@parlel.local");
    });

    it("POST signup", async () => {
      const result = await http("POST", "/api/v1/auth/user/signup", { email: "new@parlel.local" });
      expect(result.status).toBe(200);
      expect(result.data.user.roles).toBe("org-level-creator");
    });

    it("GET me", async () => {
      const result = await http("GET", "/api/v1/auth/user/me");
      expect(result.status).toBe(200);
      expect(result.data.email).toBe("user@parlel.local");
    });

    it("POST forgot password", async () => {
      const result = await http("POST", "/api/v1/auth/password/forgot", { email: "user@parlel.local" });
      expect(result.status).toBe(200);
      expect(result.data.msg).toContain("Password reset");
    });
  });

  describe("Meta Bases", () => {
    it("GET empty bases", async () => {
      const result = await http("GET", "/api/v2/meta/bases");
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ list: [] });
    });

    it("POST create base", async () => {
      const result = await http("POST", "/api/v2/meta/bases", { title: "CRM" });
      expect(result.status).toBe(200);
      expect(result.data.title).toBe("CRM");
      baseId = result.data.id;
    });

    it("GET base by id", async () => {
      const result = await http("GET", `/api/v2/meta/bases/${baseId}`);
      expect(result.status).toBe(200);
      expect(result.data).toMatchObject({ id: baseId, title: "CRM" });
    });

    it("PATCH base", async () => {
      const result = await http("PATCH", `/api/v2/meta/bases/${baseId}`, { title: "CRM Updated" });
      expect(result.status).toBe(200);
      expect(result.data.title).toBe("CRM Updated");
    });

    it("PUT base", async () => {
      const result = await http("PUT", `/api/v2/meta/bases/${baseId}`, { title: "CRM Updated" });
      expect(result.status).toBe(200);
      expect(result.data.title).toBe("CRM Updated");
    });

    it("v1 projects alias lists bases", async () => {
      const result = await http("GET", "/api/v1/db/meta/projects");
      expect(result.status).toBe(200);
      expect(result.data.list).toHaveLength(1);
    });
  });

  describe("Meta Tables, Columns, and Views", () => {
    it("POST create table with columns", async () => {
      const result = await http("POST", `/api/v2/meta/bases/${baseId}/tables`, {
        title: "Contacts",
        columns: [
          { title: "Name", uidt: "SingleLineText" },
          { title: "Age", uidt: "Number" },
          { title: "Status", uidt: "SingleSelect" },
        ],
      });
      expect(result.status).toBe(200);
      expect(result.data.title).toBe("Contacts");
      expect(result.data.table_name).toBe("contacts");
      tableId = result.data.id;
    });

    it("GET base tables", async () => {
      const result = await http("GET", `/api/v2/meta/bases/${baseId}/tables`);
      expect(result.status).toBe(200);
      expect(result.data.list.map((table: any) => table.id)).toContain(tableId);
    });

    it("GET table includes columns and views", async () => {
      const result = await http("GET", `/api/v2/meta/tables/${tableId}`);
      expect(result.status).toBe(200);
      expect(result.data.columns.map((column: any) => column.title)).toEqual(["Id", "CreatedAt", "UpdatedAt", "Name", "Age", "Status"]);
      expect(result.data.views[0].title).toBe("Grid view");
      columnId = result.data.columns.find((column: any) => column.title === "Status").id;
      viewId = result.data.views[0].id;
    });

    it("GET table columns", async () => {
      const result = await http("GET", `/api/v2/meta/tables/${tableId}/columns`);
      expect(result.status).toBe(200);
      expect(result.data.list).toHaveLength(6);
    });

    it("POST create column", async () => {
      const result = await http("POST", `/api/v2/meta/tables/${tableId}/columns`, { title: "Company", uidt: "SingleLineText" });
      expect(result.status).toBe(200);
      expect(result.data.title).toBe("Company");
    });

    it("GET, PATCH, and PUT column", async () => {
      const getResult = await http("GET", `/api/v2/meta/columns/${columnId}`);
      expect(getResult.status).toBe(200);
      expect(getResult.data.title).toBe("Status");
      const patchResult = await http("PATCH", `/api/v2/meta/columns/${columnId}`, { title: "Stage", uidt: "SingleSelect" });
      expect(patchResult.status).toBe(200);
      expect(patchResult.data.title).toBe("Stage");
      const putResult = await http("PUT", `/api/v2/meta/columns/${columnId}`, { title: "Stage", uidt: "SingleSelect" });
      expect(putResult.status).toBe(200);
      expect(putResult.data.uidt).toBe("SingleSelect");
    });

    it("GET, PATCH, and PUT table", async () => {
      const getResult = await http("GET", `/api/v1/db/meta/tables/${tableId}`);
      expect(getResult.status).toBe(200);
      const patchResult = await http("PATCH", `/api/v1/db/meta/tables/${tableId}`, { title: "Contacts Updated" });
      expect(patchResult.status).toBe(200);
      expect(patchResult.data.title).toBe("Contacts Updated");
      const putResult = await http("PUT", `/api/v2/meta/tables/${tableId}`, { title: "Contacts Updated" });
      expect(putResult.status).toBe(200);
      expect(putResult.data.title).toBe("Contacts Updated");
    });

    it("GET table views", async () => {
      const result = await http("GET", `/api/v2/meta/tables/${tableId}/views`);
      expect(result.status).toBe(200);
      expect(result.data.list[0].id).toBe(viewId);
    });

    it("POST create view", async () => {
      const result = await http("POST", `/api/v2/meta/tables/${tableId}/views`, { title: "Kanban", type: "kanban" });
      expect(result.status).toBe(200);
      expect(result.data.type).toBe("kanban");
    });

    it("GET, PATCH, and PUT view", async () => {
      const getResult = await http("GET", `/api/v2/meta/views/${viewId}`);
      expect(getResult.status).toBe(200);
      const patchResult = await http("PATCH", `/api/v2/meta/views/${viewId}`, { title: "Main Grid" });
      expect(patchResult.status).toBe(200);
      expect(patchResult.data.title).toBe("Main Grid");
      const putResult = await http("PUT", `/api/v2/meta/views/${viewId}`, { title: "Main Grid" });
      expect(putResult.status).toBe(200);
      expect(putResult.data.title).toBe("Main Grid");
    });
  });

  describe("Record Data", () => {
    it("GET empty records", async () => {
      const result = await http("GET", `/api/v2/tables/${tableId}/records`);
      expect(result.status).toBe(200);
      expect(result.data.list).toEqual([]);
      expect(result.data.pageInfo.totalRows).toBe(0);
    });

    it("POST create single record", async () => {
      const result = await http("POST", `/api/v2/tables/${tableId}/records`, { Name: "Ada", Age: 37, Stage: "Lead", Company: "Parlel" });
      expect(result.status).toBe(200);
      expect(result.data).toMatchObject({ Id: 1, id: 1, Name: "Ada", Age: 37 });
      expect(result.data.CreatedAt).toBeDefined();
      recordId = result.data.Id;
    });

    it("POST create bulk records", async () => {
      const result = await http("POST", `/api/v2/tables/${tableId}/records`, [
        { Name: "Grace", Age: 41, Stage: "Customer", Company: "Compiler Co" },
        { Name: "Linus", Age: 33, Stage: "Lead", Company: "Kernel Labs" },
      ]);
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(2);
      expect(result.data[1].Id).toBe(3);
    });

    it("GET list records with where, sort, limit, and fields", async () => {
      const result = await http("GET", `/api/v2/tables/${tableId}/records?where=(Stage,eq,Lead)&sort=-Age&limit=1&fields=Name,Age`);
      expect(result.status).toBe(200);
      expect(result.data.list).toEqual([{ Name: "Ada", Age: 37 }]);
      expect(result.data.pageInfo.totalRows).toBe(2);
      expect(result.data.pageInfo.isFirstPage).toBe(true);
    });

    it("GET count", async () => {
      const result = await http("GET", `/api/v2/tables/${tableId}/records/count?where=(Stage,eq,Lead)`);
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ count: 2 });
    });

    it("GET record by id", async () => {
      const result = await http("GET", `/api/v2/tables/${tableId}/records/${recordId}`);
      expect(result.status).toBe(200);
      expect(result.data.Name).toBe("Ada");
    });

    it("PATCH record by id", async () => {
      const result = await http("PATCH", `/api/v2/tables/${tableId}/records/${recordId}`, { Stage: "Customer" });
      expect(result.status).toBe(200);
      expect(result.data.Stage).toBe("Customer");
      expect(result.data.UpdatedAt).toBeDefined();
    });

    it("PUT record by id", async () => {
      const result = await http("PUT", `/api/v2/tables/${tableId}/records/${recordId}`, { Company: "Parlel Labs" });
      expect(result.status).toBe(200);
      expect(result.data.Company).toBe("Parlel Labs");
    });

    it("PATCH bulk records", async () => {
      const result = await http("PATCH", `/api/v2/tables/${tableId}/records`, [{ Id: 2, Stage: "Partner" }, { Id: 3, Stage: "Prospect" }]);
      expect(result.status).toBe(200);
      expect(result.data.map((row: any) => row.Stage)).toEqual(["Partner", "Prospect"]);
    });

    it("PUT bulk records", async () => {
      const result = await http("PUT", `/api/v2/tables/${tableId}/records`, [{ Id: 2, Company: "Compiler Collective" }]);
      expect(result.status).toBe(200);
      expect(result.data[0].Company).toBe("Compiler Collective");
    });

    it("v1 data alias creates, reads, updates, and deletes a record", async () => {
      const created = await http("POST", "/api/v1/db/data/CRM Updated/Contacts Updated", { Name: "Katherine", Age: 30, Stage: "Lead" });
      expect(created.status).toBe(200);
      const id = created.data.Id;
      const read = await http("GET", `/api/v1/db/data/CRM Updated/Contacts Updated/${id}`);
      expect(read.status).toBe(200);
      expect(read.data.Name).toBe("Katherine");
      const updated = await http("PATCH", `/api/v1/db/data/noco/CRM Updated/Contacts Updated/${id}`, { Stage: "Customer" });
      expect(updated.status).toBe(200);
      expect(updated.data.Stage).toBe("Customer");
      const putUpdated = await http("PUT", `/api/v1/db/data/CRM Updated/Contacts Updated/${id}`, { Company: "Math Lab" });
      expect(putUpdated.status).toBe(200);
      expect(putUpdated.data.Company).toBe("Math Lab");
      const deleted = await http("DELETE", `/api/v1/db/data/CRM Updated/Contacts Updated/${id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.data.deleted).toBe(true);
    });

    it("v1 data alias lists records", async () => {
      const result = await http("GET", "/api/v1/db/data/CRM Updated/Contacts Updated?limit=10");
      expect(result.status).toBe(200);
      expect(result.data.list).toHaveLength(3);
    });

    it("v1 data alias counts records", async () => {
      const result = await http("GET", "/api/v1/db/data/CRM Updated/Contacts Updated/count");
      expect(result.status).toBe(200);
      expect(result.data.count).toBe(3);
    });

    it("DELETE record by id", async () => {
      const result = await http("DELETE", `/api/v2/tables/${tableId}/records/3`);
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ Id: 3, id: 3, deleted: true });
    });

    it("DELETE bulk records", async () => {
      const result = await http("DELETE", `/api/v2/tables/${tableId}/records`, { ids: [2] });
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ Id: 2, id: 2, deleted: true });
    });
  });

  describe("Errors and Reset", () => {
    it("404 unknown route", async () => {
      const result = await http("GET", "/api/v2/unknown");
      expect(result.status).toBe(404);
      expect(result.data).toEqual({ msg: "Not found", error: "Not Found", statusCode: 404 });
    });

    it("404 unknown table", async () => {
      const result = await http("GET", "/api/v2/tables/missing/records");
      expect(result.status).toBe(404);
      expect(result.data.msg).toBe("Table not found");
    });

    it("404 unknown record", async () => {
      const result = await http("GET", `/api/v2/tables/${tableId}/records/999`);
      expect(result.status).toBe(404);
      expect(result.data.msg).toBe("Record not found");
    });

    it("405 unsupported method", async () => {
      const result = await http("POST", `/api/v2/meta/bases/${baseId}`);
      expect(result.status).toBe(405);
      expect(result.data.msg).toBe("Method not allowed");
    });

    it("401 protected route when auth is required", async () => {
      server.requireAuth = true;
      const result = await http("GET", "/api/v2/meta/bases");
      server.requireAuth = false;
      expect(result.status).toBe(401);
      expect(result.data).toEqual({ msg: "Unauthorized", error: "Unauthorized", statusCode: 401 });
    });

    it("DELETE column", async () => {
      const result = await http("DELETE", `/api/v2/meta/columns/${columnId}`);
      expect(result.status).toBe(200);
      expect(result.data.msg).toContain("column");
    });

    it("DELETE view", async () => {
      const result = await http("DELETE", `/api/v2/meta/views/${viewId}`);
      expect(result.status).toBe(200);
      expect(result.data.msg).toContain("view");
    });

    it("DELETE table", async () => {
      const result = await http("DELETE", `/api/v2/meta/tables/${tableId}`);
      expect(result.status).toBe(200);
      expect(server.tables.has(tableId)).toBe(false);
    });

    it("DELETE base", async () => {
      const created = await http("POST", "/api/v2/meta/bases", { title: "Temporary" });
      const result = await http("DELETE", `/api/v2/meta/bases/${created.data.id}`);
      expect(result.status).toBe(200);
      expect(server.bases.has(created.data.id)).toBe(false);
    });

    it("POST /__reset clears state", async () => {
      const result = await http("POST", "/__reset");
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ ok: true });
      expect(server.bases.size).toBe(0);
      expect(server.tables.size).toBe(0);
      expect(server.columns.size).toBe(0);
      expect(server.views.size).toBe(0);
    });
  });
});
