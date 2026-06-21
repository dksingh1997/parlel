// parlel/batch — a lightweight, dependency-free fake of AWS Batch. Batch uses
// the AWS REST-JSON protocol with fixed POST paths under /v1 (e.g.
// POST /v1/submitjob, POST /v1/describejobs). The real `@aws-sdk/client-batch`
// client works against it. Pure Node.js, in-memory state.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ClientException: 400,
  ServerException: 500,
};

class BatchError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class BatchServer {
  constructor(port = 4705, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.jobQueues = new Map(); // name -> queue
    this.jobDefinitions = new Map(); // name -> [revisions]
    this.jobs = new Map(); // jobId -> job
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new BatchError("ServerException", error.message, 500));
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
      return this.sendJson(res, 200, {
        status: "ok",
        service: "batch",
        jobQueues: this.jobQueues.size,
        jobs: this.jobs.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-batch");

    const body = await this.readBody(req);
    let input = {};
    if (body.length) {
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        return this.sendError(res, new BatchError("ClientException", "Body is not valid JSON.", 400));
      }
    }

    try {
      const output = this.route(method, path, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof BatchError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, input) {
    // Normalize: lowercase last segment under /v1/.
    const op = path.replace(/\/+$/, "").split("/").pop().toLowerCase();
    if (method !== "POST") {
      throw new BatchError("ClientException", `Unsupported method ${method} for ${path}`, 400);
    }
    switch (op) {
      case "createjobqueue":
        return this.createJobQueue(input);
      case "describejobqueues":
        return this.describeJobQueues(input);
      case "registerjobdefinition":
        return this.registerJobDefinition(input);
      case "describejobdefinitions":
        return this.describeJobDefinitions(input);
      case "submitjob":
        return this.submitJob(input);
      case "describejobs":
        return this.describeJobs(input);
      case "listjobs":
        return this.listJobs(input);
      case "canceljob":
        return this.cancelJob(input);
      default:
        throw new BatchError("ClientException", `No route for ${method} ${path}`, 404);
    }
  }

  // -------------------------------------------------------------------------
  // Job queues
  // -------------------------------------------------------------------------
  queueArn(name) {
    return `arn:aws:batch:${this.region}:${this.accountId}:job-queue/${name}`;
  }

  createJobQueue(input) {
    const name = input.jobQueueName;
    if (!name) throw new BatchError("ClientException", "jobQueueName is required.");
    if (input.priority === undefined || input.priority === null) throw new BatchError("ClientException", "priority is required.");
    const queue = {
      jobQueueName: name,
      jobQueueArn: this.queueArn(name),
      state: input.state || "ENABLED",
      status: "VALID",
      statusReason: "JobQueue is ready",
      priority: Number(input.priority),
      computeEnvironmentOrder: input.computeEnvironmentOrder || [],
      tags: input.tags || {},
    };
    this.jobQueues.set(name, queue);
    return { jobQueueName: name, jobQueueArn: queue.jobQueueArn };
  }

  describeJobQueues(input) {
    const refs = input.jobQueues;
    let queues = [...this.jobQueues.values()];
    if (Array.isArray(refs) && refs.length) {
      const wanted = new Set(refs.map((r) => (r.includes("/") ? r.split("/").pop() : r)));
      queues = queues.filter((q) => wanted.has(q.jobQueueName) || refs.includes(q.jobQueueArn));
    }
    return { jobQueues: queues };
  }

  // -------------------------------------------------------------------------
  // Job definitions
  // -------------------------------------------------------------------------
  registerJobDefinition(input) {
    const name = input.jobDefinitionName;
    if (!name) throw new BatchError("ClientException", "jobDefinitionName is required.");
    if (!input.type) throw new BatchError("ClientException", "type is required.");
    const revisions = this.jobDefinitions.get(name) || [];
    const revision = revisions.length + 1;
    const arn = `arn:aws:batch:${this.region}:${this.accountId}:job-definition/${name}:${revision}`;
    const def = {
      jobDefinitionName: name,
      jobDefinitionArn: arn,
      revision,
      status: "ACTIVE",
      type: input.type,
      containerProperties: input.containerProperties,
      nodeProperties: input.nodeProperties,
      platformCapabilities: input.platformCapabilities || ["EC2"],
      retryStrategy: input.retryStrategy,
      timeout: input.timeout,
      parameters: input.parameters || {},
      tags: input.tags || {},
    };
    revisions.push(def);
    this.jobDefinitions.set(name, revisions);
    return { jobDefinitionName: name, jobDefinitionArn: arn, revision };
  }

  resolveJobDefinition(ref) {
    if (!ref) return undefined;
    let name = ref;
    let revision;
    if (ref.includes("job-definition/")) name = ref.split("job-definition/").pop();
    if (name.includes(":")) {
      const parts = name.split(":");
      revision = Number(parts.pop());
      name = parts.join(":");
    }
    const revisions = this.jobDefinitions.get(name);
    if (!revisions || !revisions.length) return undefined;
    if (revision) return revisions.find((r) => r.revision === revision);
    return revisions[revisions.length - 1];
  }

  describeJobDefinitions(input) {
    let all = [];
    for (const revisions of this.jobDefinitions.values()) for (const r of revisions) all.push(r);
    if (input.jobDefinitionName) all = all.filter((d) => d.jobDefinitionName === input.jobDefinitionName);
    if (Array.isArray(input.jobDefinitions) && input.jobDefinitions.length) {
      const wanted = new Set(input.jobDefinitions);
      all = all.filter((d) => wanted.has(d.jobDefinitionArn) || wanted.has(`${d.jobDefinitionName}:${d.revision}`));
    }
    if (input.status) all = all.filter((d) => d.status === input.status);
    return { jobDefinitions: all };
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------
  submitJob(input) {
    const name = input.jobName;
    if (!name) throw new BatchError("ClientException", "jobName is required.");
    if (!input.jobDefinition) throw new BatchError("ClientException", "jobDefinition is required.");
    const queueName = input.jobQueue && input.jobQueue.includes("/") ? input.jobQueue.split("/").pop() : input.jobQueue;
    if (!queueName || !this.jobQueues.has(queueName)) {
      throw new BatchError("ClientException", `Job queue ${input.jobQueue} not found.`);
    }
    const def = this.resolveJobDefinition(input.jobDefinition);
    if (!def) {
      throw new BatchError("ClientException", `Job definition ${input.jobDefinition} not found.`);
    }
    const id = randomUUID();
    const now = Date.now();
    const job = {
      jobId: id,
      jobArn: `arn:aws:batch:${this.region}:${this.accountId}:job/${id}`,
      jobName: name,
      jobQueue: this.queueArn(queueName),
      jobQueueName: queueName,
      jobDefinition: def.jobDefinitionArn,
      status: "SUCCEEDED",
      statusReason: "Essential container in task exited",
      createdAt: now,
      startedAt: now,
      stoppedAt: now,
      attempts: [],
      dependsOn: input.dependsOn || [],
      parameters: input.parameters || {},
      container: def.containerProperties ? { ...def.containerProperties, exitCode: 0 } : { exitCode: 0 },
      tags: input.tags || {},
    };
    this.jobs.set(id, job);
    return { jobId: id, jobArn: job.jobArn, jobName: name };
  }

  jobView(j) {
    return {
      jobId: j.jobId,
      jobArn: j.jobArn,
      jobName: j.jobName,
      jobQueue: j.jobQueue,
      jobDefinition: j.jobDefinition,
      status: j.status,
      statusReason: j.statusReason,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      stoppedAt: j.stoppedAt,
      attempts: j.attempts,
      dependsOn: j.dependsOn,
      parameters: j.parameters,
      container: j.container,
      tags: j.tags,
    };
  }

  describeJobs(input) {
    const ids = input.jobs;
    if (!Array.isArray(ids)) throw new BatchError("ClientException", "jobs is required.");
    const jobs = [];
    for (const ref of ids) {
      const id = ref.includes("/") ? ref.split("/").pop() : ref;
      const j = this.jobs.get(id);
      if (j) jobs.push(this.jobView(j));
    }
    return { jobs };
  }

  listJobs(input) {
    let jobs = [...this.jobs.values()];
    if (input.jobQueue) {
      const queueName = input.jobQueue.includes("/") ? input.jobQueue.split("/").pop() : input.jobQueue;
      jobs = jobs.filter((j) => j.jobQueueName === queueName);
    }
    if (input.jobStatus) jobs = jobs.filter((j) => j.status === input.jobStatus);
    return {
      jobSummaryList: jobs.map((j) => ({
        jobId: j.jobId,
        jobArn: j.jobArn,
        jobName: j.jobName,
        status: j.status,
        statusReason: j.statusReason,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        stoppedAt: j.stoppedAt,
        container: { exitCode: j.container ? j.container.exitCode : 0 },
      })),
    };
  }

  cancelJob(input) {
    const id = input.jobId;
    if (!id) throw new BatchError("ClientException", "jobId is required.");
    if (!input.reason) throw new BatchError("ClientException", "reason is required.");
    const job = this.jobs.get(id);
    if (job && job.status !== "SUCCEEDED" && job.status !== "FAILED") {
      job.status = "FAILED";
      job.statusReason = input.reason;
      job.stoppedAt = Date.now();
    }
    return {};
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "ServerException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default BatchServer;
