// parlel/codebuild — a lightweight, dependency-free fake of AWS CodeBuild.
// Speaks the AWS JSON 1.1 wire protocol (target prefix CodeBuild_20161006).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

class CodeBuildError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class CodebuildServer {
  constructor(port = 4742, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.projects = new Map();
    this.builds = new Map();
    this.buildCounters = new Map(); // projectName -> int
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new CodeBuildError("InternalServerException", error.message, 500));
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
        service: "codebuild",
        projects: this.projects.size,
        builds: this.builds.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-codebuild");

    if (method !== "POST") {
      return this.sendError(res, new CodeBuildError("InvalidInputException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new CodeBuildError("InvalidInputException", "Request body is not valid JSON."));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof CodeBuildError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(op, input) {
    switch (op) {
      case "CreateProject":
        return this.createProject(input);
      case "ListProjects":
        return this.listProjects(input);
      case "BatchGetProjects":
        return this.batchGetProjects(input);
      case "UpdateProject":
        return this.updateProject(input);
      case "DeleteProject":
        return this.deleteProject(input);
      case "StartBuild":
        return this.startBuild(input);
      case "BatchGetBuilds":
        return this.batchGetBuilds(input);
      case "ListBuilds":
        return this.listBuilds(input);
      case "ListBuildsForProject":
        return this.listBuildsForProject(input);
      case "StopBuild":
        return this.stopBuild(input);
      default:
        throw new CodeBuildError("InvalidInputException", `Unknown operation ${op || "(none)"}.`);
    }
  }

  projectArn(name) {
    return `arn:aws:codebuild:${this.region}:${this.accountId}:project/${name}`;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  createProject(input) {
    const name = input.name;
    if (!name) throw new CodeBuildError("InvalidInputException", "name is required.");
    if (this.projects.has(name)) {
      throw new CodeBuildError("ResourceAlreadyExistsException", `Project ${name} already exists.`);
    }
    const now = Date.now() / 1000;
    const project = {
      name,
      arn: this.projectArn(name),
      description: input.description || "",
      source: input.source || { type: "NO_SOURCE" },
      artifacts: input.artifacts || { type: "NO_ARTIFACTS" },
      environment: input.environment || {
        type: "LINUX_CONTAINER",
        image: "aws/codebuild/standard:7.0",
        computeType: "BUILD_GENERAL1_SMALL",
        environmentVariables: [],
      },
      serviceRole: input.serviceRole,
      timeoutInMinutes: input.timeoutInMinutes || 60,
      queuedTimeoutInMinutes: input.queuedTimeoutInMinutes || 480,
      created: now,
      lastModified: now,
      tags: input.tags || [],
      badge: { badgeEnabled: false },
    };
    this.projects.set(name, project);
    return { project: this.projectView(project) };
  }

  projectView(p) {
    return {
      name: p.name,
      arn: p.arn,
      description: p.description,
      source: p.source,
      artifacts: p.artifacts,
      environment: p.environment,
      serviceRole: p.serviceRole,
      timeoutInMinutes: p.timeoutInMinutes,
      queuedTimeoutInMinutes: p.queuedTimeoutInMinutes,
      created: p.created,
      lastModified: p.lastModified,
      tags: p.tags,
      badge: p.badge,
    };
  }

  listProjects() {
    return { projects: [...this.projects.keys()] };
  }

  batchGetProjects(input) {
    const names = input.names || [];
    const found = [];
    const notFound = [];
    for (const n of names) {
      if (this.projects.has(n)) found.push(this.projectView(this.projects.get(n)));
      else notFound.push(n);
    }
    return { projects: found, projectsNotFound: notFound };
  }

  updateProject(input) {
    const name = input.name;
    const p = this.projects.get(name);
    if (!p) throw new CodeBuildError("ResourceNotFoundException", `Project ${name} not found.`);
    if (input.description !== undefined) p.description = input.description;
    if (input.source) p.source = input.source;
    if (input.artifacts) p.artifacts = input.artifacts;
    if (input.environment) p.environment = input.environment;
    if (input.serviceRole) p.serviceRole = input.serviceRole;
    if (input.timeoutInMinutes) p.timeoutInMinutes = input.timeoutInMinutes;
    if (input.tags) p.tags = input.tags;
    p.lastModified = Date.now() / 1000;
    return { project: this.projectView(p) };
  }

  deleteProject(input) {
    const name = input.name;
    if (!this.projects.has(name)) {
      throw new CodeBuildError("ResourceNotFoundException", `Project ${name} not found.`);
    }
    this.projects.delete(name);
    return {};
  }

  // -------------------------------------------------------------------------
  // Builds
  // -------------------------------------------------------------------------
  startBuild(input) {
    const name = input.projectName;
    const p = this.projects.get(name);
    if (!p) throw new CodeBuildError("ResourceNotFoundException", `Project ${name} not found.`);
    const counter = (this.buildCounters.get(name) || 0) + 1;
    this.buildCounters.set(name, counter);
    const id = `${name}:${randomUUID()}`;
    const arn = `arn:aws:codebuild:${this.region}:${this.accountId}:build/${id}`;
    const now = Date.now() / 1000;
    const build = {
      id,
      arn,
      buildNumber: counter,
      projectName: name,
      startTime: now,
      endTime: now,
      currentPhase: "COMPLETED",
      buildStatus: "SUCCEEDED",
      sourceVersion: input.sourceVersion || "",
      resolvedSourceVersion: "abcdef0",
      buildComplete: true,
      initiator: "parlel",
      environment: p.environment,
      logs: {
        groupName: `/aws/codebuild/${name}`,
        streamName: id,
        deepLink: `https://console.aws.amazon.com/cloudwatch/home#logEvent:group=/aws/codebuild/${name}`,
      },
      phases: [
        { phaseType: "SUBMITTED", phaseStatus: "SUCCEEDED", startTime: now, durationInSeconds: 0 },
        { phaseType: "BUILD", phaseStatus: "SUCCEEDED", startTime: now, durationInSeconds: 1 },
        { phaseType: "COMPLETED", startTime: now },
      ],
      timeoutInMinutes: p.timeoutInMinutes,
    };
    this.builds.set(id, build);
    return { build };
  }

  batchGetBuilds(input) {
    const ids = input.ids || [];
    const found = [];
    const notFound = [];
    for (const id of ids) {
      if (this.builds.has(id)) found.push(this.builds.get(id));
      else notFound.push(id);
    }
    return { builds: found, buildsNotFound: notFound };
  }

  listBuilds() {
    const ids = [...this.builds.keys()].reverse();
    return { ids };
  }

  listBuildsForProject(input) {
    const name = input.projectName;
    if (!this.projects.has(name)) {
      throw new CodeBuildError("ResourceNotFoundException", `Project ${name} not found.`);
    }
    const ids = [...this.builds.values()]
      .filter((b) => b.projectName === name)
      .map((b) => b.id)
      .reverse();
    return { ids };
  }

  stopBuild(input) {
    const id = input.id;
    const b = this.builds.get(id);
    if (!b) throw new CodeBuildError("ResourceNotFoundException", `Build ${id} not found.`);
    b.buildStatus = "STOPPED";
    b.currentPhase = "STOPPED";
    b.buildComplete = true;
    return { build: b };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", error.code || "InvalidInputException");
    res.end(JSON.stringify({ __type: error.code, message: error.message, Message: error.message }));
  }
}

export default CodebuildServer;
