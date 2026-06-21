// parlel/s3-tables — dependency-free fake of Amazon S3 Tables.
//
// REST/JSON protocol:
//   POST   /table-buckets                                 -> CreateTableBucket
//   GET    /table-buckets                                 -> ListTableBuckets
//   GET    /table-buckets/{arn}                           -> GetTableBucket
//   DELETE /table-buckets/{arn}                           -> DeleteTableBucket
//   PUT    /namespaces/{tableBucketARN}                   -> CreateNamespace
//   GET    /namespaces/{tableBucketARN}                   -> ListNamespaces
//   PUT    /tables/{tableBucketARN}/{namespace}           -> CreateTable
//   GET    /tables/{tableBucketARN}/{namespace}           -> ListTables
//   GET    /get-table/{tableBucketARN}/{namespace}/{name} -> GetTable
//
// State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class S3TablesError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class S3TablesServer {
  constructor(port = 4727, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // buckets: Map<arn, { name, arn, createdAt, namespaces: Map<ns, {tables: Map<name, table>}> }>
    this.buckets = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new S3TablesError("InternalServerError", error.message, 500));
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

  bucketArn(name) {
    return `arn:aws:s3tables:${this.region}:${this.accountId}:bucket/${name}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = decodeURIComponent(url.pathname);

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "s3-tables", buckets: this.buckets.size });
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
        return this.sendError(res, new S3TablesError("BadRequestException", "Invalid JSON.", 400));
      }
    }

    try {
      const segs = path.split("/").filter(Boolean);
      const top = segs[0];

      if (top === "table-buckets") {
        if (method === "POST" && segs.length === 1) return this.sendJson(res, 200, this.createTableBucket(input));
        if (method === "GET" && segs.length === 1) return this.sendJson(res, 200, this.listTableBuckets());
        if (segs.length >= 2) {
          const arn = segs.slice(1).join("/");
          if (method === "GET") return this.sendJson(res, 200, this.getTableBucket(arn));
          if (method === "DELETE") return this.sendJson(res, 200, this.deleteTableBucket(arn));
        }
      }
      if (top === "namespaces") {
        const arn = segs.slice(1).join("/");
        if (method === "PUT") return this.sendJson(res, 200, this.createNamespace(arn, input));
        if (method === "GET") return this.sendJson(res, 200, this.listNamespaces(arn));
      }
      if (top === "tables") {
        // /tables/{arn...}/{namespace}
        const rest = segs.slice(1);
        const namespace = rest[rest.length - 1];
        const arn = rest.slice(0, -1).join("/");
        if (method === "PUT") return this.sendJson(res, 200, this.createTable(arn, namespace, input));
        if (method === "GET") return this.sendJson(res, 200, this.listTables(arn, namespace));
      }
      if (top === "get-table") {
        const rest = segs.slice(1);
        const name = rest[rest.length - 1];
        const namespace = rest[rest.length - 2];
        const arn = rest.slice(0, -2).join("/");
        if (method === "GET") return this.sendJson(res, 200, this.getTable(arn, namespace, name));
      }
      throw new S3TablesError("BadRequestException", `Unknown route: ${method} ${path}`, 404);
    } catch (error) {
      if (error instanceof S3TablesError) return this.sendError(res, error);
      throw error;
    }
  }

  createTableBucket(input) {
    const name = input.name;
    if (!name) throw new S3TablesError("BadRequestException", "name is required.");
    const arn = this.bucketArn(name);
    if (this.buckets.has(arn)) {
      throw new S3TablesError("ConflictException", `Table bucket ${name} already exists.`);
    }
    this.buckets.set(arn, {
      name,
      arn,
      createdAt: Math.floor(Date.now() / 1000),
      ownerAccountId: this.accountId,
      namespaces: new Map(),
    });
    return { arn };
  }

  listTableBuckets() {
    return {
      tableBuckets: [...this.buckets.values()].map((b) => ({
        arn: b.arn,
        name: b.name,
        ownerAccountId: b.ownerAccountId,
        createdAt: b.createdAt,
      })),
    };
  }

  requireBucket(arn) {
    const b = this.buckets.get(arn);
    if (!b) throw new S3TablesError("NotFoundException", `Table bucket ${arn} not found.`);
    return b;
  }

  getTableBucket(arn) {
    const b = this.requireBucket(arn);
    return { arn: b.arn, name: b.name, ownerAccountId: b.ownerAccountId, createdAt: b.createdAt };
  }

  deleteTableBucket(arn) {
    this.requireBucket(arn);
    this.buckets.delete(arn);
    return {};
  }

  createNamespace(arn, input) {
    const b = this.requireBucket(arn);
    const ns = Array.isArray(input.namespace) ? input.namespace[0] : input.namespace;
    if (!ns) throw new S3TablesError("BadRequestException", "namespace is required.");
    if (b.namespaces.has(ns)) {
      throw new S3TablesError("ConflictException", `Namespace ${ns} already exists.`);
    }
    b.namespaces.set(ns, { tables: new Map(), createdAt: Math.floor(Date.now() / 1000) });
    return { tableBucketARN: arn, namespace: [ns] };
  }

  listNamespaces(arn) {
    const b = this.requireBucket(arn);
    return {
      namespaces: [...b.namespaces.entries()].map(([ns, v]) => ({
        namespace: [ns],
        createdAt: v.createdAt,
        ownerAccountId: this.accountId,
      })),
    };
  }

  requireNamespace(bucket, ns) {
    const n = bucket.namespaces.get(ns);
    if (!n) throw new S3TablesError("NotFoundException", `Namespace ${ns} not found.`);
    return n;
  }

  createTable(arn, namespace, input) {
    const b = this.requireBucket(arn);
    const n = this.requireNamespace(b, namespace);
    const name = input.name;
    if (!name) throw new S3TablesError("BadRequestException", "name is required.");
    if (n.tables.has(name)) {
      throw new S3TablesError("ConflictException", `Table ${name} already exists.`);
    }
    const tableArn = `${arn}/table/${randomUUID().slice(0, 12)}`;
    const table = {
      name,
      type: input.format ? "customer" : "customer",
      tableARN: tableArn,
      namespace: [namespace],
      format: input.format || "ICEBERG",
      versionToken: randomUUID().replace(/-/g, ""),
      metadataLocation: `s3://${b.name}/${namespace}/${name}/metadata/`,
      createdAt: Math.floor(Date.now() / 1000),
    };
    n.tables.set(name, table);
    return { tableARN: tableArn, versionToken: table.versionToken };
  }

  listTables(arn, namespace) {
    const b = this.requireBucket(arn);
    const n = this.requireNamespace(b, namespace);
    return {
      tables: [...n.tables.values()].map((t) => ({
        namespace: t.namespace,
        name: t.name,
        type: t.type,
        tableARN: t.tableARN,
        createdAt: t.createdAt,
      })),
    };
  }

  getTable(arn, namespace, name) {
    const b = this.requireBucket(arn);
    const n = this.requireNamespace(b, namespace);
    const t = n.tables.get(name);
    if (!t) throw new S3TablesError("NotFoundException", `Table ${name} not found.`);
    return {
      name: t.name,
      type: t.type,
      tableARN: t.tableARN,
      namespace: t.namespace,
      format: t.format,
      versionToken: t.versionToken,
      metadataLocation: t.metadataLocation,
      createdAt: t.createdAt,
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
    res.setHeader("x-amzn-errortype", error.code || "BadRequestException");
    res.end(JSON.stringify({ __type: error.code, message: error.message }));
  }
}

export default S3TablesServer;
