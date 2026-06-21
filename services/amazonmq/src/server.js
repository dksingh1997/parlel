// parlel/amazonmq — a lightweight, dependency-free fake of AWS Amazon MQ.
//
// Speaks the Amazon MQ REST/JSON API. Pure Node.js, no external npm deps.
// State is in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

const ENGINE_VERSIONS = {
  RABBITMQ: ["3.13", "3.12", "3.11"],
  ACTIVEMQ: ["5.18", "5.17", "5.16"],
};

class MqError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class AmazonmqServer {
  constructor(port = 4738, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.brokers = new Map();
    this.configurations = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new MqError("InternalServerErrorException", error.message, 500));
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
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "amazonmq",
        brokers: this.brokers.size,
        configurations: this.configurations.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-amazonmq");

    const bodyBuf = await this.readBody(req);
    let body = {};
    if (bodyBuf.length) {
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        return this.sendError(res, new MqError("BadRequestException", "Invalid JSON body."));
      }
    }

    try {
      return this.route(method, path, body, url, res);
    } catch (error) {
      if (error instanceof MqError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, body, url, res) {
    const seg = path.split("/").filter(Boolean); // e.g. ["v1","brokers","id","users","name"]
    if (seg[0] !== "v1") {
      throw new MqError("NotFoundException", `Unknown path ${path}`, 404);
    }
    const resource = seg[1];

    if (resource === "brokers") {
      if (seg.length === 2) {
        if (method === "POST") return this.sendJson(res, 200, this.createBroker(body));
        if (method === "GET") return this.sendJson(res, 200, this.listBrokers(url));
      } else if (seg.length === 3) {
        const id = decodeURIComponent(seg[2]);
        if (method === "GET") return this.sendJson(res, 200, this.describeBroker(id));
        if (method === "PUT") return this.sendJson(res, 200, this.updateBroker(id, body));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteBroker(id));
      } else if (seg.length === 4 && seg[3] === "reboot") {
        if (method === "POST") {
          this.rebootBroker(decodeURIComponent(seg[2]));
          return this.sendJson(res, 200, {});
        }
      } else if (seg.length === 4 && seg[3] === "users") {
        const brokerId = decodeURIComponent(seg[2]);
        if (method === "GET") return this.sendJson(res, 200, this.listUsers(brokerId, url));
      } else if (seg.length === 5 && seg[3] === "users") {
        const brokerId = decodeURIComponent(seg[2]);
        const username = decodeURIComponent(seg[4]);
        if (method === "POST") return this.sendJson(res, 200, this.createUser(brokerId, username, body));
        if (method === "GET") return this.sendJson(res, 200, this.describeUser(brokerId, username));
        if (method === "PUT") return this.sendJson(res, 200, this.updateUser(brokerId, username, body));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteUser(brokerId, username));
      }
    } else if (resource === "configurations") {
      if (seg.length === 2) {
        if (method === "POST") return this.sendJson(res, 200, this.createConfiguration(body));
        if (method === "GET") return this.sendJson(res, 200, this.listConfigurations());
      } else if (seg.length === 3) {
        const id = decodeURIComponent(seg[2]);
        if (method === "GET") return this.sendJson(res, 200, this.describeConfiguration(id));
        if (method === "PUT") return this.sendJson(res, 200, this.updateConfiguration(id, body));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteConfiguration(id));
      }
    }

    throw new MqError("NotFoundException", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  // Brokers
  // -------------------------------------------------------------------------
  createBroker(body) {
    const name = body.brokerName;
    if (!name) throw new MqError("BadRequestException", "brokerName is required.");
    const engineType = body.engineType;
    if (!engineType) throw new MqError("BadRequestException", "engineType is required.");
    const deploymentMode = body.deploymentMode;
    if (!deploymentMode) throw new MqError("BadRequestException", "deploymentMode is required.");
    const hostInstanceType = body.hostInstanceType;
    if (!hostInstanceType) throw new MqError("BadRequestException", "hostInstanceType is required.");
    if (body.publiclyAccessible === undefined) throw new MqError("BadRequestException", "publiclyAccessible is required.");
    for (const b of this.brokers.values()) {
      if (b.brokerName === name) {
        throw new MqError("ConflictException", `Broker name ${name} already exists.`, 409);
      }
    }
    const engine = engineType.toUpperCase();
    const id = `b-${randomUUID()}`;
    const arn = `arn:aws:mq:${this.region}:${this.accountId}:broker:${name}:${id}`;
    const users = (body.users || []).map((u) => ({
      username: u.username,
      password: u.password || "parlel-default-pw",
      consoleAccess: !!u.consoleAccess,
      groups: u.groups || [],
      replicationUser: !!u.replicationUser,
      pendingChange: "CREATE",
    }));
    const broker = {
      brokerId: id,
      brokerArn: arn,
      brokerName: name,
      engineType: engine,
      engineVersion: body.engineVersion || (ENGINE_VERSIONS[engine] || ["1.0"])[0],
      deploymentMode,
      hostInstanceType,
      publiclyAccessible: !!body.publiclyAccessible,
      autoMinorVersionUpgrade: body.autoMinorVersionUpgrade !== false,
      authenticationStrategy: body.authenticationStrategy || "SIMPLE",
      brokerState: "RUNNING",
      created: new Date().toISOString(),
      users,
      tags: body.tags || {},
      securityGroups: body.securityGroups || [],
      subnetIds: body.subnetIds || [],
      storageType: body.storageType || "EBS",
      configuration: body.configuration || null,
      encryptionOptions: body.encryptionOptions || { useAwsOwnedKey: true },
      logs: body.logs || { general: false, audit: false },
      maintenanceWindowStartTime: body.maintenanceWindowStartTime || { dayOfWeek: "SUNDAY", timeOfDay: "00:00", timeZone: "UTC" },
      brokerInstances: [
        {
          consoleURL: `https://${id}.mq.${this.region}.amazonaws.com:443`,
          endpoints: [`amqps://${id}.mq.${this.region}.amazonaws.com:5671`],
          ipAddress: "10.0.0.10",
        },
      ],
    };
    this.brokers.set(id, broker);
    return { brokerId: id, brokerArn: arn };
  }

  requireBroker(id) {
    const b = this.brokers.get(id);
    if (!b) throw new MqError("NotFoundException", `Broker ${id} not found.`, 404);
    return b;
  }

  describeBroker(id) {
    const b = this.requireBroker(id);
    return {
      brokerId: b.brokerId,
      brokerArn: b.brokerArn,
      brokerName: b.brokerName,
      brokerState: b.brokerState,
      engineType: b.engineType,
      engineVersion: b.engineVersion,
      deploymentMode: b.deploymentMode,
      hostInstanceType: b.hostInstanceType,
      publiclyAccessible: b.publiclyAccessible,
      autoMinorVersionUpgrade: b.autoMinorVersionUpgrade,
      authenticationStrategy: b.authenticationStrategy,
      created: b.created,
      securityGroups: b.securityGroups,
      subnetIds: b.subnetIds,
      storageType: b.storageType,
      brokerInstances: b.brokerInstances,
      configurations: {
        current: b.configuration || {},
        pending: {},
        history: [],
      },
      users: b.users.map((u) => ({ username: u.username, pendingChange: u.pendingChange })),
      tags: b.tags,
      encryptionOptions: b.encryptionOptions,
      logs: {
        general: b.logs.general,
        generalLogGroup: `/aws/amazonmq/broker/${b.brokerId}/general`,
        audit: b.logs.audit,
        auditLogGroup: `/aws/amazonmq/broker/${b.brokerId}/audit`,
        pending: { general: false, audit: false },
      },
      maintenanceWindowStartTime: b.maintenanceWindowStartTime,
    };
  }

  listBrokers(url) {
    const maxResults = parseInt(url.searchParams.get("maxResults") || "20", 10);
    const nextToken = url.searchParams.get("nextToken");
    let summaries = [...this.brokers.values()].map((b) => ({
      brokerId: b.brokerId,
      brokerArn: b.brokerArn,
      brokerName: b.brokerName,
      brokerState: b.brokerState,
      engineType: b.engineType,
      deploymentMode: b.deploymentMode,
      hostInstanceType: b.hostInstanceType,
      created: b.created,
    }));
    let startIdx = 0;
    if (nextToken) {
      const idx = summaries.findIndex((s) => s.brokerId === nextToken);
      if (idx >= 0) startIdx = idx;
    }
    const page = summaries.slice(startIdx, startIdx + maxResults);
    const result = { brokerSummaries: page };
    if (startIdx + maxResults < summaries.length) {
      result.nextToken = page[page.length - 1].brokerId;
    }
    return result;
  }

  updateBroker(id, body) {
    const b = this.requireBroker(id);
    if (body.engineVersion !== undefined) b.engineVersion = body.engineVersion;
    if (body.hostInstanceType !== undefined) b.hostInstanceType = body.hostInstanceType;
    if (body.autoMinorVersionUpgrade !== undefined) b.autoMinorVersionUpgrade = body.autoMinorVersionUpgrade;
    if (body.authenticationStrategy !== undefined) b.authenticationStrategy = body.authenticationStrategy;
    if (body.configuration !== undefined) b.configuration = body.configuration;
    if (body.logs !== undefined) b.logs = { ...b.logs, ...body.logs };
    if (body.securityGroups !== undefined) b.securityGroups = body.securityGroups;
    return {
      brokerId: b.brokerId,
      engineVersion: b.engineVersion,
      hostInstanceType: b.hostInstanceType,
      autoMinorVersionUpgrade: b.autoMinorVersionUpgrade,
      authenticationStrategy: b.authenticationStrategy,
      configuration: b.configuration,
      logs: b.logs,
      securityGroups: b.securityGroups,
    };
  }

  rebootBroker(id) {
    this.requireBroker(id);
    // No-op: broker stays RUNNING (by design — no real reboot)
  }

  deleteBroker(id) {
    const b = this.requireBroker(id);
    b.brokerState = "DELETION_IN_PROGRESS";
    this.brokers.delete(id);
    return { brokerId: id };
  }

  // -------------------------------------------------------------------------
  // Configurations
  // -------------------------------------------------------------------------
  createConfiguration(body) {
    const name = body.name;
    if (!name) throw new MqError("BadRequestException", "name is required.");
    const engineType = (body.engineType || "RABBITMQ").toUpperCase();
    const id = `c-${randomUUID()}`;
    const arn = `arn:aws:mq:${this.region}:${this.accountId}:configuration:${id}`;
    const created = new Date().toISOString();
    const cfg = {
      id,
      arn,
      name,
      engineType,
      engineVersion: body.engineVersion || (ENGINE_VERSIONS[engineType] || ["1.0"])[0],
      description: body.description || "",
      created,
      latestRevision: { revision: 1, created, description: "" },
      authenticationStrategy: body.authenticationStrategy || "SIMPLE",
      tags: body.tags || {},
    };
    this.configurations.set(id, cfg);
    return {
      id,
      arn,
      name,
      created,
      authenticationStrategy: cfg.authenticationStrategy,
      latestRevision: cfg.latestRevision,
    };
  }

  requireConfiguration(id) {
    const c = this.configurations.get(id);
    if (!c) throw new MqError("NotFoundException", `Configuration ${id} not found.`, 404);
    return c;
  }

  describeConfiguration(id) {
    const c = this.requireConfiguration(id);
    return {
      id: c.id,
      arn: c.arn,
      name: c.name,
      engineType: c.engineType,
      engineVersion: c.engineVersion,
      description: c.description,
      created: c.created,
      latestRevision: c.latestRevision,
      authenticationStrategy: c.authenticationStrategy,
      tags: c.tags,
    };
  }

  listConfigurations() {
    return {
      configurations: [...this.configurations.values()].map((c) => ({
        id: c.id,
        arn: c.arn,
        name: c.name,
        engineType: c.engineType,
        engineVersion: c.engineVersion,
        description: c.description,
        created: c.created,
        latestRevision: c.latestRevision,
        authenticationStrategy: c.authenticationStrategy,
        tags: c.tags,
      })),
    };
  }

  updateConfiguration(id, body) {
    const c = this.requireConfiguration(id);
    const newRevision = c.latestRevision.revision + 1;
    const created = new Date().toISOString();
    c.latestRevision = { revision: newRevision, created, description: body.description || "" };
    return {
      id: c.id,
      arn: c.arn,
      name: c.name,
      created: c.created,
      latestRevision: c.latestRevision,
    };
  }

  deleteConfiguration(id) {
    this.requireConfiguration(id);
    this.configurations.delete(id);
    return { configurationId: id };
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  requireBrokerForUsers(brokerId) {
    const b = this.brokers.get(brokerId);
    if (!b) throw new MqError("NotFoundException", `Broker ${brokerId} not found.`, 404);
    return b;
  }

  listUsers(brokerId, url) {
    const b = this.requireBrokerForUsers(brokerId);
    const maxResults = parseInt(url.searchParams.get("maxResults") || "100", 10);
    const nextToken = url.searchParams.get("nextToken");
    let users = b.users.map((u) => ({ username: u.username, pendingChange: u.pendingChange }));
    let startIdx = 0;
    if (nextToken) {
      const idx = users.findIndex((u) => u.username === nextToken);
      if (idx >= 0) startIdx = idx;
    }
    const page = users.slice(startIdx, startIdx + maxResults);
    const result = { brokerId, users: page };
    if (startIdx + maxResults < users.length) {
      result.nextToken = page[page.length - 1].username;
    }
    return result;
  }

  createUser(brokerId, username, body) {
    const b = this.requireBrokerForUsers(brokerId);
    if (!body.password) throw new MqError("BadRequestException", "password is required.");
    const existing = b.users.find((u) => u.username === username);
    if (existing) throw new MqError("ConflictException", `User ${username} already exists on broker ${brokerId}.`, 409);
    b.users.push({
      username,
      password: body.password,
      consoleAccess: !!body.consoleAccess,
      groups: body.groups || [],
      replicationUser: !!body.replicationUser,
      pendingChange: "CREATE",
    });
    return {};
  }

  describeUser(brokerId, username) {
    const b = this.requireBrokerForUsers(brokerId);
    const u = b.users.find((u) => u.username === username);
    if (!u) throw new MqError("NotFoundException", `User ${username} not found on broker ${brokerId}.`, 404);
    return {
      brokerId,
      username: u.username,
      consoleAccess: u.consoleAccess,
      groups: u.groups,
      replicationUser: u.replicationUser,
      pending: { pendingChange: u.pendingChange },
    };
  }

  updateUser(brokerId, username, body) {
    const b = this.requireBrokerForUsers(brokerId);
    const u = b.users.find((u) => u.username === username);
    if (!u) throw new MqError("NotFoundException", `User ${username} not found on broker ${brokerId}.`, 404);
    if (body.password !== undefined) u.password = body.password;
    if (body.consoleAccess !== undefined) u.consoleAccess = body.consoleAccess;
    if (body.groups !== undefined) u.groups = body.groups;
    if (body.replicationUser !== undefined) u.replicationUser = body.replicationUser;
    u.pendingChange = "UPDATE";
    return {};
  }

  deleteUser(brokerId, username) {
    const b = this.requireBrokerForUsers(brokerId);
    const idx = b.users.findIndex((u) => u.username === username);
    if (idx < 0) throw new MqError("NotFoundException", `User ${username} not found on broker ${brokerId}.`, 404);
    b.users.splice(idx, 1);
    return {};
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", error.code || "BadRequestException");
    res.end(JSON.stringify({ __type: error.code, errorAttribute: "", message: error.message }));
  }
}

export default AmazonmqServer;
