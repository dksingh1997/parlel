// parlel/elasticache — a lightweight, dependency-free fake of AWS ElastiCache.
// Speaks the AWS Query (XML) wire protocol (API version 2015-02-02, member-style
// lists) so the real `@aws-sdk/client-elasticache` client works against it.
// Conceptually this backs onto the parlel `redis` emulator — an ElastiCache
// cache cluster is metadata describing a Redis endpoint you can actually talk to
// via the redis service. Pure Node.js, in-memory state.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const EC_NAMESPACE = "http://elasticache.amazonaws.com/doc/2015-02-02/";
const API_VERSION = "2015-02-02";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  CacheClusterAlreadyExists: 400,
  CacheClusterNotFound: 404,
  ReplicationGroupAlreadyExists: 400,
  ReplicationGroupNotFoundFault: 404,
  InvalidParameterValue: 400,
  InvalidParameterCombination: 400,
  MissingParameter: 400,
  InvalidCacheClusterState: 400,
  InternalFailure: 500,
};

class EcError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlNode(tag, value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    const members = value.map((v) => xmlNode("member", v)).join("");
    return `<${tag}>${members}</${tag}>`;
  }
  if (typeof value === "object") {
    const inner = Object.entries(value).map(([k, v]) => xmlNode(k, v)).join("");
    return `<${tag}>${inner}</${tag}>`;
  }
  if (typeof value === "boolean") return `<${tag}>${value ? "true" : "false"}</${tag}>`;
  return `<${tag}>${xmlEscape(value)}</${tag}>`;
}

function parseForm(body) {
  const flat = {};
  for (const [key, value] of new URLSearchParams(body).entries()) flat[key] = value;
  return unflatten(flat);
}

function unflatten(flat) {
  const root = {};
  for (const rawKey of Object.keys(flat)) {
    const value = flat[rawKey];
    const parts = rawKey.split(".");
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) cursor[part] = value;
      else {
        if (cursor[part] === undefined) cursor[part] = {};
        cursor = cursor[part];
      }
    }
  }
  return normalizeNode(root);
}

function normalizeNode(node) {
  if (node === null || typeof node !== "object") return node;
  const keys = Object.keys(node);
  if (keys.length === 1 && (keys[0] === "member" || keys[0] === "item")) {
    const container = node[keys[0]];
    const indices = Object.keys(container).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    return indices.map((idx) => normalizeNode(container[idx]));
  }
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return keys.sort((a, b) => Number(a) - Number(b)).map((idx) => normalizeNode(node[idx]));
  }
  const out = {};
  for (const k of keys) out[k] = normalizeNode(node[k]);
  return out;
}

export class ElasticacheServer {
  constructor(port = 4707, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    // Conceptual backing redis endpoint that cache clusters point at.
    this.redisHost = options.redisHost || "127.0.0.1";
    this.redisPort = options.redisPort || 6379;
    this.reset();
  }

  reset() {
    this.clusters = new Map(); // id -> cluster
    this.replicationGroups = new Map(); // id -> rg
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new EcError("InternalFailure", error.message, 500));
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
        service: "elasticache",
        cacheClusters: this.clusters.size,
        replicationGroups: this.replicationGroups.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-elasticache");

    if (method !== "POST") {
      return this.sendError(res, new EcError("InvalidParameterValue", "Only POST is supported.", 405));
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(res, new EcError("InvalidParameterValue", "Body could not be parsed.", 400));
    }

    try {
      const { result, resultTag } = this.dispatch(input.Action, input);
      return this.sendXml(res, 200, input.Action, resultTag, result);
    } catch (error) {
      if (error instanceof EcError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      CreateCacheCluster: () => this.createCacheCluster(input),
      DescribeCacheClusters: () => this.describeCacheClusters(input),
      DeleteCacheCluster: () => this.deleteCacheCluster(input),
      CreateReplicationGroup: () => this.createReplicationGroup(input),
      DescribeReplicationGroups: () => this.describeReplicationGroups(input),
    };
    const handler = handlers[operation];
    if (!handler) throw new EcError("InvalidParameterValue", `The action ${operation || "(none)"} is not valid.`, 400);
    return handler();
  }

  // -------------------------------------------------------------------------
  // Cache clusters
  // -------------------------------------------------------------------------
  createCacheCluster(input) {
    const id = input.CacheClusterId;
    if (!id) throw new EcError("MissingParameter", "CacheClusterId is required.");
    if (this.clusters.has(id)) {
      throw new EcError("CacheClusterAlreadyExists", `Cache cluster ${id} already exists.`);
    }
    const engine = input.Engine || "redis";
    const numNodes = input.NumCacheNodes ? Number(input.NumCacheNodes) : 1;
    const nodeType = input.CacheNodeType || "cache.t3.micro";
    const port = engine === "memcached" ? 11211 : this.redisPort;
    const now = new Date().toISOString();

    const nodes = [];
    for (let i = 1; i <= numNodes; i++) {
      const nodeId = String(i).padStart(4, "0");
      nodes.push({
        CacheNodeId: nodeId,
        CacheNodeStatus: "available",
        Endpoint: { Address: `${id}.${nodeId}.parlel.cache.amazonaws.com`, Port: port },
      });
    }

    const cluster = {
      id,
      engine,
      engineVersion: input.EngineVersion || (engine === "redis" ? "7.1" : "1.6.22"),
      nodeType,
      numNodes,
      status: "available",
      createdAt: now,
      port,
      nodes,
      configurationEndpoint:
        engine === "memcached" ? { Address: `${id}.cfg.parlel.cache.amazonaws.com`, Port: port } : undefined,
      preferredAvailabilityZone: input.PreferredAvailabilityZone || `${this.region}a`,
      // Conceptual mapping to the parlel redis emulator.
      backingRedis: { host: this.redisHost, port: this.redisPort },
    };
    this.clusters.set(id, cluster);
    return { result: { CacheCluster: this.clusterXml(cluster, true) }, resultTag: "CreateCacheClusterResult" };
  }

  clusterXml(c, withNodes) {
    const out = {
      CacheClusterId: c.id,
      CacheClusterStatus: c.status,
      Engine: c.engine,
      EngineVersion: c.engineVersion,
      CacheNodeType: c.nodeType,
      NumCacheNodes: c.numNodes,
      CacheClusterCreateTime: c.createdAt,
      PreferredAvailabilityZone: c.preferredAvailabilityZone,
      ClientDownloadLandingPage: "https://console.aws.amazon.com/elasticache/home#client-download:",
      ARN: `arn:aws:elasticache:${this.region}:${this.accountId}:cluster:${c.id}`,
    };
    if (c.configurationEndpoint) out.ConfigurationEndpoint = c.configurationEndpoint;
    if (withNodes) out.CacheNodes = c.nodes;
    return out;
  }

  describeCacheClusters(input) {
    const id = input.CacheClusterId;
    let clusters = [...this.clusters.values()];
    if (id) {
      if (!this.clusters.has(id)) throw new EcError("CacheClusterNotFound", `Cache cluster ${id} not found.`);
      clusters = [this.clusters.get(id)];
    }
    const showNodes = input.ShowCacheNodeInfo === "true";
    return {
      result: { CacheClusters: clusters.map((c) => this.clusterXml(c, showNodes)) },
      resultTag: "DescribeCacheClustersResult",
    };
  }

  deleteCacheCluster(input) {
    const id = input.CacheClusterId;
    if (!id) throw new EcError("MissingParameter", "CacheClusterId is required.");
    const cluster = this.clusters.get(id);
    if (!cluster) throw new EcError("CacheClusterNotFound", `Cache cluster ${id} not found.`);
    cluster.status = "deleting";
    this.clusters.delete(id);
    return { result: { CacheCluster: this.clusterXml({ ...cluster, status: "deleting" }, false) }, resultTag: "DeleteCacheClusterResult" };
  }

  // -------------------------------------------------------------------------
  // Replication groups
  // -------------------------------------------------------------------------
  createReplicationGroup(input) {
    const id = input.ReplicationGroupId;
    if (!id) throw new EcError("MissingParameter", "ReplicationGroupId is required.");
    if (this.replicationGroups.has(id)) {
      throw new EcError("ReplicationGroupAlreadyExists", `Replication group ${id} already exists.`);
    }
    const numClusters = input.NumCacheClusters ? Number(input.NumCacheClusters) : 2;
    const nodeType = input.CacheNodeType || "cache.t3.micro";
    const port = this.redisPort;

    const memberClusters = [];
    const nodeGroupMembers = [];
    for (let i = 1; i <= numClusters; i++) {
      const memberId = `${id}-${String(i).padStart(3, "0")}`;
      memberClusters.push(memberId);
      nodeGroupMembers.push({
        CacheClusterId: memberId,
        CacheNodeId: "0001",
        ReadEndpoint: { Address: `${memberId}.parlel.cache.amazonaws.com`, Port: port },
        PreferredAvailabilityZone: `${this.region}${String.fromCharCode(97 + ((i - 1) % 3))}`,
        CurrentRole: i === 1 ? "primary" : "replica",
      });
    }

    const rg = {
      id,
      description: input.ReplicationGroupDescription || "",
      status: "available",
      nodeType,
      port,
      memberClusters,
      nodeGroupMembers,
      automaticFailover: input.AutomaticFailoverEnabled === "true" ? "enabled" : "disabled",
      multiAZ: input.MultiAZEnabled === "true" ? "enabled" : "disabled",
      primaryEndpoint: { Address: `${id}.parlel.cache.amazonaws.com`, Port: port },
      readerEndpoint: { Address: `${id}-ro.parlel.cache.amazonaws.com`, Port: port },
      backingRedis: { host: this.redisHost, port: this.redisPort },
    };
    this.replicationGroups.set(id, rg);
    return { result: { ReplicationGroup: this.rgXml(rg) }, resultTag: "CreateReplicationGroupResult" };
  }

  rgXml(rg) {
    return {
      ReplicationGroupId: rg.id,
      Description: rg.description,
      Status: rg.status,
      CacheNodeType: rg.nodeType,
      MemberClusters: rg.memberClusters,
      AutomaticFailover: rg.automaticFailover,
      MultiAZ: rg.multiAZ,
      ARN: `arn:aws:elasticache:${this.region}:${this.accountId}:replicationgroup:${rg.id}`,
      NodeGroups: [
        {
          NodeGroupId: "0001",
          Status: rg.status,
          PrimaryEndpoint: rg.primaryEndpoint,
          ReaderEndpoint: rg.readerEndpoint,
          NodeGroupMembers: rg.nodeGroupMembers,
        },
      ],
    };
  }

  describeReplicationGroups(input) {
    const id = input.ReplicationGroupId;
    let groups = [...this.replicationGroups.values()];
    if (id) {
      if (!this.replicationGroups.has(id)) {
        throw new EcError("ReplicationGroupNotFoundFault", `Replication group ${id} not found.`);
      }
      groups = [this.replicationGroups.get(id)];
    }
    return {
      result: { ReplicationGroups: groups.map((g) => this.rgXml(g)) },
      resultTag: "DescribeReplicationGroupsResult",
    };
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  buildResultXml(result) {
    let xml = "";
    for (const [key, value] of Object.entries(result)) xml += xmlNode(key, value);
    return xml;
  }

  sendXml(res, status, operation, resultTag, result) {
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    const responseTag = `${operation}Response`;
    const resultXml = this.buildResultXml(result);
    const resultBlock = resultXml.length > 0 ? `<${resultTag}>${resultXml}</${resultTag}>` : `<${resultTag}/>`;
    const xml =
      `<${responseTag} xmlns="${EC_NAMESPACE}">` +
      resultBlock +
      `<ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata>` +
      `</${responseTag}>`;
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    res.end(`<?xml version="1.0"?>\n${xml}`);
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalFailure";
    const status = error.status || ERROR_STATUS[code] || 400;
    const fault = status >= 500 ? "Receiver" : "Sender";
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    const xml =
      `<ErrorResponse xmlns="${EC_NAMESPACE}">` +
      `<Error><Type>${fault}</Type><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(error.message || code)}</Message></Error>` +
      `<RequestId>${requestId}</RequestId></ErrorResponse>`;
    res.end(`<?xml version="1.0"?>\n${xml}`);
  }
}

export default ElasticacheServer;
export const API_VERSION_ELASTICACHE = API_VERSION;
