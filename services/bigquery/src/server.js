// parlel/bigquery — a lightweight, dependency-free fake of Google Cloud
// BigQuery.
//
// Speaks the BigQuery v2 REST API (https://bigquery.googleapis.com/bigquery/v2)
// so that application code using the real `@google-cloud/bigquery` client can
// run against it with zero cost and zero side effects. Pure Node.js, no
// external npm dependencies. State is in-memory and ephemeral (resettable via
// reset() or POST /_parlel/reset).
//
// Point the client at this server by setting:
//   BIGQUERY_EMULATOR_HOST=http://127.0.0.1:4583
// and constructing the client with fake credentials (so JWT signing works
// offline — the parlel fake never validates the token):
//   new BigQuery({ projectId: "parlel", credentials: { client_email, private_key } })
//
// The @google-cloud/common Service layer composes request URLs as
//   {baseUrl}/projects/{projectId}/{uri}
// where baseUrl == BIGQUERY_EMULATOR_HOST. This server therefore implements the
// BigQuery v2 resource tree under /projects/{projectId}/...:
//
//   Datasets
//     POST   /projects/{p}/datasets                      datasets.insert
//     GET    /projects/{p}/datasets                      datasets.list
//     GET    /projects/{p}/datasets/{d}                  datasets.get
//     PATCH  /projects/{p}/datasets/{d}                  datasets.patch/update
//     DELETE /projects/{p}/datasets/{d}                  datasets.delete
//   Tables
//     POST   /projects/{p}/datasets/{d}/tables           tables.insert
//     GET    /projects/{p}/datasets/{d}/tables           tables.list
//     GET    /projects/{p}/datasets/{d}/tables/{t}       tables.get
//     PATCH  /projects/{p}/datasets/{d}/tables/{t}       tables.patch/update
//     DELETE /projects/{p}/datasets/{d}/tables/{t}       tables.delete
//     GET    /projects/{p}/datasets/{d}/tables/{t}/data  tabledata.list
//     POST   /projects/{p}/datasets/{d}/tables/{t}/insertAll  tabledata.insertAll
//     POST   /projects/{p}/datasets/{d}/tables/{t}/:getIamPolicy
//     POST   /projects/{p}/datasets/{d}/tables/{t}/:setIamPolicy
//     POST   /projects/{p}/datasets/{d}/tables/{t}/:testIamPermissions
//   Models
//     GET    /projects/{p}/datasets/{d}/models           models.list
//     GET    /projects/{p}/datasets/{d}/models/{m}       models.get
//     PATCH  /projects/{p}/datasets/{d}/models/{m}       models.patch
//     DELETE /projects/{p}/datasets/{d}/models/{m}       models.delete
//   Routines
//     POST   /projects/{p}/datasets/{d}/routines         routines.insert
//     GET    /projects/{p}/datasets/{d}/routines         routines.list
//     GET    /projects/{p}/datasets/{d}/routines/{r}     routines.get
//     PUT    /projects/{p}/datasets/{d}/routines/{r}     routines.update
//     DELETE /projects/{p}/datasets/{d}/routines/{r}     routines.delete
//   Jobs
//     POST   /projects/{p}/jobs                          jobs.insert
//     GET    /projects/{p}/jobs                          jobs.list
//     GET    /projects/{p}/jobs/{j}                      jobs.get
//     DELETE /projects/{p}/jobs/{j}/delete               jobs.delete
//     POST   /projects/{p}/jobs/{j}/cancel               jobs.cancel
//   Queries
//     POST   /projects/{p}/queries                       jobs.query
//     GET    /projects/{p}/queries/{j}                   jobs.getQueryResults

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Error shape — BigQuery returns Google-API style errors:
//   { error: { code, message, status, errors: [{ message, domain, reason }] } }
// The google-cloud client surfaces error.code as the HTTP status, error.message
// and error.errors[].reason. We throw ApiError to carry these.
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(code, message, reason = "invalid", status) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.status = status || statusForCode(code);
  }
}

function statusForCode(code) {
  switch (code) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "ALREADY_EXISTS";
    case 412:
      return "FAILED_PRECONDITION";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 500:
      return "INTERNAL";
    case 501:
      return "UNIMPLEMENTED";
    case 503:
      return "UNAVAILABLE";
    default:
      return "UNKNOWN";
  }
}

export class BigqueryServer {
  constructor(port = 4583, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.projectId = options.projectId || "parlel";
    this.location = options.location || "US";
    this.server = null;
    this.reset();
  }

  reset() {
    // datasets: Map<datasetId, { datasetReference, friendlyName, ... , _tables, _models, _routines }>
    this.datasets = new Map();
    // jobs: Map<jobId, jobResource>
    this.jobs = new Map();
    // query results cache: Map<jobId, { schema, rows, totalRows }>
    this.queryResults = new Map();
    this._seq = 0;
  }

  nextId(prefix) {
    this._seq += 1;
    return `${prefix}_${Date.now()}_${this._seq}_${randomBytes(4).toString("hex")}`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (error instanceof ApiError) return this.sendError(res, error);
          this.sendError(res, new ApiError(500, error.message || "internal error", "internalError"));
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    // Internal parlel endpoints (not part of BigQuery).
    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "bigquery",
        datasets: this.datasets.size,
        jobs: this.jobs.size,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/_parlel/dump" && method === "GET") {
      return this.sendJson(res, 200, {
        datasets: [...this.datasets.keys()],
        jobs: [...this.jobs.keys()],
      });
    }
    // Discovery document ping / root.
    if (pathname === "/" || pathname === "/bigquery/v2") {
      return this.sendJson(res, 200, { kind: "bigquery#parlel" });
    }

    const rawBody = await this.readBody(req);
    let body = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new ApiError(400, "Invalid JSON body", "parseError");
      }
    }

    // The path may be prefixed with /bigquery/v2 (apiEndpoint form) or be the
    // bare emulator form. Normalize so it begins at /projects/...
    let p = pathname;
    if (p.startsWith("/bigquery/v2/")) p = p.slice("/bigquery/v2".length);
    if (!p.startsWith("/projects/")) {
      throw new ApiError(404, `Unsupported path: ${pathname}`, "notFound");
    }

    const segs = p.split("/").filter((s) => s.length > 0);
    // segs[0] === 'projects', segs[1] === projectId
    const projectId = segs[1];
    const rest = segs.slice(2); // e.g. ['datasets', 'd', 'tables', 't', 'data']

    // ---- /projects/{p}/queries ... (jobs.query / getQueryResults) ----------
    if (rest[0] === "queries") {
      if (rest.length === 1 && method === "POST") {
        return this.jobsQuery(res, projectId, body);
      }
      if (rest.length === 2 && method === "GET") {
        return this.getQueryResults(res, projectId, rest[1], q);
      }
      throw new ApiError(405, "Method Not Allowed", "notImplemented");
    }

    // ---- /projects/{p}/jobs ... -------------------------------------------
    if (rest[0] === "jobs") {
      if (rest.length === 1 && method === "POST") return this.jobsInsert(res, projectId, body);
      if (rest.length === 1 && method === "GET") return this.jobsList(res, projectId, q);
      if (rest.length === 2 && method === "GET") return this.jobsGet(res, projectId, rest[1], q);
      if (rest.length === 3 && rest[2] === "cancel" && method === "POST") {
        return this.jobsCancel(res, projectId, rest[1]);
      }
      if (rest.length === 3 && rest[2] === "delete" && method === "DELETE") {
        return this.jobsDelete(res, projectId, rest[1]);
      }
      throw new ApiError(405, "Method Not Allowed", "notImplemented");
    }

    // ---- /projects/{p}/datasets ... ---------------------------------------
    if (rest[0] === "datasets") {
      if (rest.length === 1 && method === "POST") return this.datasetsInsert(res, projectId, body);
      if (rest.length === 1 && method === "GET") return this.datasetsList(res, projectId, q);

      const datasetId = rest[1];
      if (rest.length === 2) {
        if (method === "GET") return this.datasetsGet(res, projectId, datasetId);
        if (method === "PATCH" || method === "PUT") return this.datasetsPatch(res, projectId, datasetId, body);
        if (method === "DELETE") return this.datasetsDelete(res, projectId, datasetId, q);
        throw new ApiError(405, "Method Not Allowed", "notImplemented");
      }

      const ds = this.getDataset(projectId, datasetId);
      const kind = rest[2]; // tables | models | routines

      // ----- tables -----
      if (kind === "tables") {
        if (rest.length === 3 && method === "POST") return this.tablesInsert(res, ds, body);
        if (rest.length === 3 && method === "GET") return this.tablesList(res, ds, q);

        // IAM verbs arrive colon-suffixed on the table id: "iam_t:getIamPolicy".
        if (rest.length === 4 && rest[3].includes(":")) {
          const [tid, verb] = rest[3].split(":");
          if (verb === "getIamPolicy" && method === "POST") return this.tableGetIamPolicy(res, ds, tid, body);
          if (verb === "setIamPolicy" && method === "POST") return this.tableSetIamPolicy(res, ds, tid, body);
          if (verb === "testIamPermissions" && method === "POST") {
            return this.tableTestIamPermissions(res, ds, tid, body);
          }
          throw new ApiError(404, `Unknown table verb: ${verb}`, "notFound");
        }

        const tableId = rest[3];
        if (rest.length === 4) {
          if (method === "GET") return this.tablesGet(res, ds, tableId, q);
          if (method === "PATCH" || method === "PUT") return this.tablesPatch(res, ds, tableId, body);
          if (method === "DELETE") return this.tablesDelete(res, ds, tableId);
          throw new ApiError(405, "Method Not Allowed", "notImplemented");
        }
        const sub = rest[4];
        if (rest.length === 5) {
          if (sub === "data" && method === "GET") return this.tabledataList(res, ds, tableId, q);
          if (sub === "insertAll" && method === "POST") return this.tabledataInsertAll(res, ds, tableId, body);
        }
        throw new ApiError(405, "Method Not Allowed", "notImplemented");
      }

      // ----- models -----
      if (kind === "models") {
        if (rest.length === 3 && method === "GET") return this.modelsList(res, ds, q);
        const modelId = rest[3];
        if (rest.length === 4) {
          if (method === "GET") return this.modelsGet(res, ds, modelId);
          if (method === "PATCH" || method === "PUT") return this.modelsPatch(res, ds, modelId, body);
          if (method === "DELETE") return this.modelsDelete(res, ds, modelId);
        }
        throw new ApiError(405, "Method Not Allowed", "notImplemented");
      }

      // ----- routines -----
      if (kind === "routines") {
        if (rest.length === 3 && method === "POST") return this.routinesInsert(res, ds, body);
        if (rest.length === 3 && method === "GET") return this.routinesList(res, ds, q);
        const routineId = rest[3];
        if (rest.length === 4) {
          if (method === "GET") return this.routinesGet(res, ds, routineId);
          if (method === "PUT" || method === "PATCH") return this.routinesUpdate(res, ds, routineId, body);
          if (method === "DELETE") return this.routinesDelete(res, ds, routineId);
        }
        throw new ApiError(405, "Method Not Allowed", "notImplemented");
      }

      throw new ApiError(404, `Unsupported dataset sub-resource: ${kind}`, "notFound");
    }

    throw new ApiError(404, `Unsupported resource: ${rest[0]}`, "notFound");
  }

  // -------------------------------------------------------------------------
  // Datasets
  // -------------------------------------------------------------------------
  datasetsInsert(res, projectId, body) {
    const ref = body.datasetReference || {};
    const datasetId = ref.datasetId || body.id;
    if (!datasetId) throw new ApiError(400, "Required parameter datasetId is missing", "required");
    if (this.datasets.has(datasetId)) {
      throw new ApiError(409, `Already Exists: Dataset ${projectId}:${datasetId}`, "duplicate");
    }
    const now = String(Date.now());
    const ds = {
      kind: "bigquery#dataset",
      etag: this.etag(),
      id: `${projectId}:${datasetId}`,
      selfLink: `/projects/${projectId}/datasets/${datasetId}`,
      datasetReference: { projectId, datasetId },
      friendlyName: body.friendlyName,
      description: body.description,
      labels: body.labels,
      location: body.location || this.location,
      defaultTableExpirationMs: body.defaultTableExpirationMs,
      access: body.access,
      creationTime: now,
      lastModifiedTime: now,
      _tables: new Map(),
      _models: new Map(),
      _routines: new Map(),
    };
    this.datasets.set(datasetId, ds);
    return this.sendJson(res, 200, this.datasetResource(ds));
  }

  datasetsList(res, projectId, q) {
    const all = q.get("all") === "true";
    const maxResults = parseInt(q.get("maxResults") || "0", 10);
    let list = [...this.datasets.values()].map((ds) => ({
      kind: "bigquery#dataset",
      id: ds.id,
      datasetReference: ds.datasetReference,
      labels: ds.labels,
      friendlyName: ds.friendlyName,
      location: ds.location,
    }));
    void all;
    if (maxResults > 0) list = list.slice(0, maxResults);
    return this.sendJson(res, 200, {
      kind: "bigquery#datasetList",
      etag: this.etag(),
      datasets: list,
    });
  }

  datasetsGet(res, projectId, datasetId) {
    const ds = this.getDataset(projectId, datasetId);
    return this.sendJson(res, 200, this.datasetResource(ds));
  }

  datasetsPatch(res, projectId, datasetId, body) {
    const ds = this.getDataset(projectId, datasetId);
    for (const key of ["friendlyName", "description", "labels", "defaultTableExpirationMs", "access", "location"]) {
      if (key in body) ds[key] = body[key];
    }
    ds.etag = this.etag();
    ds.lastModifiedTime = String(Date.now());
    return this.sendJson(res, 200, this.datasetResource(ds));
  }

  datasetsDelete(res, projectId, datasetId, q) {
    const ds = this.datasets.get(datasetId);
    if (!ds) throw new ApiError(404, `Not found: Dataset ${projectId}:${datasetId}`, "notFound");
    const deleteContents = q.get("deleteContents") === "true";
    if (!deleteContents && ds._tables.size > 0) {
      throw new ApiError(
        400,
        `Dataset ${projectId}:${datasetId} is still in use`,
        "resourceInUse",
      );
    }
    this.datasets.delete(datasetId);
    return this.sendNoContent(res);
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------
  tablesInsert(res, ds, body) {
    const ref = body.tableReference || {};
    const tableId = ref.tableId || body.id;
    if (!tableId) throw new ApiError(400, "Required parameter tableId is missing", "required");
    if (ds._tables.has(tableId)) {
      throw new ApiError(409, `Already Exists: Table ${ds.id}.${tableId}`, "duplicate");
    }
    const now = String(Date.now());
    const projectId = ds.datasetReference.projectId;
    const datasetId = ds.datasetReference.datasetId;
    const table = {
      kind: "bigquery#table",
      etag: this.etag(),
      id: `${projectId}:${datasetId}.${tableId}`,
      selfLink: `/projects/${projectId}/datasets/${datasetId}/tables/${tableId}`,
      tableReference: { projectId, datasetId, tableId },
      friendlyName: body.friendlyName,
      description: body.description,
      labels: body.labels,
      schema: body.schema || { fields: [] },
      type: body.view ? "VIEW" : body.type || "TABLE",
      view: body.view,
      timePartitioning: body.timePartitioning,
      rangePartitioning: body.rangePartitioning,
      clustering: body.clustering,
      expirationTime: body.expirationTime,
      numRows: "0",
      numBytes: "0",
      creationTime: now,
      lastModifiedTime: now,
      _rows: [],
    };
    ds._tables.set(tableId, table);
    return this.sendJson(res, 200, this.tableResource(table, true));
  }

  tablesList(res, ds, q) {
    const maxResults = parseInt(q.get("maxResults") || "0", 10);
    let list = [...ds._tables.values()].map((t) => ({
      kind: "bigquery#table",
      id: t.id,
      tableReference: t.tableReference,
      friendlyName: t.friendlyName,
      type: t.type,
      labels: t.labels,
      creationTime: t.creationTime,
      view: t.view,
      timePartitioning: t.timePartitioning,
    }));
    if (maxResults > 0) list = list.slice(0, maxResults);
    return this.sendJson(res, 200, {
      kind: "bigquery#tableList",
      etag: this.etag(),
      tables: list,
      totalItems: ds._tables.size,
    });
  }

  tablesGet(res, ds, tableId, q) {
    const t = this.getTable(ds, tableId);
    return this.sendJson(res, 200, this.tableResource(t, true));
  }

  tablesPatch(res, ds, tableId, body) {
    const t = this.getTable(ds, tableId);
    for (const key of [
      "friendlyName",
      "description",
      "labels",
      "schema",
      "expirationTime",
      "timePartitioning",
      "rangePartitioning",
      "clustering",
      "view",
    ]) {
      if (key in body) t[key] = body[key];
    }
    t.etag = this.etag();
    t.lastModifiedTime = String(Date.now());
    return this.sendJson(res, 200, this.tableResource(t, true));
  }

  tablesDelete(res, ds, tableId) {
    if (!ds._tables.has(tableId)) {
      throw new ApiError(404, `Not found: Table ${ds.id}.${tableId}`, "notFound");
    }
    ds._tables.delete(tableId);
    return this.sendNoContent(res);
  }

  // -------------------------------------------------------------------------
  // Table data (tabledata.list / tabledata.insertAll)
  // -------------------------------------------------------------------------
  tabledataList(res, ds, tableId, q) {
    const t = this.getTable(ds, tableId);
    const maxResults = parseInt(q.get("maxResults") || "0", 10);
    const startIndex = parseInt(q.get("startIndex") || "0", 10);
    let rows = t._rows.slice();
    const total = rows.length;
    if (startIndex > 0) rows = rows.slice(startIndex);
    let pageToken;
    if (maxResults > 0 && rows.length > maxResults) {
      pageToken = String((startIndex || 0) + maxResults);
      rows = rows.slice(0, maxResults);
    }
    const fields = (t.schema && t.schema.fields) || [];
    const out = {
      kind: "bigquery#tableDataList",
      etag: this.etag(),
      totalRows: String(total),
      rows: rows.map((r) => this.rowToCells(r, fields)),
    };
    if (pageToken) out.pageToken = pageToken;
    return this.sendJson(res, 200, out);
  }

  tabledataInsertAll(res, ds, tableId, body) {
    const t = this.getTable(ds, tableId);
    const rows = body.rows || [];
    const insertErrors = [];
    const fields = (t.schema && t.schema.fields) || [];
    const fieldNames = new Set(fields.map((f) => f.name));
    const skipInvalid = !!body.skipInvalidRows;
    const ignoreUnknown = !!body.ignoreUnknownValues;

    rows.forEach((row, index) => {
      const json = row.json || {};
      const errors = [];
      if (!ignoreUnknown && fields.length > 0) {
        for (const key of Object.keys(json)) {
          if (!fieldNames.has(key)) {
            errors.push({
              reason: "invalid",
              message: `no such field: ${key}.`,
            });
          }
        }
      }
      if (errors.length > 0) {
        insertErrors.push({ index, errors });
        if (!skipInvalid) return;
      }
      t._rows.push(json);
    });

    t.numRows = String(t._rows.length);

    const out = { kind: "bigquery#tableDataInsertAllResponse" };
    if (insertErrors.length > 0) out.insertErrors = insertErrors;
    return this.sendJson(res, 200, out);
  }

  // -------------------------------------------------------------------------
  // Table IAM policy (getIamPolicy / setIamPolicy / testIamPermissions)
  // -------------------------------------------------------------------------
  tableGetIamPolicy(res, ds, tableId, body) {
    const t = this.getTable(ds, tableId);
    return this.sendJson(res, 200, t._iamPolicy || { version: 1, etag: "ACAB", bindings: [] });
  }

  tableSetIamPolicy(res, ds, tableId, body) {
    const t = this.getTable(ds, tableId);
    const policy = (body && body.policy) || { version: 1, bindings: [] };
    if (!policy.etag) policy.etag = "ACAB";
    t._iamPolicy = policy;
    return this.sendJson(res, 200, policy);
  }

  tableTestIamPermissions(res, ds, tableId, body) {
    this.getTable(ds, tableId);
    const requested = (body && body.permissions) || [];
    // The fake grants every requested permission.
    return this.sendJson(res, 200, { permissions: requested });
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------
  modelsList(res, ds, q) {
    const list = [...ds._models.values()].map((m) => this.modelResource(m));
    return this.sendJson(res, 200, { models: list });
  }

  modelsGet(res, ds, modelId) {
    const m = ds._models.get(modelId);
    if (!m) throw new ApiError(404, `Not found: Model ${ds.id}.${modelId}`, "notFound");
    return this.sendJson(res, 200, this.modelResource(m));
  }

  modelsPatch(res, ds, modelId, body) {
    const m = ds._models.get(modelId);
    if (!m) throw new ApiError(404, `Not found: Model ${ds.id}.${modelId}`, "notFound");
    for (const key of ["friendlyName", "description", "labels", "expirationTime"]) {
      if (key in body) m[key] = body[key];
    }
    m.etag = this.etag();
    return this.sendJson(res, 200, this.modelResource(m));
  }

  modelsDelete(res, ds, modelId) {
    if (!ds._models.has(modelId)) {
      throw new ApiError(404, `Not found: Model ${ds.id}.${modelId}`, "notFound");
    }
    ds._models.delete(modelId);
    return this.sendNoContent(res);
  }

  // -------------------------------------------------------------------------
  // Routines
  // -------------------------------------------------------------------------
  routinesInsert(res, ds, body) {
    const ref = body.routineReference || {};
    const routineId = ref.routineId;
    if (!routineId) throw new ApiError(400, "Required parameter routineId is missing", "required");
    if (ds._routines.has(routineId)) {
      throw new ApiError(409, `Already Exists: Routine ${ds.id}.${routineId}`, "duplicate");
    }
    const projectId = ds.datasetReference.projectId;
    const datasetId = ds.datasetReference.datasetId;
    const now = String(Date.now());
    const routine = {
      etag: this.etag(),
      routineReference: { projectId, datasetId, routineId },
      routineType: body.routineType || "SCALAR_FUNCTION",
      definitionBody: body.definitionBody,
      language: body.language,
      arguments: body.arguments,
      returnType: body.returnType,
      importedLibraries: body.importedLibraries,
      description: body.description,
      creationTime: now,
      lastModifiedTime: now,
    };
    ds._routines.set(routineId, routine);
    return this.sendJson(res, 200, routine);
  }

  routinesList(res, ds, q) {
    const list = [...ds._routines.values()];
    return this.sendJson(res, 200, { routines: list });
  }

  routinesGet(res, ds, routineId) {
    const r = ds._routines.get(routineId);
    if (!r) throw new ApiError(404, `Not found: Routine ${ds.id}.${routineId}`, "notFound");
    return this.sendJson(res, 200, r);
  }

  routinesUpdate(res, ds, routineId, body) {
    const r = ds._routines.get(routineId);
    if (!r) throw new ApiError(404, `Not found: Routine ${ds.id}.${routineId}`, "notFound");
    for (const key of [
      "definitionBody",
      "language",
      "arguments",
      "returnType",
      "importedLibraries",
      "description",
      "routineType",
    ]) {
      if (key in body) r[key] = body[key];
    }
    r.etag = this.etag();
    r.lastModifiedTime = String(Date.now());
    return this.sendJson(res, 200, r);
  }

  routinesDelete(res, ds, routineId) {
    if (!ds._routines.has(routineId)) {
      throw new ApiError(404, `Not found: Routine ${ds.id}.${routineId}`, "notFound");
    }
    ds._routines.delete(routineId);
    return this.sendNoContent(res);
  }

  // -------------------------------------------------------------------------
  // Jobs (insert / list / get / cancel / delete)
  // -------------------------------------------------------------------------
  jobsInsert(res, projectId, body) {
    const config = body.configuration || {};
    const jobRef = body.jobReference || {};
    const jobId = jobRef.jobId || this.nextId("job");
    const location = jobRef.location || this.location;

    let statistics = {};
    let errorResult = null;

    try {
      if (config.query) {
        statistics = this.executeQueryJob(projectId, config.query, jobId);
      } else if (config.load) {
        statistics = this.executeLoadJob(projectId, config.load);
      } else if (config.copy) {
        statistics = this.executeCopyJob(projectId, config.copy);
      } else if (config.extract) {
        statistics = { extract: { destinationUriFileCounts: ["0"] } };
      } else {
        throw new ApiError(400, "Job configuration must specify query, load, copy, or extract", "invalid");
      }
    } catch (err) {
      if (err instanceof ApiError) {
        errorResult = { reason: err.reason, message: err.message };
      } else {
        throw err;
      }
    }

    const job = this.buildJobResource(projectId, jobId, location, config, statistics, errorResult);
    this.jobs.set(jobId, job);
    return this.sendJson(res, 200, job);
  }

  jobsList(res, projectId, q) {
    const stateFilter = q.get("stateFilter");
    let list = [...this.jobs.values()];
    if (stateFilter) {
      list = list.filter((j) => (j.status.state || "").toLowerCase() === stateFilter.toLowerCase());
    }
    return this.sendJson(res, 200, {
      kind: "bigquery#jobList",
      etag: this.etag(),
      jobs: list.map((j) => ({
        kind: "bigquery#job",
        id: j.id,
        jobReference: j.jobReference,
        state: j.status.state,
        statistics: j.statistics,
        status: j.status,
        configuration: j.configuration,
      })),
    });
  }

  jobsGet(res, projectId, jobId, q) {
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, `Not found: Job ${projectId}:${jobId}`, "notFound");
    return this.sendJson(res, 200, job);
  }

  jobsCancel(res, projectId, jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, `Not found: Job ${projectId}:${jobId}`, "notFound");
    // Jobs in this fake complete instantly, so cancellation is a no-op that
    // returns the (already DONE) job resource.
    return this.sendJson(res, 200, { kind: "bigquery#jobCancelResponse", job });
  }

  jobsDelete(res, projectId, jobId) {
    if (!this.jobs.has(jobId)) {
      throw new ApiError(404, `Not found: Job ${projectId}:${jobId}`, "notFound");
    }
    this.jobs.delete(jobId);
    this.queryResults.delete(jobId);
    return this.sendNoContent(res);
  }

  buildJobResource(projectId, jobId, location, config, statistics, errorResult) {
    const now = Date.now();
    const status = errorResult
      ? { state: "DONE", errorResult, errors: [errorResult] }
      : { state: "DONE" };
    return {
      kind: "bigquery#job",
      etag: this.etag(),
      id: `${projectId}:${location}.${jobId}`,
      selfLink: `/projects/${projectId}/jobs/${jobId}`,
      jobReference: { projectId, jobId, location },
      configuration: { ...config, jobType: this.jobType(config) },
      statistics: {
        creationTime: String(now),
        startTime: String(now),
        endTime: String(now),
        ...statistics,
      },
      status,
    };
  }

  jobType(config) {
    if (config.query) return "QUERY";
    if (config.load) return "LOAD";
    if (config.copy) return "COPY";
    if (config.extract) return "EXTRACT";
    return "UNKNOWN";
  }

  // -------------------------------------------------------------------------
  // Query job execution: SELECT ... -> { schema, rows } cached by jobId.
  // -------------------------------------------------------------------------
  executeQueryJob(projectId, queryConfig, jobId) {
    const sql = queryConfig.query;
    const params = this.collectParams(queryConfig);
    const { schema, rows, statementType } = this.runSql(projectId, sql, queryConfig, params);
    this.queryResults.set(jobId, { schema, rows });
    return {
      query: {
        statementType,
        totalBytesProcessed: "0",
        cacheHit: false,
        schema,
      },
      totalBytesProcessed: "0",
    };
  }

  executeLoadJob(projectId, loadConfig) {
    // Loads from inline rows are not transferred over REST (the source bytes go
    // through the resumable-upload endpoint, which this fake does not host).
    // We accept the job, optionally create the destination table from the
    // provided schema, and report zero output rows.
    const dest = loadConfig.destinationTable;
    if (dest && loadConfig.schema) {
      const ds = this.datasets.get(dest.datasetId);
      if (ds && !ds._tables.has(dest.tableId)) {
        this.tablesInsert(
          { __captured: true, statusCode: 0, setHeader() {}, end() {} },
          ds,
          { tableReference: dest, schema: loadConfig.schema },
        );
      }
    }
    return { load: { outputRows: "0", outputBytes: "0", inputFiles: "0" } };
  }

  executeCopyJob(projectId, copyConfig) {
    const sources = copyConfig.sourceTables || (copyConfig.sourceTable ? [copyConfig.sourceTable] : []);
    const dest = copyConfig.destinationTable;
    if (!dest) throw new ApiError(400, "copy job requires destinationTable", "invalid");
    const destDs = this.datasets.get(dest.datasetId);
    if (!destDs) throw new ApiError(404, `Not found: Dataset ${projectId}:${dest.datasetId}`, "notFound");

    let mergedSchema = null;
    const copiedRows = [];
    for (const src of sources) {
      const srcDs = this.datasets.get(src.datasetId);
      const srcTable = srcDs && srcDs._tables.get(src.tableId);
      if (!srcTable) throw new ApiError(404, `Not found: Table ${src.datasetId}.${src.tableId}`, "notFound");
      if (!mergedSchema) mergedSchema = srcTable.schema;
      for (const r of srcTable._rows) copiedRows.push(r);
    }

    let destTable = destDs._tables.get(dest.tableId);
    const writeDisposition = copyConfig.writeDisposition || "WRITE_EMPTY";
    if (!destTable) {
      this.tablesInsert(
        { __captured: true, statusCode: 0, setHeader() {}, end() {} },
        destDs,
        { tableReference: dest, schema: mergedSchema || { fields: [] } },
      );
      destTable = destDs._tables.get(dest.tableId);
    } else if (writeDisposition === "WRITE_TRUNCATE") {
      destTable._rows = [];
    } else if (writeDisposition === "WRITE_EMPTY" && destTable._rows.length > 0) {
      throw new ApiError(409, `Already Exists: Table ${dest.datasetId}.${dest.tableId} is not empty`, "duplicate");
    }
    destTable._rows.push(...copiedRows);
    destTable.numRows = String(destTable._rows.length);
    return { copy: { copiedRows: String(copiedRows.length), copiedLogicalBytes: "0" } };
  }

  collectParams(queryConfig) {
    const named = {};
    const positional = [];
    const qp = queryConfig.queryParameters || [];
    for (const p of qp) {
      const value = this.decodeParamValue(p.parameterValue, p.parameterType);
      if (p.name) named[p.name] = value;
      else positional.push(value);
    }
    return { named, positional, mode: queryConfig.parameterMode };
  }

  decodeParamValue(pv, pt) {
    if (pv == null) return null;
    if (pt && pt.type === "ARRAY" && pv.arrayValues) {
      return pv.arrayValues.map((v) => this.decodeParamValue(v, pt.arrayType));
    }
    if (pt && pt.type === "STRUCT" && pv.structValues) {
      const out = {};
      for (const k of Object.keys(pv.structValues)) out[k] = this.decodeParamValue(pv.structValues[k]);
      return out;
    }
    if (pv.value === undefined || pv.value === null) return null;
    const type = pt && pt.type;
    if (type === "INTEGER" || type === "INT64") return parseInt(pv.value, 10);
    if (type === "FLOAT" || type === "FLOAT64" || type === "NUMERIC") return parseFloat(pv.value);
    if (type === "BOOLEAN" || type === "BOOL") return pv.value === true || pv.value === "true";
    return pv.value;
  }

  // -------------------------------------------------------------------------
  // jobs.query — synchronous query path used by client.query().
  // -------------------------------------------------------------------------
  jobsQuery(res, projectId, body) {
    const jobId = this.nextId("job");
    const location = body.location || this.location;
    const params = this.collectParams(body);
    // Query validation errors (e.g. missing table) surface as HTTP errors at the
    // jobs.query level, matching real BigQuery and letting client.query() reject.
    const result = this.runSql(projectId, body.query, body, params);
    const schema = result.schema;
    const rows = result.rows;
    const statementType = result.statementType;
    const errorResult = null;

    if (body.dryRun) {
      return this.sendJson(res, 200, {
        kind: "bigquery#queryResponse",
        jobReference: { projectId, jobId, location },
        jobComplete: true,
        schema: schema || { fields: [] },
        totalBytesProcessed: "0",
        cacheHit: false,
      });
    }

    // Register a job resource so subsequent job.getQueryResults / job.get work.
    const config = { query: { query: body.query, useLegacySql: false } };
    const stats = { query: { statementType, schema, totalBytesProcessed: "0", cacheHit: false } };
    const job = this.buildJobResource(projectId, jobId, location, config, stats, errorResult);
    this.jobs.set(jobId, job);
    this.queryResults.set(jobId, { schema, rows });

    const wireRows = rows.map((r) => this.rowToCells(r, schema.fields));
    return this.sendJson(res, 200, {
      kind: "bigquery#queryResponse",
      jobReference: { projectId, jobId, location },
      jobComplete: true,
      schema,
      rows: wireRows,
      totalRows: String(rows.length),
      totalBytesProcessed: "0",
      cacheHit: false,
    });
  }

  getQueryResults(res, projectId, jobId, q) {
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, `Not found: Job ${projectId}:${jobId}`, "notFound");
    const location = (job.jobReference && job.jobReference.location) || this.location;

    if (job.status && job.status.errorResult) {
      return this.sendJson(res, 200, {
        kind: "bigquery#getQueryResultsResponse",
        jobReference: { projectId, jobId, location },
        jobComplete: true,
        errors: [job.status.errorResult],
      });
    }

    const cached = this.queryResults.get(jobId) || { schema: { fields: [] }, rows: [] };
    const schema = cached.schema || { fields: [] };
    let rows = cached.rows || [];
    const total = rows.length;

    const maxResults = parseInt(q.get("maxResults") || "0", 10);
    const startIndex = parseInt(q.get("startIndex") || "0", 10);
    if (startIndex > 0) rows = rows.slice(startIndex);
    let pageToken;
    if (maxResults > 0 && rows.length > maxResults) {
      pageToken = String((startIndex || 0) + maxResults);
      rows = rows.slice(0, maxResults);
    }

    const out = {
      kind: "bigquery#getQueryResultsResponse",
      etag: this.etag(),
      jobReference: { projectId, jobId, location },
      jobComplete: true,
      schema,
      totalRows: String(total),
      rows: rows.map((r) => this.rowToCells(r, schema.fields)),
      totalBytesProcessed: "0",
      cacheHit: false,
    };
    if (pageToken) out.pageToken = pageToken;
    return this.sendJson(res, 200, out);
  }

  // -------------------------------------------------------------------------
  // Minimal SQL engine.
  //
  // Supports the patterns exercised by application code & tests:
  //   SELECT <scalar-exprs>                       (no FROM — literal projection)
  //   SELECT * | <cols> FROM [`]proj.[/]ds.table[`] [WHERE ...] [ORDER BY ...] [LIMIT n]
  //   SELECT COUNT(*) [AS alias] FROM ...
  //   Named (@name) and positional (?) query parameters.
  // -------------------------------------------------------------------------
  runSql(projectId, sql, config, params) {
    if (typeof sql !== "string" || sql.trim() === "") {
      throw new ApiError(400, "Query is required", "invalid");
    }
    let text = sql.trim().replace(/;\s*$/, "");

    // Substitute query parameters into the SQL with literal encodings.
    text = this.substituteParams(text, params);

    const upper = text.toUpperCase();
    if (!upper.startsWith("SELECT")) {
      // DDL/DML are accepted but produce no rows (e.g. CREATE/INSERT/UPDATE).
      let statementType = "SCRIPT";
      if (upper.startsWith("CREATE")) statementType = "CREATE_TABLE";
      else if (upper.startsWith("INSERT")) statementType = "INSERT";
      else if (upper.startsWith("UPDATE")) statementType = "UPDATE";
      else if (upper.startsWith("DELETE")) statementType = "DELETE";
      else if (upper.startsWith("MERGE")) statementType = "MERGE";
      else if (upper.startsWith("DROP")) statementType = "DROP_TABLE";
      return { schema: { fields: [] }, rows: [], statementType };
    }

    const fromIdx = this.findKeyword(text, "FROM");
    if (fromIdx === -1) {
      // SELECT of literal expressions only.
      return this.evalLiteralSelect(text);
    }

    const selectPart = text.slice("SELECT".length, fromIdx).trim();
    let remainder = text.slice(fromIdx + 4).trim();

    // Parse table reference (up to WHERE/ORDER/LIMIT/GROUP).
    const stopIdx = this.findFirstClause(remainder);
    const tableRefRaw = (stopIdx === -1 ? remainder : remainder.slice(0, stopIdx)).trim();
    let clauses = stopIdx === -1 ? "" : remainder.slice(stopIdx).trim();

    const table = this.resolveTable(projectId, tableRefRaw);
    const fields = (table.schema && table.schema.fields) || [];
    let rows = table._rows.map((r) => ({ ...r }));

    // WHERE
    const whereMatch = /\bWHERE\b(.+?)(\bORDER\s+BY\b|\bLIMIT\b|\bGROUP\s+BY\b|$)/is.exec(clauses);
    if (whereMatch) {
      const cond = whereMatch[1].trim();
      rows = rows.filter((r) => this.evalWhere(cond, r));
    }

    // Reject GROUP BY (beyond the bare COUNT(*) case handled below) and JOINs
    // rather than silently dropping the clause and returning ungrouped rows.
    if (/\bGROUP\s+BY\b/i.test(clauses) && !/^\s*COUNT\s*\(\s*\*\s*\)/i.test(selectPart)) {
      throw new ApiError(400, "GROUP BY with non-COUNT projections is not supported by the parlel bigquery emulator", "invalidQuery");
    }
    if (/\bJOIN\b/i.test(text)) {
      throw new ApiError(400, "JOIN is not supported by the parlel bigquery emulator", "invalidQuery");
    }
    if (/\bOVER\s*\(/i.test(text)) {
      throw new ApiError(400, "window functions are not supported by the parlel bigquery emulator", "invalidQuery");
    }

    // COUNT(*) aggregate
    if (/^\s*COUNT\s*\(\s*\*\s*\)/i.test(selectPart)) {
      const aliasMatch = /AS\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(selectPart);
      const alias = aliasMatch ? aliasMatch[1] : "f0_";
      const schema = { fields: [{ name: alias, type: "INTEGER", mode: "NULLABLE" }] };
      return { schema, rows: [{ [alias]: rows.length }], statementType: "SELECT" };
    }

    // ORDER BY
    const orderMatch = /\bORDER\s+BY\b(.+?)(\bLIMIT\b|$)/is.exec(clauses);
    if (orderMatch) {
      const spec = orderMatch[1].trim();
      const parts = spec.split(",").map((s) => s.trim());
      rows.sort((a, b) => {
        for (const part of parts) {
          const m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(ASC|DESC)?$/i.exec(part);
          if (!m) continue;
          const col = m[1];
          const desc = (m[2] || "ASC").toUpperCase() === "DESC";
          const av = a[col];
          const bv = b[col];
          let cmp;
          if (av === bv) cmp = 0;
          else if (av === null || av === undefined) cmp = -1;
          else if (bv === null || bv === undefined) cmp = 1;
          else cmp = av < bv ? -1 : 1;
          if (cmp !== 0) return desc ? -cmp : cmp;
        }
        return 0;
      });
    }

    // LIMIT
    const limitMatch = /\bLIMIT\b\s+(\d+)/i.exec(clauses);
    if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1], 10));

    // Projection
    let schema;
    let projected;
    if (selectPart === "*") {
      schema = { fields: fields.length ? fields : this.inferSchema(rows) };
      projected = rows;
    } else {
      const cols = this.parseSelectColumns(selectPart);
      schema = {
        fields: cols.map((c) => {
          const sf = fields.find((f) => f.name === c.name);
          return { name: c.alias, type: (sf && sf.type) || "STRING", mode: (sf && sf.mode) || "NULLABLE" };
        }),
      };
      projected = rows.map((r) => {
        const out = {};
        for (const c of cols) out[c.alias] = r[c.name];
        return out;
      });
    }
    return { schema, rows: projected, statementType: "SELECT" };
  }

  parseSelectColumns(selectPart) {
    return selectPart.split(",").map((raw) => {
      const s = raw.trim();
      const asMatch = /^(.+?)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(s);
      if (asMatch) return { name: this.stripIdent(asMatch[1].trim()), alias: asMatch[2] };
      const ident = this.stripIdent(s);
      return { name: ident, alias: ident };
    });
  }

  stripIdent(s) {
    return s.replace(/^`|`$/g, "").trim();
  }

  evalLiteralSelect(text) {
    const selectPart = text.slice("SELECT".length).trim();
    const cols = selectPart.split(",").map((raw, i) => {
      const s = raw.trim();
      const asMatch = /^(.+?)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(s);
      const expr = asMatch ? asMatch[1].trim() : s;
      const alias = asMatch ? asMatch[2] : `f${i}_`;
      return { expr, alias };
    });
    const fields = [];
    const row = {};
    for (const c of cols) {
      const { value, type } = this.evalLiteral(c.expr);
      fields.push({ name: c.alias, type, mode: "NULLABLE" });
      row[c.alias] = value;
    }
    return { schema: { fields }, rows: [row], statementType: "SELECT" };
  }

  evalLiteral(expr) {
    const e = expr.trim();
    if (/^-?\d+$/.test(e)) return { value: parseInt(e, 10), type: "INTEGER" };
    if (/^-?\d*\.\d+$/.test(e)) return { value: parseFloat(e), type: "FLOAT" };
    if (/^(TRUE|FALSE)$/i.test(e)) return { value: /^TRUE$/i.test(e), type: "BOOLEAN" };
    if (/^NULL$/i.test(e)) return { value: null, type: "STRING" };
    const str = /^'([^']*)'$/.exec(e) || /^"([^"]*)"$/.exec(e);
    if (str) return { value: str[1], type: "STRING" };
    // Fallback: treat as opaque string.
    return { value: e, type: "STRING" };
  }

  evalWhere(cond, row) {
    // Support AND-separated simple comparisons: col OP value
    const clauses = cond.split(/\bAND\b/i).map((c) => c.trim());
    return clauses.every((c) => this.evalComparison(c, row));
  }

  evalComparison(c, row) {
    const m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(>=|<=|!=|<>|=|>|<)\s*(.+)$/.exec(c.trim());
    if (!m) {
      // IS NULL / IS NOT NULL
      const nullM = /^([A-Za-z_][A-Za-z0-9_.]*)\s+IS\s+(NOT\s+)?NULL$/i.exec(c.trim());
      if (nullM) {
        const v = row[nullM[1]];
        const isNull = v === null || v === undefined;
        return nullM[2] ? !isNull : isNull;
      }
      return true;
    }
    const col = m[1];
    const op = m[2];
    const rhs = this.evalLiteral(m[3]).value;
    const lhs = row[col];
    switch (op) {
      case "=":
        return lhs == rhs;
      case "!=":
      case "<>":
        return lhs != rhs;
      case ">":
        return lhs > rhs;
      case "<":
        return lhs < rhs;
      case ">=":
        return lhs >= rhs;
      case "<=":
        return lhs <= rhs;
      default:
        return false;
    }
  }

  substituteParams(text, params) {
    if (!params) return text;
    let out = text;
    // Named: @name
    out = out.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => {
      if (params.named && name in params.named) return this.sqlLiteral(params.named[name]);
      return whole;
    });
    // Positional: ?
    if (params.positional && params.positional.length) {
      let i = 0;
      out = out.replace(/\?/g, () => {
        const v = params.positional[i];
        i += 1;
        return this.sqlLiteral(v);
      });
    }
    return out;
  }

  sqlLiteral(v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (Array.isArray(v)) return `[${v.map((x) => this.sqlLiteral(x)).join(", ")}]`;
    return `'${String(v).replace(/'/g, "\\'")}'`;
  }

  resolveTable(projectId, ref) {
    let raw = this.stripIdent(ref);
    // Forms: project.dataset.table | dataset.table | project:dataset.table
    raw = raw.replace(":", ".");
    const parts = raw.split(".").map((p) => p.trim()).filter(Boolean);
    let datasetId;
    let tableId;
    if (parts.length === 3) {
      datasetId = parts[1];
      tableId = parts[2];
    } else if (parts.length === 2) {
      datasetId = parts[0];
      tableId = parts[1];
    } else {
      throw new ApiError(400, `Invalid table reference: ${ref}`, "invalid");
    }
    const ds = this.datasets.get(datasetId);
    if (!ds) throw new ApiError(404, `Not found: Dataset ${projectId}:${datasetId}`, "notFound");
    const table = ds._tables.get(tableId);
    if (!table) throw new ApiError(404, `Not found: Table ${projectId}:${datasetId}.${tableId}`, "notFound");
    return table;
  }

  findKeyword(text, kw) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    const m = re.exec(text);
    return m ? m.index : -1;
  }

  findFirstClause(remainder) {
    const re = /\b(WHERE|ORDER\s+BY|LIMIT|GROUP\s+BY)\b/i;
    const m = re.exec(remainder);
    return m ? m.index : -1;
  }

  inferSchema(rows) {
    const fields = [];
    const seen = new Set();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (seen.has(k)) continue;
        seen.add(k);
        fields.push({ name: k, type: this.inferType(r[k]), mode: "NULLABLE" });
      }
    }
    return fields;
  }

  inferType(v) {
    if (typeof v === "number") return Number.isInteger(v) ? "INTEGER" : "FLOAT";
    if (typeof v === "boolean") return "BOOLEAN";
    return "STRING";
  }

  // -------------------------------------------------------------------------
  // Row encoding: convert a plain JS row object into BigQuery's { f: [{v}] }
  // wire representation, ordered by the schema fields. Values are stringified
  // (BigQuery returns all scalar cell values as strings).
  // -------------------------------------------------------------------------
  rowToCells(row, fields) {
    const fieldList = fields && fields.length ? fields : this.inferSchema([row]);
    return {
      f: fieldList.map((field) => ({ v: this.cellValue(row[field.name], field) })),
    };
  }

  cellValue(value, field) {
    if (value === null || value === undefined) return null;
    const mode = field && field.mode;
    if (mode === "REPEATED" && Array.isArray(value)) {
      return value.map((el) => ({ v: this.scalarCell(el, field) }));
    }
    return this.scalarCell(value, field);
  }

  scalarCell(value, field) {
    if (value === null || value === undefined) return null;
    const type = field && field.type;
    if ((type === "RECORD" || type === "STRUCT") && typeof value === "object") {
      const sub = field.fields || [];
      return this.rowToCells(value, sub);
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  // -------------------------------------------------------------------------
  // Resource serializers
  // -------------------------------------------------------------------------
  datasetResource(ds) {
    return {
      kind: "bigquery#dataset",
      etag: ds.etag,
      id: ds.id,
      selfLink: ds.selfLink,
      datasetReference: ds.datasetReference,
      friendlyName: ds.friendlyName,
      description: ds.description,
      labels: ds.labels,
      location: ds.location,
      defaultTableExpirationMs: ds.defaultTableExpirationMs,
      access: ds.access,
      creationTime: ds.creationTime,
      lastModifiedTime: ds.lastModifiedTime,
    };
  }

  tableResource(t, full) {
    const r = {
      kind: "bigquery#table",
      etag: t.etag,
      id: t.id,
      selfLink: t.selfLink,
      tableReference: t.tableReference,
      friendlyName: t.friendlyName,
      description: t.description,
      labels: t.labels,
      type: t.type,
      numRows: String(t._rows.length),
      numBytes: t.numBytes,
      creationTime: t.creationTime,
      lastModifiedTime: String(Date.now()),
    };
    if (full) {
      r.schema = t.schema;
      if (t.view) r.view = t.view;
      if (t.timePartitioning) r.timePartitioning = t.timePartitioning;
      if (t.rangePartitioning) r.rangePartitioning = t.rangePartitioning;
      if (t.clustering) r.clustering = t.clustering;
      if (t.expirationTime) r.expirationTime = t.expirationTime;
    }
    return r;
  }

  modelResource(m) {
    return {
      etag: m.etag,
      modelReference: m.modelReference,
      modelType: m.modelType,
      friendlyName: m.friendlyName,
      description: m.description,
      labels: m.labels,
      creationTime: m.creationTime,
      lastModifiedTime: m.lastModifiedTime,
      expirationTime: m.expirationTime,
    };
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------
  getDataset(projectId, datasetId) {
    const ds = this.datasets.get(datasetId);
    if (!ds) throw new ApiError(404, `Not found: Dataset ${projectId}:${datasetId}`, "notFound");
    return ds;
  }

  getTable(ds, tableId) {
    const t = ds._tables.get(tableId);
    if (!t) throw new ApiError(404, `Not found: Table ${ds.id}.${tableId}`, "notFound");
    return t;
  }

  etag() {
    return randomBytes(12).toString("base64");
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    if (res.__captured) return; // internal synthetic response (load/copy table create)
    const data = JSON.stringify(obj);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(data);
  }

  sendNoContent(res) {
    res.statusCode = 204;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end("");
  }

  sendError(res, apiError) {
    const payload = {
      error: {
        code: apiError.code,
        message: apiError.message,
        status: apiError.status,
        errors: [
          {
            message: apiError.message,
            domain: "global",
            reason: apiError.reason,
          },
        ],
      },
    };
    res.statusCode = apiError.code;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(payload));
  }
}

export default BigqueryServer;
