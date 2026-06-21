// parlel/transfer-family — a lightweight, dependency-free fake of AWS Transfer
// Family (SFTP/FTPS/FTP servers and users).
//
// Speaks the AWS JSON 1.1 wire protocol (target prefix TransferService).
// Requests are POST / with header `X-Amz-Target: TransferService.<Operation>`
// and JSON bodies. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const TARGET_PREFIX = "TransferService";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidRequestException: 400,
  ResourceNotFoundException: 400,
  ResourceExistsException: 400,
  ServiceUnavailableException: 500,
  InternalServiceError: 500,
  ThrottlingException: 429,
};

class TransferError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function serverId() {
  return `s-${randomBytes(8).toString("hex").slice(0, 17)}`;
}

export class TransferFamilyServer {
  constructor(port = 4718, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.servers = new Map(); // serverId -> server
    this.users = new Map(); // serverId -> Map<userName, user>
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new TransferError("InternalServiceError", error.message, 500));
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
        service: "transfer-family",
        servers: this.servers.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-transfer-family");

    if (method !== "POST") {
      return this.sendError(res, new TransferError("InvalidRequestException", "Only POST supported", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new TransferError("InvalidRequestException", "Invalid JSON", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof TransferError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateServer":
        return this.createServer(input);
      case "ListServers":
        return this.listServers(input);
      case "DescribeServer":
        return this.describeServer(input);
      case "DeleteServer":
        return this.deleteServer(input);
      case "StartServer":
        return this.startServer(input);
      case "StopServer":
        return this.stopServer(input);
      case "CreateUser":
        return this.createUser(input);
      case "ListUsers":
        return this.listUsers(input);
      case "DescribeUser":
        return this.describeUser(input);
      case "DeleteUser":
        return this.deleteUser(input);
      default:
        throw new TransferError(
          "InvalidRequestException",
          `The action ${operation || "(none)"} is not valid.`,
          400,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------
  createServer(input) {
    const id = serverId();
    const arn = `arn:aws:transfer:${this.region}:${this.accountId}:server/${id}`;
    const protocols = input.Protocols || ["SFTP"];
    const server = {
      ServerId: id,
      Arn: arn,
      Protocols: protocols,
      Domain: input.Domain || "S3",
      EndpointType: input.EndpointType || "PUBLIC",
      IdentityProviderType: input.IdentityProviderType || "SERVICE_MANAGED",
      LoggingRole: input.LoggingRole,
      State: "ONLINE",
      UserCount: 0,
      Tags: input.Tags || [],
      SecurityPolicyName: input.SecurityPolicyName || "TransferSecurityPolicy-2020-06",
    };
    this.servers.set(id, server);
    this.users.set(id, new Map());
    return { ServerId: id };
  }

  listServers() {
    return {
      Servers: [...this.servers.values()].map((s) => ({
        Arn: s.Arn,
        ServerId: s.ServerId,
        Domain: s.Domain,
        EndpointType: s.EndpointType,
        IdentityProviderType: s.IdentityProviderType,
        State: s.State,
        UserCount: this.users.get(s.ServerId).size,
      })),
    };
  }

  requireServer(serverId) {
    if (!serverId) throw new TransferError("InvalidRequestException", "ServerId is required");
    const server = this.servers.get(serverId);
    if (!server) {
      throw new TransferError("ResourceNotFoundException", `Server ${serverId} does not exist`);
    }
    return server;
  }

  describeServer(input) {
    const s = this.requireServer(input.ServerId);
    return {
      Server: {
        Arn: s.Arn,
        ServerId: s.ServerId,
        Protocols: s.Protocols,
        Domain: s.Domain,
        EndpointType: s.EndpointType,
        IdentityProviderType: s.IdentityProviderType,
        LoggingRole: s.LoggingRole,
        State: s.State,
        UserCount: this.users.get(s.ServerId).size,
        Tags: s.Tags,
        SecurityPolicyName: s.SecurityPolicyName,
      },
    };
  }

  deleteServer(input) {
    const s = this.requireServer(input.ServerId);
    this.servers.delete(s.ServerId);
    this.users.delete(s.ServerId);
    return {};
  }

  startServer(input) {
    const s = this.requireServer(input.ServerId);
    s.State = "ONLINE";
    return {};
  }

  stopServer(input) {
    const s = this.requireServer(input.ServerId);
    s.State = "OFFLINE";
    return {};
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  createUser(input) {
    const s = this.requireServer(input.ServerId);
    const userName = input.UserName;
    if (!userName) throw new TransferError("InvalidRequestException", "UserName is required");
    const users = this.users.get(s.ServerId);
    if (users.has(userName)) {
      throw new TransferError("ResourceExistsException", `User ${userName} already exists`);
    }
    const arn = `arn:aws:transfer:${this.region}:${this.accountId}:user/${s.ServerId}/${userName}`;
    const user = {
      Arn: arn,
      UserName: userName,
      ServerId: s.ServerId,
      Role: input.Role,
      HomeDirectory: input.HomeDirectory,
      HomeDirectoryType: input.HomeDirectoryType || "PATH",
      HomeDirectoryMappings: input.HomeDirectoryMappings,
      Policy: input.Policy,
      PosixProfile: input.PosixProfile,
      SshPublicKeys: input.SshPublicKeyBody
        ? [
            {
              SshPublicKeyId: `key-${randomBytes(8).toString("hex").slice(0, 17)}`,
              SshPublicKeyBody: input.SshPublicKeyBody,
              DateImported: Date.now() / 1000,
            },
          ]
        : [],
      Tags: input.Tags || [],
    };
    users.set(userName, user);
    return { ServerId: s.ServerId, UserName: userName };
  }

  listUsers(input) {
    const s = this.requireServer(input.ServerId);
    const users = [...this.users.get(s.ServerId).values()];
    return {
      ServerId: s.ServerId,
      Users: users.map((u) => ({
        Arn: u.Arn,
        UserName: u.UserName,
        Role: u.Role,
        HomeDirectory: u.HomeDirectory,
        HomeDirectoryType: u.HomeDirectoryType,
        SshPublicKeyCount: u.SshPublicKeys.length,
      })),
    };
  }

  describeUser(input) {
    const s = this.requireServer(input.ServerId);
    const user = this.users.get(s.ServerId).get(input.UserName);
    if (!user) {
      throw new TransferError("ResourceNotFoundException", `User ${input.UserName} does not exist`);
    }
    return { ServerId: s.ServerId, User: user };
  }

  deleteUser(input) {
    const s = this.requireServer(input.ServerId);
    const users = this.users.get(s.ServerId);
    if (!users.has(input.UserName)) {
      throw new TransferError("ResourceNotFoundException", `User ${input.UserName} does not exist`);
    }
    users.delete(input.UserName);
    return {};
  }

  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServiceError";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default TransferFamilyServer;
export const TRANSFER_TARGET_PREFIX = TARGET_PREFIX;
