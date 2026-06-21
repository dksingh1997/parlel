import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { XrayServer } from "../services/xray/src/server.js";

const PORT = 14747;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(ENDPOINT + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = {};
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

function segmentDoc(traceId: string, id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    trace_id: traceId,
    id,
    name: "my-service",
    start_time: 1700000000.0,
    end_time: 1700000001.5,
    ...extra,
  });
}

let server: XrayServer;

beforeAll(async () => {
  server = new XrayServer(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

const TRACE = "1-58406520-a006649127e371903a2de979";

describe("xray", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("xray");
  });

  it("default port 4744", () => {
    expect(new XrayServer().port).toBe(4744);
  });

  it("puts trace segments", async () => {
    const res = await call("POST", "/TraceSegments", {
      TraceSegmentDocuments: [segmentDoc(TRACE, "seg1")],
    });
    expect(res.status).toBe(200);
    expect(res.json.UnprocessedTraceSegments).toEqual([]);
  });

  it("reports unprocessed for invalid segment", async () => {
    const res = await call("POST", "/TraceSegments", {
      TraceSegmentDocuments: ["{not json"],
    });
    expect(res.status).toBe(200);
    expect(res.json.UnprocessedTraceSegments.length).toBe(1);
  });

  it("batch-gets traces grouped by trace_id", async () => {
    await call("POST", "/TraceSegments", {
      TraceSegmentDocuments: [segmentDoc(TRACE, "seg1"), segmentDoc(TRACE, "seg2")],
    });
    const res = await call("POST", "/Traces", { TraceIds: [TRACE] });
    expect(res.status).toBe(200);
    expect(res.json.Traces.length).toBe(1);
    expect(res.json.Traces[0].Id).toBe(TRACE);
    expect(res.json.Traces[0].Segments.length).toBe(2);
    expect(res.json.Traces[0].Duration).toBeCloseTo(1.5, 3);
  });

  it("reports unprocessed trace ids", async () => {
    const res = await call("POST", "/Traces", { TraceIds: ["1-missing-trace"] });
    expect(res.json.Traces.length).toBe(0);
    expect(res.json.UnprocessedTraceIds).toEqual(["1-missing-trace"]);
  });

  it("gets trace summaries", async () => {
    await call("POST", "/TraceSegments", {
      TraceSegmentDocuments: [segmentDoc(TRACE, "seg1", { error: true })],
    });
    const res = await call("POST", "/TraceSummaries", {
      StartTime: 1700000000,
      EndTime: 1700000100,
    });
    expect(res.status).toBe(200);
    expect(res.json.TraceSummaries.length).toBe(1);
    expect(res.json.TraceSummaries[0].HasError).toBe(true);
    expect(res.json.TracesProcessedCount).toBe(1);
  });

  it("puts telemetry records", async () => {
    const res = await call("POST", "/TelemetryRecords", {
      InstanceId: "i-1",
      TelemetryRecords: [{ Timestamp: 1700000000, SegmentsReceivedCount: 5 }],
    });
    expect(res.status).toBe(200);
  });

  it("gets sampling rules (POST)", async () => {
    const res = await call("POST", "/GetSamplingRules", {});
    expect(res.status).toBe(200);
    expect(res.json.SamplingRuleRecords.length).toBeGreaterThan(0);
    expect(res.json.SamplingRuleRecords[0].SamplingRule.RuleName).toBe("Default");
  });

  it("gets sampling rules (GET)", async () => {
    const res = await call("GET", "/GetSamplingRules");
    expect(res.status).toBe(200);
    expect(res.json.SamplingRuleRecords.length).toBeGreaterThan(0);
  });

  it("404 for unknown path", async () => {
    const res = await call("POST", "/Bogus", {});
    expect(res.status).toBe(404);
  });
});
