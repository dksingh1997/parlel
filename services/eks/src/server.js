// parlel/eks — a lightweight, dependency-free fake of AWS EKS (Elastic Kubernetes
// Service). EKS uses the AWS REST-JSON protocol: operations are expressed as
// HTTP method + path (e.g. POST /clusters, GET /clusters/{name}). The real
// `@aws-sdk/client-eks` client works against it. Pure Node.js, in-memory state.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ResourceInUseException: 409,
  ResourceNotFoundException: 404,
  InvalidParameterException: 400,
  InvalidRequestException: 400,
  ResourceLimitExceededException: 400,
  ServerException: 500,
  NotFoundException: 404,
};

class EksError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class EksServer {
  constructor(port = 4704, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // clusters: Map<name, cluster>
    //   cluster.accessEntries: Map<principalArn, entry>
    this.clusters = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new EksError("ServerException", error.message, 500));
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
      return this.sendJson(res, 200, { status: "ok", service: "eks", clusters: this.clusters.size });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-eks");

    const body = await this.readBody(req);
    let input = {};
    if (body.length) {
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        return this.sendError(res, new EksError("InvalidRequestException", "Body is not valid JSON.", 400));
      }
    }

    try {
      const output = this.route(method, path, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof EksError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, input) {
    // Strip trailing slash (except root).
    const segments = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));

    // /clusters
    if (segments.length === 1 && segments[0] === "clusters") {
      if (method === "POST") return this.createCluster(input);
      if (method === "GET") return this.listClusters(input);
    }
    // /clusters/{name}
    if (segments.length === 2 && segments[0] === "clusters") {
      const name = segments[1];
      if (method === "GET") return this.describeCluster(name);
      if (method === "DELETE") return this.deleteCluster(name);
    }
    // /clusters/{name}/access-entries
    if (segments.length === 3 && segments[0] === "clusters" && segments[2] === "access-entries") {
      const name = segments[1];
      if (method === "POST") return this.createAccessEntry(name, input);
      if (method === "GET") return this.listAccessEntries(name);
    }

    throw new EksError("NotFoundException", `No route for ${method} ${path}`, 404);
  }

  clusterArn(name) {
    return `arn:aws:eks:${this.region}:${this.accountId}:cluster/${name}`;
  }

  requireCluster(name) {
    const c = this.clusters.get(name);
    if (!c) throw new EksError("ResourceNotFoundException", `No cluster found for name: ${name}.`);
    return c;
  }

  clusterView(c) {
    return {
      name: c.name,
      arn: c.arn,
      createdAt: c.createdAt / 1000,
      version: c.version,
      endpoint: c.endpoint,
      roleArn: c.roleArn,
      resourcesVpcConfig: c.resourcesVpcConfig,
      kubernetesNetworkConfig: c.kubernetesNetworkConfig,
      status: c.status,
      certificateAuthority: { data: c.certificateAuthority },
      platformVersion: c.platformVersion,
      tags: c.tags,
      accessConfig: c.accessConfig,
      identity: { oidc: { issuer: `https://oidc.eks.${this.region}.amazonaws.com/id/${c.oidcId}` } },
    };
  }

  createCluster(input) {
    const name = input.name;
    if (!name) throw new EksError("InvalidParameterException", "Cluster name is required.");
    if (this.clusters.has(name)) {
      throw new EksError("ResourceInUseException", `Cluster already exists with name: ${name}`);
    }
    const oidcId = randomUUID().replace(/-/g, "").toUpperCase().slice(0, 32);
    const cluster = {
      name,
      arn: this.clusterArn(name),
      createdAt: Date.now(),
      version: input.version || "1.30",
      endpoint: `https://${randomUUID().replace(/-/g, "").slice(0, 32)}.gr7.${this.region}.eks.amazonaws.com`,
      roleArn: input.roleArn,
      resourcesVpcConfig: input.resourcesVpcConfig || {},
      kubernetesNetworkConfig: input.kubernetesNetworkConfig || { serviceIpv4Cidr: "10.100.0.0/16", ipFamily: "ipv4" },
      status: "ACTIVE",
      certificateAuthority: Buffer.from(`parlel-ca-${name}`).toString("base64"),
      platformVersion: "eks.1",
      tags: input.tags || {},
      accessConfig: input.accessConfig || { authenticationMode: "API_AND_CONFIG_MAP" },
      oidcId,
      accessEntries: new Map(),
    };
    this.clusters.set(name, cluster);
    return { cluster: this.clusterView(cluster) };
  }

  listClusters(input) {
    void input;
    return { clusters: [...this.clusters.keys()] };
  }

  describeCluster(name) {
    const c = this.requireCluster(name);
    return { cluster: this.clusterView(c) };
  }

  deleteCluster(name) {
    const c = this.requireCluster(name);
    this.clusters.delete(name);
    return { cluster: { ...this.clusterView(c), status: "DELETING" } };
  }

  // -------------------------------------------------------------------------
  // Access entries
  // -------------------------------------------------------------------------
  accessEntryView(name, e) {
    return {
      clusterName: name,
      principalArn: e.principalArn,
      kubernetesGroups: e.kubernetesGroups,
      accessEntryArn: e.accessEntryArn,
      createdAt: e.createdAt / 1000,
      modifiedAt: e.modifiedAt / 1000,
      tags: e.tags,
      username: e.username,
      type: e.type,
    };
  }

  createAccessEntry(name, input) {
    const cluster = this.requireCluster(name);
    const principalArn = input.principalArn;
    if (!principalArn) throw new EksError("InvalidParameterException", "principalArn is required.");
    if (cluster.accessEntries.has(principalArn)) {
      throw new EksError("ResourceInUseException", `Access entry already exists for principal: ${principalArn}`);
    }
    const now = Date.now();
    const entry = {
      principalArn,
      kubernetesGroups: input.kubernetesGroups || [],
      accessEntryArn: `${cluster.arn}/access-entry/${randomUUID()}`,
      createdAt: now,
      modifiedAt: now,
      tags: input.tags || {},
      username: input.username || principalArn,
      type: input.type || "STANDARD",
    };
    cluster.accessEntries.set(principalArn, entry);
    return { accessEntry: this.accessEntryView(name, entry) };
  }

  listAccessEntries(name) {
    const cluster = this.requireCluster(name);
    return { accessEntries: [...cluster.accessEntries.keys()] };
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

export default EksServer;
