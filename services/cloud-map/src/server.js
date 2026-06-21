// parlel/cloud-map — a lightweight, dependency-free fake of AWS Cloud Map
// (Route 53 Auto Naming).
//
// Speaks the AWS JSON 1.1 wire protocol (target prefix
// Route53AutoNaming_v20170314). Requests are POST / with header
// `X-Amz-Target: Route53AutoNaming_v20170314.<Operation>` and JSON bodies.
// State is in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const TARGET_PREFIX = "Route53AutoNaming_v20170314";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidInput: 400,
  NamespaceNotFound: 400,
  ServiceNotFound: 400,
  InstanceNotFound: 400,
  NamespaceAlreadyExists: 400,
  ServiceAlreadyExists: 400,
  ResourceInUse: 400,
  ResourceLimitExceeded: 400,
  DuplicateRequest: 400,
  InternalError: 500,
};

class CloudMapError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function shortId(prefix) {
  return `${prefix}-${randomBytes(13).toString("hex").slice(0, 17)}`;
}

export class CloudMapServer {
  constructor(port = 4717, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.namespaces = new Map(); // id -> namespace
    this.services = new Map(); // id -> service
    this.instances = new Map(); // serviceId -> Map<instanceId, instance>
    this.operations = new Map(); // operationId -> operation
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new CloudMapError("InternalError", error.message, 500));
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
        service: "cloud-map",
        namespaces: this.namespaces.size,
        services: this.services.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-cloud-map");

    if (method !== "POST") {
      return this.sendError(res, new CloudMapError("InvalidInput", "Only POST supported", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new CloudMapError("InvalidInput", "Invalid JSON", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof CloudMapError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateHttpNamespace":
        return this.createNamespace(input, "HTTP");
      case "CreatePrivateDnsNamespace":
        return this.createNamespace(input, "DNS_PRIVATE");
      case "CreatePublicDnsNamespace":
        return this.createNamespace(input, "DNS_PUBLIC");
      case "ListNamespaces":
        return this.listNamespaces(input);
      case "GetNamespace":
        return this.getNamespace(input);
      case "DeleteNamespace":
        return this.deleteNamespace(input);
      case "CreateService":
        return this.createService(input);
      case "ListServices":
        return this.listServices(input);
      case "GetService":
        return this.getService(input);
      case "DeleteService":
        return this.deleteService(input);
      case "RegisterInstance":
        return this.registerInstance(input);
      case "DeregisterInstance":
        return this.deregisterInstance(input);
      case "GetInstance":
        return this.getInstance(input);
      case "ListInstances":
        return this.listInstances(input);
      case "DiscoverInstances":
        return this.discoverInstances(input);
      case "GetOperation":
        return this.getOperation(input);
      default:
        throw new CloudMapError(
          "InvalidInput",
          `The action ${operation || "(none)"} is not valid.`,
          400,
        );
    }
  }

  newOperation(type, targets = {}) {
    const id = randomBytes(16).toString("hex");
    this.operations.set(id, {
      Id: id,
      Type: type,
      Status: "SUCCESS",
      CreateDate: Date.now() / 1000,
      UpdateDate: Date.now() / 1000,
      Targets: targets,
    });
    return id;
  }

  getOperation(input) {
    const op = this.operations.get(input.OperationId);
    if (!op) throw new CloudMapError("InvalidInput", `Operation ${input.OperationId} not found`);
    return { Operation: op };
  }

  // -------------------------------------------------------------------------
  // Namespaces
  // -------------------------------------------------------------------------
  createNamespace(input, type) {
    const name = input.Name;
    if (!name) throw new CloudMapError("InvalidInput", "Name is required");
    for (const ns of this.namespaces.values()) {
      if (ns.Name === name) {
        throw new CloudMapError("NamespaceAlreadyExists", `Namespace ${name} already exists`);
      }
    }
    const id = shortId("ns");
    const arn = `arn:aws:servicediscovery:${this.region}:${this.accountId}:namespace/${id}`;
    const namespace = {
      Id: id,
      Arn: arn,
      Name: name,
      Type: type,
      Description: input.Description,
      ServiceCount: 0,
      Properties:
        type === "HTTP"
          ? { HttpProperties: { HttpName: name } }
          : { DnsProperties: { HostedZoneId: `Z${randomBytes(7).toString("hex").toUpperCase().slice(0, 13)}` } },
      CreateDate: Date.now() / 1000,
      vpc: input.Vpc,
    };
    this.namespaces.set(id, namespace);
    const operationId = this.newOperation("CREATE_NAMESPACE", { NAMESPACE: id });
    return { OperationId: operationId };
  }

  listNamespaces() {
    return {
      Namespaces: [...this.namespaces.values()].map((ns) => ({
        Id: ns.Id,
        Arn: ns.Arn,
        Name: ns.Name,
        Type: ns.Type,
        Description: ns.Description,
        ServiceCount: this.namespaceServiceCount(ns.Id),
        CreateDate: ns.CreateDate,
      })),
    };
  }

  namespaceServiceCount(nsId) {
    let count = 0;
    for (const svc of this.services.values()) {
      if (svc.NamespaceId === nsId) count += 1;
    }
    return count;
  }

  requireNamespace(id) {
    const ns = this.namespaces.get(id);
    if (!ns) throw new CloudMapError("NamespaceNotFound", `Namespace ${id} not found`);
    return ns;
  }

  getNamespace(input) {
    const ns = this.requireNamespace(input.Id);
    return {
      Namespace: {
        Id: ns.Id,
        Arn: ns.Arn,
        Name: ns.Name,
        Type: ns.Type,
        Description: ns.Description,
        ServiceCount: this.namespaceServiceCount(ns.Id),
        Properties: ns.Properties,
        CreateDate: ns.CreateDate,
      },
    };
  }

  deleteNamespace(input) {
    const ns = this.requireNamespace(input.Id);
    if (this.namespaceServiceCount(ns.Id) > 0) {
      throw new CloudMapError("ResourceInUse", "The namespace still contains services");
    }
    this.namespaces.delete(ns.Id);
    const operationId = this.newOperation("DELETE_NAMESPACE", { NAMESPACE: ns.Id });
    return { OperationId: operationId };
  }

  // -------------------------------------------------------------------------
  // Services
  // -------------------------------------------------------------------------
  createService(input) {
    const name = input.Name;
    if (!name) throw new CloudMapError("InvalidInput", "Name is required");
    const namespaceId = input.NamespaceId;
    if (namespaceId) this.requireNamespace(namespaceId);
    for (const svc of this.services.values()) {
      if (svc.Name === name && svc.NamespaceId === namespaceId) {
        throw new CloudMapError("ServiceAlreadyExists", `Service ${name} already exists`);
      }
    }
    const id = shortId("srv");
    const arn = `arn:aws:servicediscovery:${this.region}:${this.accountId}:service/${id}`;
    const service = {
      Id: id,
      Arn: arn,
      Name: name,
      NamespaceId: namespaceId,
      Description: input.Description,
      DnsConfig: input.DnsConfig,
      HealthCheckConfig: input.HealthCheckConfig,
      HealthCheckCustomConfig: input.HealthCheckCustomConfig,
      Type: input.Type,
      CreateDate: Date.now() / 1000,
    };
    this.services.set(id, service);
    this.instances.set(id, new Map());
    return { Service: { ...service, InstanceCount: 0 } };
  }

  listServices(input) {
    let services = [...this.services.values()];
    const filters = input.Filters || [];
    for (const f of filters) {
      if (f.Name === "NAMESPACE_ID") {
        services = services.filter((s) => (f.Values || []).includes(s.NamespaceId));
      }
    }
    return {
      Services: services.map((s) => ({
        Id: s.Id,
        Arn: s.Arn,
        Name: s.Name,
        Type: s.Type,
        Description: s.Description,
        InstanceCount: this.instances.get(s.Id).size,
        DnsConfig: s.DnsConfig,
        CreateDate: s.CreateDate,
      })),
    };
  }

  requireService(id) {
    const svc = this.services.get(id);
    if (!svc) throw new CloudMapError("ServiceNotFound", `Service ${id} not found`);
    return svc;
  }

  getService(input) {
    const svc = this.requireService(input.Id);
    return {
      Service: {
        Id: svc.Id,
        Arn: svc.Arn,
        Name: svc.Name,
        NamespaceId: svc.NamespaceId,
        Description: svc.Description,
        InstanceCount: this.instances.get(svc.Id).size,
        DnsConfig: svc.DnsConfig,
        HealthCheckConfig: svc.HealthCheckConfig,
        Type: svc.Type,
        CreateDate: svc.CreateDate,
      },
    };
  }

  deleteService(input) {
    const svc = this.requireService(input.Id);
    if (this.instances.get(svc.Id).size > 0) {
      throw new CloudMapError("ResourceInUse", "The service still contains instances");
    }
    this.services.delete(svc.Id);
    this.instances.delete(svc.Id);
    return {};
  }

  // -------------------------------------------------------------------------
  // Instances
  // -------------------------------------------------------------------------
  registerInstance(input) {
    const svc = this.requireService(input.ServiceId);
    const instanceId = input.InstanceId;
    if (!instanceId) throw new CloudMapError("InvalidInput", "InstanceId is required");
    const instances = this.instances.get(svc.Id);
    instances.set(instanceId, {
      Id: instanceId,
      Attributes: input.Attributes || {},
    });
    const operationId = this.newOperation("REGISTER_INSTANCE", {
      INSTANCE: instanceId,
      SERVICE: svc.Id,
    });
    return { OperationId: operationId };
  }

  deregisterInstance(input) {
    const svc = this.requireService(input.ServiceId);
    const instances = this.instances.get(svc.Id);
    if (!instances.has(input.InstanceId)) {
      throw new CloudMapError("InstanceNotFound", `Instance ${input.InstanceId} not found`);
    }
    instances.delete(input.InstanceId);
    const operationId = this.newOperation("DEREGISTER_INSTANCE", {
      INSTANCE: input.InstanceId,
      SERVICE: svc.Id,
    });
    return { OperationId: operationId };
  }

  getInstance(input) {
    const svc = this.requireService(input.ServiceId);
    const inst = this.instances.get(svc.Id).get(input.InstanceId);
    if (!inst) throw new CloudMapError("InstanceNotFound", `Instance ${input.InstanceId} not found`);
    return { Instance: inst };
  }

  listInstances(input) {
    const svc = this.requireService(input.ServiceId);
    const instances = [...this.instances.get(svc.Id).values()];
    return {
      Instances: instances.map((i) => ({ Id: i.Id, Attributes: i.Attributes })),
    };
  }

  discoverInstances(input) {
    const namespaceName = input.NamespaceName;
    const serviceName = input.ServiceName;
    const ns = [...this.namespaces.values()].find((n) => n.Name === namespaceName);
    if (!ns) throw new CloudMapError("NamespaceNotFound", `Namespace ${namespaceName} not found`);
    const svc = [...this.services.values()].find(
      (s) => s.Name === serviceName && s.NamespaceId === ns.Id,
    );
    if (!svc) throw new CloudMapError("ServiceNotFound", `Service ${serviceName} not found`);
    let instances = [...this.instances.get(svc.Id).values()];
    const queryParams = input.QueryParameters || {};
    if (Object.keys(queryParams).length > 0) {
      instances = instances.filter((i) =>
        Object.entries(queryParams).every(([k, v]) => i.Attributes[k] === v),
      );
    }
    return {
      Instances: instances.map((i) => ({
        InstanceId: i.Id,
        NamespaceName: namespaceName,
        ServiceName: serviceName,
        HealthStatus: "HEALTHY",
        Attributes: i.Attributes,
      })),
    };
  }

  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalError";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default CloudMapServer;
export const CLOUD_MAP_TARGET_PREFIX = TARGET_PREFIX;
