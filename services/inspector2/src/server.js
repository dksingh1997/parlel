// parlel/inspector2 — a lightweight, dependency-free fake of AWS Inspector2.
//
// Speaks the REST/JSON wire protocol used by the real `@aws-sdk/client-inspector2`
// client. Operations map to POST paths like /findings/list, /coverage/list,
// /filters/create, /filters/list, /enable, /disable. Pure Node.js.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/json";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ResourceNotFoundException: 404,
  ValidationException: 400,
  AccessDeniedException: 403,
  InternalServerException: 500,
  ThrottlingException: 429,
  ConflictException: 409,
};

class InspectorError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class Inspector2Server {
  constructor(port = 4735, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.filters = new Map(); // arn -> filter
    this.accountStatus = {
      EC2: "DISABLED",
      ECR: "DISABLED",
      LAMBDA: "DISABLED",
    };
    this.seedFindings();
    this.seedCoverage();
  }

  seedFindings() {
    const now = Date.now();
    this.findings = [
      {
        findingArn: `arn:aws:inspector2:${this.region}:${this.accountId}:finding/${randomUUID()}`,
        awsAccountId: this.accountId,
        type: "PACKAGE_VULNERABILITY",
        severity: "HIGH",
        status: "ACTIVE",
        title: "CVE-2023-1234 - openssl",
        description: "A vulnerability in openssl allows remote code execution.",
        firstObservedAt: Math.floor((now - 86400000) / 1000),
        lastObservedAt: Math.floor(now / 1000),
        updatedAt: Math.floor(now / 1000),
        remediation: { recommendation: { text: "Update openssl to the latest version." } },
        resources: [
          { type: "AWS_EC2_INSTANCE", id: "i-0123456789abcdef0", partition: "aws", region: this.region },
        ],
        packageVulnerabilityDetails: {
          vulnerabilityId: "CVE-2023-1234",
          source: "NVD",
          vulnerablePackages: [{ name: "openssl", version: "1.1.1", fixedInVersion: "1.1.1t" }],
        },
      },
      {
        findingArn: `arn:aws:inspector2:${this.region}:${this.accountId}:finding/${randomUUID()}`,
        awsAccountId: this.accountId,
        type: "NETWORK_REACHABILITY",
        severity: "MEDIUM",
        status: "ACTIVE",
        title: "Port 22 reachable from internet",
        description: "SSH port reachable from 0.0.0.0/0.",
        firstObservedAt: Math.floor((now - 43200000) / 1000),
        lastObservedAt: Math.floor(now / 1000),
        updatedAt: Math.floor(now / 1000),
        resources: [
          { type: "AWS_EC2_INSTANCE", id: "i-0fedcba9876543210", partition: "aws", region: this.region },
        ],
      },
    ];
  }

  seedCoverage() {
    this.coverage = [
      {
        accountId: this.accountId,
        resourceId: "i-0123456789abcdef0",
        resourceType: "AWS_EC2_INSTANCE",
        scanType: "PACKAGE",
        scanStatus: { statusCode: "ACTIVE", reason: "SUCCESSFUL" },
      },
      {
        accountId: this.accountId,
        resourceId: "repo/my-app",
        resourceType: "AWS_ECR_REPOSITORY",
        scanType: "PACKAGE",
        scanStatus: { statusCode: "ACTIVE", reason: "SUCCESSFUL" },
      },
    ];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new InspectorError("InternalServerException", error.message, 500));
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
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "inspector2", filters: this.filters.size });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-inspector2");

    const body = await this.readBody(req);
    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new InspectorError("ValidationException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = this.route(method, path, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof InspectorError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, input) {
    const key = `${method} ${path}`;
    switch (key) {
      case "POST /findings/list": return this.listFindings(input);
      case "POST /coverage/list": return this.listCoverage(input);
      case "POST /filters/create": return this.createFilter(input);
      case "POST /filters/list": return this.listFilters(input);
      case "POST /filters/delete": return this.deleteFilter(input);
      case "POST /enable": return this.enable(input);
      case "POST /disable": return this.disable(input);
      case "POST /status/batch/get": return this.batchGetAccountStatus(input);
      case "POST /accountstatus/batch/get": return this.batchGetAccountStatus(input);
      default:
        throw new InspectorError("ValidationException", `No route for ${key}.`, 400);
    }
  }

  listFindings(input = {}) {
    let findings = this.findings.slice();
    const criteria = input.filterCriteria || {};
    if (criteria.severity && criteria.severity.length) {
      const allowed = new Set(criteria.severity.map((s) => s.value));
      findings = findings.filter((f) => allowed.has(f.severity));
    }
    if (criteria.findingType && criteria.findingType.length) {
      const allowed = new Set(criteria.findingType.map((s) => s.value));
      findings = findings.filter((f) => allowed.has(f.type));
    }
    return { findings };
  }

  listCoverage(input = {}) {
    return { coveredResources: this.coverage };
  }

  createFilter(input) {
    if (!input.name) throw new InspectorError("ValidationException", "name is required.");
    if (!input.action) throw new InspectorError("ValidationException", "action is required.");
    const id = randomUUID();
    const arn = `arn:aws:inspector2:${this.region}:${this.accountId}:owner/${this.accountId}/filter/${id}`;
    const now = Date.now();
    const filter = {
      arn,
      name: input.name,
      action: input.action,
      criteria: input.filterCriteria || {},
      description: input.description,
      reason: input.reason,
      createdAt: Math.floor(now / 1000),
      updatedAt: Math.floor(now / 1000),
      ownerId: this.accountId,
    };
    this.filters.set(arn, filter);
    return { arn };
  }

  listFilters(input = {}) {
    let all = [...this.filters.values()];
    if (input.arns && input.arns.length) {
      const set = new Set(input.arns);
      all = all.filter((f) => set.has(f.arn));
    }
    if (input.action) all = all.filter((f) => f.action === input.action);
    return {
      filters: all.map((f) => ({
        arn: f.arn,
        name: f.name,
        action: f.action,
        criteria: f.criteria,
        description: f.description,
        reason: f.reason,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        ownerId: f.ownerId,
      })),
    };
  }

  deleteFilter(input) {
    const arn = input.arn;
    if (!this.filters.has(arn)) {
      throw new InspectorError("ResourceNotFoundException", `Filter ${arn} not found.`);
    }
    this.filters.delete(arn);
    return { arn };
  }

  resourceTypes(input) {
    const types = input.resourceTypes || ["EC2", "ECR", "LAMBDA"];
    return types;
  }

  enable(input = {}) {
    const types = this.resourceTypes(input);
    const accounts = input.accountIds && input.accountIds.length ? input.accountIds : [this.accountId];
    for (const t of types) this.accountStatus[t] = "ENABLED";
    return {
      accounts: accounts.map((id) => ({
        accountId: id,
        resourceStatus: { ...this.accountStatus },
        status: "ENABLED",
      })),
      failedAccounts: [],
    };
  }

  disable(input = {}) {
    const types = this.resourceTypes(input);
    const accounts = input.accountIds && input.accountIds.length ? input.accountIds : [this.accountId];
    for (const t of types) this.accountStatus[t] = "DISABLED";
    return {
      accounts: accounts.map((id) => ({
        accountId: id,
        resourceStatus: { ...this.accountStatus },
        status: "DISABLED",
      })),
      failedAccounts: [],
    };
  }

  batchGetAccountStatus(input = {}) {
    const accounts = input.accountIds && input.accountIds.length ? input.accountIds : [this.accountId];
    const anyEnabled = Object.values(this.accountStatus).some((v) => v === "ENABLED");
    return {
      accounts: accounts.map((id) => ({
        accountId: id,
        state: { status: anyEnabled ? "ENABLED" : "DISABLED" },
        resourceState: {
          ec2: { status: this.accountStatus.EC2 },
          ecr: { status: this.accountStatus.ECR },
          lambda: { status: this.accountStatus.LAMBDA },
        },
      })),
      failedAccounts: [],
    };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default Inspector2Server;
