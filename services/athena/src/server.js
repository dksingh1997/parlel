// parlel/athena — dependency-free fake of Amazon Athena.
//
// AWS JSON 1.1 protocol, target prefix `AmazonAthena`. State is in-memory and
// ephemeral. Ships a trivial query engine that resolves `SELECT <literal>`.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidRequestException: 400,
  ResourceNotFoundException: 400,
  InternalServerException: 500,
  TooManyRequestsException: 400,
};

class AthenaError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class AthenaServer {
  constructor(port = 4723, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.executions = new Map(); // id -> execution
    this.workGroups = new Map();
    this.namedQueries = new Map();
    this.workGroups.set("primary", {
      Name: "primary",
      State: "ENABLED",
      Description: "Default workgroup",
      CreationTime: Math.floor(Date.now() / 1000),
      Configuration: {},
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new AthenaError("InternalServerException", error.message, 500));
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "athena",
        executions: this.executions.size,
        workGroups: this.workGroups.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    if (method !== "POST") {
      return this.sendError(res, new AthenaError("InvalidRequestException", "Only POST supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;
    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new AthenaError("InvalidRequestException", "Invalid JSON.", 400));
    }

    try {
      return this.sendJson(res, 200, this.dispatch(operation, input) ?? {});
    } catch (error) {
      if (error instanceof AthenaError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "StartQueryExecution":
        return this.startQueryExecution(input);
      case "GetQueryExecution":
        return this.getQueryExecution(input);
      case "GetQueryResults":
        return this.getQueryResults(input);
      case "StopQueryExecution":
        return this.stopQueryExecution(input);
      case "ListQueryExecutions":
        return this.listQueryExecutions(input);
      case "CreateWorkGroup":
        return this.createWorkGroup(input);
      case "ListWorkGroups":
        return this.listWorkGroups(input);
      case "GetWorkGroup":
        return this.getWorkGroup(input);
      case "CreateNamedQuery":
        return this.createNamedQuery(input);
      case "ListNamedQueries":
        return this.listNamedQueries(input);
      case "GetNamedQuery":
        return this.getNamedQuery(input);
      default:
        throw new AthenaError("InvalidRequestException", `Unsupported operation: ${operation}`);
    }
  }

  // Compute a trivial result set for SELECT <literal[, ...]>.
  computeResult(sql) {
    const trimmed = String(sql || "").trim().replace(/;$/, "");
    const m = trimmed.match(/^SELECT\s+([\s\S]+?)(\s+FROM\s+[\s\S]+)?$/i);
    if (!m) {
      return { columns: [{ name: "_col0", type: "varchar" }], rows: [["ok"]] };
    }
    if (m[2]) {
      // SELECT ... FROM <table>: return one demo row.
      return {
        columns: [{ name: "col0", type: "varchar" }, { name: "col1", type: "varchar" }],
        rows: [
          ["row1-a", "row1-b"],
          ["row2-a", "row2-b"],
        ],
      };
    }
    const exprs = m[1].split(",").map((e) => e.trim());
    const columns = exprs.map((_, i) => ({ name: `_col${i}`, type: "integer" }));
    const row = exprs.map((e) => {
      const lit = e.replace(/^'(.*)'$/, "$1");
      return lit;
    });
    return { columns, rows: [row] };
  }

  startQueryExecution(input) {
    if (!input.QueryString) {
      throw new AthenaError("InvalidRequestException", "QueryString is required.");
    }
    const id = randomUUID();
    const result = this.computeResult(input.QueryString);
    const now = Math.floor(Date.now() / 1000);
    this.executions.set(id, {
      QueryExecutionId: id,
      Query: input.QueryString,
      StatementType: input.QueryString.trim().toUpperCase().startsWith("SELECT") ? "DML" : "DDL",
      ResultConfiguration: input.ResultConfiguration || {
        OutputLocation: `s3://parlel-athena-results/${id}/`,
      },
      QueryExecutionContext: input.QueryExecutionContext || {},
      WorkGroup: input.WorkGroup || "primary",
      Status: {
        State: "SUCCEEDED",
        SubmissionDateTime: now,
        CompletionDateTime: now,
      },
      Statistics: {
        EngineExecutionTimeInMillis: 12,
        DataScannedInBytes: 0,
        TotalExecutionTimeInMillis: 12,
      },
      _result: result,
    });
    return { QueryExecutionId: id };
  }

  requireExecution(id) {
    const e = this.executions.get(id);
    if (!e) throw new AthenaError("InvalidRequestException", `QueryExecution ${id} not found.`);
    return e;
  }

  getQueryExecution(input) {
    const e = this.requireExecution(input.QueryExecutionId);
    const { _result, ...rest } = e;
    return { QueryExecution: rest };
  }

  getQueryResults(input) {
    const e = this.requireExecution(input.QueryExecutionId);
    const result = e._result;
    const headerRow = {
      Data: result.columns.map((c) => ({ VarCharValue: c.name })),
    };
    const dataRows = result.rows.map((r) => ({
      Data: r.map((v) => (v === null || v === undefined ? {} : { VarCharValue: String(v) })),
    }));
    return {
      ResultSet: {
        Rows: [headerRow, ...dataRows],
        ResultSetMetadata: {
          ColumnInfo: result.columns.map((c) => ({
            Name: c.name,
            Label: c.name,
            Type: c.type,
            Nullable: "NULLABLE",
          })),
        },
      },
      UpdateCount: 0,
    };
  }

  stopQueryExecution(input) {
    const e = this.requireExecution(input.QueryExecutionId);
    e.Status.State = "CANCELLED";
    return {};
  }

  listQueryExecutions(input) {
    let list = [...this.executions.keys()];
    if (input.WorkGroup) {
      list = [...this.executions.values()]
        .filter((e) => e.WorkGroup === input.WorkGroup)
        .map((e) => e.QueryExecutionId);
    }
    return { QueryExecutionIds: list };
  }

  createWorkGroup(input) {
    const name = input.Name;
    if (!name) throw new AthenaError("InvalidRequestException", "Name is required.");
    if (this.workGroups.has(name)) {
      throw new AthenaError("InvalidRequestException", `WorkGroup ${name} already exists.`);
    }
    this.workGroups.set(name, {
      Name: name,
      State: "ENABLED",
      Description: input.Description || "",
      CreationTime: Math.floor(Date.now() / 1000),
      Configuration: input.Configuration || {},
    });
    return {};
  }

  listWorkGroups() {
    return {
      WorkGroups: [...this.workGroups.values()].map((w) => ({
        Name: w.Name,
        State: w.State,
        Description: w.Description,
        CreationTime: w.CreationTime,
      })),
    };
  }

  getWorkGroup(input) {
    const w = this.workGroups.get(input.WorkGroup);
    if (!w) throw new AthenaError("InvalidRequestException", `WorkGroup ${input.WorkGroup} not found.`);
    return { WorkGroup: w };
  }

  createNamedQuery(input) {
    const id = randomUUID();
    this.namedQueries.set(id, {
      NamedQueryId: id,
      Name: input.Name,
      Description: input.Description,
      Database: input.Database,
      QueryString: input.QueryString,
      WorkGroup: input.WorkGroup || "primary",
    });
    return { NamedQueryId: id };
  }

  listNamedQueries(input) {
    let list = [...this.namedQueries.values()];
    if (input.WorkGroup) list = list.filter((q) => q.WorkGroup === input.WorkGroup);
    return { NamedQueryIds: list.map((q) => q.NamedQueryId) };
  }

  getNamedQuery(input) {
    const q = this.namedQueries.get(input.NamedQueryId);
    if (!q) throw new AthenaError("InvalidRequestException", `NamedQuery ${input.NamedQueryId} not found.`);
    return { NamedQuery: q };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerException";
    res.statusCode = error.status || ERROR_STATUS[code] || 400;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code }));
  }
}

export default AthenaServer;
