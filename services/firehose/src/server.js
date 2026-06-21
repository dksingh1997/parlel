// parlel/firehose — dependency-free fake of Amazon Data Firehose.
//
// AWS JSON 1.1 protocol, target prefix `Firehose_20150804`. State is in-memory
// and ephemeral; records are buffered in memory keyed by delivery stream.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ResourceNotFoundException: 400,
  ResourceInUseException: 400,
  InvalidArgumentException: 400,
  LimitExceededException: 400,
  ServiceUnavailableException: 500,
};

class FirehoseError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class FirehoseServer {
  constructor(port = 4725, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.streams = new Map(); // name -> { name, arn, ..., records: [] }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new FirehoseError("ServiceUnavailableException", error.message, 500));
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

  streamArn(name) {
    return `arn:aws:firehose:${this.region}:${this.accountId}:deliverystream/${name}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "firehose",
        streams: this.streams.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    if (method !== "POST") {
      return this.sendError(res, new FirehoseError("InvalidArgumentException", "Only POST supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;
    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new FirehoseError("InvalidArgumentException", "Invalid JSON.", 400));
    }

    try {
      return this.sendJson(res, 200, this.dispatch(operation, input) ?? {});
    } catch (error) {
      if (error instanceof FirehoseError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateDeliveryStream":
        return this.createDeliveryStream(input);
      case "DescribeDeliveryStream":
        return this.describeDeliveryStream(input);
      case "ListDeliveryStreams":
        return this.listDeliveryStreams(input);
      case "DeleteDeliveryStream":
        return this.deleteDeliveryStream(input);
      case "PutRecord":
        return this.putRecord(input);
      case "PutRecordBatch":
        return this.putRecordBatch(input);
      default:
        throw new FirehoseError("InvalidArgumentException", `Unsupported operation: ${operation}`);
    }
  }

  createDeliveryStream(input) {
    const name = input.DeliveryStreamName;
    if (!name) throw new FirehoseError("InvalidArgumentException", "DeliveryStreamName is required.");
    if (this.streams.has(name)) {
      throw new FirehoseError("ResourceInUseException", `Delivery stream ${name} already exists.`);
    }
    const destinations = [];
    if (input.S3DestinationConfiguration || input.ExtendedS3DestinationConfiguration) {
      const cfg = input.ExtendedS3DestinationConfiguration || input.S3DestinationConfiguration;
      destinations.push({
        DestinationId: "destinationId-000000000001",
        ExtendedS3DestinationDescription: {
          BucketARN: cfg.BucketARN,
          RoleARN: cfg.RoleARN,
          Prefix: cfg.Prefix || "",
          BufferingHints: cfg.BufferingHints || { SizeInMBs: 5, IntervalInSeconds: 300 },
          CompressionFormat: cfg.CompressionFormat || "UNCOMPRESSED",
        },
      });
    }
    if (input.ElasticsearchDestinationConfiguration || input.AmazonopensearchserviceDestinationConfiguration) {
      const cfg =
        input.ElasticsearchDestinationConfiguration ||
        input.AmazonopensearchserviceDestinationConfiguration;
      destinations.push({
        DestinationId: "destinationId-000000000001",
        ElasticsearchDestinationDescription: {
          DomainARN: cfg.DomainARN,
          IndexName: cfg.IndexName,
          RoleARN: cfg.RoleARN,
        },
      });
    }
    if (!destinations.length) {
      destinations.push({ DestinationId: "destinationId-000000000001" });
    }
    this.streams.set(name, {
      name,
      arn: this.streamArn(name),
      DeliveryStreamType: input.DeliveryStreamType || "DirectPut",
      status: "ACTIVE",
      createdAt: Date.now(),
      versionId: "1",
      destinations,
      records: [],
    });
    return { DeliveryStreamARN: this.streamArn(name) };
  }

  requireStream(name) {
    const s = this.streams.get(name);
    if (!s) throw new FirehoseError("ResourceNotFoundException", `Delivery stream ${name} not found.`);
    return s;
  }

  describeDeliveryStream(input) {
    const s = this.requireStream(input.DeliveryStreamName);
    return {
      DeliveryStreamDescription: {
        DeliveryStreamName: s.name,
        DeliveryStreamARN: s.arn,
        DeliveryStreamStatus: s.status,
        DeliveryStreamType: s.DeliveryStreamType,
        VersionId: s.versionId,
        CreateTimestamp: Math.floor(s.createdAt / 1000),
        HasMoreDestinations: false,
        Destinations: s.destinations,
      },
    };
  }

  listDeliveryStreams(input = {}) {
    let names = [...this.streams.keys()].sort();
    const limit = input.Limit ? Number(input.Limit) : names.length;
    if (input.ExclusiveStartDeliveryStreamName) {
      const idx = names.indexOf(input.ExclusiveStartDeliveryStreamName);
      if (idx >= 0) names = names.slice(idx + 1);
    }
    const page = names.slice(0, limit);
    return {
      DeliveryStreamNames: page,
      HasMoreDeliveryStreams: page.length < names.length,
    };
  }

  deleteDeliveryStream(input) {
    this.requireStream(input.DeliveryStreamName);
    this.streams.delete(input.DeliveryStreamName);
    return {};
  }

  putRecord(input) {
    const s = this.requireStream(input.DeliveryStreamName);
    const data = input.Record && input.Record.Data;
    const recordId = randomUUID().replace(/-/g, "");
    s.records.push({ recordId, data });
    return { RecordId: recordId, Encrypted: false };
  }

  putRecordBatch(input) {
    const s = this.requireStream(input.DeliveryStreamName);
    const responses = (input.Records || []).map((r) => {
      const recordId = randomUUID().replace(/-/g, "");
      s.records.push({ recordId, data: r.Data });
      return { RecordId: recordId };
    });
    return {
      FailedPutCount: 0,
      Encrypted: false,
      RequestResponses: responses,
    };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "ServiceUnavailableException";
    res.statusCode = error.status || ERROR_STATUS[code] || 400;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code }));
  }
}

export default FirehoseServer;
