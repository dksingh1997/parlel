// parlel/ecs — a lightweight, dependency-free fake of AWS ECS (Elastic Container
// Service). Speaks the AWS JSON 1.1 wire protocol (target prefix
// AmazonEC2ContainerServiceV20141113) so the real `@aws-sdk/client-ecs` works
// against it. Pure Node.js, no external dependencies, in-memory state.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ClusterNotFoundException: 400,
  ClusterContainsServicesException: 400,
  ClusterContainsTasksException: 400,
  ServiceNotFoundException: 400,
  ServiceNotActiveException: 400,
  InvalidParameterException: 400,
  ClientException: 400,
  ServerException: 500,
};

class EcsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class EcsServer {
  constructor(port = 4703, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.clusters = new Map(); // name -> cluster
    this.taskDefinitions = new Map(); // family -> [revisions]
    this.tasks = new Map(); // taskId -> task
    this.services = new Map(); // "cluster/serviceName" -> service
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new EcsError("ServerException", error.message, 500));
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
      return this.sendJson(res, 200, {
        status: "ok",
        service: "ecs",
        clusters: this.clusters.size,
        services: this.services.size,
        tasks: this.tasks.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-ecs");

    if (method !== "POST") {
      return this.sendError(res, new EcsError("InvalidParameterException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new EcsError("InvalidParameterException", "Body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof EcsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateCluster":
        return this.createCluster(input);
      case "ListClusters":
        return this.listClusters(input);
      case "DescribeClusters":
        return this.describeClusters(input);
      case "DeleteCluster":
        return this.deleteCluster(input);
      case "RegisterTaskDefinition":
        return this.registerTaskDefinition(input);
      case "ListTaskDefinitions":
        return this.listTaskDefinitions(input);
      case "RunTask":
        return this.runTask(input);
      case "ListTasks":
        return this.listTasks(input);
      case "DescribeTasks":
        return this.describeTasks(input);
      case "StopTask":
        return this.stopTask(input);
      case "CreateService":
        return this.createService(input);
      case "ListServices":
        return this.listServices(input);
      case "DescribeServices":
        return this.describeServices(input);
      case "UpdateService":
        return this.updateService(input);
      case "DeleteService":
        return this.deleteService(input);
      default:
        throw new EcsError("InvalidParameterException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  clusterArn(name) {
    return `arn:aws:ecs:${this.region}:${this.accountId}:cluster/${name}`;
  }

  // resolve a cluster reference (name or arn) -> name. defaults to "default".
  clusterName(ref) {
    if (!ref) return "default";
    if (ref.includes("/")) return ref.split("/").pop();
    return ref;
  }

  requireCluster(ref) {
    const name = this.clusterName(ref);
    const cluster = this.clusters.get(name);
    if (!cluster) throw new EcsError("ClusterNotFoundException", `Cluster not found: ${name}`);
    return cluster;
  }

  // -------------------------------------------------------------------------
  // Clusters
  // -------------------------------------------------------------------------
  clusterSummary(c) {
    const services = [...this.services.values()].filter((s) => s.clusterName === c.name && s.status === "ACTIVE");
    const tasks = [...this.tasks.values()].filter((t) => t.clusterName === c.name && t.lastStatus === "RUNNING");
    return {
      clusterArn: c.arn,
      clusterName: c.name,
      status: c.status,
      registeredContainerInstancesCount: 0,
      runningTasksCount: tasks.length,
      pendingTasksCount: 0,
      activeServicesCount: services.length,
      statistics: [],
      tags: c.tags,
      settings: c.settings,
      capacityProviders: c.capacityProviders,
      defaultCapacityProviderStrategy: [],
    };
  }

  createCluster(input) {
    const name = input.clusterName || "default";
    const cluster = {
      name,
      arn: this.clusterArn(name),
      status: "ACTIVE",
      tags: input.tags || [],
      settings: input.settings || [],
      capacityProviders: input.capacityProviders || [],
    };
    this.clusters.set(name, cluster);
    return { cluster: this.clusterSummary(cluster) };
  }

  listClusters() {
    return { clusterArns: [...this.clusters.values()].map((c) => c.arn) };
  }

  describeClusters(input) {
    const refs = input.clusters && input.clusters.length ? input.clusters : [...this.clusters.keys()];
    const clusters = [];
    const failures = [];
    for (const ref of refs) {
      const name = this.clusterName(ref);
      const c = this.clusters.get(name);
      if (!c) {
        failures.push({ arn: this.clusterArn(name), reason: "MISSING" });
        continue;
      }
      clusters.push(this.clusterSummary(c));
    }
    return { clusters, failures };
  }

  deleteCluster(input) {
    const cluster = this.requireCluster(input.cluster);
    cluster.status = "INACTIVE";
    this.clusters.delete(cluster.name);
    return { cluster: { ...this.clusterSummary(cluster), status: "INACTIVE" } };
  }

  // -------------------------------------------------------------------------
  // Task definitions
  // -------------------------------------------------------------------------
  registerTaskDefinition(input) {
    const family = input.family;
    if (!family) throw new EcsError("ClientException", "Task definition family is required.");
    const revisions = this.taskDefinitions.get(family) || [];
    const revision = revisions.length + 1;
    const arn = `arn:aws:ecs:${this.region}:${this.accountId}:task-definition/${family}:${revision}`;
    const td = {
      taskDefinitionArn: arn,
      family,
      revision,
      status: "ACTIVE",
      containerDefinitions: input.containerDefinitions || [],
      requiresCompatibilities: input.requiresCompatibilities || ["EC2"],
      networkMode: input.networkMode || "bridge",
      cpu: input.cpu,
      memory: input.memory,
      executionRoleArn: input.executionRoleArn,
      taskRoleArn: input.taskRoleArn,
      volumes: input.volumes || [],
      registeredAt: Math.floor(Date.now() / 1000),
    };
    revisions.push(td);
    this.taskDefinitions.set(family, revisions);
    return { taskDefinition: td };
  }

  resolveTaskDefinition(ref) {
    if (!ref) return undefined;
    // ref may be family, family:revision, or full arn.
    let family = ref;
    let revision;
    if (ref.includes("task-definition/")) {
      family = ref.split("task-definition/").pop();
    }
    if (family.includes(":")) {
      const parts = family.split(":");
      revision = Number(parts.pop());
      family = parts.join(":");
    }
    const revisions = this.taskDefinitions.get(family);
    if (!revisions || !revisions.length) return undefined;
    if (revision) return revisions.find((r) => r.revision === revision);
    return revisions[revisions.length - 1];
  }

  listTaskDefinitions(input) {
    let all = [];
    for (const revisions of this.taskDefinitions.values()) {
      for (const r of revisions) all.push(r);
    }
    if (input.familyPrefix) all = all.filter((r) => r.family.startsWith(input.familyPrefix));
    return { taskDefinitionArns: all.map((r) => r.taskDefinitionArn) };
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  runTask(input) {
    const cluster = this.requireCluster(input.cluster);
    const td = this.resolveTaskDefinition(input.taskDefinition);
    if (!td) throw new EcsError("ClientException", `Task definition not found: ${input.taskDefinition}`);
    const count = input.count ? Number(input.count) : 1;
    const tasks = [];
    for (let i = 0; i < count; i++) {
      const id = randomUUID().replace(/-/g, "");
      const arn = `arn:aws:ecs:${this.region}:${this.accountId}:task/${cluster.name}/${id}`;
      const now = Math.floor(Date.now() / 1000);
      const task = {
        taskArn: arn,
        taskId: id,
        clusterArn: cluster.arn,
        clusterName: cluster.name,
        taskDefinitionArn: td.taskDefinitionArn,
        lastStatus: "RUNNING",
        desiredStatus: "RUNNING",
        launchType: input.launchType || "EC2",
        cpu: td.cpu,
        memory: td.memory,
        group: input.group || `family:${td.family}`,
        startedBy: input.startedBy,
        createdAt: now,
        startedAt: now,
        connectivity: "CONNECTED",
        containers: (td.containerDefinitions || []).map((cd) => ({
          containerArn: `arn:aws:ecs:${this.region}:${this.accountId}:container/${cluster.name}/${id}/${randomUUID()}`,
          taskArn: arn,
          name: cd.name,
          image: cd.image,
          lastStatus: "RUNNING",
          networkInterfaces: [],
        })),
        overrides: input.overrides || {},
        attachments: [],
      };
      this.tasks.set(id, task);
      tasks.push(this.taskSummary(task));
    }
    return { tasks, failures: [] };
  }

  taskSummary(t) {
    return {
      taskArn: t.taskArn,
      clusterArn: t.clusterArn,
      taskDefinitionArn: t.taskDefinitionArn,
      lastStatus: t.lastStatus,
      desiredStatus: t.desiredStatus,
      launchType: t.launchType,
      cpu: t.cpu,
      memory: t.memory,
      group: t.group,
      startedBy: t.startedBy,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      stoppedReason: t.stoppedReason,
      connectivity: t.connectivity,
      containers: t.containers,
      overrides: t.overrides,
      attachments: t.attachments,
    };
  }

  taskIdFromRef(ref) {
    if (!ref) return ref;
    if (ref.includes("/")) return ref.split("/").pop();
    return ref;
  }

  listTasks(input) {
    let tasks = [...this.tasks.values()];
    if (input.cluster) {
      const name = this.clusterName(input.cluster);
      tasks = tasks.filter((t) => t.clusterName === name);
    }
    if (input.desiredStatus) tasks = tasks.filter((t) => t.desiredStatus === input.desiredStatus);
    if (input.startedBy) tasks = tasks.filter((t) => t.startedBy === input.startedBy);
    return { taskArns: tasks.map((t) => t.taskArn) };
  }

  describeTasks(input) {
    const refs = input.tasks || [];
    const tasks = [];
    const failures = [];
    for (const ref of refs) {
      const id = this.taskIdFromRef(ref);
      const task = this.tasks.get(id);
      if (!task) {
        failures.push({ arn: ref, reason: "MISSING" });
        continue;
      }
      tasks.push(this.taskSummary(task));
    }
    return { tasks, failures };
  }

  stopTask(input) {
    const id = this.taskIdFromRef(input.task);
    const task = this.tasks.get(id);
    if (!task) throw new EcsError("InvalidParameterException", `The task ID ${input.task} could not be found.`);
    task.lastStatus = "STOPPED";
    task.desiredStatus = "STOPPED";
    task.stoppedReason = input.reason || "Task stopped by user";
    task.stoppedAt = Math.floor(Date.now() / 1000);
    return { task: this.taskSummary(task) };
  }

  // -------------------------------------------------------------------------
  // Services
  // -------------------------------------------------------------------------
  serviceKey(clusterName, name) {
    return `${clusterName}/${name}`;
  }

  serviceSummary(s) {
    return {
      serviceArn: s.arn,
      serviceName: s.name,
      clusterArn: this.clusterArn(s.clusterName),
      status: s.status,
      desiredCount: s.desiredCount,
      runningCount: s.runningCount,
      pendingCount: s.pendingCount,
      launchType: s.launchType,
      taskDefinition: s.taskDefinition,
      deploymentConfiguration: s.deploymentConfiguration,
      schedulingStrategy: s.schedulingStrategy,
      createdAt: s.createdAt,
      loadBalancers: s.loadBalancers,
      deployments: s.deployments,
      events: [],
      roleArn: s.roleArn,
    };
  }

  createService(input) {
    const cluster = this.requireCluster(input.cluster);
    const name = input.serviceName;
    if (!name) throw new EcsError("InvalidParameterException", "Service name is required.");
    const td = this.resolveTaskDefinition(input.taskDefinition);
    if (input.taskDefinition && !td) {
      throw new EcsError("ClientException", `Task definition not found: ${input.taskDefinition}`);
    }
    const desired = input.desiredCount !== undefined ? Number(input.desiredCount) : 0;
    const now = Math.floor(Date.now() / 1000);
    const arn = `arn:aws:ecs:${this.region}:${this.accountId}:service/${cluster.name}/${name}`;
    const service = {
      name,
      arn,
      clusterName: cluster.name,
      status: "ACTIVE",
      desiredCount: desired,
      runningCount: desired,
      pendingCount: 0,
      launchType: input.launchType || "EC2",
      taskDefinition: td ? td.taskDefinitionArn : input.taskDefinition,
      deploymentConfiguration: input.deploymentConfiguration || {},
      schedulingStrategy: input.schedulingStrategy || "REPLICA",
      createdAt: now,
      loadBalancers: input.loadBalancers || [],
      roleArn: input.role,
      deployments: [
        {
          id: `ecs-svc/${Date.now()}`,
          status: "PRIMARY",
          taskDefinition: td ? td.taskDefinitionArn : input.taskDefinition,
          desiredCount: desired,
          runningCount: desired,
          pendingCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    this.services.set(this.serviceKey(cluster.name, name), service);
    return { service: this.serviceSummary(service) };
  }

  listServices(input) {
    let services = [...this.services.values()];
    if (input.cluster) {
      const name = this.clusterName(input.cluster);
      services = services.filter((s) => s.clusterName === name);
    }
    if (input.launchType) services = services.filter((s) => s.launchType === input.launchType);
    return { serviceArns: services.map((s) => s.arn) };
  }

  resolveService(clusterName, ref) {
    if (!ref) return undefined;
    const name = ref.includes("/") ? ref.split("/").pop() : ref;
    return this.services.get(this.serviceKey(clusterName, name));
  }

  describeServices(input) {
    const clusterName = this.clusterName(input.cluster);
    const refs = input.services || [];
    const services = [];
    const failures = [];
    for (const ref of refs) {
      const s = this.resolveService(clusterName, ref);
      if (!s) {
        failures.push({ arn: ref, reason: "MISSING" });
        continue;
      }
      services.push(this.serviceSummary(s));
    }
    return { services, failures };
  }

  updateService(input) {
    const clusterName = this.clusterName(input.cluster);
    const s = this.resolveService(clusterName, input.service);
    if (!s) throw new EcsError("ServiceNotFoundException", `Service not found: ${input.service}`);
    if (input.desiredCount !== undefined) {
      s.desiredCount = Number(input.desiredCount);
      s.runningCount = Number(input.desiredCount);
    }
    if (input.taskDefinition) {
      const td = this.resolveTaskDefinition(input.taskDefinition);
      s.taskDefinition = td ? td.taskDefinitionArn : input.taskDefinition;
    }
    if (input.deploymentConfiguration) s.deploymentConfiguration = input.deploymentConfiguration;
    return { service: this.serviceSummary(s) };
  }

  deleteService(input) {
    const clusterName = this.clusterName(input.cluster);
    const s = this.resolveService(clusterName, input.service);
    if (!s) throw new EcsError("ServiceNotFoundException", `Service not found: ${input.service}`);
    if (s.desiredCount > 0 && input.force !== true) {
      throw new EcsError("InvalidParameterException", "The service cannot be stopped while it is scaled above 0.");
    }
    s.status = "DRAINING";
    this.services.delete(this.serviceKey(clusterName, s.name));
    return { service: { ...this.serviceSummary(s), status: "DRAINING" } };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "ServerException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default EcsServer;
