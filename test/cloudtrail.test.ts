import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CloudtrailServer } from "../services/cloudtrail/src/server.js";

const PORT = 14734;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const TARGET = "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101";

async function call(op: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `${TARGET}.${op}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

describe("CloudTrail Service", () => {
  let server: CloudtrailServer;

  beforeAll(async () => {
    server = new CloudtrailServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("uses default port 4734", () => {
    expect(new CloudtrailServer().port).toBe(4734);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await res.json()).service).toBe("cloudtrail");
  });

  it("creates and describes a trail", async () => {
    const c = await call("CreateTrail", { Name: "my-trail", S3BucketName: "my-bucket" });
    expect(c.status).toBe(200);
    expect(c.json.TrailARN).toContain(":trail/my-trail");
    const d = await call("DescribeTrails", { trailNameList: ["my-trail"] });
    expect(d.json.trailList.length).toBe(1);
  });

  it("starts and stops logging", async () => {
    await call("CreateTrail", { Name: "log-trail", S3BucketName: "b" });
    let s = await call("GetTrailStatus", { Name: "log-trail" });
    expect(s.json.IsLogging).toBe(false);
    await call("StartLogging", { Name: "log-trail" });
    s = await call("GetTrailStatus", { Name: "log-trail" });
    expect(s.json.IsLogging).toBe(true);
    await call("StopLogging", { Name: "log-trail" });
    s = await call("GetTrailStatus", { Name: "log-trail" });
    expect(s.json.IsLogging).toBe(false);
  });

  it("deletes a trail", async () => {
    await call("CreateTrail", { Name: "del-trail", S3BucketName: "b" });
    await call("DeleteTrail", { Name: "del-trail" });
    const s = await call("GetTrailStatus", { Name: "del-trail" });
    expect(s.status).toBe(400);
    expect(s.json.__type).toBe("TrailNotFoundException");
  });

  it("looks up seeded events", async () => {
    const e = await call("LookupEvents", {});
    expect(e.json.Events.length).toBeGreaterThan(0);
    expect(e.json.Events[0].CloudTrailEvent).toContain("eventVersion");
  });

  it("filters events by EventName", async () => {
    const e = await call("LookupEvents", {
      LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: "ConsoleLogin" }],
    });
    expect(e.json.Events.length).toBe(1);
    expect(e.json.Events[0].EventName).toBe("ConsoleLogin");
  });

  it("puts and gets event selectors", async () => {
    await call("CreateTrail", { Name: "sel-trail", S3BucketName: "b" });
    const selectors = [{ ReadWriteType: "All", IncludeManagementEvents: true }];
    const p = await call("PutEventSelectors", { TrailName: "sel-trail", EventSelectors: selectors });
    expect(p.json.EventSelectors.length).toBe(1);
    const g = await call("GetEventSelectors", { TrailName: "sel-trail" });
    expect(g.json.EventSelectors[0].ReadWriteType).toBe("All");
  });

  it("rejects duplicate trail", async () => {
    await call("CreateTrail", { Name: "dup", S3BucketName: "b" });
    const c = await call("CreateTrail", { Name: "dup", S3BucketName: "b" });
    expect(c.status).toBe(400);
    expect(c.json.__type).toBe("TrailAlreadyExistsException");
  });
});
