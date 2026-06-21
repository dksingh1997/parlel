// parlel/efs — a lightweight, dependency-free fake of AWS EFS (Elastic File
// System). EFS uses the AWS REST-JSON protocol with paths under /2015-02-01
// (e.g. POST /2015-02-01/file-systems). The real `@aws-sdk/client-efs` client
// works against it. Pure Node.js, in-memory state.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";
const BASE = "/2015-02-01";

const ERROR_STATUS = {
  FileSystemAlreadyExists: 409,
  FileSystemNotFound: 404,
  FileSystemInUse: 409,
  MountTargetNotFound: 404,
  BadRequest: 400,
  IncorrectFileSystemLifeCycleState: 409,
  InternalServerError: 500,
};

class EfsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function fsId() {
  return `fs-${randomBytes(8).toString("hex").slice(0, 17)}`;
}
function mtId() {
  return `fsmt-${randomBytes(8).toString("hex").slice(0, 17)}`;
}

export class EfsServer {
  constructor(port = 4708, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.fileSystems = new Map(); // id -> fs
    this.mountTargets = new Map(); // id -> mt
    this.creationTokens = new Map(); // token -> fsId (idempotency)
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new EfsError("InternalServerError", error.message, 500));
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
        service: "efs",
        fileSystems: this.fileSystems.size,
        mountTargets: this.mountTargets.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-efs");

    const body = await this.readBody(req);
    let input = {};
    if (body.length) {
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        return this.sendError(res, new EfsError("BadRequest", "Body is not valid JSON.", 400));
      }
    }

    try {
      const output = this.route(method, path, input, url);
      return this.sendJson(res, output.status || 200, output.body ?? {});
    } catch (error) {
      if (error instanceof EfsError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, input, url) {
    let rest = path;
    if (rest.startsWith(BASE)) rest = rest.slice(BASE.length);
    const segments = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));

    // /file-systems
    if (segments.length === 1 && segments[0] === "file-systems") {
      if (method === "POST") return { status: 201, body: this.createFileSystem(input) };
      if (method === "GET") return { status: 200, body: this.describeFileSystems(url) };
    }
    // /file-systems/{id}
    if (segments.length === 2 && segments[0] === "file-systems") {
      const id = segments[1];
      if (method === "DELETE") return { status: 204, body: this.deleteFileSystem(id) };
      if (method === "GET") return { status: 200, body: this.describeFileSystems(url, id) };
    }
    // /mount-targets
    if (segments.length === 1 && segments[0] === "mount-targets") {
      if (method === "POST") return { status: 200, body: this.createMountTarget(input) };
      if (method === "GET") return { status: 200, body: this.describeMountTargets(url) };
    }

    throw new EfsError("BadRequest", `No route for ${method} ${path}`, 404);
  }

  fsArn(id) {
    return `arn:aws:elasticfilesystem:${this.region}:${this.accountId}:file-system/${id}`;
  }

  fsView(fs) {
    return {
      OwnerId: this.accountId,
      CreationToken: fs.creationToken,
      FileSystemId: fs.id,
      FileSystemArn: this.fsArn(fs.id),
      CreationTime: fs.creationTime / 1000,
      LifeCycleState: fs.lifeCycleState,
      Name: fs.name,
      NumberOfMountTargets: [...this.mountTargets.values()].filter((m) => m.fileSystemId === fs.id).length,
      SizeInBytes: { Value: 0, Timestamp: Date.now() / 1000, ValueInIA: 0, ValueInStandard: 0 },
      PerformanceMode: fs.performanceMode,
      ThroughputMode: fs.throughputMode,
      Encrypted: fs.encrypted,
      KmsKeyId: fs.kmsKeyId,
      Tags: fs.tags,
      AvailabilityZoneName: fs.availabilityZoneName,
    };
  }

  createFileSystem(input) {
    const token = input.CreationToken || randomUUID();
    // Idempotency on creation token.
    if (this.creationTokens.has(token)) {
      const existingId = this.creationTokens.get(token);
      const existing = this.fileSystems.get(existingId);
      if (existing) {
        throw new EfsError("FileSystemAlreadyExists", `File system already exists with creation token ${token}`, 409);
      }
    }
    const id = fsId();
    const fs = {
      id,
      creationToken: token,
      creationTime: Date.now(),
      lifeCycleState: "available",
      name: (input.Tags || []).find((t) => t.Key === "Name")?.Value,
      performanceMode: input.PerformanceMode || "generalPurpose",
      throughputMode: input.ThroughputMode || "bursting",
      encrypted: input.Encrypted === true,
      kmsKeyId: input.KmsKeyId,
      tags: input.Tags || [],
      availabilityZoneName: input.AvailabilityZoneName,
    };
    this.fileSystems.set(id, fs);
    this.creationTokens.set(token, id);
    return this.fsView(fs);
  }

  requireFs(id) {
    const fs = this.fileSystems.get(id);
    if (!fs) throw new EfsError("FileSystemNotFound", `File system '${id}' does not exist.`, 404);
    return fs;
  }

  describeFileSystems(url, idFromPath) {
    const id = idFromPath || url.searchParams.get("FileSystemId");
    if (id) {
      const fs = this.requireFs(id);
      return { FileSystems: [this.fsView(fs)] };
    }
    const token = url.searchParams.get("CreationToken");
    let all = [...this.fileSystems.values()];
    if (token) all = all.filter((f) => f.creationToken === token);
    return { FileSystems: all.map((f) => this.fsView(f)) };
  }

  deleteFileSystem(id) {
    const fs = this.requireFs(id);
    const mts = [...this.mountTargets.values()].filter((m) => m.fileSystemId === id);
    if (mts.length > 0) {
      throw new EfsError("FileSystemInUse", `File system '${id}' has mount targets and cannot be deleted.`, 409);
    }
    this.fileSystems.delete(id);
    this.creationTokens.delete(fs.creationToken);
    return {};
  }

  // -------------------------------------------------------------------------
  // Mount targets
  // -------------------------------------------------------------------------
  mtView(mt) {
    return {
      OwnerId: this.accountId,
      MountTargetId: mt.id,
      FileSystemId: mt.fileSystemId,
      SubnetId: mt.subnetId,
      LifeCycleState: mt.lifeCycleState,
      IpAddress: mt.ipAddress,
      NetworkInterfaceId: mt.networkInterfaceId,
      AvailabilityZoneId: mt.availabilityZoneId,
      AvailabilityZoneName: mt.availabilityZoneName,
      VpcId: mt.vpcId,
    };
  }

  createMountTarget(input) {
    const fsId2 = input.FileSystemId;
    this.requireFs(fsId2);
    if (!input.SubnetId) throw new EfsError("BadRequest", "SubnetId is required.", 400);
    const id = mtId();
    const octet = 10 + this.mountTargets.size;
    const mt = {
      id,
      fileSystemId: fsId2,
      subnetId: input.SubnetId,
      lifeCycleState: "available",
      ipAddress: input.IpAddress || `10.0.0.${octet}`,
      networkInterfaceId: `eni-${randomBytes(8).toString("hex").slice(0, 17)}`,
      availabilityZoneId: `${this.region}-az1`,
      availabilityZoneName: `${this.region}a`,
      vpcId: `vpc-${randomBytes(8).toString("hex").slice(0, 17)}`,
    };
    this.mountTargets.set(id, mt);
    return this.mtView(mt);
  }

  describeMountTargets(url) {
    const fsId2 = url.searchParams.get("FileSystemId");
    const mtIdQ = url.searchParams.get("MountTargetId");
    let all = [...this.mountTargets.values()];
    if (mtIdQ) {
      const mt = this.mountTargets.get(mtIdQ);
      if (!mt) throw new EfsError("MountTargetNotFound", `Mount target '${mtIdQ}' does not exist.`, 404);
      all = [mt];
    } else if (fsId2) {
      this.requireFs(fsId2);
      all = all.filter((m) => m.fileSystemId === fsId2);
    } else {
      throw new EfsError("BadRequest", "Either FileSystemId or MountTargetId must be provided.", 400);
    }
    return { MountTargets: all.map((m) => this.mtView(m)) };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    if (status === 204) return res.end();
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerError";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ ErrorCode: code, __type: code, Message: error.message || code, message: error.message || code }));
  }
}

export default EfsServer;
