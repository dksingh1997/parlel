// parlel/cost-usage-reports — a lightweight, dependency-free fake of
// AWS Cost and Usage Report Service (CUR).
//
// Speaks AWS JSON 1.1 (X-Amz-Target: AWSOrigamiServiceGatewayService.<Op>).
// Pure Node.js.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  DuplicateReportNameException: 400,
  ReportLimitReachedException: 400,
  ValidationException: 400,
  InternalErrorException: 500,
  ResourceNotFoundException: 404,
};

class CurError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class CostUsageReportsServer {
  constructor(port = 4737, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.reports = new Map(); // ReportName -> definition
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new CurError("InternalErrorException", error.message, 500));
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

  requestId() {
    return randomUUID();
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "cost-usage-reports", reports: this.reports.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-cost-usage-reports");

    if (method !== "POST") {
      return this.sendError(res, new CurError("ValidationException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new CurError("ValidationException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof CurError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "PutReportDefinition": return this.putReportDefinition(input);
      case "DescribeReportDefinitions": return this.describeReportDefinitions(input);
      case "DeleteReportDefinition": return this.deleteReportDefinition(input);
      case "ModifyReportDefinition": return this.modifyReportDefinition(input);
      case "ListTagsForResource": return this.listTagsForResource(input);
      default:
        throw new CurError("ValidationException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  validateDefinition(def) {
    if (!def) throw new CurError("ValidationException", "ReportDefinition is required.");
    if (!def.ReportName) throw new CurError("ValidationException", "ReportName is required.");
    if (!def.S3Bucket) throw new CurError("ValidationException", "S3Bucket is required.");
    if (!def.TimeUnit) throw new CurError("ValidationException", "TimeUnit is required.");
  }

  normalizeDefinition(def) {
    return {
      ReportName: def.ReportName,
      TimeUnit: def.TimeUnit,
      Format: def.Format || "textORcsv",
      Compression: def.Compression || "GZIP",
      AdditionalSchemaElements: def.AdditionalSchemaElements || ["RESOURCES"],
      S3Bucket: def.S3Bucket,
      S3Prefix: def.S3Prefix || "",
      S3Region: def.S3Region || this.region,
      AdditionalArtifacts: def.AdditionalArtifacts || [],
      RefreshClosedReports: def.RefreshClosedReports !== undefined ? def.RefreshClosedReports : true,
      ReportVersioning: def.ReportVersioning || "CREATE_NEW_REPORT",
      BillingViewArn: def.BillingViewArn,
    };
  }

  putReportDefinition(input) {
    const def = input.ReportDefinition;
    this.validateDefinition(def);
    if (this.reports.has(def.ReportName)) {
      throw new CurError("DuplicateReportNameException", `A report named ${def.ReportName} already exists.`);
    }
    const normalized = this.normalizeDefinition(def);
    normalized.tags = input.Tags || [];
    this.reports.set(def.ReportName, normalized);
    return {};
  }

  describeReportDefinitions() {
    return {
      ReportDefinitions: [...this.reports.values()].map((d) => {
        const { tags, ...rest } = d;
        return rest;
      }),
    };
  }

  deleteReportDefinition(input) {
    const name = input.ReportName;
    if (!name) throw new CurError("ValidationException", "ReportName is required.");
    const existed = this.reports.delete(name);
    return existed ? { ResponseMessage: `Report ${name} deleted.` } : {};
  }

  modifyReportDefinition(input) {
    const name = input.ReportName;
    const def = input.ReportDefinition;
    this.validateDefinition(def);
    if (!this.reports.has(name)) {
      throw new CurError("ResourceNotFoundException", `Report ${name} does not exist.`);
    }
    const normalized = this.normalizeDefinition(def);
    normalized.tags = this.reports.get(name).tags || [];
    // Allow rename via ReportDefinition.ReportName.
    this.reports.delete(name);
    this.reports.set(normalized.ReportName, normalized);
    return {};
  }

  listTagsForResource(input) {
    const name = (input.ReportName || (input.ResourceArn || "").split("/").pop());
    const report = this.reports.get(name);
    if (!report) throw new CurError("ResourceNotFoundException", `Report ${name} does not exist.`);
    return { Tags: report.tags || [] };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalErrorException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default CostUsageReportsServer;
