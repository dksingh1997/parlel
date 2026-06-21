// parlel/emr — a lightweight, dependency-free fake of AWS EMR (Elastic
// MapReduce). Speaks the AWS JSON 1.1 wire protocol (target prefix
// ElasticMapReduce) so the real `@aws-sdk/client-emr` client works against it.
// Pure Node.js, no external dependencies, in-memory state.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidRequestException: 400,
  ValidationException: 400,
  InternalServerException: 500,
  InternalServerError: 500,
};

class EmrError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function clusterId() {
  return `j-${randomBytes(8).toString("hex").toUpperCase().slice(0, 13)}`;
}
function stepId() {
  return `s-${randomBytes(8).toString("hex").toUpperCase().slice(0, 13)}`;
}

export class EmrServer {
  constructor(port = 4709, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.clusters = new Map(); // id -> cluster (cluster.steps: Map<stepId, step>)
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new EmrError("InternalServerError", error.message, 500));
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
      return this.sendJson(res, 200, { status: "ok", service: "emr", clusters: this.clusters.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-emr");

    if (method !== "POST") {
      return this.sendError(res, new EmrError("InvalidRequestException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new EmrError("InvalidRequestException", "Body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof EmrError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "RunJobFlow":
        return this.runJobFlow(input);
      case "ListClusters":
        return this.listClusters(input);
      case "DescribeCluster":
        return this.describeCluster(input);
      case "TerminateJobFlows":
        return this.terminateJobFlows(input);
      case "AddJobFlowSteps":
        return this.addJobFlowSteps(input);
      case "ListSteps":
        return this.listSteps(input);
      case "DescribeStep":
        return this.describeStep(input);
      default:
        throw new EmrError("InvalidRequestException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  clusterArn(id) {
    return `arn:aws:elasticmapreduce:${this.region}:${this.accountId}:cluster/${id}`;
  }

  // -------------------------------------------------------------------------
  // RunJobFlow
  // -------------------------------------------------------------------------
  runJobFlow(input) {
    const name = input.Name;
    if (!name) throw new EmrError("ValidationException", "Name is required.");
    const id = clusterId();
    const now = Date.now() / 1000;
    const cluster = {
      id,
      name,
      releaseLabel: input.ReleaseLabel || "emr-7.1.0",
      logUri: input.LogUri,
      serviceRole: input.ServiceRole,
      jobFlowRole: input.JobFlowRole,
      autoTerminate: !input.KeepJobFlowAliveWhenNoSteps,
      applications: (input.Applications || []).map((a) => ({ Name: a.Name, Version: a.Version })),
      instances: input.Instances || {},
      visibleToAllUsers: input.VisibleToAllUsers !== false,
      tags: input.Tags || [],
      state: "WAITING",
      stateChangeReason: { Message: "Cluster ready to run steps." },
      createdAt: now,
      steps: new Map(),
      stepOrder: [],
    };

    // Steps provided at launch.
    for (const s of input.Steps || []) {
      this.addStep(cluster, s);
    }

    this.clusters.set(id, cluster);
    return { JobFlowId: id, ClusterArn: this.clusterArn(id) };
  }

  addStep(cluster, s) {
    const sid = stepId();
    const now = Date.now() / 1000;
    const step = {
      id: sid,
      name: s.Name || "Step",
      config: {
        Jar: s.HadoopJarStep ? s.HadoopJarStep.Jar : undefined,
        Args: s.HadoopJarStep ? s.HadoopJarStep.Args || [] : [],
        MainClass: s.HadoopJarStep ? s.HadoopJarStep.MainClass : undefined,
        Properties: s.HadoopJarStep ? s.HadoopJarStep.Properties || [] : [],
      },
      actionOnFailure: s.ActionOnFailure || "TERMINATE_CLUSTER",
      status: {
        State: "COMPLETED",
        StateChangeReason: {},
        Timeline: { CreationDateTime: now, StartDateTime: now, EndDateTime: now },
      },
    };
    cluster.steps.set(sid, step);
    cluster.stepOrder.push(sid);
    return sid;
  }

  requireCluster(id) {
    if (!id) throw new EmrError("ValidationException", "ClusterId is required.");
    const c = this.clusters.get(id);
    if (!c) throw new EmrError("InvalidRequestException", `Cluster id '${id}' is not valid.`);
    return c;
  }

  // -------------------------------------------------------------------------
  // ListClusters / DescribeCluster
  // -------------------------------------------------------------------------
  clusterSummary(c) {
    return {
      Id: c.id,
      Name: c.name,
      Status: {
        State: c.state,
        StateChangeReason: c.stateChangeReason,
        Timeline: { CreationDateTime: c.createdAt, ReadyDateTime: c.createdAt },
      },
      NormalizedInstanceHours: 0,
      ClusterArn: this.clusterArn(c.id),
    };
  }

  listClusters(input) {
    let clusters = [...this.clusters.values()];
    if (Array.isArray(input.ClusterStates) && input.ClusterStates.length) {
      const states = new Set(input.ClusterStates);
      clusters = clusters.filter((c) => states.has(c.state));
    }
    return { Clusters: clusters.map((c) => this.clusterSummary(c)) };
  }

  describeCluster(input) {
    const c = this.requireCluster(input.ClusterId);
    return {
      Cluster: {
        Id: c.id,
        Name: c.name,
        Status: {
          State: c.state,
          StateChangeReason: c.stateChangeReason,
          Timeline: { CreationDateTime: c.createdAt, ReadyDateTime: c.createdAt },
        },
        ReleaseLabel: c.releaseLabel,
        LogUri: c.logUri,
        ServiceRole: c.serviceRole,
        AutoTerminate: c.autoTerminate,
        TerminationProtected: false,
        VisibleToAllUsers: c.visibleToAllUsers,
        Applications: c.applications,
        Tags: c.tags,
        InstanceCollectionType: "INSTANCE_GROUP",
        ClusterArn: this.clusterArn(c.id),
        NormalizedInstanceHours: 0,
      },
    };
  }

  terminateJobFlows(input) {
    const ids = input.JobFlowIds || [];
    for (const id of ids) {
      const c = this.clusters.get(id);
      if (c) {
        c.state = "TERMINATED";
        c.stateChangeReason = { Code: "USER_REQUEST", Message: "Terminated by user request" };
      }
    }
    return {};
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------
  addJobFlowSteps(input) {
    const c = this.requireCluster(input.JobFlowId);
    const ids = [];
    for (const s of input.Steps || []) ids.push(this.addStep(c, s));
    return { StepIds: ids };
  }

  stepSummary(step) {
    return {
      Id: step.id,
      Name: step.name,
      Config: step.config,
      ActionOnFailure: step.actionOnFailure,
      Status: step.status,
    };
  }

  listSteps(input) {
    const c = this.requireCluster(input.ClusterId);
    let steps = c.stepOrder.map((sid) => c.steps.get(sid));
    if (Array.isArray(input.StepStates) && input.StepStates.length) {
      const states = new Set(input.StepStates);
      steps = steps.filter((s) => states.has(s.status.State));
    }
    if (Array.isArray(input.StepIds) && input.StepIds.length) {
      const wanted = new Set(input.StepIds);
      steps = steps.filter((s) => wanted.has(s.id));
    }
    // EMR returns steps in reverse order (most recent first).
    return { Steps: steps.slice().reverse().map((s) => this.stepSummary(s)) };
  }

  describeStep(input) {
    const c = this.requireCluster(input.ClusterId);
    const step = c.steps.get(input.StepId);
    if (!step) throw new EmrError("InvalidRequestException", `Step id '${input.StepId}' is not valid.`);
    return { Step: this.stepSummary(step) };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerError";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default EmrServer;
