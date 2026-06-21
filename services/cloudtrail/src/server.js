// parlel/cloudtrail — a lightweight, dependency-free fake of AWS CloudTrail.
//
// Speaks AWS JSON 1.1
// (X-Amz-Target: com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.<Op>).
// Pure Node.js. LookupEvents returns seeded audit events.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  TrailNotFoundException: 400,
  TrailAlreadyExistsException: 400,
  InvalidTrailNameException: 400,
  InvalidParameterException: 400,
  InvalidParameterCombinationException: 400,
  ValidationException: 400,
  InternalErrorException: 500,
};

class CloudTrailError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function epochSeconds(ms = Date.now()) {
  return Math.floor(ms / 1000);
}

export class CloudtrailServer {
  constructor(port = 4734, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.trails = new Map(); // name -> trail
    this.seedEvents();
  }

  seedEvents() {
    const now = Date.now();
    this.events = [
      {
        EventId: randomUUID(),
        EventName: "ConsoleLogin",
        EventTime: now - 3600 * 1000,
        EventSource: "signin.amazonaws.com",
        Username: "parlel",
        Resources: [],
        CloudTrailEvent: JSON.stringify({
          eventVersion: "1.08",
          eventName: "ConsoleLogin",
          eventSource: "signin.amazonaws.com",
          awsRegion: this.region,
          sourceIPAddress: "127.0.0.1",
          userIdentity: { type: "IAMUser", userName: "parlel" },
        }),
      },
      {
        EventId: randomUUID(),
        EventName: "RunInstances",
        EventTime: now - 1800 * 1000,
        EventSource: "ec2.amazonaws.com",
        Username: "parlel",
        Resources: [{ ResourceType: "AWS::EC2::Instance", ResourceName: "i-0123456789abcdef0" }],
        CloudTrailEvent: JSON.stringify({
          eventVersion: "1.08",
          eventName: "RunInstances",
          eventSource: "ec2.amazonaws.com",
          awsRegion: this.region,
        }),
      },
      {
        EventId: randomUUID(),
        EventName: "CreateBucket",
        EventTime: now - 600 * 1000,
        EventSource: "s3.amazonaws.com",
        Username: "parlel",
        Resources: [{ ResourceType: "AWS::S3::Bucket", ResourceName: "parlel-bucket" }],
        CloudTrailEvent: JSON.stringify({
          eventVersion: "1.08",
          eventName: "CreateBucket",
          eventSource: "s3.amazonaws.com",
          awsRegion: this.region,
        }),
      },
    ];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new CloudTrailError("InternalErrorException", error.message, 500));
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

  trailArn(name) {
    return `arn:aws:cloudtrail:${this.region}:${this.accountId}:trail/${name}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "cloudtrail", trails: this.trails.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-cloudtrail");

    if (method !== "POST") {
      return this.sendError(res, new CloudTrailError("ValidationException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new CloudTrailError("ValidationException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof CloudTrailError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateTrail": return this.createTrail(input);
      case "DescribeTrails": return this.describeTrails(input);
      case "GetTrailStatus": return this.getTrailStatus(input);
      case "StartLogging": return this.startLogging(input);
      case "StopLogging": return this.stopLogging(input);
      case "DeleteTrail": return this.deleteTrail(input);
      case "UpdateTrail": return this.updateTrail(input);
      case "LookupEvents": return this.lookupEvents(input);
      case "PutEventSelectors": return this.putEventSelectors(input);
      case "GetEventSelectors": return this.getEventSelectors(input);
      case "ListTrails": return this.listTrails(input);
      default:
        throw new CloudTrailError("ValidationException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  resolveTrail(nameOrArn) {
    if (!nameOrArn) return undefined;
    if (this.trails.has(nameOrArn)) return this.trails.get(nameOrArn);
    if (nameOrArn.startsWith("arn:")) {
      const name = nameOrArn.split("/").pop();
      if (this.trails.has(name)) return this.trails.get(name);
    }
    return undefined;
  }

  createTrail(input) {
    const name = input.Name;
    if (!name) throw new CloudTrailError("InvalidTrailNameException", "Name is required.");
    if (this.trails.has(name)) {
      throw new CloudTrailError("TrailAlreadyExistsException", `Trail ${name} already exists.`);
    }
    if (!input.S3BucketName) throw new CloudTrailError("InvalidParameterException", "S3BucketName is required.");
    const trail = {
      Name: name,
      TrailARN: this.trailArn(name),
      S3BucketName: input.S3BucketName,
      S3KeyPrefix: input.S3KeyPrefix,
      IncludeGlobalServiceEvents: input.IncludeGlobalServiceEvents !== false,
      IsMultiRegionTrail: input.IsMultiRegionTrail || false,
      IsOrganizationTrail: input.IsOrganizationTrail || false,
      HomeRegion: this.region,
      LogFileValidationEnabled: input.EnableLogFileValidation || false,
      KmsKeyId: input.KmsKeyId,
      isLogging: false,
      eventSelectors: [],
      createdAt: Date.now(),
    };
    this.trails.set(name, trail);
    return this.trailView(trail);
  }

  trailView(trail) {
    return {
      Name: trail.Name,
      TrailARN: trail.TrailARN,
      S3BucketName: trail.S3BucketName,
      S3KeyPrefix: trail.S3KeyPrefix,
      IncludeGlobalServiceEvents: trail.IncludeGlobalServiceEvents,
      IsMultiRegionTrail: trail.IsMultiRegionTrail,
      IsOrganizationTrail: trail.IsOrganizationTrail,
      HomeRegion: trail.HomeRegion,
      LogFileValidationEnabled: trail.LogFileValidationEnabled,
      KmsKeyId: trail.KmsKeyId,
    };
  }

  describeTrails(input = {}) {
    let trails = [...this.trails.values()];
    if (input.trailNameList && input.trailNameList.length) {
      trails = input.trailNameList.map((n) => this.resolveTrail(n)).filter(Boolean);
    }
    return { trailList: trails.map((t) => this.trailView(t)) };
  }

  listTrails() {
    return {
      Trails: [...this.trails.values()].map((t) => ({
        TrailARN: t.TrailARN,
        Name: t.Name,
        HomeRegion: t.HomeRegion,
      })),
    };
  }

  requireTrail(nameOrArn) {
    const trail = this.resolveTrail(nameOrArn);
    if (!trail) throw new CloudTrailError("TrailNotFoundException", `Trail ${nameOrArn} not found.`);
    return trail;
  }

  getTrailStatus(input) {
    const trail = this.requireTrail(input.Name);
    return {
      IsLogging: trail.isLogging,
      LatestDeliveryTime: trail.isLogging ? epochSeconds() : undefined,
      StartLoggingTime: trail.startLoggingTime ? epochSeconds(trail.startLoggingTime) : undefined,
      StopLoggingTime: trail.stopLoggingTime ? epochSeconds(trail.stopLoggingTime) : undefined,
    };
  }

  startLogging(input) {
    const trail = this.requireTrail(input.Name);
    trail.isLogging = true;
    trail.startLoggingTime = Date.now();
    return {};
  }

  stopLogging(input) {
    const trail = this.requireTrail(input.Name);
    trail.isLogging = false;
    trail.stopLoggingTime = Date.now();
    return {};
  }

  deleteTrail(input) {
    const trail = this.requireTrail(input.Name);
    this.trails.delete(trail.Name);
    return {};
  }

  updateTrail(input) {
    const trail = this.requireTrail(input.Name);
    if (input.S3BucketName !== undefined) trail.S3BucketName = input.S3BucketName;
    if (input.S3KeyPrefix !== undefined) trail.S3KeyPrefix = input.S3KeyPrefix;
    if (input.IncludeGlobalServiceEvents !== undefined) trail.IncludeGlobalServiceEvents = input.IncludeGlobalServiceEvents;
    if (input.IsMultiRegionTrail !== undefined) trail.IsMultiRegionTrail = input.IsMultiRegionTrail;
    return this.trailView(trail);
  }

  lookupEvents(input = {}) {
    let events = this.events.slice();
    const attrs = input.LookupAttributes || [];
    for (const attr of attrs) {
      const key = attr.AttributeKey;
      const value = attr.AttributeValue;
      events = events.filter((e) => {
        if (key === "EventName") return e.EventName === value;
        if (key === "EventSource") return e.EventSource === value;
        if (key === "Username") return e.Username === value;
        if (key === "ResourceName") return e.Resources.some((r) => r.ResourceName === value);
        return true;
      });
    }
    return {
      Events: events.map((e) => ({
        EventId: e.EventId,
        EventName: e.EventName,
        EventTime: epochSeconds(e.EventTime),
        EventSource: e.EventSource,
        Username: e.Username,
        Resources: e.Resources,
        CloudTrailEvent: e.CloudTrailEvent,
        ReadOnly: "false",
      })),
    };
  }

  putEventSelectors(input) {
    const trail = this.requireTrail(input.TrailName);
    trail.eventSelectors = input.EventSelectors || [];
    return {
      TrailARN: trail.TrailARN,
      EventSelectors: trail.eventSelectors,
    };
  }

  getEventSelectors(input) {
    const trail = this.requireTrail(input.TrailName);
    return {
      TrailARN: trail.TrailARN,
      EventSelectors: trail.eventSelectors,
    };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalErrorException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default CloudtrailServer;
