// parlel/appconfig — a lightweight, dependency-free fake of AWS AppConfig.
//
// Speaks the AppConfig REST/JSON API. Pure Node.js, no external npm deps.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class AppConfigError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

function shortId() {
  return Math.random().toString(36).slice(2, 9);
}

export class AppconfigServer {
  constructor(port = 4739, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.applications = new Map();
    // environments: Map<appId, Map<envId, env>>
    this.environments = new Map();
    // profiles: Map<appId, Map<profileId, profile>>
    this.profiles = new Map();
    // deployments: Map<appId, Map<envId, [deployment]>>
    this.deployments = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new AppConfigError("InternalServerException", error.message, 500));
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
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "appconfig",
        applications: this.applications.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-appconfig");

    const bodyBuf = await this.readBody(req);
    let body = {};
    if (bodyBuf.length) {
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        return this.sendError(res, new AppConfigError("BadRequestException", "Invalid JSON body."));
      }
    }

    try {
      return this.route(method, path, body, res);
    } catch (error) {
      if (error instanceof AppConfigError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, body, res) {
    const seg = path.split("/").filter(Boolean);
    // /applications
    if (seg[0] === "applications") {
      if (seg.length === 1) {
        if (method === "POST") return this.sendJson(res, 201, this.createApplication(body));
        if (method === "GET") return this.sendJson(res, 200, this.listApplications());
      }
      if (seg.length === 2) {
        const appId = seg[1];
        if (method === "GET") return this.sendJson(res, 200, this.getApplication(appId));
      }
      if (seg.length === 3) {
        const appId = seg[1];
        if (seg[2] === "environments") {
          if (method === "POST") return this.sendJson(res, 201, this.createEnvironment(appId, body));
          if (method === "GET") return this.sendJson(res, 200, this.listEnvironments(appId));
        }
        if (seg[2] === "configurationprofiles") {
          if (method === "POST") return this.sendJson(res, 201, this.createProfile(appId, body));
          if (method === "GET") return this.sendJson(res, 200, this.listProfiles(appId));
        }
      }
      if (seg.length === 4 && seg[2] === "environments") {
        const appId = seg[1];
        const envId = seg[3];
        if (method === "GET") return this.sendJson(res, 200, this.getEnvironment(appId, envId));
      }
      if (seg.length === 5 && seg[2] === "environments" && seg[4] === "deployments") {
        const appId = seg[1];
        const envId = seg[3];
        if (method === "POST") return this.sendJson(res, 201, this.startDeployment(appId, envId, body));
        if (method === "GET") return this.sendJson(res, 200, this.listDeployments(appId, envId));
      }
    }
    throw new AppConfigError("BadRequestException", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  // Applications
  // -------------------------------------------------------------------------
  createApplication(body) {
    if (!body.Name) throw new AppConfigError("BadRequestException", "Name is required.");
    const id = shortId();
    const app = { Id: id, Name: body.Name, Description: body.Description || "" };
    this.applications.set(id, app);
    this.environments.set(id, new Map());
    this.profiles.set(id, new Map());
    this.deployments.set(id, new Map());
    return app;
  }

  listApplications() {
    return { Items: [...this.applications.values()] };
  }

  requireApp(appId) {
    const app = this.applications.get(appId);
    if (!app) throw new AppConfigError("ResourceNotFoundException", `Application ${appId} not found.`, 404);
    return app;
  }

  getApplication(appId) {
    return this.requireApp(appId);
  }

  // -------------------------------------------------------------------------
  // Environments
  // -------------------------------------------------------------------------
  createEnvironment(appId, body) {
    this.requireApp(appId);
    if (!body.Name) throw new AppConfigError("BadRequestException", "Name is required.");
    const id = shortId();
    const env = {
      ApplicationId: appId,
      Id: id,
      Name: body.Name,
      Description: body.Description || "",
      State: "ReadyForDeployment",
      Monitors: body.Monitors || [],
    };
    this.environments.get(appId).set(id, env);
    return env;
  }

  listEnvironments(appId) {
    this.requireApp(appId);
    return { Items: [...this.environments.get(appId).values()] };
  }

  getEnvironment(appId, envId) {
    this.requireApp(appId);
    const env = this.environments.get(appId).get(envId);
    if (!env) throw new AppConfigError("ResourceNotFoundException", `Environment ${envId} not found.`, 404);
    return env;
  }

  // -------------------------------------------------------------------------
  // Configuration profiles
  // -------------------------------------------------------------------------
  createProfile(appId, body) {
    this.requireApp(appId);
    if (!body.Name) throw new AppConfigError("BadRequestException", "Name is required.");
    if (!body.LocationUri) throw new AppConfigError("BadRequestException", "LocationUri is required.");
    const id = shortId();
    const profile = {
      ApplicationId: appId,
      Id: id,
      Name: body.Name,
      Description: body.Description || "",
      LocationUri: body.LocationUri,
      RetrievalRoleArn: body.RetrievalRoleArn,
      Type: body.Type || "AWS.Freeform",
      Validators: body.Validators || [],
    };
    this.profiles.get(appId).set(id, profile);
    return profile;
  }

  listProfiles(appId) {
    this.requireApp(appId);
    return {
      Items: [...this.profiles.get(appId).values()].map((p) => ({
        ApplicationId: p.ApplicationId,
        Id: p.Id,
        Name: p.Name,
        LocationUri: p.LocationUri,
        Type: p.Type,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Deployments
  // -------------------------------------------------------------------------
  startDeployment(appId, envId, body) {
    this.getEnvironment(appId, envId);
    const list = this.deployments.get(appId).get(envId) || [];
    const number = list.length + 1;
    const deployment = {
      ApplicationId: appId,
      EnvironmentId: envId,
      DeploymentNumber: number,
      ConfigurationProfileId: body.ConfigurationProfileId,
      ConfigurationVersion: body.ConfigurationVersion,
      DeploymentStrategyId: body.DeploymentStrategyId,
      State: "COMPLETE",
      PercentageComplete: 100,
      StartedAt: new Date().toISOString(),
      CompletedAt: new Date().toISOString(),
      Description: body.Description || "",
    };
    list.push(deployment);
    this.deployments.get(appId).set(envId, list);
    return deployment;
  }

  listDeployments(appId, envId) {
    this.getEnvironment(appId, envId);
    const list = this.deployments.get(appId).get(envId) || [];
    return { Items: list };
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
    res.end(JSON.stringify({ __type: error.code, Message: error.message, message: error.message }));
  }
}

export default AppconfigServer;
