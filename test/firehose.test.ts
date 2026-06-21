import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FirehoseServer } from "../services/firehose/src/server.js";

const PORT = 14725;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const TARGET = "Firehose_20150804";

async function call(op: string, body: object) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `${TARGET}.${op}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("Firehose", () => {
  let server: FirehoseServer;
  beforeAll(async () => {
    server = new FirehoseServer(PORT);
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => server.reset());

  it("defaults to port 4725", () => {
    expect(new FirehoseServer().port).toBe(4725);
  });

  it("health endpoint", async () => {
    const r = await fetch(`${ENDPOINT}/_parlel/health`);
    const j = await r.json();
    expect(j.status).toBe("ok");
    expect(j.service).toBe("firehose");
  });

  it("CreateDeliveryStream with S3 destination", async () => {
    const c = await call("CreateDeliveryStream", {
      DeliveryStreamName: "logs",
      S3DestinationConfiguration: {
        BucketARN: "arn:aws:s3:::my-bucket",
        RoleARN: "arn:aws:iam::000000000000:role/firehose",
        Prefix: "logs/",
      },
    });
    expect(c.json.DeliveryStreamARN).toContain("deliverystream/logs");
  });

  it("DescribeDeliveryStream returns destinations", async () => {
    await call("CreateDeliveryStream", {
      DeliveryStreamName: "logs",
      S3DestinationConfiguration: { BucketARN: "arn:aws:s3:::b", RoleARN: "arn:r" },
    });
    const d = await call("DescribeDeliveryStream", { DeliveryStreamName: "logs" });
    expect(d.json.DeliveryStreamDescription.DeliveryStreamStatus).toBe("ACTIVE");
    expect(d.json.DeliveryStreamDescription.Destinations[0].ExtendedS3DestinationDescription.BucketARN).toBe(
      "arn:aws:s3:::b",
    );
  });

  it("ElasticsearchDestinationConfiguration", async () => {
    await call("CreateDeliveryStream", {
      DeliveryStreamName: "es",
      ElasticsearchDestinationConfiguration: {
        DomainARN: "arn:aws:es:us-east-1:000000000000:domain/d",
        IndexName: "idx",
        RoleARN: "arn:r",
      },
    });
    const d = await call("DescribeDeliveryStream", { DeliveryStreamName: "es" });
    expect(d.json.DeliveryStreamDescription.Destinations[0].ElasticsearchDestinationDescription.IndexName).toBe(
      "idx",
    );
  });

  it("ListDeliveryStreams", async () => {
    await call("CreateDeliveryStream", { DeliveryStreamName: "a" });
    await call("CreateDeliveryStream", { DeliveryStreamName: "b" });
    const l = await call("ListDeliveryStreams", {});
    expect(l.json.DeliveryStreamNames).toEqual(["a", "b"]);
  });

  it("PutRecord stores record", async () => {
    await call("CreateDeliveryStream", { DeliveryStreamName: "logs" });
    const r = await call("PutRecord", {
      DeliveryStreamName: "logs",
      Record: { Data: b64("hello") },
    });
    expect(r.json.RecordId).toBeTruthy();
    expect(server.streams.get("logs")!.records).toHaveLength(1);
  });

  it("PutRecordBatch stores records", async () => {
    await call("CreateDeliveryStream", { DeliveryStreamName: "logs" });
    const r = await call("PutRecordBatch", {
      DeliveryStreamName: "logs",
      Records: [{ Data: b64("a") }, { Data: b64("b") }, { Data: b64("c") }],
    });
    expect(r.json.FailedPutCount).toBe(0);
    expect(r.json.RequestResponses).toHaveLength(3);
    expect(server.streams.get("logs")!.records).toHaveLength(3);
  });

  it("DeleteDeliveryStream", async () => {
    await call("CreateDeliveryStream", { DeliveryStreamName: "logs" });
    await call("DeleteDeliveryStream", { DeliveryStreamName: "logs" });
    const d = await call("DescribeDeliveryStream", { DeliveryStreamName: "logs" });
    expect(d.status).toBe(400);
  });

  it("PutRecord to missing stream errors", async () => {
    const r = await call("PutRecord", { DeliveryStreamName: "nope", Record: { Data: b64("x") } });
    expect(r.status).toBe(400);
    expect(r.json.__type).toContain("ResourceNotFoundException");
  });
});
