// parlel/dynamodb-streams — dependency-free fake of Amazon DynamoDB Streams.
//
// AWS JSON 1.0 protocol, target prefix `DynamoDBStreams_20120810`. State is
// in-memory and ephemeral. Streams can be seeded programmatically via
// seedStream()/putRecord() helpers, or implicitly created on first reference.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.0";
const DEFAULT_ACCOUNT_ID = "000000000000";
const ERROR_TYPE_PREFIX = "com.amazonaws.dynamodb.v20120810#";

const ERROR_STATUS = {
  ResourceNotFoundException: 400,
  TrimmedDataAccessException: 400,
  ExpiredIteratorException: 400,
  ValidationException: 400,
  LimitExceededException: 400,
  InternalServerError: 500,
};

class StreamsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class DynamodbStreamsServer {
  constructor(port = 4720, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // streams: Map<streamArn, Stream>
    //   Stream = { arn, label, tableName, shards: [{shardId, records: [] }], status }
    this.streams = new Map();
    this.iterators = new Map(); // iteratorId -> { streamArn, shardId, position }
    this.seq = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new StreamsError("InternalServerError", error.message, 500));
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

  streamArn(tableName, label) {
    return `arn:aws:dynamodb:${this.region}:${this.accountId}:table/${tableName}/stream/${label}`;
  }

  // Programmatic helper: create a stream for a table.
  seedStream(tableName) {
    const label = new Date().toISOString();
    const arn = this.streamArn(tableName, label);
    if (!this.streams.has(arn)) {
      this.streams.set(arn, {
        arn,
        label,
        tableName,
        status: "ENABLED",
        shards: [{ shardId: `shardId-${randomUUID().slice(0, 8)}`, records: [] }],
        createdAt: Date.now(),
      });
    }
    return arn;
  }

  // Programmatic helper: append a record (eventName INSERT/MODIFY/REMOVE).
  putRecord(streamArn, { eventName = "INSERT", keys = {}, newImage, oldImage } = {}) {
    const stream = this.streams.get(streamArn);
    if (!stream) throw new StreamsError("ResourceNotFoundException", `Stream ${streamArn} not found`);
    const shard = stream.shards[0];
    this.seq += 1;
    const record = {
      eventID: randomUUID(),
      eventName,
      eventVersion: "1.1",
      eventSource: "aws:dynamodb",
      awsRegion: this.region,
      dynamodb: {
        ApproximateCreationDateTime: Math.floor(Date.now() / 1000),
        Keys: keys,
        SequenceNumber: String(100000000000000000000 + this.seq),
        SizeBytes: 64,
        StreamViewType: "NEW_AND_OLD_IMAGES",
        ...(newImage ? { NewImage: newImage } : {}),
        ...(oldImage ? { OldImage: oldImage } : {}),
      },
    };
    shard.records.push(record);
    return record;
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

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "dynamodb-streams",
        streams: this.streams.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    if (method !== "POST") {
      return this.sendError(res, new StreamsError("ValidationException", "Only POST supported.", 400));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;
    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new StreamsError("ValidationException", "Invalid JSON.", 400));
    }

    try {
      return this.sendJson(res, 200, this.dispatch(operation, input) ?? {});
    } catch (error) {
      if (error instanceof StreamsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "ListStreams":
        return this.listStreams(input);
      case "DescribeStream":
        return this.describeStream(input);
      case "GetShardIterator":
        return this.getShardIterator(input);
      case "GetRecords":
        return this.getRecords(input);
      default:
        throw new StreamsError("ValidationException", `Unsupported operation: ${operation}`);
    }
  }

  listStreams(input) {
    let list = [...this.streams.values()];
    if (input.TableName) list = list.filter((s) => s.tableName === input.TableName);
    return {
      Streams: list.map((s) => ({
        StreamArn: s.arn,
        TableName: s.tableName,
        StreamLabel: s.label,
      })),
    };
  }

  requireStream(arn) {
    const s = this.streams.get(arn);
    if (!s) throw new StreamsError("ResourceNotFoundException", `Stream ${arn} not found`);
    return s;
  }

  describeStream(input) {
    const stream = this.requireStream(input.StreamArn);
    return {
      StreamDescription: {
        StreamArn: stream.arn,
        StreamLabel: stream.label,
        StreamStatus: stream.status,
        StreamViewType: "NEW_AND_OLD_IMAGES",
        CreationRequestDateTime: Math.floor(stream.createdAt / 1000),
        TableName: stream.tableName,
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        Shards: stream.shards.map((sh) => ({
          ShardId: sh.shardId,
          SequenceNumberRange: {
            StartingSequenceNumber: "100000000000000000000",
          },
        })),
      },
    };
  }

  getShardIterator(input) {
    const stream = this.requireStream(input.StreamArn);
    const shard = stream.shards.find((s) => s.shardId === input.ShardId);
    if (!shard) throw new StreamsError("ResourceNotFoundException", `Shard ${input.ShardId} not found`);
    const id = randomUUID();
    let position = 0;
    if (input.ShardIteratorType === "LATEST") position = shard.records.length;
    this.iterators.set(id, { streamArn: input.StreamArn, shardId: input.ShardId, position });
    return { ShardIterator: id };
  }

  getRecords(input) {
    const it = this.iterators.get(input.ShardIterator);
    if (!it) {
      throw new StreamsError("ExpiredIteratorException", "The shard iterator is invalid or expired.");
    }
    const stream = this.requireStream(it.streamArn);
    const shard = stream.shards.find((s) => s.shardId === it.shardId);
    const limit = input.Limit ? Number(input.Limit) : 1000;
    const records = shard.records.slice(it.position, it.position + limit);
    const newPos = it.position + records.length;
    const nextId = randomUUID();
    this.iterators.set(nextId, { ...it, position: newPos });
    return { Records: records, NextShardIterator: nextId };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerError";
    res.statusCode = error.status || ERROR_STATUS[code] || 400;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", `${code}:`);
    res.end(JSON.stringify({ __type: `${ERROR_TYPE_PREFIX}${code}`, message: error.message || code }));
  }
}

export default DynamodbStreamsServer;
