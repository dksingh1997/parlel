// parlel/kinesis — a lightweight, dependency-free fake of Amazon Kinesis Data
// Streams.
//
// Speaks the Kinesis AWS JSON 1.1 wire protocol so application code using the
// real `@aws-sdk/client-kinesis` client can run against it with zero cost and
// zero side effects. Pure Node.js, no external npm dependencies. State is
// in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-kinesis v3):
//   * Requests are POST / with header `X-Amz-Target: Kinesis_20131202.<Operation>`
//     and `Content-Type: application/x-amz-json-1.1`. Body is JSON input.
//   * Success: 200, JSON output, `Content-Type: application/x-amz-json-1.1`.
//   * Error: non-2xx, JSON `{ "__type": "<Code>", "message": "<msg>" }` plus the
//     `x-amzn-errortype: <Code>` header. JSON-RPC error code resolution reads
//     `__type` from the body first, then the header.
//   * Record `Data` is a blob — base64-encoded on the wire, decoded by the SDK
//     into a Uint8Array. We round-trip it verbatim.
//
// State model: streams hold shards, shards hold an ordered list of records.
// Shard iterators are opaque, position-encoding tokens. GetRecords advances the
// iterator. Sharding is simplified: PutRecord hashes the partition key to pick a
// shard deterministically; explicit hash keys are honored where provided.

import { createServer as createHttp1Server } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import { createServer as createTcpServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";

// HTTP/2 cleartext (h2c) connection preface. Clients using prior knowledge open
// the connection with these exact bytes.
const HTTP2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";
const TARGET_PREFIX = "Kinesis_20131202";

// 2^128 — the size of the Kinesis hash-key space.
const HASH_KEY_MAX = 340282366920938463463374607431768211455n;

// Kinesis error codes -> HTTP status.
const ERROR_STATUS = {
  ResourceNotFoundException: 400,
  ResourceInUseException: 400,
  InvalidArgumentException: 400,
  LimitExceededException: 400,
  ExpiredIteratorException: 400,
  ExpiredNextTokenException: 400,
  ProvisionedThroughputExceededException: 400,
  KMSDisabledException: 400,
  KMSInvalidStateException: 400,
  KMSAccessDeniedException: 400,
  KMSNotFoundException: 400,
  KMSOptInRequired: 400,
  KMSThrottlingException: 400,
  ValidationException: 400,
  AccessDeniedException: 400,
  InternalFailureException: 500,
};

class KinesisError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

// MD5 of a partition key, interpreted as a 128-bit unsigned integer. This is the
// real Kinesis explicit-hash-key derivation.
function partitionKeyToHash(partitionKey) {
  const digest = createHash("md5").update(String(partitionKey), "utf8").digest("hex");
  return BigInt("0x" + digest);
}

function isValidStreamName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_.-]+$/.test(name) && name.length >= 1 && name.length <= 128;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class KinesisServer {
  constructor(port = 4576, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // streams: Map<streamName, Stream>
    // Stream = {
    //   name, arn, status, streamModeDetails,
    //   retentionPeriodHours, createdAt (sec),
    //   shards: Map<shardId, Shard>,
    //   shardCounter, sequenceCounter,
    //   tags: Map<string,string>,
    //   encryptionType, keyId,
    //   enhancedMonitoring: Set<string>,
    //   consumers: Map<consumerName, Consumer>,
    //   consumerCounter,
    // }
    // Shard = {
    //   shardId, hashKeyStart (BigInt), hashKeyEnd (BigInt),
    //   startingSequenceNumber, endingSequenceNumber (null = open),
    //   parentShardId, adjacentParentShardId,
    //   records: Record[],   // ordered
    // }
    // Record = { sequenceNumber, data (base64 str), partitionKey, approximateArrivalTimestamp, explicitHashKey }
    this.streams = new Map();
    this.streamCounter = 0;
    // Resource policies keyed by resource ARN.
    this.resourcePolicies = new Map();
    // Account-level settings (minimum throughput billing commitment).
    this.accountSettings = {
      minimumThroughputBillingCommitment: { Status: "DISABLED" },
    };
  }

  start() {
    const onRequest = (req, res) => {
      this.handle(req, res).catch((error) => {
        this.sendError(res, new KinesisError("InternalFailureException", error.message, 500));
      });
    };

    // The real @aws-sdk/client-kinesis ships a NodeHttp2Handler, so the client
    // speaks HTTP/2 cleartext (h2c) with prior knowledge. Tools like fetch/curl
    // and the internal /_parlel/* endpoints speak HTTP/1.1. We front both with a
    // raw TCP listener that sniffs the first bytes: the h2c connection preface
    // is routed to an http2 server, everything else to an http1 server.
    this.http2 = createHttp2Server(onRequest);
    this.http1 = createHttp1Server(onRequest);
    // Swallow per-server errors so a stray connection can't crash the process.
    this.http2.on("error", () => {});
    this.http1.on("error", () => {});

    this.tcp = createTcpServer((socket) => {
      socket.once("data", (chunk) => {
        const isH2 =
          chunk.length >= HTTP2_PREFACE.length &&
          chunk.subarray(0, HTTP2_PREFACE.length).equals(HTTP2_PREFACE);
        const target = isH2 ? this.http2 : this.http1;
        // Replay the consumed bytes and hand the socket to the chosen server.
        socket.pause();
        target.emit("connection", socket);
        socket.unshift(chunk);
        socket.resume();
      });
      socket.on("error", () => {});
    });

    return new Promise((resolve, reject) => {
      this.server = this.tcp;
      this.tcp.once("error", reject);
      this.tcp.listen(this.port, this.host, () => {
        this.tcp.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.tcp) return resolve();
      const closeAll = () => {
        let pending = 2;
        let failed = null;
        const done = (err) => {
          if (err) failed = err;
          if (--pending === 0) {
            this.server = null;
            this.tcp = null;
            if (failed) reject(failed);
            else resolve();
          }
        };
        try {
          this.http2.close(() => done());
        } catch {
          done();
        }
        try {
          this.http1.close(() => done());
        } catch {
          done();
        }
      };
      this.tcp.close(() => closeAll());
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

  streamArn(name) {
    return `arn:aws:kinesis:${this.region}:${this.accountId}:stream/${name}`;
  }

  consumerArn(streamName, consumerName, creationTs) {
    return `${this.streamArn(streamName)}/consumer/${consumerName}:${creationTs}`;
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "kinesis",
        streams: this.streams.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-kinesis");

    if (method !== "POST") {
      return this.sendError(
        res,
        new KinesisError("AccessDeniedException", "Only POST is supported by the parlel kinesis fake.", 405),
      );
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(
        res,
        new KinesisError("InvalidArgumentException", "Request body is not valid JSON.", 400),
      );
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof KinesisError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      // Stream lifecycle
      case "CreateStream":
        return this.createStream(input);
      case "DeleteStream":
        return this.deleteStream(input);
      case "ListStreams":
        return this.listStreams(input);
      case "DescribeStream":
        return this.describeStream(input);
      case "DescribeStreamSummary":
        return this.describeStreamSummary(input);
      case "DescribeLimits":
        return this.describeLimits(input);
      case "DescribeAccountSettings":
        return this.describeAccountSettings(input);
      case "UpdateAccountSettings":
        return this.updateAccountSettings(input);
      case "UpdateMaxRecordSize":
        return this.updateMaxRecordSize(input);
      // Retention
      case "IncreaseStreamRetentionPeriod":
        return this.increaseStreamRetentionPeriod(input);
      case "DecreaseStreamRetentionPeriod":
        return this.decreaseStreamRetentionPeriod(input);
      // Shards
      case "ListShards":
        return this.listShards(input);
      case "GetShardIterator":
        return this.getShardIterator(input);
      case "MergeShards":
        return this.mergeShards(input);
      case "SplitShard":
        return this.splitShard(input);
      case "UpdateShardCount":
        return this.updateShardCount(input);
      case "UpdateStreamMode":
        return this.updateStreamMode(input);
      case "UpdateStreamWarmThroughput":
        return this.updateStreamWarmThroughput(input);
      // Records
      case "PutRecord":
        return this.putRecord(input);
      case "PutRecords":
        return this.putRecords(input);
      case "GetRecords":
        return this.getRecords(input);
      // Tags
      case "AddTagsToStream":
        return this.addTagsToStream(input);
      case "RemoveTagsFromStream":
        return this.removeTagsFromStream(input);
      case "ListTagsForStream":
        return this.listTagsForStream(input);
      case "TagResource":
        return this.tagResource(input);
      case "UntagResource":
        return this.untagResource(input);
      case "ListTagsForResource":
        return this.listTagsForResource(input);
      // Enhanced monitoring
      case "EnableEnhancedMonitoring":
        return this.enableEnhancedMonitoring(input);
      case "DisableEnhancedMonitoring":
        return this.disableEnhancedMonitoring(input);
      // Encryption
      case "StartStreamEncryption":
        return this.startStreamEncryption(input);
      case "StopStreamEncryption":
        return this.stopStreamEncryption(input);
      // Consumers (enhanced fan-out)
      case "RegisterStreamConsumer":
        return this.registerStreamConsumer(input);
      case "DeregisterStreamConsumer":
        return this.deregisterStreamConsumer(input);
      case "DescribeStreamConsumer":
        return this.describeStreamConsumer(input);
      case "ListStreamConsumers":
        return this.listStreamConsumers(input);
      // Resource policies
      case "PutResourcePolicy":
        return this.putResourcePolicy(input);
      case "GetResourcePolicy":
        return this.getResourcePolicy(input);
      case "DeleteResourcePolicy":
        return this.deleteResourcePolicy(input);
      // Event-stream op (HTTP/2 fan-out) — not supported over this transport.
      case "SubscribeToShard":
        throw new KinesisError(
          "InvalidArgumentException",
          "SubscribeToShard requires an HTTP/2 event stream and is not supported by the parlel kinesis fake. Use GetRecords / GetShardIterator instead.",
          400,
        );
      default:
        throw new KinesisError(
          "InvalidArgumentException",
          `The action ${operation || "(none)"} is not valid for this endpoint.`,
          400,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Stream resolution
  // -------------------------------------------------------------------------
  streamNameFromArn(arn) {
    // arn:aws:kinesis:region:acct:stream/<name>
    const marker = ":stream/";
    const idx = arn.indexOf(marker);
    if (idx === -1) return null;
    let rest = arn.slice(idx + marker.length);
    // strip any /consumer/... suffix
    const slash = rest.indexOf("/");
    if (slash !== -1) rest = rest.slice(0, slash);
    return rest;
  }

  // Resolve a stream from either StreamName or StreamARN.
  resolveStream(input, { required = true } = {}) {
    let name = input.StreamName;
    if (!name && input.StreamARN) {
      name = this.streamNameFromArn(input.StreamARN);
    }
    if (!name) {
      if (!required) return null;
      throw new KinesisError(
        "InvalidArgumentException",
        "Either StreamName or StreamARN must be provided.",
      );
    }
    const stream = this.streams.get(name);
    if (!stream) {
      if (!required) return null;
      throw new KinesisError(
        "ResourceNotFoundException",
        `Stream ${name} under account ${this.accountId} not found.`,
      );
    }
    return stream;
  }

  // -------------------------------------------------------------------------
  // Shard / sequence helpers
  // -------------------------------------------------------------------------
  nextShardId(stream) {
    const id = `shardId-${String(stream.shardCounter++).padStart(12, "0")}`;
    return id;
  }

  nextSequenceNumber(stream) {
    // Monotonic, lexicographically sortable (zero-padded). Real Kinesis uses
    // a 56-digit decimal; we use a wide zero-padded counter which preserves
    // ordering and is opaque to clients.
    return String(++stream.sequenceCounter).padStart(56, "0");
  }

  buildEvenShards(stream, count) {
    const shards = new Map();
    const span = (HASH_KEY_MAX + 1n) / BigInt(count);
    for (let i = 0; i < count; i++) {
      const start = span * BigInt(i);
      const end = i === count - 1 ? HASH_KEY_MAX : span * BigInt(i + 1) - 1n;
      const shardId = this.nextShardId(stream);
      shards.set(shardId, {
        shardId,
        hashKeyStart: start,
        hashKeyEnd: end,
        startingSequenceNumber: this.nextSequenceNumber(stream),
        endingSequenceNumber: null,
        parentShardId: undefined,
        adjacentParentShardId: undefined,
        records: [],
      });
    }
    return shards;
  }

  // -------------------------------------------------------------------------
  // Stream lifecycle
  // -------------------------------------------------------------------------
  createStream(input) {
    const name = input.StreamName;
    if (!name) {
      throw new KinesisError("InvalidArgumentException", "StreamName is required.");
    }
    if (!isValidStreamName(name)) {
      throw new KinesisError(
        "InvalidArgumentException",
        "Stream name can only contain alphanumeric characters, hyphens, underscores, and periods (1-128 chars).",
      );
    }
    if (this.streams.has(name)) {
      throw new KinesisError(
        "ResourceInUseException",
        `Stream ${name} under account ${this.accountId} already exists.`,
      );
    }

    const mode = (input.StreamModeDetails && input.StreamModeDetails.StreamMode) || "PROVISIONED";
    let shardCount = input.ShardCount;
    if (mode === "ON_DEMAND") {
      // On-demand streams ignore ShardCount; start with 4 shards like AWS.
      shardCount = 4;
    } else {
      if (shardCount === undefined || shardCount === null) {
        throw new KinesisError(
          "InvalidArgumentException",
          "ShardCount is required for PROVISIONED streams.",
        );
      }
      shardCount = parseInt(shardCount, 10);
      if (Number.isNaN(shardCount) || shardCount < 1 || shardCount > 100000) {
        throw new KinesisError(
          "InvalidArgumentException",
          `ShardCount ${input.ShardCount} is invalid. Must be between 1 and 100000.`,
        );
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const stream = {
      name,
      arn: this.streamArn(name),
      status: "ACTIVE",
      streamModeDetails: { StreamMode: mode },
      retentionPeriodHours: 24,
      createdAt: now,
      shards: new Map(),
      shardCounter: 0,
      sequenceCounter: 0,
      tags: new Map(),
      encryptionType: "NONE",
      keyId: undefined,
      enhancedMonitoring: new Set(),
      consumers: new Map(),
      consumerCounter: 0,
      warmThroughput: undefined,
    };
    if (input.Tags && typeof input.Tags === "object") {
      for (const [k, v] of Object.entries(input.Tags)) stream.tags.set(k, String(v));
    }
    stream.shards = this.buildEvenShards(stream, shardCount);
    this.streams.set(name, stream);
    return {};
  }

  deleteStream(input) {
    const stream = this.resolveStream(input);
    this.streams.delete(stream.name);
    return {};
  }

  listStreams(input = {}) {
    let names = [...this.streams.keys()].sort();
    const limit = input.Limit ? parseInt(input.Limit, 10) : 100;

    let start = 0;
    if (input.NextToken) {
      try {
        start = parseInt(Buffer.from(input.NextToken, "base64").toString("utf8"), 10) || 0;
      } catch {
        throw new KinesisError("ExpiredNextTokenException", "Invalid NextToken.");
      }
    } else if (input.ExclusiveStartStreamName) {
      const idx = names.indexOf(input.ExclusiveStartStreamName);
      start = idx === -1 ? 0 : idx + 1;
    }

    const page = names.slice(start, start + limit);
    const hasMore = start + limit < names.length;

    const out = {
      StreamNames: page,
      HasMoreStreams: hasMore,
      StreamSummaries: page.map((n) => this.streamSummary(this.streams.get(n))),
    };
    if (hasMore) {
      out.NextToken = Buffer.from(String(start + limit)).toString("base64");
    }
    return out;
  }

  streamSummary(stream) {
    return {
      StreamName: stream.name,
      StreamARN: stream.arn,
      StreamStatus: stream.status,
      StreamModeDetails: stream.streamModeDetails,
      StreamCreationTimestamp: stream.createdAt,
    };
  }

  describeStream(input) {
    const stream = this.resolveStream(input);
    const limit = input.Limit ? parseInt(input.Limit, 10) : 100;
    const allShards = [...stream.shards.values()];

    let startIdx = 0;
    if (input.ExclusiveStartShardId) {
      const idx = allShards.findIndex((s) => s.shardId === input.ExclusiveStartShardId);
      startIdx = idx === -1 ? allShards.length : idx + 1;
    }
    const page = allShards.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < allShards.length;

    return {
      StreamDescription: {
        StreamName: stream.name,
        StreamARN: stream.arn,
        StreamStatus: stream.status,
        StreamModeDetails: stream.streamModeDetails,
        Shards: page.map((s) => this.shardJson(s)),
        HasMoreShards: hasMore,
        RetentionPeriodHours: stream.retentionPeriodHours,
        StreamCreationTimestamp: stream.createdAt,
        EnhancedMonitoring: [{ ShardLevelMetrics: [...stream.enhancedMonitoring] }],
        EncryptionType: stream.encryptionType,
        ...(stream.keyId ? { KeyId: stream.keyId } : {}),
      },
    };
  }

  shardJson(shard) {
    const out = {
      ShardId: shard.shardId,
      HashKeyRange: {
        StartingHashKey: shard.hashKeyStart.toString(),
        EndingHashKey: shard.hashKeyEnd.toString(),
      },
      SequenceNumberRange: {
        StartingSequenceNumber: shard.startingSequenceNumber,
        ...(shard.endingSequenceNumber ? { EndingSequenceNumber: shard.endingSequenceNumber } : {}),
      },
    };
    if (shard.parentShardId) out.ParentShardId = shard.parentShardId;
    if (shard.adjacentParentShardId) out.AdjacentParentShardId = shard.adjacentParentShardId;
    return out;
  }

  describeStreamSummary(input) {
    const stream = this.resolveStream(input);
    const openShards = [...stream.shards.values()].filter((s) => !s.endingSequenceNumber);
    return {
      StreamDescriptionSummary: {
        StreamName: stream.name,
        StreamARN: stream.arn,
        StreamStatus: stream.status,
        StreamModeDetails: stream.streamModeDetails,
        RetentionPeriodHours: stream.retentionPeriodHours,
        StreamCreationTimestamp: stream.createdAt,
        EnhancedMonitoring: [{ ShardLevelMetrics: [...stream.enhancedMonitoring] }],
        EncryptionType: stream.encryptionType,
        ...(stream.keyId ? { KeyId: stream.keyId } : {}),
        OpenShardCount: openShards.length,
        ConsumerCount: stream.consumers.size,
      },
    };
  }

  describeLimits() {
    let openShards = 0;
    for (const stream of this.streams.values()) {
      openShards += [...stream.shards.values()].filter((s) => !s.endingSequenceNumber).length;
    }
    return {
      ShardLimit: 500,
      OpenShardCount: openShards,
      OnDemandStreamCount: [...this.streams.values()].filter(
        (s) => s.streamModeDetails.StreamMode === "ON_DEMAND",
      ).length,
      OnDemandStreamCountLimit: 50,
    };
  }

  describeAccountSettings() {
    return {
      MinimumThroughputBillingCommitment: this.accountSettings.minimumThroughputBillingCommitment,
    };
  }

  updateAccountSettings(input) {
    const commitment = input.MinimumThroughputBillingCommitment;
    if (!commitment || !commitment.Status) {
      throw new KinesisError(
        "InvalidArgumentException",
        "MinimumThroughputBillingCommitment.Status is required.",
      );
    }
    if (commitment.Status !== "ENABLED" && commitment.Status !== "DISABLED") {
      throw new KinesisError("ValidationException", "Status must be ENABLED or DISABLED.");
    }
    // AWS JSON serializes timestamps as epoch seconds (a number).
    const nowSec = Math.floor(Date.now() / 1000);
    this.accountSettings.minimumThroughputBillingCommitment =
      commitment.Status === "ENABLED"
        ? { Status: "ENABLED", StartedAt: nowSec, EarliestAllowedEndAt: nowSec }
        : { Status: "DISABLED" };
    return {
      MinimumThroughputBillingCommitment: this.accountSettings.minimumThroughputBillingCommitment,
    };
  }

  updateMaxRecordSize(input) {
    const stream = this.resolveStream(input);
    const size = parseInt(input.MaxRecordSizeInKiB, 10);
    if (Number.isNaN(size) || size < 1024 || size > 10240) {
      throw new KinesisError(
        "ValidationException",
        "MaxRecordSizeInKiB must be between 1024 and 10240 KiB.",
      );
    }
    stream.maxRecordSizeInKiB = size;
    return {
      StreamARN: stream.arn,
      StreamName: stream.name,
      MaxRecordSizeInKiB: size,
    };
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------
  increaseStreamRetentionPeriod(input) {
    const stream = this.resolveStream(input);
    const hours = parseInt(input.RetentionPeriodHours, 10);
    if (Number.isNaN(hours)) {
      throw new KinesisError("InvalidArgumentException", "RetentionPeriodHours is required.");
    }
    if (hours <= stream.retentionPeriodHours) {
      throw new KinesisError(
        "InvalidArgumentException",
        `Requested retention period (${hours} hours) for stream ${stream.name} cannot be longer than existing.`,
      );
    }
    if (hours > 8760) {
      throw new KinesisError(
        "InvalidArgumentException",
        "Retention period cannot exceed 8760 hours.",
      );
    }
    stream.retentionPeriodHours = hours;
    return {};
  }

  decreaseStreamRetentionPeriod(input) {
    const stream = this.resolveStream(input);
    const hours = parseInt(input.RetentionPeriodHours, 10);
    if (Number.isNaN(hours)) {
      throw new KinesisError("InvalidArgumentException", "RetentionPeriodHours is required.");
    }
    if (hours >= stream.retentionPeriodHours) {
      throw new KinesisError(
        "InvalidArgumentException",
        `Requested retention period (${hours} hours) for stream ${stream.name} cannot be longer than existing.`,
      );
    }
    if (hours < 24) {
      throw new KinesisError(
        "InvalidArgumentException",
        "Minimum retention period is 24 hours.",
      );
    }
    stream.retentionPeriodHours = hours;
    return {};
  }

  // -------------------------------------------------------------------------
  // Shards
  // -------------------------------------------------------------------------
  listShards(input) {
    let stream;
    if (input.NextToken) {
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(input.NextToken, "base64").toString("utf8"));
      } catch {
        throw new KinesisError("InvalidArgumentException", "Invalid NextToken.");
      }
      if (input.StreamName || input.StreamARN) {
        throw new KinesisError(
          "InvalidArgumentException",
          "NextToken and StreamName/StreamARN cannot be provided together.",
        );
      }
      stream = this.streams.get(decoded.stream);
      if (!stream) {
        throw new KinesisError("ResourceNotFoundException", `Stream ${decoded.stream} not found.`);
      }
      input = { ...input, _start: decoded.start };
    } else {
      stream = this.resolveStream(input);
    }

    const limit = input.MaxResults ? parseInt(input.MaxResults, 10) : 1000;
    let all = [...stream.shards.values()];

    let start = input._start || 0;
    if (input.ExclusiveStartShardId) {
      const idx = all.findIndex((s) => s.shardId === input.ExclusiveStartShardId);
      start = idx === -1 ? all.length : idx + 1;
    }
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    const out = { Shards: page.map((s) => this.shardJson(s)) };
    if (hasMore) {
      out.NextToken = Buffer.from(
        JSON.stringify({ stream: stream.name, start: start + limit }),
      ).toString("base64");
    }
    return out;
  }

  getShardIterator(input) {
    const stream = this.resolveStream(input);
    const shardId = input.ShardId;
    if (!shardId) {
      throw new KinesisError("InvalidArgumentException", "ShardId is required.");
    }
    const shard = stream.shards.get(shardId);
    if (!shard) {
      throw new KinesisError(
        "ResourceNotFoundException",
        `Shard ${shardId} in stream ${stream.name} under account ${this.accountId} does not exist.`,
      );
    }
    const type = input.ShardIteratorType;
    const validTypes = [
      "AT_SEQUENCE_NUMBER",
      "AFTER_SEQUENCE_NUMBER",
      "TRIM_HORIZON",
      "LATEST",
      "AT_TIMESTAMP",
    ];
    if (!validTypes.includes(type)) {
      throw new KinesisError(
        "InvalidArgumentException",
        `Invalid ShardIteratorType: ${type}.`,
      );
    }

    // Determine starting position as an index into shard.records.
    let position = 0;
    if (type === "TRIM_HORIZON") {
      position = 0;
    } else if (type === "LATEST") {
      position = shard.records.length;
    } else if (type === "AT_TIMESTAMP") {
      if (input.Timestamp === undefined || input.Timestamp === null) {
        throw new KinesisError("InvalidArgumentException", "Timestamp is required for AT_TIMESTAMP.");
      }
      const ts = typeof input.Timestamp === "number" ? input.Timestamp * 1000 : new Date(input.Timestamp).getTime();
      position = shard.records.findIndex((r) => r.approximateArrivalTimestamp * 1000 >= ts);
      if (position === -1) position = shard.records.length;
    } else if (type === "AT_SEQUENCE_NUMBER" || type === "AFTER_SEQUENCE_NUMBER") {
      const seq = input.StartingSequenceNumber;
      if (!seq) {
        throw new KinesisError(
          "InvalidArgumentException",
          `StartingSequenceNumber is required for ${type}.`,
        );
      }
      const idx = shard.records.findIndex((r) => r.sequenceNumber === seq);
      if (idx === -1) {
        // Sequence not found among current records — position past the matching point.
        position = shard.records.findIndex((r) => r.sequenceNumber > seq);
        if (position === -1) position = shard.records.length;
      } else {
        position = type === "AT_SEQUENCE_NUMBER" ? idx : idx + 1;
      }
    }

    const token = this.encodeIterator(stream.name, shardId, position);
    return { ShardIterator: token };
  }

  encodeIterator(streamName, shardId, position) {
    return Buffer.from(
      JSON.stringify({ s: streamName, sh: shardId, p: position, t: Date.now() }),
    ).toString("base64");
  }

  decodeIterator(token) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    } catch {
      throw new KinesisError("InvalidArgumentException", "Invalid ShardIterator.");
    }
    if (!decoded || typeof decoded.p !== "number" || !decoded.s || !decoded.sh) {
      throw new KinesisError("InvalidArgumentException", "Invalid ShardIterator.");
    }
    return decoded;
  }

  mergeShards(input) {
    const stream = this.resolveStream(input);
    const shard = stream.shards.get(input.ShardToMerge);
    const adjacent = stream.shards.get(input.AdjacentShardToMerge);
    if (!shard || !adjacent) {
      throw new KinesisError(
        "ResourceNotFoundException",
        "One or both of the specified shards do not exist.",
      );
    }
    if (shard.endingSequenceNumber || adjacent.endingSequenceNumber) {
      throw new KinesisError("InvalidArgumentException", "Cannot merge a closed shard.");
    }
    // Shards must be adjacent in hash space.
    const [lo, hi] =
      shard.hashKeyStart < adjacent.hashKeyStart ? [shard, adjacent] : [adjacent, shard];
    if (lo.hashKeyEnd + 1n !== hi.hashKeyStart) {
      throw new KinesisError("InvalidArgumentException", "Specified shards are not adjacent.");
    }

    const now = Math.floor(Date.now() / 1000);
    lo.endingSequenceNumber = this.nextSequenceNumber(stream);
    hi.endingSequenceNumber = lo.endingSequenceNumber;

    const childId = this.nextShardId(stream);
    stream.shards.set(childId, {
      shardId: childId,
      hashKeyStart: lo.hashKeyStart,
      hashKeyEnd: hi.hashKeyEnd,
      startingSequenceNumber: this.nextSequenceNumber(stream),
      endingSequenceNumber: null,
      parentShardId: lo.shardId,
      adjacentParentShardId: hi.shardId,
      records: [],
    });
    void now;
    return {};
  }

  splitShard(input) {
    const stream = this.resolveStream(input);
    const shard = stream.shards.get(input.ShardToSplit);
    if (!shard) {
      throw new KinesisError(
        "ResourceNotFoundException",
        `Shard ${input.ShardToSplit} does not exist.`,
      );
    }
    if (shard.endingSequenceNumber) {
      throw new KinesisError("InvalidArgumentException", "Cannot split a closed shard.");
    }
    if (!input.NewStartingHashKey) {
      throw new KinesisError("InvalidArgumentException", "NewStartingHashKey is required.");
    }
    let newStart;
    try {
      newStart = BigInt(input.NewStartingHashKey);
    } catch {
      throw new KinesisError("InvalidArgumentException", "NewStartingHashKey must be a valid integer.");
    }
    if (newStart <= shard.hashKeyStart || newStart > shard.hashKeyEnd) {
      throw new KinesisError(
        "InvalidArgumentException",
        "NewStartingHashKey must fall within the parent shard's hash key range.",
      );
    }

    shard.endingSequenceNumber = this.nextSequenceNumber(stream);

    const child1 = this.nextShardId(stream);
    const child2 = this.nextShardId(stream);
    stream.shards.set(child1, {
      shardId: child1,
      hashKeyStart: shard.hashKeyStart,
      hashKeyEnd: newStart - 1n,
      startingSequenceNumber: this.nextSequenceNumber(stream),
      endingSequenceNumber: null,
      parentShardId: shard.shardId,
      adjacentParentShardId: undefined,
      records: [],
    });
    stream.shards.set(child2, {
      shardId: child2,
      hashKeyStart: newStart,
      hashKeyEnd: shard.hashKeyEnd,
      startingSequenceNumber: this.nextSequenceNumber(stream),
      endingSequenceNumber: null,
      parentShardId: shard.shardId,
      adjacentParentShardId: undefined,
      records: [],
    });
    return {};
  }

  updateShardCount(input) {
    const stream = this.resolveStream(input);
    const target = parseInt(input.TargetShardCount, 10);
    if (Number.isNaN(target) || target < 1) {
      throw new KinesisError("InvalidArgumentException", "TargetShardCount must be a positive integer.");
    }
    if (input.ScalingType && input.ScalingType !== "UNIFORM_SCALING") {
      throw new KinesisError("InvalidArgumentException", "ScalingType must be UNIFORM_SCALING.");
    }
    const currentOpen = [...stream.shards.values()].filter((s) => !s.endingSequenceNumber).length;

    // Close existing open shards and rebuild an evenly-partitioned set.
    for (const s of stream.shards.values()) {
      if (!s.endingSequenceNumber) s.endingSequenceNumber = this.nextSequenceNumber(stream);
    }
    const newShards = this.buildEvenShards(stream, target);
    for (const [id, sh] of newShards) stream.shards.set(id, sh);

    return {
      StreamName: stream.name,
      CurrentShardCount: currentOpen,
      TargetShardCount: target,
    };
  }

  updateStreamMode(input) {
    const stream = this.resolveStream({ StreamARN: input.StreamARN, StreamName: input.StreamName });
    const mode = input.StreamModeDetails && input.StreamModeDetails.StreamMode;
    if (mode !== "ON_DEMAND" && mode !== "PROVISIONED") {
      throw new KinesisError("InvalidArgumentException", "StreamMode must be ON_DEMAND or PROVISIONED.");
    }
    stream.streamModeDetails = { StreamMode: mode };
    return {};
  }

  updateStreamWarmThroughput(input) {
    const stream = this.resolveStream(input);
    const target = input.WarmThroughputMiBps;
    if (target === undefined || target === null) {
      throw new KinesisError("InvalidArgumentException", "WarmThroughputMiBps is required.");
    }
    stream.warmThroughput = { TargetMiBps: target, CurrentMiBps: target };
    return {
      StreamARN: stream.arn,
      StreamName: stream.name,
      WarmThroughput: stream.warmThroughput,
    };
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------
  pickShard(stream, partitionKey, explicitHashKey) {
    const hash = explicitHashKey !== undefined && explicitHashKey !== null
      ? BigInt(explicitHashKey)
      : partitionKeyToHash(partitionKey);
    let fallback = null;
    for (const shard of stream.shards.values()) {
      if (shard.endingSequenceNumber) continue; // closed
      fallback = fallback || shard;
      if (hash >= shard.hashKeyStart && hash <= shard.hashKeyEnd) {
        return shard;
      }
    }
    if (!fallback) {
      throw new KinesisError("ResourceNotFoundException", "No open shards available.");
    }
    return fallback;
  }

  // Normalizes wire `Data` (base64 string or Uint8Array-like) to a base64 string.
  normalizeData(data) {
    if (data === undefined || data === null) {
      throw new KinesisError("InvalidArgumentException", "Record Data is required.");
    }
    if (typeof data === "string") {
      return data; // already base64 on the wire
    }
    // Uint8Array / array of bytes (defensive — wire form is a base64 string).
    return Buffer.from(data).toString("base64");
  }

  appendRecord(stream, shard, partitionKey, dataB64, explicitHashKey) {
    const seq = this.nextSequenceNumber(stream);
    const rec = {
      sequenceNumber: seq,
      data: dataB64,
      partitionKey: String(partitionKey),
      approximateArrivalTimestamp: Date.now() / 1000,
      explicitHashKey: explicitHashKey !== undefined && explicitHashKey !== null ? String(explicitHashKey) : undefined,
    };
    shard.records.push(rec);
    return rec;
  }

  putRecord(input) {
    const stream = this.resolveStream(input);
    if (input.PartitionKey === undefined || input.PartitionKey === null || input.PartitionKey === "") {
      throw new KinesisError("InvalidArgumentException", "PartitionKey is required.");
    }
    if (String(input.PartitionKey).length > 256) {
      throw new KinesisError(
        "InvalidArgumentException",
        "PartitionKey must be between 1 and 256 characters.",
      );
    }
    const dataB64 = this.normalizeData(input.Data);
    const dataBytes = Buffer.from(dataB64, "base64").length;
    if (dataBytes > 1024 * 1024) {
      throw new KinesisError(
        "InvalidArgumentException",
        "Record data must be 1 MiB or less.",
      );
    }
    const shard = this.pickShard(stream, input.PartitionKey, input.ExplicitHashKey);
    const rec = this.appendRecord(stream, shard, input.PartitionKey, dataB64, input.ExplicitHashKey);
    return {
      ShardId: shard.shardId,
      SequenceNumber: rec.sequenceNumber,
      EncryptionType: stream.encryptionType,
    };
  }

  putRecords(input) {
    const stream = this.resolveStream(input);
    const entries = input.Records;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new KinesisError("InvalidArgumentException", "Records list must contain at least one record.");
    }
    if (entries.length > 500) {
      throw new KinesisError(
        "InvalidArgumentException",
        "A single PutRecords request can contain a maximum of 500 records.",
      );
    }

    const records = [];
    let failedCount = 0;
    for (const e of entries) {
      try {
        if (e.PartitionKey === undefined || e.PartitionKey === null || e.PartitionKey === "") {
          throw new KinesisError("InvalidArgumentException", "PartitionKey is required.");
        }
        const dataB64 = this.normalizeData(e.Data);
        if (Buffer.from(dataB64, "base64").length > 1024 * 1024) {
          throw new KinesisError("InvalidArgumentException", "Record data must be 1 MiB or less.");
        }
        const shard = this.pickShard(stream, e.PartitionKey, e.ExplicitHashKey);
        const rec = this.appendRecord(stream, shard, e.PartitionKey, dataB64, e.ExplicitHashKey);
        records.push({ SequenceNumber: rec.sequenceNumber, ShardId: shard.shardId });
      } catch (err) {
        failedCount++;
        records.push({
          ErrorCode: err instanceof KinesisError ? err.code : "InternalFailure",
          ErrorMessage: err.message,
        });
      }
    }
    return {
      FailedRecordCount: failedCount,
      Records: records,
      EncryptionType: stream.encryptionType,
    };
  }

  getRecords(input) {
    const token = input.ShardIterator;
    if (!token) {
      throw new KinesisError("InvalidArgumentException", "ShardIterator is required.");
    }
    const decoded = this.decodeIterator(token);
    const stream = this.streams.get(decoded.s);
    if (!stream) {
      throw new KinesisError("ResourceNotFoundException", `Stream ${decoded.s} not found.`);
    }
    const shard = stream.shards.get(decoded.sh);
    if (!shard) {
      throw new KinesisError("ResourceNotFoundException", `Shard ${decoded.sh} not found.`);
    }

    const limit = input.Limit ? parseInt(input.Limit, 10) : 10000;
    if (limit < 1 || limit > 10000) {
      throw new KinesisError(
        "InvalidArgumentException",
        "Limit must be between 1 and 10000.",
      );
    }

    const start = decoded.p;
    const slice = shard.records.slice(start, start + limit);
    const nextPosition = start + slice.length;

    const records = slice.map((r) => ({
      SequenceNumber: r.sequenceNumber,
      Data: r.data, // base64 on the wire; SDK decodes to Uint8Array
      PartitionKey: r.partitionKey,
      ApproximateArrivalTimestamp: r.approximateArrivalTimestamp,
      EncryptionType: stream.encryptionType,
    }));

    // MillisBehindLatest: 0 when caught up; otherwise a rough estimate.
    const behind = shard.records.length - nextPosition;
    const out = {
      Records: records,
      NextShardIterator: shard.endingSequenceNumber && nextPosition >= shard.records.length
        ? undefined
        : this.encodeIterator(stream.name, shard.shardId, nextPosition),
      MillisBehindLatest: behind > 0 ? behind * 1000 : 0,
    };
    if (out.NextShardIterator === undefined) delete out.NextShardIterator;
    return out;
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  addTagsToStream(input) {
    const stream = this.resolveStream(input);
    const tags = input.Tags || {};
    if (Object.keys(tags).length === 0) {
      throw new KinesisError("InvalidArgumentException", "Tags must contain at least one entry.");
    }
    if (stream.tags.size + Object.keys(tags).length > 50) {
      throw new KinesisError("InvalidArgumentException", "A stream cannot have more than 50 tags.");
    }
    for (const [k, v] of Object.entries(tags)) stream.tags.set(k, String(v));
    return {};
  }

  removeTagsFromStream(input) {
    const stream = this.resolveStream(input);
    const keys = input.TagKeys || [];
    for (const k of keys) stream.tags.delete(k);
    return {};
  }

  listTagsForStream(input) {
    const stream = this.resolveStream(input);
    const all = [...stream.tags.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const limit = input.Limit ? parseInt(input.Limit, 10) : 50;

    let start = 0;
    if (input.ExclusiveStartTagKey) {
      const idx = all.findIndex(([k]) => k === input.ExclusiveStartTagKey);
      start = idx === -1 ? 0 : idx + 1;
    }
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return {
      Tags: page.map(([Key, Value]) => ({ Key, Value })),
      HasMoreTags: hasMore,
    };
  }

  resolveResourceByArn(arn) {
    if (typeof arn !== "string") {
      throw new KinesisError("InvalidArgumentException", "ResourceARN is required.");
    }
    // Stream consumer ARN?
    if (arn.includes("/consumer/")) {
      const streamName = this.streamNameFromArn(arn);
      const stream = this.streams.get(streamName);
      if (stream) {
        for (const consumer of stream.consumers.values()) {
          if (consumer.arn === arn) return { type: "consumer", stream, consumer };
        }
      }
      throw new KinesisError("ResourceNotFoundException", `Consumer ${arn} not found.`);
    }
    const streamName = this.streamNameFromArn(arn);
    const stream = this.streams.get(streamName);
    if (!stream) {
      throw new KinesisError("ResourceNotFoundException", `Stream ${arn} not found.`);
    }
    return { type: "stream", stream };
  }

  tagResource(input) {
    const { stream, consumer, type } = this.resolveResourceByArn(input.ResourceARN);
    const bag = type === "consumer" ? consumer.tags : stream.tags;
    const tags = input.Tags || {};
    for (const [k, v] of Object.entries(tags)) bag.set(k, String(v));
    return {};
  }

  untagResource(input) {
    const { stream, consumer, type } = this.resolveResourceByArn(input.ResourceARN);
    const bag = type === "consumer" ? consumer.tags : stream.tags;
    const keys = input.TagKeys || [];
    for (const k of keys) bag.delete(k);
    return {};
  }

  listTagsForResource(input) {
    const { stream, consumer, type } = this.resolveResourceByArn(input.ResourceARN);
    const bag = type === "consumer" ? consumer.tags : stream.tags;
    const tags = [...bag.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([Key, Value]) => ({ Key, Value }));
    return { Tags: tags };
  }

  // -------------------------------------------------------------------------
  // Enhanced monitoring
  // -------------------------------------------------------------------------
  validMetrics() {
    return [
      "IncomingBytes",
      "IncomingRecords",
      "OutgoingBytes",
      "OutgoingRecords",
      "WriteProvisionedThroughputExceeded",
      "ReadProvisionedThroughputExceeded",
      "IteratorAgeMilliseconds",
    ];
  }

  enableEnhancedMonitoring(input) {
    const stream = this.resolveStream(input);
    const metrics = input.ShardLevelMetrics || [];
    const before = [...stream.enhancedMonitoring];
    const valid = new Set(this.validMetrics());
    for (const m of metrics) {
      if (m === "ALL") {
        for (const v of valid) stream.enhancedMonitoring.add(v);
      } else if (valid.has(m)) {
        stream.enhancedMonitoring.add(m);
      } else {
        throw new KinesisError("InvalidArgumentException", `Invalid metric: ${m}.`);
      }
    }
    return {
      StreamName: stream.name,
      StreamARN: stream.arn,
      CurrentShardLevelMetrics: before,
      DesiredShardLevelMetrics: [...stream.enhancedMonitoring],
    };
  }

  disableEnhancedMonitoring(input) {
    const stream = this.resolveStream(input);
    const metrics = input.ShardLevelMetrics || [];
    const before = [...stream.enhancedMonitoring];
    const valid = new Set(this.validMetrics());
    for (const m of metrics) {
      if (m === "ALL") {
        stream.enhancedMonitoring.clear();
      } else if (valid.has(m)) {
        stream.enhancedMonitoring.delete(m);
      } else {
        throw new KinesisError("InvalidArgumentException", `Invalid metric: ${m}.`);
      }
    }
    return {
      StreamName: stream.name,
      StreamARN: stream.arn,
      CurrentShardLevelMetrics: before,
      DesiredShardLevelMetrics: [...stream.enhancedMonitoring],
    };
  }

  // -------------------------------------------------------------------------
  // Encryption
  // -------------------------------------------------------------------------
  startStreamEncryption(input) {
    const stream = this.resolveStream(input);
    if (input.EncryptionType !== "KMS") {
      throw new KinesisError("InvalidArgumentException", "EncryptionType must be KMS.");
    }
    if (!input.KeyId) {
      throw new KinesisError("InvalidArgumentException", "KeyId is required.");
    }
    stream.encryptionType = "KMS";
    stream.keyId = input.KeyId;
    return {};
  }

  stopStreamEncryption(input) {
    const stream = this.resolveStream(input);
    stream.encryptionType = "NONE";
    stream.keyId = undefined;
    return {};
  }

  // -------------------------------------------------------------------------
  // Consumers (enhanced fan-out)
  // -------------------------------------------------------------------------
  registerStreamConsumer(input) {
    const streamArn = input.StreamARN;
    if (!streamArn) {
      throw new KinesisError("InvalidArgumentException", "StreamARN is required.");
    }
    const streamName = this.streamNameFromArn(streamArn);
    const stream = this.streams.get(streamName);
    if (!stream) {
      throw new KinesisError("ResourceNotFoundException", `Stream ${streamArn} not found.`);
    }
    const name = input.ConsumerName;
    if (!name) {
      throw new KinesisError("InvalidArgumentException", "ConsumerName is required.");
    }
    if (stream.consumers.has(name)) {
      throw new KinesisError(
        "ResourceInUseException",
        `Consumer ${name} already exists for stream ${stream.name}.`,
      );
    }
    if (stream.consumers.size >= 20) {
      throw new KinesisError(
        "LimitExceededException",
        "A stream cannot have more than 20 registered consumers.",
      );
    }
    const creationTs = Math.floor(Date.now() / 1000);
    const consumer = {
      name,
      arn: this.consumerArn(stream.name, name, creationTs),
      status: "ACTIVE",
      creationTimestamp: creationTs,
      tags: new Map(),
    };
    stream.consumers.set(name, consumer);
    return {
      Consumer: {
        ConsumerName: consumer.name,
        ConsumerARN: consumer.arn,
        ConsumerStatus: consumer.status,
        ConsumerCreationTimestamp: consumer.creationTimestamp,
      },
    };
  }

  findConsumer(input) {
    // By ConsumerARN, or by (StreamARN + ConsumerName).
    if (input.ConsumerARN) {
      const streamName = this.streamNameFromArn(input.ConsumerARN);
      const stream = this.streams.get(streamName);
      if (stream) {
        for (const c of stream.consumers.values()) {
          if (c.arn === input.ConsumerARN) return { stream, consumer: c };
        }
      }
      throw new KinesisError("ResourceNotFoundException", `Consumer ${input.ConsumerARN} not found.`);
    }
    const streamName = this.streamNameFromArn(input.StreamARN || "");
    const stream = this.streams.get(streamName);
    if (!stream) {
      throw new KinesisError("ResourceNotFoundException", `Stream ${input.StreamARN} not found.`);
    }
    const consumer = stream.consumers.get(input.ConsumerName);
    if (!consumer) {
      throw new KinesisError(
        "ResourceNotFoundException",
        `Consumer ${input.ConsumerName} not found for stream ${stream.name}.`,
      );
    }
    return { stream, consumer };
  }

  deregisterStreamConsumer(input) {
    const { stream, consumer } = this.findConsumer(input);
    stream.consumers.delete(consumer.name);
    return {};
  }

  describeStreamConsumer(input) {
    const { stream, consumer } = this.findConsumer(input);
    return {
      ConsumerDescription: {
        ConsumerName: consumer.name,
        ConsumerARN: consumer.arn,
        ConsumerStatus: consumer.status,
        ConsumerCreationTimestamp: consumer.creationTimestamp,
        StreamARN: stream.arn,
      },
    };
  }

  listStreamConsumers(input) {
    const streamArn = input.StreamARN;
    if (!streamArn) {
      throw new KinesisError("InvalidArgumentException", "StreamARN is required.");
    }
    const streamName = this.streamNameFromArn(streamArn);
    const stream = this.streams.get(streamName);
    if (!stream) {
      throw new KinesisError("ResourceNotFoundException", `Stream ${streamArn} not found.`);
    }
    const all = [...stream.consumers.values()].sort((a, b) => a.name.localeCompare(b.name));
    const limit = input.MaxResults ? parseInt(input.MaxResults, 10) : 100;

    let start = 0;
    if (input.NextToken) {
      try {
        start = parseInt(Buffer.from(input.NextToken, "base64").toString("utf8"), 10) || 0;
      } catch {
        throw new KinesisError("InvalidArgumentException", "Invalid NextToken.");
      }
    }
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    const out = {
      Consumers: page.map((c) => ({
        ConsumerName: c.name,
        ConsumerARN: c.arn,
        ConsumerStatus: c.status,
        ConsumerCreationTimestamp: c.creationTimestamp,
      })),
    };
    if (hasMore) out.NextToken = Buffer.from(String(start + limit)).toString("base64");
    return out;
  }

  // -------------------------------------------------------------------------
  // Resource policies
  // -------------------------------------------------------------------------
  putResourcePolicy(input) {
    if (!input.ResourceARN) {
      throw new KinesisError("InvalidArgumentException", "ResourceARN is required.");
    }
    if (!input.Policy) {
      throw new KinesisError("InvalidArgumentException", "Policy is required.");
    }
    // Validate the resource exists.
    this.resolveResourceByArn(input.ResourceARN);
    this.resourcePolicies.set(input.ResourceARN, input.Policy);
    return {};
  }

  getResourcePolicy(input) {
    if (!input.ResourceARN) {
      throw new KinesisError("InvalidArgumentException", "ResourceARN is required.");
    }
    this.resolveResourceByArn(input.ResourceARN);
    const policy = this.resourcePolicies.get(input.ResourceARN);
    if (!policy) {
      throw new KinesisError(
        "ResourceNotFoundException",
        `No resource policy attached to ${input.ResourceARN}.`,
      );
    }
    return { Policy: policy };
  }

  deleteResourcePolicy(input) {
    if (!input.ResourceARN) {
      throw new KinesisError("InvalidArgumentException", "ResourceARN is required.");
    }
    this.resolveResourceByArn(input.ResourceARN);
    this.resourcePolicies.delete(input.ResourceARN);
    return {};
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalFailureException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.setHeader("x-amzn-errortype", code);
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(
      JSON.stringify({
        __type: code,
        message: error.message || code,
        Message: error.message || code,
      }),
    );
  }
}

export default KinesisServer;
