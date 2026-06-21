import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DynamodbStreamsServer } from "../services/dynamodb-streams/src/server.js";

const PORT = 14720;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const TARGET = "DynamoDBStreams_20120810";

async function call(op: string, body: object) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": `${TARGET}.${op}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("DynamoDB Streams", () => {
  let server: DynamodbStreamsServer;
  beforeAll(async () => {
    server = new DynamodbStreamsServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4720", () => {
    expect(new DynamodbStreamsServer().port).toBe(4720);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("dynamodb-streams");
  });

  it("ListStreams returns seeded streams", async () => {
    server.seedStream("Users");
    const l = await call("ListStreams", {});
    expect(l.json.Streams).toHaveLength(1);
    expect(l.json.Streams[0].TableName).toBe("Users");
  });

  it("ListStreams filters by TableName", async () => {
    server.seedStream("Users");
    server.seedStream("Orders");
    const l = await call("ListStreams", { TableName: "Orders" });
    expect(l.json.Streams).toHaveLength(1);
    expect(l.json.Streams[0].TableName).toBe("Orders");
  });

  it("DescribeStream returns shards", async () => {
    const arn = server.seedStream("Users");
    const d = await call("DescribeStream", { StreamArn: arn });
    expect(d.json.StreamDescription.StreamStatus).toBe("ENABLED");
    expect(d.json.StreamDescription.Shards.length).toBeGreaterThan(0);
  });

  it("GetShardIterator + GetRecords reads seeded records", async () => {
    const arn = server.seedStream("Users");
    server.putRecord(arn, {
      eventName: "INSERT",
      keys: { id: { S: "1" } },
      newImage: { id: { S: "1" }, name: { S: "Alice" } },
    });
    server.putRecord(arn, {
      eventName: "MODIFY",
      keys: { id: { S: "1" } },
      newImage: { id: { S: "1" }, name: { S: "Bob" } },
      oldImage: { id: { S: "1" }, name: { S: "Alice" } },
    });

    const d = await call("DescribeStream", { StreamArn: arn });
    const shardId = d.json.StreamDescription.Shards[0].ShardId;

    const si = await call("GetShardIterator", {
      StreamArn: arn,
      ShardId: shardId,
      ShardIteratorType: "TRIM_HORIZON",
    });
    expect(si.json.ShardIterator).toBeTruthy();

    const gr = await call("GetRecords", { ShardIterator: si.json.ShardIterator });
    expect(gr.json.Records).toHaveLength(2);
    expect(gr.json.Records[0].eventName).toBe("INSERT");
    expect(gr.json.Records[1].eventName).toBe("MODIFY");
    expect(gr.json.Records[1].dynamodb.OldImage.name.S).toBe("Alice");
    expect(gr.json.NextShardIterator).toBeTruthy();
  });

  it("GetRecords LATEST iterator returns nothing for old records", async () => {
    const arn = server.seedStream("Users");
    server.putRecord(arn, { eventName: "INSERT", keys: { id: { S: "1" } } });
    const d = await call("DescribeStream", { StreamArn: arn });
    const shardId = d.json.StreamDescription.Shards[0].ShardId;
    const si = await call("GetShardIterator", {
      StreamArn: arn,
      ShardId: shardId,
      ShardIteratorType: "LATEST",
    });
    const gr = await call("GetRecords", { ShardIterator: si.json.ShardIterator });
    expect(gr.json.Records).toHaveLength(0);
  });

  it("DescribeStream on missing stream errors", async () => {
    const d = await call("DescribeStream", { StreamArn: "arn:aws:dynamodb:us-east-1:000000000000:table/X/stream/none" });
    expect(d.status).toBe(400);
    expect(d.json.__type).toContain("ResourceNotFoundException");
  });

  it("GetRecords with expired iterator errors", async () => {
    const gr = await call("GetRecords", { ShardIterator: "nope" });
    expect(gr.status).toBe(400);
    expect(gr.json.__type).toContain("ExpiredIteratorException");
  });
});
