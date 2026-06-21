import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { BigqueryServer } from "../services/bigquery/src/server.js";

// A lightweight, dependency-free fake of Google Cloud BigQuery exercised
// through the real `@google-cloud/bigquery` client over its HTTP/1.1 REST
// transport. Mirrors the structure/style of tests/redis.test.ts,
// tests/postgres.test.ts and tests/firestore.test.ts.

const PORT = 14583;
const HOST = `http://127.0.0.1:${PORT}`;

// The BigQuery client reads BIGQUERY_EMULATOR_HOST at construction time and
// uses it as the baseUrl for all requests.
process.env.BIGQUERY_EMULATOR_HOST = HOST;
process.env.GOOGLE_CLOUD_PROJECT = "parlel";
process.env.GCLOUD_PROJECT = "parlel";

// A real RSA key is generated to satisfy any local credential plumbing, but the
// BigQuery common layer would otherwise attempt a real OAuth token exchange
// against accounts.google.com. Since the parlel fake never validates tokens, we
// inject a no-network GoogleAuth instance whose authorizeRequest is a no-op.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
void PRIVATE_KEY_PEM;

let BigQuery: any;
let server: BigqueryServer;
let bq: any;

function makeOfflineAuth(): any {
  // Imported lazily so we share the exact google-auth-library bundled with the
  // @google-cloud/common used by @google-cloud/bigquery.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({ projectId: "parlel" });
  const fakeHeaders = new Headers({ Authorization: "Bearer parlel-fake-token" });
  const fakeClient: any = {
    getRequestHeaders: async () => fakeHeaders,
    request: async () => ({ data: {} }),
    getAccessToken: async () => ({ token: "parlel-fake-token" }),
  };
  auth.authorizeRequest = async (opts: any) => {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers.Authorization = "Bearer parlel-fake-token";
    return opts;
  };
  auth.getClient = async () => fakeClient;
  auth.getProjectId = async () => "parlel";
  auth.getCredentials = async () => ({ client_email: "parlel@parlel.iam.gserviceaccount.com" });
  return auth;
}

function makeClient(): any {
  return new BigQuery({
    projectId: "parlel",
    authClient: makeOfflineAuth(),
  });
}

// Raw HTTP helper for internal endpoints + wire-level assertions.
function rawRequest(opts: {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function resetServer(): Promise<void> {
  await rawRequest({ method: "POST", path: "/_parlel/reset" });
}

describe("BigQuery Service", () => {
  beforeAll(async () => {
    const mod: any = await import("@google-cloud/bigquery");
    BigQuery = mod.BigQuery;
    server = new BigqueryServer(PORT, { projectId: "parlel" });
    await server.start();
    bq = makeClient();
  }, 30000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await resetServer();
  });

  // -------------------------------------------------------------------------
  describe("Server / health", () => {
    it("exposes the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("responds to the health endpoint", async () => {
      const res = await rawRequest({ path: "/_parlel/health" });
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("bigquery");
    });

    it("resets in-memory state", async () => {
      await bq.createDataset("reset_ds");
      let res = await rawRequest({ path: "/_parlel/health" });
      expect(JSON.parse(res.body).datasets).toBeGreaterThan(0);
      await resetServer();
      res = await rawRequest({ path: "/_parlel/health" });
      expect(JSON.parse(res.body).datasets).toBe(0);
    });

    it("exposes a dump endpoint", async () => {
      await bq.createDataset("dump_ds");
      const res = await rawRequest({ path: "/_parlel/dump" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).datasets).toContain("dump_ds");
    });
  });

  // -------------------------------------------------------------------------
  describe("Datasets", () => {
    it("creates a dataset (datasets.insert)", async () => {
      const [dataset] = await bq.createDataset("ds1");
      expect(dataset.id).toBe("ds1");
      const [md] = await dataset.getMetadata();
      expect(md.datasetReference.datasetId).toBe("ds1");
      expect(md.kind).toBe("bigquery#dataset");
    });

    it("creates a dataset with options", async () => {
      const [dataset] = await bq.createDataset("ds_opts", {
        friendlyName: "Friendly",
        location: "EU",
        labels: { env: "test" },
      });
      const [md] = await dataset.getMetadata();
      expect(md.friendlyName).toBe("Friendly");
      expect(md.location).toBe("EU");
      expect(md.labels).toEqual({ env: "test" });
    });

    it("rejects duplicate dataset creation (409)", async () => {
      await bq.createDataset("dup_ds");
      await expect(bq.createDataset("dup_ds")).rejects.toMatchObject({ code: 409 });
    });

    it("lists datasets (datasets.list)", async () => {
      await bq.createDataset("list_a");
      await bq.createDataset("list_b");
      const [datasets] = await bq.getDatasets();
      const ids = datasets.map((d: any) => d.id).sort();
      expect(ids).toEqual(["list_a", "list_b"]);
    });

    it("gets dataset metadata (datasets.get)", async () => {
      const [dataset] = await bq.createDataset("get_ds");
      const [md] = await dataset.getMetadata();
      expect(md.id).toBe("parlel:get_ds");
    });

    it("checks dataset existence (exists)", async () => {
      const [dataset] = await bq.createDataset("exists_ds");
      const [exists] = await dataset.exists();
      expect(exists).toBe(true);
      const [missing] = await bq.dataset("nope_ds").exists();
      expect(missing).toBe(false);
    });

    it("patches dataset metadata (datasets.patch)", async () => {
      const [dataset] = await bq.createDataset("patch_ds");
      const [md] = await dataset.setMetadata({ description: "patched" });
      expect(md.description).toBe("patched");
    });

    it("deletes a dataset (datasets.delete)", async () => {
      const [dataset] = await bq.createDataset("del_ds");
      await dataset.delete();
      const [exists] = await dataset.exists();
      expect(exists).toBe(false);
    });

    it("deletes a dataset with contents (deleteContents)", async () => {
      const [dataset] = await bq.createDataset("del_ds2");
      await dataset.createTable("t", { schema: [{ name: "a", type: "STRING" }] });
      await dataset.delete({ force: true });
      const [exists] = await dataset.exists();
      expect(exists).toBe(false);
    });

    it("rejects delete of non-empty dataset without force (400)", async () => {
      const [dataset] = await bq.createDataset("busy_ds");
      await dataset.createTable("t", { schema: [{ name: "a", type: "STRING" }] });
      await expect(dataset.delete()).rejects.toMatchObject({ code: 400 });
    });

    it("returns 404 getting a missing dataset", async () => {
      await expect(bq.dataset("ghost").getMetadata()).rejects.toMatchObject({ code: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Tables", () => {
    let dataset: any;
    beforeEach(async () => {
      [dataset] = await bq.createDataset("tbl_ds");
    });

    const schema = [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "STRING" },
      { name: "active", type: "BOOLEAN" },
    ];

    it("creates a table (tables.insert)", async () => {
      const [table] = await dataset.createTable("t1", { schema });
      expect(table.id).toBe("t1");
      const [md] = await table.getMetadata();
      expect(md.schema.fields.map((f: any) => f.name)).toEqual(["id", "name", "active"]);
    });

    it("rejects duplicate table creation (409)", async () => {
      await dataset.createTable("dup_t", { schema });
      await expect(dataset.createTable("dup_t", { schema })).rejects.toMatchObject({ code: 409 });
    });

    it("lists tables (tables.list)", async () => {
      await dataset.createTable("ta", { schema });
      await dataset.createTable("tb", { schema });
      const [tables] = await dataset.getTables();
      const ids = tables.map((t: any) => t.id).sort();
      expect(ids).toEqual(["ta", "tb"]);
    });

    it("gets table metadata (tables.get)", async () => {
      const [table] = await dataset.createTable("get_t", { schema });
      const [md] = await table.getMetadata();
      expect(md.tableReference.tableId).toBe("get_t");
      expect(md.type).toBe("TABLE");
    });

    it("checks table existence (exists)", async () => {
      await dataset.createTable("ex_t", { schema });
      const [exists] = await dataset.table("ex_t").exists();
      expect(exists).toBe(true);
      const [missing] = await dataset.table("nope_t").exists();
      expect(missing).toBe(false);
    });

    it("patches table metadata (tables.patch)", async () => {
      const [table] = await dataset.createTable("patch_t", { schema });
      const [md] = await table.setMetadata({ description: "a table" });
      expect(md.description).toBe("a table");
    });

    it("deletes a table (tables.delete)", async () => {
      const [table] = await dataset.createTable("del_t", { schema });
      await table.delete();
      const [exists] = await table.exists();
      expect(exists).toBe(false);
    });

    it("creates a view table", async () => {
      const [table] = await dataset.createTable("v1", {
        view: { query: "SELECT 1 AS x", useLegacySql: false },
      });
      const [md] = await table.getMetadata();
      expect(md.type).toBe("VIEW");
    });

    it("returns 404 for missing table metadata", async () => {
      await expect(dataset.table("ghost").getMetadata()).rejects.toMatchObject({ code: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Table data: insert + list", () => {
    let dataset: any;
    let table: any;
    const schema = [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "STRING" },
      { name: "score", type: "FLOAT" },
    ];
    beforeEach(async () => {
      [dataset] = await bq.createDataset("data_ds");
      [table] = await dataset.createTable("rows", { schema });
    });

    it("inserts rows (tabledata.insertAll)", async () => {
      await table.insert([
        { id: 1, name: "alice", score: 9.5 },
        { id: 2, name: "bob", score: 7.0 },
      ]);
      const [rows] = await table.getRows();
      expect(rows.length).toBe(2);
      const alice = rows.find((r: any) => r.name === "alice");
      expect(alice.id).toBe(1);
      expect(alice.score).toBeCloseTo(9.5);
    });

    it("lists rows (tabledata.list) with f/v wire shape", async () => {
      await table.insert([{ id: 10, name: "x", score: 1.0 }]);
      const res = await rawRequest({
        path: `/projects/parlel/datasets/data_ds/tables/rows/data`,
      });
      const body = JSON.parse(res.body);
      expect(body.kind).toBe("bigquery#tableDataList");
      expect(body.rows[0].f[0].v).toBe("10");
      expect(body.totalRows).toBe("1");
    });

    it("reports insert errors for unknown fields (partial failure)", async () => {
      await expect(
        table.insert([{ id: 1, name: "ok" }, { id: 2, bogus: "field" }]),
      ).rejects.toBeTruthy();
      // The first valid row may still be inserted depending on retry; verify
      // at least the API surfaced an error.
    });

    it("paginates rows via maxResults", async () => {
      const many = Array.from({ length: 5 }, (_, i) => ({ id: i, name: `n${i}`, score: i }));
      await table.insert(many);
      const [rows, nextQuery] = await table.getRows({ maxResults: 2, autoPaginate: false });
      expect(rows.length).toBe(2);
      expect(nextQuery).toBeTruthy();
    });

    it("accepts a string schema when creating a table then inserting", async () => {
      // The client's insert(autoCreate) path imposes a hard-coded 60s settle
      // delay after creating the table, so we create explicitly (same code path
      // on the server) to keep the test fast and deterministic.
      const [fresh] = await dataset.createTable("string_schema", {
        schema: "id:INTEGER, name:STRING, score:FLOAT",
      });
      await fresh.insert([{ id: 1, name: "auto", score: 3.3 }]);
      const [rows] = await fresh.getRows();
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("auto");
    });
  });

  // -------------------------------------------------------------------------
  describe("Queries", () => {
    let dataset: any;
    beforeEach(async () => {
      [dataset] = await bq.createDataset("q_ds");
      const [table] = await dataset.createTable("people", {
        schema: [
          { name: "id", type: "INTEGER" },
          { name: "name", type: "STRING" },
          { name: "age", type: "INTEGER" },
        ],
      });
      await table.insert([
        { id: 1, name: "alice", age: 30 },
        { id: 2, name: "bob", age: 25 },
        { id: 3, name: "carol", age: 40 },
      ]);
    });

    it("runs a literal SELECT (jobs.query fast path)", async () => {
      const [rows] = await bq.query("SELECT 1 AS one, 'hi' AS greeting");
      expect(rows[0].one).toBe(1);
      expect(rows[0].greeting).toBe("hi");
    });

    it("runs SELECT * FROM table", async () => {
      const [rows] = await bq.query("SELECT * FROM q_ds.people");
      expect(rows.length).toBe(3);
      expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "bob", "carol"]);
    });

    it("runs SELECT with WHERE", async () => {
      const [rows] = await bq.query("SELECT name FROM q_ds.people WHERE age > 28");
      expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "carol"]);
    });

    it("runs SELECT with ORDER BY and LIMIT", async () => {
      const [rows] = await bq.query("SELECT name, age FROM q_ds.people ORDER BY age DESC LIMIT 2");
      expect(rows.map((r: any) => r.name)).toEqual(["carol", "alice"]);
    });

    it("runs COUNT(*)", async () => {
      const [rows] = await bq.query("SELECT COUNT(*) AS total FROM q_ds.people");
      expect(Number(rows[0].total)).toBe(3);
    });

    it("supports named query parameters", async () => {
      const [rows] = await bq.query({
        query: "SELECT name FROM q_ds.people WHERE age >= @minAge",
        params: { minAge: 30 },
      });
      expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "carol"]);
    });

    it("supports positional query parameters", async () => {
      const [rows] = await bq.query({
        query: "SELECT name FROM q_ds.people WHERE name = ?",
        params: ["bob"],
      });
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("bob");
    });

    it("creates a query job (createQueryJob) and reads results", async () => {
      const [job] = await bq.createQueryJob({ query: "SELECT * FROM q_ds.people" });
      expect(job.id).toBeTruthy();
      const [rows] = await job.getQueryResults();
      expect(rows.length).toBe(3);
    });

    it("supports dryRun queries", async () => {
      const [job, resp] = await bq.createQueryJob({ query: "SELECT * FROM q_ds.people", dryRun: true });
      void job;
      expect(resp.statistics).toBeTruthy();
    });

    it("returns a query error for missing table", async () => {
      await expect(bq.query("SELECT * FROM q_ds.nonexistent")).rejects.toMatchObject({ code: 404 });
    });

    it("getQueryResults reflects f/v wire shape", async () => {
      const [job] = await bq.createQueryJob({ query: "SELECT * FROM q_ds.people ORDER BY id" });
      const res = await rawRequest({
        path: `/projects/parlel/queries/${job.id}`,
      });
      const body = JSON.parse(res.body);
      expect(body.kind).toBe("bigquery#getQueryResultsResponse");
      expect(body.jobComplete).toBe(true);
      expect(body.schema.fields.length).toBe(3);
      expect(body.rows.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe("Jobs", () => {
    let dataset: any;
    beforeEach(async () => {
      [dataset] = await bq.createDataset("job_ds");
      const [t] = await dataset.createTable("nums", { schema: [{ name: "n", type: "INTEGER" }] });
      await t.insert([{ n: 1 }, { n: 2 }]);
    });

    it("gets job metadata (jobs.get) with DONE state", async () => {
      const [job] = await bq.createQueryJob({ query: "SELECT * FROM job_ds.nums" });
      const [md] = await job.getMetadata();
      expect(md.status.state).toBe("DONE");
      expect(md.configuration.jobType).toBe("QUERY");
    });

    it("lists jobs (jobs.list)", async () => {
      await bq.createQueryJob({ query: "SELECT * FROM job_ds.nums" });
      const [jobs] = await bq.getJobs();
      expect(jobs.length).toBeGreaterThan(0);
    });

    it("cancels a job (jobs.cancel)", async () => {
      const [job] = await bq.createQueryJob({ query: "SELECT * FROM job_ds.nums" });
      const [resp] = await job.cancel();
      expect(resp.job.status.state).toBe("DONE");
    });

    it("deletes a job (jobs.delete)", async () => {
      const [job] = await bq.createQueryJob({ query: "SELECT * FROM job_ds.nums" });
      await job.delete();
      await expect(job.getMetadata()).rejects.toMatchObject({ code: 404 });
    });

    it("returns 404 for missing job", async () => {
      await expect(bq.job("no-such-job").getMetadata()).rejects.toMatchObject({ code: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Copy jobs", () => {
    it("copies rows between tables (jobs.insert copy)", async () => {
      const [ds] = await bq.createDataset("copy_ds");
      const [src] = await ds.createTable("src", { schema: [{ name: "v", type: "INTEGER" }] });
      await src.insert([{ v: 1 }, { v: 2 }, { v: 3 }]);
      const dest = ds.table("dest");
      const [job] = await src.createCopyJob(dest);
      const [md] = await job.getMetadata();
      expect(md.status.state).toBe("DONE");
      const [rows] = await dest.getRows();
      expect(rows.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe("Load jobs", () => {
    it("accepts a load job and creates the destination table", async () => {
      const [ds] = await bq.createDataset("load_ds");
      const dest = ds.table("loaded");
      // createLoadJob with metadata only (no source bytes over emulator REST).
      const [job] = await bq.createJob({
        configuration: {
          load: {
            destinationTable: { projectId: "parlel", datasetId: "load_ds", tableId: "loaded" },
            schema: { fields: [{ name: "a", type: "STRING" }] },
            sourceFormat: "NEWLINE_DELIMITED_JSON",
          },
        },
      });
      const [md] = await job.getMetadata();
      expect(md.status.state).toBe("DONE");
      const [exists] = await dest.exists();
      expect(exists).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("Routines", () => {
    let dataset: any;
    beforeEach(async () => {
      [dataset] = await bq.createDataset("routine_ds");
    });

    it("creates a routine (routines.insert)", async () => {
      const [routine] = await dataset.createRoutine("add_one", {
        arguments: [{ name: "x", dataType: { typeKind: "INT64" } }],
        definitionBody: "x + 1",
        routineType: "SCALAR_FUNCTION",
        returnType: { typeKind: "INT64" },
      });
      expect(routine.id).toBe("add_one");
      const [md] = await routine.getMetadata();
      expect(md.routineReference.routineId).toBe("add_one");
    });

    it("lists routines (routines.list)", async () => {
      await dataset.createRoutine("r1", { definitionBody: "1", routineType: "SCALAR_FUNCTION" });
      await dataset.createRoutine("r2", { definitionBody: "2", routineType: "SCALAR_FUNCTION" });
      const [routines] = await dataset.getRoutines();
      expect(routines.length).toBe(2);
    });

    it("updates a routine (routines.update)", async () => {
      const [routine] = await dataset.createRoutine("upd_r", {
        definitionBody: "1",
        routineType: "SCALAR_FUNCTION",
      });
      const [md] = await routine.setMetadata({
        definitionBody: "2",
        routineType: "SCALAR_FUNCTION",
        arguments: [],
      });
      expect(md.definitionBody).toBe("2");
    });

    it("deletes a routine (routines.delete)", async () => {
      const [routine] = await dataset.createRoutine("del_r", {
        definitionBody: "1",
        routineType: "SCALAR_FUNCTION",
      });
      await routine.delete();
      const [exists] = await routine.exists();
      expect(exists).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("Models", () => {
    it("lists models (empty) and 404s on missing model", async () => {
      const [ds] = await bq.createDataset("model_ds");
      const [models] = await ds.getModels();
      expect(models.length).toBe(0);
      await expect(ds.model("ghost").getMetadata()).rejects.toMatchObject({ code: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Table IAM policy", () => {
    let table: any;
    beforeEach(async () => {
      const [ds] = await bq.createDataset("iam_ds");
      [table] = await ds.createTable("iam_t", { schema: [{ name: "a", type: "STRING" }] });
    });

    it("gets a default IAM policy", async () => {
      const [policy] = await table.getIamPolicy();
      expect(policy.version).toBe(1);
    });

    it("sets and reads back an IAM policy", async () => {
      const [policy] = await table.setIamPolicy({
        bindings: [{ role: "roles/bigquery.dataViewer", members: ["user:a@b.com"] }],
      });
      expect(policy.bindings[0].role).toBe("roles/bigquery.dataViewer");
      const [readback] = await table.getIamPolicy();
      expect(readback.bindings[0].members).toContain("user:a@b.com");
    });

    it("tests IAM permissions", async () => {
      const [resp] = await table.testIamPermissions(["bigquery.tables.get"]);
      expect(resp.permissions).toContain("bigquery.tables.get");
    });
  });

  // -------------------------------------------------------------------------
  describe("Error shapes", () => {
    it("returns Google-API error JSON with code/message/status/errors", async () => {
      const res = await rawRequest({ path: "/projects/parlel/datasets/missing_xyz" });
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(404);
      expect(body.error.status).toBe("NOT_FOUND");
      expect(Array.isArray(body.error.errors)).toBe(true);
      expect(body.error.errors[0].reason).toBe("notFound");
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await rawRequest({
        method: "POST",
        path: "/projects/parlel/datasets",
        body: "{not json",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });
  });
});
