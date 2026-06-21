import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CloudwatchLogsServer } from "../services/cloudwatch-logs/src/server.js";

const PORT = 14745;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const TARGET_PREFIX = "Logs_20140328";

async function op(name: string, body: unknown = {}) {
  const res = await fetch(ENDPOINT + "/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `${TARGET_PREFIX}.${name}`,
    },
    body: JSON.stringify(body),
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

let server: CloudwatchLogsServer;

beforeAll(async () => {
  server = new CloudwatchLogsServer(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

async function setup(group = "g1", stream = "s1") {
  await op("CreateLogGroup", { logGroupName: group });
  await op("CreateLogStream", { logGroupName: group, logStreamName: stream });
}

describe("cloudwatch-logs", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("cloudwatch-logs");
  });

  it("default port 4745", () => {
    expect(new CloudwatchLogsServer().port).toBe(4745);
  });

  it("creates and describes log groups", async () => {
    await op("CreateLogGroup", { logGroupName: "/app/one" });
    await op("CreateLogGroup", { logGroupName: "/app/two" });
    const d = await op("DescribeLogGroups", { logGroupNamePrefix: "/app" });
    expect(d.status).toBe(200);
    expect(d.json.logGroups.length).toBe(2);
    expect(d.json.logGroups[0].arn).toContain("log-group");
  });

  it("rejects duplicate log group", async () => {
    await op("CreateLogGroup", { logGroupName: "dup" });
    const again = await op("CreateLogGroup", { logGroupName: "dup" });
    expect(again.status).toBe(400);
    expect(again.json.__type).toContain("ResourceAlreadyExists");
  });

  it("creates and describes log streams", async () => {
    await op("CreateLogGroup", { logGroupName: "g1" });
    await op("CreateLogStream", { logGroupName: "g1", logStreamName: "s1" });
    const d = await op("DescribeLogStreams", { logGroupName: "g1" });
    expect(d.json.logStreams.length).toBe(1);
    expect(d.json.logStreams[0].logStreamName).toBe("s1");
  });

  it("puts and gets log events with sequence tokens", async () => {
    await setup();
    const now = Date.now();
    const put1 = await op("PutLogEvents", {
      logGroupName: "g1",
      logStreamName: "s1",
      logEvents: [
        { timestamp: now, message: "hello" },
        { timestamp: now + 1, message: "world" },
      ],
    });
    expect(put1.status).toBe(200);
    const token = put1.json.nextSequenceToken;
    expect(token).toBeTruthy();

    // Wrong token rejected.
    const bad = await op("PutLogEvents", {
      logGroupName: "g1",
      logStreamName: "s1",
      sequenceToken: "wrong",
      logEvents: [{ timestamp: now + 2, message: "x" }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.__type).toContain("InvalidSequenceToken");

    // Correct token accepted.
    const put2 = await op("PutLogEvents", {
      logGroupName: "g1",
      logStreamName: "s1",
      sequenceToken: token,
      logEvents: [{ timestamp: now + 2, message: "third" }],
    });
    expect(put2.status).toBe(200);

    const get = await op("GetLogEvents", { logGroupName: "g1", logStreamName: "s1" });
    expect(get.json.events.length).toBe(3);
    expect(get.json.events[0].message).toBe("hello");
  });

  it("filters log events by substring pattern", async () => {
    await setup();
    const now = Date.now();
    await op("PutLogEvents", {
      logGroupName: "g1",
      logStreamName: "s1",
      logEvents: [
        { timestamp: now, message: "ERROR something failed" },
        { timestamp: now + 1, message: "INFO all good" },
        { timestamp: now + 2, message: "ERROR another failure" },
      ],
    });
    const f = await op("FilterLogEvents", { logGroupName: "g1", filterPattern: "ERROR" });
    expect(f.status).toBe(200);
    expect(f.json.events.length).toBe(2);
    expect(f.json.events.every((e: any) => e.message.includes("ERROR"))).toBe(true);
  });

  it("filter excludes with - prefix", async () => {
    await setup();
    const now = Date.now();
    await op("PutLogEvents", {
      logGroupName: "g1",
      logStreamName: "s1",
      logEvents: [
        { timestamp: now, message: "ERROR fail" },
        { timestamp: now + 1, message: "ERROR debug noise" },
      ],
    });
    const f = await op("FilterLogEvents", { logGroupName: "g1", filterPattern: "ERROR -debug" });
    expect(f.json.events.length).toBe(1);
    expect(f.json.events[0].message).toBe("ERROR fail");
  });

  it("sets retention policy and tags", async () => {
    await op("CreateLogGroup", { logGroupName: "g1" });
    const r = await op("PutRetentionPolicy", { logGroupName: "g1", retentionInDays: 14 });
    expect(r.status).toBe(200);
    const d = await op("DescribeLogGroups", { logGroupNamePrefix: "g1" });
    expect(d.json.logGroups[0].retentionInDays).toBe(14);

    await op("TagLogGroup", { logGroupName: "g1", tags: { env: "prod" } });
    const tags = await op("ListTagsLogGroup", { logGroupName: "g1" });
    expect(tags.json.tags.env).toBe("prod");
  });

  it("deletes a log stream and group", async () => {
    await setup();
    const ds = await op("DeleteLogStream", { logGroupName: "g1", logStreamName: "s1" });
    expect(ds.status).toBe(200);
    const dg = await op("DeleteLogGroup", { logGroupName: "g1" });
    expect(dg.status).toBe(200);
    const d = await op("DescribeLogGroups", {});
    expect(d.json.logGroups.length).toBe(0);
  });

  it("404 put to missing group", async () => {
    const put = await op("PutLogEvents", {
      logGroupName: "missing",
      logStreamName: "s1",
      logEvents: [{ timestamp: Date.now(), message: "x" }],
    });
    expect(put.status).toBe(400);
    expect(put.json.__type).toContain("ResourceNotFound");
  });
});
