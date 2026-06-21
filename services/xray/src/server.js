// parlel/xray — a lightweight, dependency-free fake of AWS X-Ray.
// Speaks the X-Ray REST/JSON API. Pure Node.js, no external npm deps.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class XrayError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class XrayServer {
  constructor(port = 4744, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // traces: Map<traceId, { segments: [doc], updatedAt }>
    this.traces = new Map();
    this.telemetryRecords = [];
    this.samplingRules = new Map();
    // Seed the AWS Default sampling rule.
    this.samplingRules.set("Default", {
      RuleName: "Default",
      Priority: 10000,
      FixedRate: 0.05,
      ReservoirSize: 1,
      ServiceName: "*",
      ServiceType: "*",
      Host: "*",
      HTTPMethod: "*",
      URLPath: "*",
      ResourceARN: "*",
      Version: 1,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new XrayError("InternalFailure", error.message, 500));
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
        service: "xray",
        traces: this.traces.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-xray");

    const bodyBuf = await this.readBody(req);
    let body = {};
    if (bodyBuf.length) {
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        return this.sendError(res, new XrayError("InvalidRequestException", "Invalid JSON body."));
      }
    }

    try {
      return this.route(method, path, body, res);
    } catch (error) {
      if (error instanceof XrayError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, body, res) {
    const p = path.replace(/\/+$/, "") || "/";
    if (method === "POST" && p === "/TraceSegments") {
      return this.sendJson(res, 200, this.putTraceSegments(body));
    }
    if (method === "POST" && p === "/Traces") {
      return this.sendJson(res, 200, this.batchGetTraces(body));
    }
    if (method === "POST" && p === "/TraceSummaries") {
      return this.sendJson(res, 200, this.getTraceSummaries(body));
    }
    if (method === "POST" && p === "/TelemetryRecords") {
      return this.sendJson(res, 200, this.putTelemetryRecords(body));
    }
    if ((method === "POST" || method === "GET") && p === "/GetSamplingRules") {
      return this.sendJson(res, 200, this.getSamplingRules(body));
    }
    throw new XrayError("InvalidRequestException", `Unsupported ${method} ${p}`, 404);
  }

  // -------------------------------------------------------------------------
  // Segments
  // -------------------------------------------------------------------------
  putTraceSegments(body) {
    const docs = body.TraceSegmentDocuments || [];
    const unprocessed = [];
    for (const raw of docs) {
      let seg;
      try {
        seg = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        unprocessed.push({ Id: undefined, ErrorCode: "ParseError", Message: "Invalid segment document." });
        continue;
      }
      const traceId = seg.trace_id;
      if (!traceId) {
        unprocessed.push({ Id: seg.id, ErrorCode: "MissingId", Message: "Segment missing trace_id." });
        continue;
      }
      if (!this.traces.has(traceId)) {
        this.traces.set(traceId, { id: traceId, segments: [], updatedAt: Date.now() });
      }
      const trace = this.traces.get(traceId);
      trace.segments.push({ Id: seg.id, Document: typeof raw === "string" ? raw : JSON.stringify(seg), parsed: seg });
      trace.updatedAt = Date.now();
    }
    return { UnprocessedTraceSegments: unprocessed };
  }

  // -------------------------------------------------------------------------
  // BatchGetTraces
  // -------------------------------------------------------------------------
  batchGetTraces(body) {
    const ids = body.TraceIds || [];
    const traces = [];
    const unprocessed = [];
    for (const id of ids) {
      const t = this.traces.get(id);
      if (!t) {
        unprocessed.push(id);
        continue;
      }
      const duration = this.traceDuration(t);
      traces.push({
        Id: id,
        Duration: duration,
        Segments: t.segments.map((s) => ({ Id: s.Id, Document: s.Document })),
      });
    }
    return { Traces: traces, UnprocessedTraceIds: unprocessed };
  }

  traceDuration(trace) {
    let min = Infinity;
    let max = -Infinity;
    for (const s of trace.segments) {
      const p = s.parsed || {};
      if (typeof p.start_time === "number") min = Math.min(min, p.start_time);
      if (typeof p.end_time === "number") max = Math.max(max, p.end_time);
    }
    if (min === Infinity || max === -Infinity) return 0;
    return Math.max(0, max - min);
  }

  // -------------------------------------------------------------------------
  // GetTraceSummaries
  // -------------------------------------------------------------------------
  getTraceSummaries(body) {
    const summaries = [];
    for (const t of this.traces.values()) {
      const root = t.segments.find((s) => s.parsed && !s.parsed.parent_id) || t.segments[0];
      const p = (root && root.parsed) || {};
      let hasError = false;
      let hasFault = false;
      for (const s of t.segments) {
        if (s.parsed && s.parsed.error) hasError = true;
        if (s.parsed && s.parsed.fault) hasFault = true;
      }
      summaries.push({
        Id: t.id,
        Duration: this.traceDuration(t),
        ResponseTime: this.traceDuration(t),
        HasError: hasError,
        HasFault: hasFault,
        HasThrottle: false,
        ServiceIds: [{ Name: p.name, Type: "AWS::EC2::Instance" }],
        Http: p.http || {},
      });
    }
    return {
      TraceSummaries: summaries,
      ApproximateTime: Math.floor(Date.now() / 1000),
      TracesProcessedCount: summaries.length,
    };
  }

  // -------------------------------------------------------------------------
  // Telemetry & sampling
  // -------------------------------------------------------------------------
  putTelemetryRecords(body) {
    const records = body.TelemetryRecords || [];
    for (const r of records) this.telemetryRecords.push(r);
    return {};
  }

  getSamplingRules() {
    return {
      SamplingRuleRecords: [...this.samplingRules.values()].map((r) => ({
        SamplingRule: r,
        CreatedAt: Math.floor(Date.now() / 1000),
        ModifiedAt: Math.floor(Date.now() / 1000),
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
    res.setHeader("x-amzn-errortype", error.code || "InvalidRequestException");
    res.end(JSON.stringify({ __type: error.code, message: error.message, Message: error.message }));
  }
}

export default XrayServer;
