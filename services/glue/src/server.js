// parlel/glue — dependency-free fake of AWS Glue (Data Catalog + Jobs).
//
// AWS JSON 1.1 protocol, target prefix `AWSGlue`. State is in-memory and
// ephemeral.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  AlreadyExistsException: 400,
  EntityNotFoundException: 400,
  InvalidInputException: 400,
  InternalServiceException: 500,
};

class GlueError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class GlueServer {
  constructor(port = 4724, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.databases = new Map(); // name -> {Name, ...}
    this.tables = new Map(); // `${db}/${table}` -> table
    this.jobs = new Map(); // name -> job
    this.jobRuns = new Map(); // runId -> run
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new GlueError("InternalServiceException", error.message, 500));
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
        service: "glue",
        databases: this.databases.size,
        tables: this.tables.size,
        jobs: this.jobs.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    if (method !== "POST") {
      return this.sendError(res, new GlueError("InvalidInputException", "Only POST supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;
    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new GlueError("InvalidInputException", "Invalid JSON.", 400));
    }

    try {
      return this.sendJson(res, 200, this.dispatch(operation, input) ?? {});
    } catch (error) {
      if (error instanceof GlueError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateDatabase":
        return this.createDatabase(input);
      case "GetDatabases":
        return this.getDatabases(input);
      case "GetDatabase":
        return this.getDatabase(input);
      case "DeleteDatabase":
        return this.deleteDatabase(input);
      case "CreateTable":
        return this.createTable(input);
      case "GetTables":
        return this.getTables(input);
      case "GetTable":
        return this.getTable(input);
      case "DeleteTable":
        return this.deleteTable(input);
      case "CreateJob":
        return this.createJob(input);
      case "GetJobs":
        return this.getJobs(input);
      case "GetJob":
        return this.getJob(input);
      case "StartJobRun":
        return this.startJobRun(input);
      case "GetJobRun":
        return this.getJobRun(input);
      default:
        throw new GlueError("InvalidInputException", `Unsupported operation: ${operation}`);
    }
  }

  createDatabase(input) {
    const di = input.DatabaseInput || {};
    const name = di.Name;
    if (!name) throw new GlueError("InvalidInputException", "DatabaseInput.Name is required.");
    if (this.databases.has(name)) {
      throw new GlueError("AlreadyExistsException", `Database ${name} already exists.`);
    }
    this.databases.set(name, {
      Name: name,
      Description: di.Description,
      LocationUri: di.LocationUri,
      Parameters: di.Parameters || {},
      CreateTime: Math.floor(Date.now() / 1000),
      CatalogId: this.accountId,
    });
    return {};
  }

  getDatabases() {
    return { DatabaseList: [...this.databases.values()] };
  }

  getDatabase(input) {
    const db = this.databases.get(input.Name);
    if (!db) throw new GlueError("EntityNotFoundException", `Database ${input.Name} not found.`);
    return { Database: db };
  }

  deleteDatabase(input) {
    if (!this.databases.has(input.Name)) {
      throw new GlueError("EntityNotFoundException", `Database ${input.Name} not found.`);
    }
    this.databases.delete(input.Name);
    for (const key of [...this.tables.keys()]) {
      if (key.startsWith(`${input.Name}/`)) this.tables.delete(key);
    }
    return {};
  }

  createTable(input) {
    const dbName = input.DatabaseName;
    if (!this.databases.has(dbName)) {
      throw new GlueError("EntityNotFoundException", `Database ${dbName} not found.`);
    }
    const ti = input.TableInput || {};
    const name = ti.Name;
    const key = `${dbName}/${name}`;
    if (this.tables.has(key)) {
      throw new GlueError("AlreadyExistsException", `Table ${name} already exists.`);
    }
    this.tables.set(key, {
      Name: name,
      DatabaseName: dbName,
      Description: ti.Description,
      StorageDescriptor: ti.StorageDescriptor || {},
      PartitionKeys: ti.PartitionKeys || [],
      TableType: ti.TableType || "EXTERNAL_TABLE",
      Parameters: ti.Parameters || {},
      CreateTime: Math.floor(Date.now() / 1000),
      CatalogId: this.accountId,
    });
    return {};
  }

  getTables(input) {
    const dbName = input.DatabaseName;
    const list = [...this.tables.entries()]
      .filter(([key]) => key.startsWith(`${dbName}/`))
      .map(([, v]) => v);
    return { TableList: list };
  }

  getTable(input) {
    const key = `${input.DatabaseName}/${input.Name}`;
    const table = this.tables.get(key);
    if (!table) throw new GlueError("EntityNotFoundException", `Table ${input.Name} not found.`);
    return { Table: table };
  }

  deleteTable(input) {
    const key = `${input.DatabaseName}/${input.Name}`;
    if (!this.tables.has(key)) {
      throw new GlueError("EntityNotFoundException", `Table ${input.Name} not found.`);
    }
    this.tables.delete(key);
    return {};
  }

  createJob(input) {
    const name = input.Name;
    if (!name) throw new GlueError("InvalidInputException", "Name is required.");
    if (this.jobs.has(name)) {
      throw new GlueError("AlreadyExistsException", `Job ${name} already exists.`);
    }
    this.jobs.set(name, {
      Name: name,
      Description: input.Description,
      Role: input.Role,
      Command: input.Command || {},
      DefaultArguments: input.DefaultArguments || {},
      MaxRetries: input.MaxRetries || 0,
      GlueVersion: input.GlueVersion || "4.0",
      WorkerType: input.WorkerType,
      NumberOfWorkers: input.NumberOfWorkers,
      CreatedOn: Math.floor(Date.now() / 1000),
    });
    return { Name: name };
  }

  getJobs() {
    return { Jobs: [...this.jobs.values()] };
  }

  getJob(input) {
    const job = this.jobs.get(input.JobName);
    if (!job) throw new GlueError("EntityNotFoundException", `Job ${input.JobName} not found.`);
    return { Job: job };
  }

  startJobRun(input) {
    const job = this.jobs.get(input.JobName);
    if (!job) throw new GlueError("EntityNotFoundException", `Job ${input.JobName} not found.`);
    const id = `jr_${randomUUID().replace(/-/g, "")}`;
    this.jobRuns.set(id, {
      Id: id,
      JobName: input.JobName,
      Attempt: 0,
      JobRunState: "SUCCEEDED",
      Arguments: input.Arguments || {},
      StartedOn: Math.floor(Date.now() / 1000),
      CompletedOn: Math.floor(Date.now() / 1000),
      ExecutionTime: 5,
      GlueVersion: job.GlueVersion,
    });
    return { JobRunId: id };
  }

  getJobRun(input) {
    const run = this.jobRuns.get(input.RunId);
    if (!run) throw new GlueError("EntityNotFoundException", `JobRun ${input.RunId} not found.`);
    return { JobRun: run };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServiceException";
    res.statusCode = error.status || ERROR_STATUS[code] || 400;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code }));
  }
}

export default GlueServer;
