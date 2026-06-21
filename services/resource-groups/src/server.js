// parlel/resource-groups — a lightweight, dependency-free fake of AWS Resource Groups.
//
// Speaks the REST/JSON wire protocol used by `@aws-sdk/client-resource-groups`:
//   POST   /groups                       CreateGroup
//   GET    /groups                       ListGroups (also POST /groups/list)
//   GET    /groups/{name}                GetGroup
//   DELETE /groups/{name}                DeleteGroup
//   POST   /resources/search             SearchResources
//   GET    /groups/{name}/resources      ListGroupResources
//   PUT    /resources/{arn}/tags         Tag
//   GET    /resources/{arn}/tags         GetTags
// Pure Node.js.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/json";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  NotFoundException: 404,
  BadRequestException: 400,
  ValidationException: 400,
  ForbiddenException: 403,
  InternalServerErrorException: 500,
  TooManyRequestsException: 429,
};

class RgError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class ResourceGroupsServer {
  constructor(port = 4736, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.groups = new Map(); // name -> group
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new RgError("InternalServerErrorException", error.message, 500));
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

  groupArn(name) {
    return `arn:aws:resource-groups:${this.region}:${this.accountId}:group/${name}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = decodeURIComponent(url.pathname);

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "resource-groups", groups: this.groups.size });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-resource-groups");

    const body = await this.readBody(req);
    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new RgError("BadRequestException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = this.route(method, path, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof RgError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, input) {
    const segments = path.split("/").filter(Boolean);

    if (path === "/groups" && method === "POST") return this.createGroup(input);
    if (path === "/groups" && method === "GET") return this.listGroups(input);
    if (path === "/groups/list" && method === "POST") return this.listGroups(input);
    if (path === "/resources/search" && method === "POST") return this.searchResources(input);

    // /groups/{name}/resources
    if (segments[0] === "groups" && segments.length === 3 && segments[2] === "resources") {
      const name = segments[1];
      if (method === "GET" || method === "POST") return this.listGroupResources(name, input);
    }
    // /groups/{name}
    if (segments[0] === "groups" && segments.length === 2) {
      const name = segments[1];
      if (method === "GET") return this.getGroup(name, input);
      if (method === "DELETE") return this.deleteGroup(name, input);
      if (method === "PATCH" || method === "PUT") return this.updateGroup(name, input);
    }
    // /resources/{arn}/tags
    if (segments[0] === "resources" && segments[segments.length - 1] === "tags") {
      const arn = segments.slice(1, -1).join("/");
      if (method === "PUT") return this.tag(arn, input);
      if (method === "GET") return this.getTags(arn);
      if (method === "PATCH") return this.untag(arn, input);
    }

    throw new RgError("ValidationException", `No route for ${method} ${path}.`, 400);
  }

  createGroup(input) {
    const name = input.Name || input.GroupName;
    if (!name) throw new RgError("BadRequestException", "Name is required.");
    if (this.groups.has(name)) {
      throw new RgError("BadRequestException", `Group ${name} already exists.`);
    }
    const group = {
      Name: name,
      GroupArn: this.groupArn(name),
      Description: input.Description || "",
      ResourceQuery: input.ResourceQuery,
      Configuration: input.Configuration,
      Tags: input.Tags || {},
      resources: input.Resources || [],
    };
    this.groups.set(name, group);
    return {
      Group: this.groupView(group),
      ResourceQuery: group.ResourceQuery,
      Tags: group.Tags,
    };
  }

  groupView(group) {
    const v = { GroupArn: group.GroupArn, Name: group.Name };
    if (group.Description) v.Description = group.Description;
    return v;
  }

  requireGroup(name) {
    const group = this.groups.get(name);
    if (!group) throw new RgError("NotFoundException", `Group ${name} not found.`);
    return group;
  }

  listGroups() {
    return {
      GroupIdentifiers: [...this.groups.values()].map((g) => ({ GroupName: g.Name, GroupArn: g.GroupArn })),
      Groups: [...this.groups.values()].map((g) => this.groupView(g)),
    };
  }

  resolveGroupName(name) {
    // name may be a group name or ARN.
    if (this.groups.has(name)) return name;
    if (name.startsWith("arn:")) {
      const n = name.split("group/").pop();
      if (this.groups.has(n)) return n;
    }
    return name;
  }

  getGroup(name, input) {
    const resolved = this.resolveGroupName(input.GroupName || input.Group || name);
    const group = this.requireGroup(resolved);
    return { Group: this.groupView(group) };
  }

  deleteGroup(name, input) {
    const resolved = this.resolveGroupName(input.GroupName || input.Group || name);
    const group = this.requireGroup(resolved);
    this.groups.delete(group.Name);
    return { Group: this.groupView(group) };
  }

  updateGroup(name, input) {
    const resolved = this.resolveGroupName(input.GroupName || input.Group || name);
    const group = this.requireGroup(resolved);
    if (input.Description !== undefined) group.Description = input.Description;
    return { Group: this.groupView(group) };
  }

  listGroupResources(name, input) {
    const resolved = this.resolveGroupName((input && (input.GroupName || input.Group)) || name);
    const group = this.requireGroup(resolved);
    return {
      Resources: group.resources.map((arn) => ({
        Identifier: { ResourceArn: arn, ResourceType: this.typeFromArn(arn) },
        Status: { Name: "SUCCESS" },
      })),
      ResourceIdentifiers: group.resources.map((arn) => ({
        ResourceArn: arn,
        ResourceType: this.typeFromArn(arn),
      })),
      QueryErrors: [],
    };
  }

  typeFromArn(arn) {
    const parts = arn.split(":");
    const svc = parts[2] || "unknown";
    return `AWS::${svc.toUpperCase()}::Resource`;
  }

  searchResources(input) {
    // Return a small synthetic result set based on the query, if any.
    const sample = [
      `arn:aws:ec2:${this.region}:${this.accountId}:instance/i-0123456789abcdef0`,
      `arn:aws:s3:::parlel-bucket`,
    ];
    return {
      ResourceIdentifiers: sample.map((arn) => ({ ResourceArn: arn, ResourceType: this.typeFromArn(arn) })),
      QueryErrors: [],
    };
  }

  tag(arn, input) {
    // Find group by ARN.
    const name = arn.split("group/").pop();
    const group = this.groups.get(name);
    if (!group) throw new RgError("NotFoundException", `Resource ${arn} not found.`);
    const tags = input.Tags || {};
    for (const [k, v] of Object.entries(tags)) group.Tags[k] = v;
    return { Arn: this.groupArn(group.Name), Tags: group.Tags };
  }

  untag(arn, input) {
    const name = arn.split("group/").pop();
    const group = this.groups.get(name);
    if (!group) throw new RgError("NotFoundException", `Resource ${arn} not found.`);
    for (const k of input.Keys || []) delete group.Tags[k];
    return { Arn: this.groupArn(group.Name), Keys: input.Keys || [] };
  }

  getTags(arn) {
    const name = arn.split("group/").pop();
    const group = this.groups.get(name);
    if (!group) throw new RgError("NotFoundException", `Resource ${arn} not found.`);
    return { Arn: this.groupArn(group.Name), Tags: group.Tags };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerErrorException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default ResourceGroupsServer;
