// parlel/cloudwatch-logs — a lightweight, dependency-free fake of Amazon
// CloudWatch Logs. Speaks the AWS JSON 1.1 wire protocol (target Logs_20140328).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

class LogsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class CloudwatchLogsServer {
  constructor(port = 4745, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // groups: Map<name, group>
    //   group.streams: Map<streamName, stream>
    //   stream.events: [{ timestamp, message, ingestionTime }]
    //   stream.sequenceToken: string
    this.groups = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new LogsError("ServiceUnavailableException", error.message, 500));
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

  groupArn(name) {
    return `arn:aws:logs:${this.region}:${this.accountId}:log-group:${name}:*`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "cloudwatch-logs",
        logGroups: this.groups.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-cloudwatch-logs");

    if (method !== "POST") {
      return this.sendError(res, new LogsError("InvalidParameterException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new LogsError("InvalidParameterException", "Request body is not valid JSON."));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof LogsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(op, input) {
    switch (op) {
      case "CreateLogGroup":
        return this.createLogGroup(input);
      case "DescribeLogGroups":
        return this.describeLogGroups(input);
      case "DeleteLogGroup":
        return this.deleteLogGroup(input);
      case "CreateLogStream":
        return this.createLogStream(input);
      case "DescribeLogStreams":
        return this.describeLogStreams(input);
      case "DeleteLogStream":
        return this.deleteLogStream(input);
      case "PutLogEvents":
        return this.putLogEvents(input);
      case "GetLogEvents":
        return this.getLogEvents(input);
      case "FilterLogEvents":
        return this.filterLogEvents(input);
      case "PutRetentionPolicy":
        return this.putRetentionPolicy(input);
      case "DeleteRetentionPolicy":
        return this.deleteRetentionPolicy(input);
      case "TagLogGroup":
        return this.tagLogGroup(input);
      case "ListTagsLogGroup":
        return this.listTagsLogGroup(input);
      case "UntagLogGroup":
        return this.untagLogGroup(input);
      default:
        throw new LogsError("InvalidParameterException", `Unknown operation ${op || "(none)"}.`);
    }
  }

  requireGroup(name) {
    const g = this.groups.get(name);
    if (!g) throw new LogsError("ResourceNotFoundException", `The specified log group does not exist.`, 400);
    return g;
  }

  requireStream(group, streamName) {
    const s = group.streams.get(streamName);
    if (!s) throw new LogsError("ResourceNotFoundException", `The specified log stream does not exist.`, 400);
    return s;
  }

  // -------------------------------------------------------------------------
  // Log groups
  // -------------------------------------------------------------------------
  createLogGroup(input) {
    const name = input.logGroupName;
    if (!name) throw new LogsError("InvalidParameterException", "logGroupName is required.");
    if (this.groups.has(name)) {
      throw new LogsError("ResourceAlreadyExistsException", "The specified log group already exists.");
    }
    this.groups.set(name, {
      logGroupName: name,
      arn: this.groupArn(name),
      creationTime: Date.now(),
      retentionInDays: undefined,
      tags: input.tags || {},
      kmsKeyId: input.kmsKeyId,
      streams: new Map(),
    });
    return {};
  }

  describeLogGroups(input) {
    const prefix = input.logGroupNamePrefix;
    const groups = [...this.groups.values()]
      .filter((g) => !prefix || g.logGroupName.startsWith(prefix))
      .map((g) => ({
        logGroupName: g.logGroupName,
        creationTime: g.creationTime,
        arn: g.arn,
        retentionInDays: g.retentionInDays,
        metricFilterCount: 0,
        storedBytes: 0,
      }));
    return { logGroups: groups };
  }

  deleteLogGroup(input) {
    this.requireGroup(input.logGroupName);
    this.groups.delete(input.logGroupName);
    return {};
  }

  // -------------------------------------------------------------------------
  // Log streams
  // -------------------------------------------------------------------------
  createLogStream(input) {
    const g = this.requireGroup(input.logGroupName);
    const name = input.logStreamName;
    if (!name) throw new LogsError("InvalidParameterException", "logStreamName is required.");
    if (g.streams.has(name)) {
      throw new LogsError("ResourceAlreadyExistsException", "The specified log stream already exists.");
    }
    g.streams.set(name, {
      logStreamName: name,
      arn: `${g.arn.replace(/:\*$/, "")}:log-stream:${name}`,
      creationTime: Date.now(),
      events: [],
      sequenceToken: undefined,
      lastEventTimestamp: undefined,
    });
    return {};
  }

  describeLogStreams(input) {
    const g = this.requireGroup(input.logGroupName);
    const prefix = input.logStreamNamePrefix;
    const streams = [...g.streams.values()]
      .filter((s) => !prefix || s.logStreamName.startsWith(prefix))
      .map((s) => ({
        logStreamName: s.logStreamName,
        creationTime: s.creationTime,
        arn: s.arn,
        firstEventTimestamp: s.events[0] ? s.events[0].timestamp : undefined,
        lastEventTimestamp: s.lastEventTimestamp,
        lastIngestionTime: s.lastEventTimestamp,
        uploadSequenceToken: s.sequenceToken,
        storedBytes: 0,
      }));
    return { logStreams: streams };
  }

  deleteLogStream(input) {
    const g = this.requireGroup(input.logGroupName);
    this.requireStream(g, input.logStreamName);
    g.streams.delete(input.logStreamName);
    return {};
  }

  // -------------------------------------------------------------------------
  // Log events
  // -------------------------------------------------------------------------
  putLogEvents(input) {
    const g = this.requireGroup(input.logGroupName);
    const s = this.requireStream(g, input.logStreamName);
    // Validate sequence token if one already exists.
    if (s.sequenceToken && input.sequenceToken !== s.sequenceToken) {
      throw new LogsError(
        "InvalidSequenceTokenException",
        "The given sequenceToken is invalid.",
      );
    }
    const events = input.logEvents || [];
    for (const e of events) {
      s.events.push({
        timestamp: e.timestamp,
        message: e.message,
        ingestionTime: Date.now(),
      });
    }
    s.events.sort((a, b) => a.timestamp - b.timestamp);
    if (events.length) {
      s.lastEventTimestamp = s.events[s.events.length - 1].timestamp;
    }
    const next = randomUUID().replace(/-/g, "");
    s.sequenceToken = next;
    return { nextSequenceToken: next };
  }

  getLogEvents(input) {
    const g = this.requireGroup(input.logGroupName);
    const s = this.requireStream(g, input.logStreamName);
    let events = s.events.slice();
    if (input.startTime !== undefined) events = events.filter((e) => e.timestamp >= input.startTime);
    if (input.endTime !== undefined) events = events.filter((e) => e.timestamp < input.endTime);
    const limit = input.limit || 10000;
    const startFromHead = input.startFromHead !== false;
    if (!startFromHead) events = events.slice(-limit);
    else events = events.slice(0, limit);
    return {
      events: events.map((e) => ({
        timestamp: e.timestamp,
        message: e.message,
        ingestionTime: e.ingestionTime,
      })),
      nextForwardToken: "f/" + randomUUID().replace(/-/g, ""),
      nextBackwardToken: "b/" + randomUUID().replace(/-/g, ""),
    };
  }

  filterLogEvents(input) {
    const g = this.requireGroup(input.logGroupName);
    let streams = [...g.streams.values()];
    if (input.logStreamNames && input.logStreamNames.length) {
      streams = streams.filter((s) => input.logStreamNames.includes(s.logStreamName));
    }
    if (input.logStreamNamePrefix) {
      streams = streams.filter((s) => s.logStreamName.startsWith(input.logStreamNamePrefix));
    }
    const pattern = input.filterPattern;
    const terms = this.parseFilterPattern(pattern);
    const out = [];
    for (const s of streams) {
      for (const e of s.events) {
        if (input.startTime !== undefined && e.timestamp < input.startTime) continue;
        if (input.endTime !== undefined && e.timestamp >= input.endTime) continue;
        if (!this.matchPattern(e.message, terms)) continue;
        out.push({
          logStreamName: s.logStreamName,
          timestamp: e.timestamp,
          message: e.message,
          ingestionTime: e.ingestionTime,
          eventId: randomUUID().replace(/-/g, ""),
        });
      }
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    const limit = input.limit || 10000;
    return {
      events: out.slice(0, limit),
      searchedLogStreams: streams.map((s) => ({
        logStreamName: s.logStreamName,
        searchedCompletely: true,
      })),
    };
  }

  // Basic CloudWatch Logs filter pattern: space-separated terms, optional
  // leading `?` for OR, `-` for exclude, double-quoted phrases. Substring match.
  parseFilterPattern(pattern) {
    if (!pattern || !pattern.trim()) return null;
    const raw = pattern.match(/"[^"]*"|\S+/g) || [];
    const include = [];
    const exclude = [];
    const optional = [];
    for (let tok of raw) {
      let mode = "include";
      if (tok.startsWith("?")) {
        mode = "optional";
        tok = tok.slice(1);
      } else if (tok.startsWith("-")) {
        mode = "exclude";
        tok = tok.slice(1);
      }
      if (tok.startsWith('"') && tok.endsWith('"')) tok = tok.slice(1, -1);
      if (!tok) continue;
      if (mode === "exclude") exclude.push(tok);
      else if (mode === "optional") optional.push(tok);
      else include.push(tok);
    }
    return { include, exclude, optional };
  }

  matchPattern(message, terms) {
    if (!terms) return true;
    const msg = String(message);
    for (const t of terms.include) {
      if (!msg.includes(t)) return false;
    }
    for (const t of terms.exclude) {
      if (msg.includes(t)) return false;
    }
    if (terms.optional.length) {
      if (!terms.optional.some((t) => msg.includes(t))) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Retention & tags
  // -------------------------------------------------------------------------
  putRetentionPolicy(input) {
    const g = this.requireGroup(input.logGroupName);
    g.retentionInDays = input.retentionInDays;
    return {};
  }

  deleteRetentionPolicy(input) {
    const g = this.requireGroup(input.logGroupName);
    g.retentionInDays = undefined;
    return {};
  }

  tagLogGroup(input) {
    const g = this.requireGroup(input.logGroupName);
    Object.assign(g.tags, input.tags || {});
    return {};
  }

  listTagsLogGroup(input) {
    const g = this.requireGroup(input.logGroupName);
    return { tags: g.tags };
  }

  untagLogGroup(input) {
    const g = this.requireGroup(input.logGroupName);
    for (const k of input.tags || []) delete g.tags[k];
    return {};
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", error.code || "InvalidParameterException");
    res.end(JSON.stringify({ __type: error.code, message: error.message, Message: error.message }));
  }
}

export default CloudwatchLogsServer;
