// parlel/rds — dependency-free fake of Amazon RDS (control plane).
//
// AWS Query/XML protocol (API version 2014-10-31). State is in-memory and
// ephemeral. DB instances back onto the parlel postgres/mysql emulators for
// the data plane; this service models only the control-plane metadata.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const API_VERSION = "2014-10-31";
const RDS_NAMESPACE = "http://rds.amazonaws.com/doc/2014-10-31/";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  DBInstanceAlreadyExists: 400,
  DBInstanceNotFound: 404,
  DBClusterAlreadyExistsFault: 400,
  DBClusterNotFoundFault: 404,
  DBSnapshotAlreadyExists: 400,
  DBSnapshotNotFound: 404,
  InvalidParameterValue: 400,
  InvalidParameterCombination: 400,
  InternalFailure: 500,
};

class RdsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---- XML helpers --------------------------------------------------------
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
    const inner = Object.entries(value)
      .map(([k, v]) => xmlNode(k, v))
      .join("");
    return `<${tag}>${inner}</${tag}>`;
  }
  if (typeof value === "boolean") return `<${tag}>${value ? "true" : "false"}</${tag}>`;
  return `<${tag}>${xmlEscape(value)}</${tag}>`;
}

function parseForm(body) {
  const flat = {};
  const params = new URLSearchParams(body);
  for (const [k, v] of params.entries()) flat[k] = v;
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
      const last = i === parts.length - 1;
      if (last) cursor[part] = value;
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
  if (keys.length === 1 && (keys[0] === "member" || keys[0] === "entry")) {
    const container = node[keys[0]];
    const indices = Object.keys(container)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    return indices.map((idx) => normalizeNode(container[idx]));
  }
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return keys.sort((a, b) => Number(a) - Number(b)).map((idx) => normalizeNode(node[idx]));
  }
  const out = {};
  for (const k of keys) out[k] = normalizeNode(node[k]);
  return out;
}

export class RdsServer {
  constructor(port = 4721, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.instances = new Map(); // id -> instance
    this.clusters = new Map(); // id -> cluster
    this.snapshots = new Map(); // id -> snapshot
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new RdsError("InternalFailure", error.message, 500));
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
        service: "rds",
        instances: this.instances.size,
        clusters: this.clusters.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    if (method !== "POST") {
      return this.sendError(res, new RdsError("InvalidParameterValue", "Only POST supported.", 405));
    }

    const body = (await this.readBody(req)).toString("utf8");
    const input = parseForm(body);
    const operation = input.Action;
    try {
      const { result, resultTag } = this.dispatch(operation, input);
      return this.sendXml(res, 200, operation, resultTag, result);
    } catch (error) {
      if (error instanceof RdsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateDBInstance":
        return { result: { DBInstance: this.createDBInstance(input) }, resultTag: "CreateDBInstanceResult" };
      case "DescribeDBInstances":
        return { result: this.describeDBInstances(input), resultTag: "DescribeDBInstancesResult" };
      case "DeleteDBInstance":
        return { result: { DBInstance: this.deleteDBInstance(input) }, resultTag: "DeleteDBInstanceResult" };
      case "ModifyDBInstance":
        return { result: { DBInstance: this.modifyDBInstance(input) }, resultTag: "ModifyDBInstanceResult" };
      case "CreateDBCluster":
        return { result: { DBCluster: this.createDBCluster(input) }, resultTag: "CreateDBClusterResult" };
      case "DescribeDBClusters":
        return { result: this.describeDBClusters(input), resultTag: "DescribeDBClustersResult" };
      case "CreateDBSnapshot":
        return { result: { DBSnapshot: this.createDBSnapshot(input) }, resultTag: "CreateDBSnapshotResult" };
      case "DescribeDBSnapshots":
        return { result: this.describeDBSnapshots(input), resultTag: "DescribeDBSnapshotsResult" };
      default:
        throw new RdsError("InvalidParameterValue", `Unsupported action: ${operation}`);
    }
  }

  engineDefaultPort(engine) {
    if (!engine) return 5432;
    if (engine.includes("mysql") || engine.includes("maria") || engine.includes("aurora-mysql")) return 3306;
    return 5432;
  }

  buildInstance(input) {
    const id = input.DBInstanceIdentifier;
    const engine = input.Engine || "postgres";
    const port = input.Port ? Number(input.Port) : this.engineDefaultPort(engine);
    return {
      DBInstanceIdentifier: id,
      DBInstanceArn: `arn:aws:rds:${this.region}:${this.accountId}:db:${id}`,
      DBInstanceClass: input.DBInstanceClass || "db.t3.micro",
      Engine: engine,
      EngineVersion: input.EngineVersion || (engine.includes("mysql") ? "8.0.35" : "15.4"),
      DBInstanceStatus: "available",
      MasterUsername: input.MasterUsername || "admin",
      DBName: input.DBName,
      AllocatedStorage: input.AllocatedStorage ? Number(input.AllocatedStorage) : 20,
      Endpoint: {
        Address: `${id}.parlel.${this.region}.rds.amazonaws.com`,
        Port: port,
        HostedZoneId: "Z0000000000000",
      },
      AvailabilityZone: `${this.region}a`,
      MultiAZ: input.MultiAZ === "true",
      PubliclyAccessible: input.PubliclyAccessible !== "false",
      StorageType: input.StorageType || "gp2",
      DBClusterIdentifier: input.DBClusterIdentifier,
      InstanceCreateTime: new Date().toISOString(),
    };
  }

  createDBInstance(input) {
    const id = input.DBInstanceIdentifier;
    if (!id) throw new RdsError("InvalidParameterValue", "DBInstanceIdentifier is required.");
    if (this.instances.has(id)) {
      throw new RdsError("DBInstanceAlreadyExists", `DB instance ${id} already exists.`);
    }
    const inst = this.buildInstance(input);
    this.instances.set(id, inst);
    return inst;
  }

  describeDBInstances(input) {
    let list = [...this.instances.values()];
    if (input.DBInstanceIdentifier) {
      list = list.filter((i) => i.DBInstanceIdentifier === input.DBInstanceIdentifier);
      if (!list.length) {
        throw new RdsError("DBInstanceNotFound", `DBInstance ${input.DBInstanceIdentifier} not found.`);
      }
    }
    return { DBInstances: list };
  }

  deleteDBInstance(input) {
    const id = input.DBInstanceIdentifier;
    const inst = this.instances.get(id);
    if (!inst) throw new RdsError("DBInstanceNotFound", `DBInstance ${id} not found.`);
    this.instances.delete(id);
    inst.DBInstanceStatus = "deleting";
    return inst;
  }

  modifyDBInstance(input) {
    const id = input.DBInstanceIdentifier;
    const inst = this.instances.get(id);
    if (!inst) throw new RdsError("DBInstanceNotFound", `DBInstance ${id} not found.`);
    if (input.DBInstanceClass) inst.DBInstanceClass = input.DBInstanceClass;
    if (input.AllocatedStorage) inst.AllocatedStorage = Number(input.AllocatedStorage);
    if (input.EngineVersion) inst.EngineVersion = input.EngineVersion;
    if (input.MultiAZ) inst.MultiAZ = input.MultiAZ === "true";
    return inst;
  }

  createDBCluster(input) {
    const id = input.DBClusterIdentifier;
    if (!id) throw new RdsError("InvalidParameterValue", "DBClusterIdentifier is required.");
    if (this.clusters.has(id)) {
      throw new RdsError("DBClusterAlreadyExistsFault", `DB cluster ${id} already exists.`);
    }
    const engine = input.Engine || "aurora-postgresql";
    const port = input.Port ? Number(input.Port) : this.engineDefaultPort(engine);
    const cluster = {
      DBClusterIdentifier: id,
      DBClusterArn: `arn:aws:rds:${this.region}:${this.accountId}:cluster:${id}`,
      Engine: engine,
      EngineVersion: input.EngineVersion || "15.4",
      Status: "available",
      Endpoint: `${id}.cluster-parlel.${this.region}.rds.amazonaws.com`,
      ReaderEndpoint: `${id}.cluster-ro-parlel.${this.region}.rds.amazonaws.com`,
      Port: port,
      MasterUsername: input.MasterUsername || "admin",
      DatabaseName: input.DatabaseName,
      ClusterCreateTime: new Date().toISOString(),
      DBClusterMembers: [],
    };
    this.clusters.set(id, cluster);
    return cluster;
  }

  describeDBClusters(input) {
    let list = [...this.clusters.values()];
    if (input.DBClusterIdentifier) {
      list = list.filter((c) => c.DBClusterIdentifier === input.DBClusterIdentifier);
      if (!list.length) {
        throw new RdsError("DBClusterNotFoundFault", `DBCluster ${input.DBClusterIdentifier} not found.`);
      }
    }
    return { DBClusters: list };
  }

  createDBSnapshot(input) {
    const sid = input.DBSnapshotIdentifier;
    const did = input.DBInstanceIdentifier;
    if (!sid) throw new RdsError("InvalidParameterValue", "DBSnapshotIdentifier is required.");
    const inst = this.instances.get(did);
    if (!inst) throw new RdsError("DBInstanceNotFound", `DBInstance ${did} not found.`);
    const snap = {
      DBSnapshotIdentifier: sid,
      DBSnapshotArn: `arn:aws:rds:${this.region}:${this.accountId}:snapshot:${sid}`,
      DBInstanceIdentifier: did,
      Engine: inst.Engine,
      EngineVersion: inst.EngineVersion,
      Status: "available",
      AllocatedStorage: inst.AllocatedStorage,
      SnapshotType: "manual",
      SnapshotCreateTime: new Date().toISOString(),
    };
    this.snapshots.set(sid, snap);
    return snap;
  }

  describeDBSnapshots(input) {
    let list = [...this.snapshots.values()];
    if (input.DBSnapshotIdentifier) {
      list = list.filter((s) => s.DBSnapshotIdentifier === input.DBSnapshotIdentifier);
    }
    if (input.DBInstanceIdentifier) {
      list = list.filter((s) => s.DBInstanceIdentifier === input.DBInstanceIdentifier);
    }
    return { DBSnapshots: list };
  }

  // ---- writers ----------------------------------------------------------
  buildResultXml(result) {
    return Object.entries(result)
      .map(([k, v]) => xmlNode(k, v))
      .join("");
  }

  sendXml(res, status, operation, resultTag, result) {
    const requestId = res.getHeader("x-amzn-RequestId") || randomUUID();
    const responseTag = `${operation}Response`;
    const resultXml = this.buildResultXml(result);
    const resultBlock = resultXml.length ? `<${resultTag}>${resultXml}</${resultTag}>` : `<${resultTag}/>`;
    const xml =
      `<${responseTag} xmlns="${RDS_NAMESPACE}">` +
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
    const requestId = res.getHeader("x-amzn-RequestId") || randomUUID();
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    const xml =
      `<ErrorResponse xmlns="${RDS_NAMESPACE}">` +
      `<Error><Type>${fault}</Type><Code>${xmlEscape(code)}</Code>` +
      `<Message>${xmlEscape(error.message || code)}</Message></Error>` +
      `<RequestId>${requestId}</RequestId></ErrorResponse>`;
    res.end(`<?xml version="1.0"?>\n${xml}`);
  }
}

export default RdsServer;
export const API_VERSION_RDS = API_VERSION;
