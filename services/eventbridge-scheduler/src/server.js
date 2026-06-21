// parlel/eventbridge-scheduler — a lightweight, dependency-free fake of
// Amazon EventBridge Scheduler. Speaks the REST/JSON API. Pure Node.js.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class SchedulerError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class EventbridgeSchedulerServer {
  constructor(port = 4740, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // schedules: Map<"group/name", schedule>
    this.schedules = new Map();
    this.groups = new Map();
    // Default group always exists.
    this.groups.set("default", {
      Name: "default",
      Arn: this.groupArn("default"),
      State: "ACTIVE",
      CreationDate: new Date().toISOString(),
      LastModificationDate: new Date().toISOString(),
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new SchedulerError("InternalServerException", error.message, 500));
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

  scheduleArn(group, name) {
    return `arn:aws:scheduler:${this.region}:${this.accountId}:schedule/${group}/${name}`;
  }

  groupArn(name) {
    return `arn:aws:scheduler:${this.region}:${this.accountId}:schedule-group/${name}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "eventbridge-scheduler",
        schedules: this.schedules.size,
        groups: this.groups.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-eventbridge-scheduler");

    const bodyBuf = await this.readBody(req);
    let body = {};
    if (bodyBuf.length) {
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        return this.sendError(res, new SchedulerError("ValidationException", "Invalid JSON body."));
      }
    }

    try {
      return this.route(method, path, body, url, res);
    } catch (error) {
      if (error instanceof SchedulerError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, body, url, res) {
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent);

    if (seg[0] === "schedules") {
      if (seg.length === 1 && method === "GET") {
        return this.sendJson(res, 200, this.listSchedules(url));
      }
      if (seg.length === 2) {
        const name = seg[1];
        const group = url.searchParams.get("groupName") || "default";
        if (method === "POST") return this.sendJson(res, 200, this.createSchedule(group, name, body));
        if (method === "PUT") return this.sendJson(res, 200, this.updateSchedule(group, name, body));
        if (method === "GET") return this.sendJson(res, 200, this.getSchedule(group, name));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteSchedule(group, name));
      }
    } else if (seg[0] === "schedule-groups") {
      if (seg.length === 1 && method === "GET") {
        return this.sendJson(res, 200, this.listScheduleGroups());
      }
      if (seg.length === 2) {
        const name = seg[1];
        if (method === "POST") return this.sendJson(res, 200, this.createScheduleGroup(name, body));
        if (method === "GET") return this.sendJson(res, 200, this.getScheduleGroup(name));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteScheduleGroup(name));
      }
    }
    throw new SchedulerError("ValidationException", `Unsupported ${method} ${path}`, 404);
  }

  key(group, name) {
    return `${group}/${name}`;
  }

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------
  createSchedule(group, name, body) {
    if (!this.groups.has(group)) {
      throw new SchedulerError("ResourceNotFoundException", `Schedule group ${group} not found.`, 404);
    }
    if (!body.ScheduleExpression) {
      throw new SchedulerError("ValidationException", "ScheduleExpression is required.");
    }
    if (!body.Target) {
      throw new SchedulerError("ValidationException", "Target is required.");
    }
    const k = this.key(group, name);
    if (this.schedules.has(k)) {
      throw new SchedulerError("ConflictException", `Schedule ${name} already exists.`, 409);
    }
    const arn = this.scheduleArn(group, name);
    const now = new Date().toISOString();
    const schedule = {
      Name: name,
      GroupName: group,
      Arn: arn,
      ScheduleExpression: body.ScheduleExpression,
      ScheduleExpressionTimezone: body.ScheduleExpressionTimezone || "UTC",
      State: body.State || "ENABLED",
      Description: body.Description || "",
      Target: body.Target,
      FlexibleTimeWindow: body.FlexibleTimeWindow || { Mode: "OFF" },
      StartDate: body.StartDate,
      EndDate: body.EndDate,
      KmsKeyArn: body.KmsKeyArn,
      CreationDate: now,
      LastModificationDate: now,
    };
    this.schedules.set(k, schedule);
    return { ScheduleArn: arn };
  }

  updateSchedule(group, name, body) {
    const k = this.key(group, name);
    const existing = this.schedules.get(k);
    if (!existing) {
      throw new SchedulerError("ResourceNotFoundException", `Schedule ${name} not found.`, 404);
    }
    if (!body.ScheduleExpression) {
      throw new SchedulerError("ValidationException", "ScheduleExpression is required.");
    }
    if (!body.Target) {
      throw new SchedulerError("ValidationException", "Target is required.");
    }
    existing.ScheduleExpression = body.ScheduleExpression;
    existing.ScheduleExpressionTimezone = body.ScheduleExpressionTimezone || existing.ScheduleExpressionTimezone;
    existing.State = body.State || existing.State;
    existing.Description = body.Description !== undefined ? body.Description : existing.Description;
    existing.Target = body.Target;
    existing.FlexibleTimeWindow = body.FlexibleTimeWindow || existing.FlexibleTimeWindow;
    existing.LastModificationDate = new Date().toISOString();
    return { ScheduleArn: existing.Arn };
  }

  getSchedule(group, name) {
    const k = this.key(group, name);
    const s = this.schedules.get(k);
    if (!s) throw new SchedulerError("ResourceNotFoundException", `Schedule ${name} not found.`, 404);
    return { ...s };
  }

  deleteSchedule(group, name) {
    const k = this.key(group, name);
    if (!this.schedules.has(k)) {
      throw new SchedulerError("ResourceNotFoundException", `Schedule ${name} not found.`, 404);
    }
    this.schedules.delete(k);
    return {};
  }

  listSchedules(url) {
    const groupFilter = url.searchParams.get("ScheduleGroup") || url.searchParams.get("groupName");
    const namePrefix = url.searchParams.get("NamePrefix");
    const items = [...this.schedules.values()]
      .filter((s) => !groupFilter || s.GroupName === groupFilter)
      .filter((s) => !namePrefix || s.Name.startsWith(namePrefix))
      .map((s) => ({
        Name: s.Name,
        GroupName: s.GroupName,
        Arn: s.Arn,
        State: s.State,
        Target: { Arn: s.Target && s.Target.Arn },
        CreationDate: s.CreationDate,
        LastModificationDate: s.LastModificationDate,
      }));
    return { Schedules: items };
  }

  // -------------------------------------------------------------------------
  // Schedule groups
  // -------------------------------------------------------------------------
  createScheduleGroup(name, body) {
    if (this.groups.has(name)) {
      throw new SchedulerError("ConflictException", `Schedule group ${name} already exists.`, 409);
    }
    const arn = this.groupArn(name);
    const now = new Date().toISOString();
    this.groups.set(name, {
      Name: name,
      Arn: arn,
      State: "ACTIVE",
      CreationDate: now,
      LastModificationDate: now,
      Tags: body.Tags || [],
    });
    return { ScheduleGroupArn: arn };
  }

  getScheduleGroup(name) {
    const g = this.groups.get(name);
    if (!g) throw new SchedulerError("ResourceNotFoundException", `Schedule group ${name} not found.`, 404);
    return {
      Name: g.Name,
      Arn: g.Arn,
      State: g.State,
      CreationDate: g.CreationDate,
      LastModificationDate: g.LastModificationDate,
    };
  }

  deleteScheduleGroup(name) {
    if (name === "default") {
      throw new SchedulerError("ValidationException", "Cannot delete the default schedule group.");
    }
    if (!this.groups.has(name)) {
      throw new SchedulerError("ResourceNotFoundException", `Schedule group ${name} not found.`, 404);
    }
    this.groups.delete(name);
    for (const k of [...this.schedules.keys()]) {
      if (k.startsWith(`${name}/`)) this.schedules.delete(k);
    }
    return {};
  }

  listScheduleGroups() {
    return {
      ScheduleGroups: [...this.groups.values()].map((g) => ({
        Name: g.Name,
        Arn: g.Arn,
        State: g.State,
        CreationDate: g.CreationDate,
        LastModificationDate: g.LastModificationDate,
      })),
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
    res.setHeader("x-amzn-errortype", error.code || "ValidationException");
    res.end(JSON.stringify({ __type: error.code, Message: error.message, message: error.message }));
  }
}

export default EventbridgeSchedulerServer;
