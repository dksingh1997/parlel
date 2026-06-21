// parlel/opensearch — dependency-free fake of the Amazon OpenSearch Service
// control plane. REST/JSON protocol with versioned paths under /2021-01-01.
//
//   POST   /2021-01-01/opensearch/domain          -> CreateDomain
//   GET    /2021-01-01/opensearch/domain/{name}    -> DescribeDomain
//   GET    /2021-01-01/opensearch/domain           -> ListDomainNames
//   DELETE /2021-01-01/opensearch/domain/{name}    -> DeleteDomain
//   POST   /2021-01-01/opensearch/domain-info      -> DescribeDomains
//
// The data plane reuses the parlel elasticsearch emulator. State is in-memory.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class OpenSearchError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class OpensearchServer {
  constructor(port = 4726, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.domains = new Map(); // name -> domain
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new OpenSearchError("InternalException", error.message, 500));
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

  domainArn(name) {
    return `arn:aws:es:${this.region}:${this.accountId}:domain/${name}`;
  }

  buildDomain(input) {
    const name = input.DomainName;
    return {
      DomainId: `${this.accountId}/${name}`,
      DomainName: name,
      ARN: this.domainArn(name),
      Created: true,
      Deleted: false,
      Endpoint: `search-${name}-parlel.${this.region}.es.amazonaws.com`,
      Processing: false,
      UpgradeProcessing: false,
      EngineVersion: input.EngineVersion || "OpenSearch_2.11",
      ClusterConfig: input.ClusterConfig || {
        InstanceType: "t3.small.search",
        InstanceCount: 1,
        DedicatedMasterEnabled: false,
        ZoneAwarenessEnabled: false,
      },
      EBSOptions: input.EBSOptions || { EBSEnabled: true, VolumeType: "gp3", VolumeSize: 10 },
      AccessPolicies: input.AccessPolicies || "",
      EncryptionAtRestOptions: input.EncryptionAtRestOptions || { Enabled: false },
      NodeToNodeEncryptionOptions: input.NodeToNodeEncryptionOptions || { Enabled: false },
      AdvancedSecurityOptions: input.AdvancedSecurityOptions || { Enabled: false },
    };
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "opensearch", domains: this.domains.size });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());

    const body = await this.readBody(req);
    let input = {};
    if (body.length) {
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        return this.sendError(res, new OpenSearchError("ValidationException", "Invalid JSON.", 400));
      }
    }

    const base = "/2021-01-01/opensearch";
    try {
      if (path === `${base}/domain` && method === "POST") {
        return this.sendJson(res, 200, this.createDomain(input));
      }
      if (path === `${base}/domain` && method === "GET") {
        return this.sendJson(res, 200, this.listDomainNames());
      }
      if (path === `${base}/domain-info` && method === "POST") {
        return this.sendJson(res, 200, this.describeDomains(input));
      }
      const domainMatch = path.match(new RegExp(`^${base}/domain/([^/]+)$`));
      if (domainMatch) {
        const name = decodeURIComponent(domainMatch[1]);
        if (method === "GET") return this.sendJson(res, 200, this.describeDomain(name));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteDomain(name));
      }
      throw new OpenSearchError("ValidationException", `Unknown route: ${method} ${path}`, 404);
    } catch (error) {
      if (error instanceof OpenSearchError) return this.sendError(res, error);
      throw error;
    }
  }

  createDomain(input) {
    const name = input.DomainName;
    if (!name) throw new OpenSearchError("ValidationException", "DomainName is required.");
    if (this.domains.has(name)) {
      throw new OpenSearchError("ResourceAlreadyExistsException", `Domain ${name} already exists.`);
    }
    const domain = this.buildDomain(input);
    domain.Created = true;
    domain.Processing = true;
    this.domains.set(name, domain);
    return { DomainStatus: domain };
  }

  requireDomain(name) {
    const d = this.domains.get(name);
    if (!d) throw new OpenSearchError("ResourceNotFoundException", `Domain ${name} not found.`);
    return d;
  }

  describeDomain(name) {
    const d = this.requireDomain(name);
    return { DomainStatus: d };
  }

  describeDomains(input) {
    const names = input.DomainNames || [];
    const list = names.map((n) => this.domains.get(n)).filter(Boolean);
    return { DomainStatusList: list };
  }

  listDomainNames() {
    return {
      DomainNames: [...this.domains.values()].map((d) => ({
        DomainName: d.DomainName,
        EngineType: d.EngineVersion.startsWith("Elasticsearch") ? "Elasticsearch" : "OpenSearch",
      })),
    };
  }

  deleteDomain(name) {
    const d = this.requireDomain(name);
    this.domains.delete(name);
    return { DomainStatus: { ...d, Deleted: true, Processing: true } };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", error.code || "ValidationException");
    res.end(JSON.stringify({ __type: error.code, message: error.message }));
  }
}

export default OpensearchServer;
