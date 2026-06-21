// parlel/backup — a lightweight, dependency-free fake of AWS Backup.
// Speaks the REST/JSON API. Pure Node.js, no external npm deps.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class BackupError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class BackupServer {
  constructor(port = 4741, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.vaults = new Map();
    this.plans = new Map();
    // selections: Map<planId, Map<selectionId, selection>>
    this.selections = new Map();
    this.jobs = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new BackupError("InternalServiceException", error.message, 500));
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

  vaultArn(name) {
    return `arn:aws:backup:${this.region}:${this.accountId}:backup-vault:${name}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "backup",
        vaults: this.vaults.size,
        plans: this.plans.size,
        jobs: this.jobs.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-backup");

    const bodyBuf = await this.readBody(req);
    let body = {};
    if (bodyBuf.length) {
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        return this.sendError(res, new BackupError("InvalidRequestException", "Invalid JSON body."));
      }
    }

    try {
      return this.route(method, path, body, res);
    } catch (error) {
      if (error instanceof BackupError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, body, res) {
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent);

    // backup-vaults
    if (seg[0] === "backup-vaults") {
      if (seg.length === 1 && method === "GET") return this.sendJson(res, 200, this.listVaults());
      if (seg.length === 2) {
        const name = seg[1];
        if (method === "PUT") return this.sendJson(res, 200, this.createVault(name, body));
        if (method === "GET") return this.sendJson(res, 200, this.describeVault(name));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteVault(name));
      }
    }
    // backup/plans
    if (seg[0] === "backup" && seg[1] === "plans") {
      if (seg.length === 2) {
        if (method === "PUT" || method === "POST") return this.sendJson(res, 200, this.createPlan(body));
        if (method === "GET") return this.sendJson(res, 200, this.listPlans());
      }
      if (seg.length === 3) {
        const planId = seg[2];
        if (method === "GET") return this.sendJson(res, 200, this.getPlan(planId));
      }
      if (seg.length === 4 && seg[3] === "selections") {
        const planId = seg[2];
        if (method === "PUT" || method === "POST") return this.sendJson(res, 200, this.createSelection(planId, body));
        if (method === "GET") return this.sendJson(res, 200, this.listSelections(planId));
      }
    }
    // backup-jobs
    if (seg[0] === "backup-jobs") {
      if (seg.length === 1) {
        if (method === "PUT" || method === "POST") return this.sendJson(res, 200, this.startJob(body));
        if (method === "GET") return this.sendJson(res, 200, this.listJobs());
      }
      if (seg.length === 2 && method === "GET") {
        return this.sendJson(res, 200, this.describeJob(seg[1]));
      }
    }
    throw new BackupError("InvalidRequestException", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  // Vaults
  // -------------------------------------------------------------------------
  createVault(name, body) {
    if (this.vaults.has(name)) {
      throw new BackupError("AlreadyExistsException", `Backup vault ${name} already exists.`, 400);
    }
    const arn = this.vaultArn(name);
    const vault = {
      BackupVaultName: name,
      BackupVaultArn: arn,
      CreationDate: Date.now() / 1000,
      EncryptionKeyArn: body.EncryptionKeyArn,
      NumberOfRecoveryPoints: 0,
      Locked: false,
      Tags: body.BackupVaultTags || {},
    };
    this.vaults.set(name, vault);
    return { BackupVaultName: name, BackupVaultArn: arn, CreationDate: vault.CreationDate };
  }

  requireVault(name) {
    const v = this.vaults.get(name);
    if (!v) throw new BackupError("ResourceNotFoundException", `Backup vault ${name} not found.`, 400);
    return v;
  }

  describeVault(name) {
    const v = this.requireVault(name);
    return {
      BackupVaultName: v.BackupVaultName,
      BackupVaultArn: v.BackupVaultArn,
      CreationDate: v.CreationDate,
      EncryptionKeyArn: v.EncryptionKeyArn,
      NumberOfRecoveryPoints: v.NumberOfRecoveryPoints,
      Locked: v.Locked,
    };
  }

  listVaults() {
    return {
      BackupVaultList: [...this.vaults.values()].map((v) => ({
        BackupVaultName: v.BackupVaultName,
        BackupVaultArn: v.BackupVaultArn,
        CreationDate: v.CreationDate,
        NumberOfRecoveryPoints: v.NumberOfRecoveryPoints,
        Locked: v.Locked,
      })),
    };
  }

  deleteVault(name) {
    this.requireVault(name);
    this.vaults.delete(name);
    return {};
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------
  createPlan(body) {
    const plan = body.BackupPlan;
    if (!plan || !plan.BackupPlanName) {
      throw new BackupError("InvalidParameterValueException", "BackupPlan.BackupPlanName is required.");
    }
    const id = randomUUID();
    const arn = `arn:aws:backup:${this.region}:${this.accountId}:backup-plan:${id}`;
    const versionId = Buffer.from(randomUUID()).toString("base64").slice(0, 40);
    const now = Date.now() / 1000;
    this.plans.set(id, {
      BackupPlanId: id,
      BackupPlanArn: arn,
      VersionId: versionId,
      CreationDate: now,
      BackupPlan: plan,
    });
    this.selections.set(id, new Map());
    return {
      BackupPlanId: id,
      BackupPlanArn: arn,
      CreationDate: now,
      VersionId: versionId,
    };
  }

  requirePlan(id) {
    const p = this.plans.get(id);
    if (!p) throw new BackupError("ResourceNotFoundException", `Backup plan ${id} not found.`, 400);
    return p;
  }

  getPlan(id) {
    const p = this.requirePlan(id);
    return {
      BackupPlan: p.BackupPlan,
      BackupPlanId: p.BackupPlanId,
      BackupPlanArn: p.BackupPlanArn,
      VersionId: p.VersionId,
      CreationDate: p.CreationDate,
    };
  }

  listPlans() {
    return {
      BackupPlansList: [...this.plans.values()].map((p) => ({
        BackupPlanId: p.BackupPlanId,
        BackupPlanArn: p.BackupPlanArn,
        BackupPlanName: p.BackupPlan.BackupPlanName,
        VersionId: p.VersionId,
        CreationDate: p.CreationDate,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Selections
  // -------------------------------------------------------------------------
  createSelection(planId, body) {
    this.requirePlan(planId);
    const sel = body.BackupSelection;
    if (!sel || !sel.SelectionName) {
      throw new BackupError("InvalidParameterValueException", "BackupSelection.SelectionName is required.");
    }
    const id = randomUUID();
    this.selections.get(planId).set(id, {
      SelectionId: id,
      BackupPlanId: planId,
      CreationDate: Date.now() / 1000,
      BackupSelection: sel,
    });
    return { SelectionId: id, BackupPlanId: planId, CreationDate: Date.now() / 1000 };
  }

  listSelections(planId) {
    this.requirePlan(planId);
    return {
      BackupSelectionsList: [...this.selections.get(planId).values()].map((s) => ({
        SelectionId: s.SelectionId,
        BackupPlanId: s.BackupPlanId,
        SelectionName: s.BackupSelection.SelectionName,
        IamRoleArn: s.BackupSelection.IamRoleArn,
        CreationDate: s.CreationDate,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------
  startJob(body) {
    if (!body.BackupVaultName) {
      throw new BackupError("InvalidParameterValueException", "BackupVaultName is required.");
    }
    this.requireVault(body.BackupVaultName);
    if (!body.ResourceArn) {
      throw new BackupError("InvalidParameterValueException", "ResourceArn is required.");
    }
    const id = randomUUID();
    const now = Date.now() / 1000;
    const rpArn = `arn:aws:backup:${this.region}:${this.accountId}:recovery-point:${randomUUID()}`;
    const job = {
      BackupJobId: id,
      BackupVaultName: body.BackupVaultName,
      BackupVaultArn: this.vaultArn(body.BackupVaultName),
      ResourceArn: body.ResourceArn,
      ResourceType: body.ResourceType || this.resourceTypeFromArn(body.ResourceArn),
      IamRoleArn: body.IamRoleArn,
      State: "COMPLETED",
      StatusMessage: "",
      PercentDone: "100.0",
      CreationDate: now,
      CompletionDate: now,
      RecoveryPointArn: rpArn,
      BackupSizeInBytes: 1024,
    };
    this.jobs.set(id, job);
    const v = this.vaults.get(body.BackupVaultName);
    if (v) v.NumberOfRecoveryPoints += 1;
    return { BackupJobId: id, CreationDate: now, RecoveryPointArn: rpArn };
  }

  resourceTypeFromArn(arn) {
    if (typeof arn !== "string") return "EBS";
    if (arn.includes(":dynamodb:")) return "DynamoDB";
    if (arn.includes(":rds:")) return "RDS";
    if (arn.includes(":ec2:") && arn.includes("volume")) return "EBS";
    if (arn.includes(":s3:")) return "S3";
    return "EBS";
  }

  describeJob(id) {
    const j = this.jobs.get(id);
    if (!j) throw new BackupError("ResourceNotFoundException", `Backup job ${id} not found.`, 400);
    return { ...j };
  }

  listJobs() {
    return {
      BackupJobs: [...this.jobs.values()].map((j) => ({
        BackupJobId: j.BackupJobId,
        BackupVaultName: j.BackupVaultName,
        BackupVaultArn: j.BackupVaultArn,
        ResourceArn: j.ResourceArn,
        ResourceType: j.ResourceType,
        State: j.State,
        PercentDone: j.PercentDone,
        CreationDate: j.CreationDate,
        CompletionDate: j.CompletionDate,
        RecoveryPointArn: j.RecoveryPointArn,
        BackupSizeInBytes: j.BackupSizeInBytes,
      })),
    };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", error.code || "InvalidRequestException");
    res.end(JSON.stringify({ __type: error.code, Message: error.message, message: error.message }));
  }
}

export default BackupServer;
