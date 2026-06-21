// parlel/sqs — a lightweight, dependency-free fake of AWS SQS.
//
// Speaks the modern AWS SQS JSON wire protocol (AWS JSON 1.0, query-compatible)
// so application code using the real `@aws-sdk/client-sqs` client can run against
// it with zero cost and zero side effects. Pure Node.js, no external npm
// dependencies. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-sqs v3):
//   * Requests are POST / with header `X-Amz-Target: AmazonSQS.<Operation>`
//     and `Content-Type: application/x-amz-json-1.0`. Body is JSON input.
//   * Success: 200, JSON output, `Content-Type: application/x-amz-json-1.0`.
//   * Error: non-2xx, JSON `{ "__type": "<Code>", "message": "<msg>" }` plus the
//     query-compatible header `x-amzn-query-error: <Code>;Sender`.
//   * The SDK validates MD5OfBody / MD5OfMessageBody / MD5OfMessageAttributes
//     locally, so this fake computes them exactly the way real SQS does.

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.0";
const DEFAULT_ACCOUNT_ID = "000000000000";
const MAX_RECEIVE_DEFAULT = 1;

// SQS error codes -> HTTP status + fault. (Sender == client fault.)
const ERROR_STATUS = {
  QueueDoesNotExist: 400,
  "AWS.SimpleQueueService.NonExistentQueue": 400,
  QueueNameExists: 400,
  "AWS.SimpleQueueService.QueueNameExists": 400,
  QueueDeletedRecently: 400,
  "AWS.SimpleQueueService.QueueDeletedRecently": 400,
  InvalidMessageContents: 400,
  ReceiptHandleIsInvalid: 400,
  "AWS.SimpleQueueService.ReceiptHandleIsInvalid": 400,
  MessageNotInflight: 400,
  "AWS.SimpleQueueService.MessageNotInflight": 400,
  BatchEntryIdsNotDistinct: 400,
  "AWS.SimpleQueueService.BatchEntryIdsNotDistinct": 400,
  EmptyBatchRequest: 400,
  "AWS.SimpleQueueService.EmptyBatchRequest": 400,
  TooManyEntriesInBatchRequest: 400,
  "AWS.SimpleQueueService.TooManyEntriesInBatchRequest": 400,
  BatchRequestTooLong: 400,
  "AWS.SimpleQueueService.BatchRequestTooLong": 400,
  InvalidBatchEntryId: 400,
  "AWS.SimpleQueueService.InvalidBatchEntryId": 400,
  InvalidAttributeName: 400,
  InvalidAttributeValue: 400,
  InvalidAddress: 404,
  InvalidSecurity: 403,
  UnsupportedOperation: 400,
  "AWS.SimpleQueueService.UnsupportedOperation": 400,
  PurgeQueueInProgress: 403,
  "AWS.SimpleQueueService.PurgeQueueInProgress": 403,
  OverLimit: 403,
  RequestThrottled: 403,
  InvalidIdFormat: 400,
  KmsDisabled: 400,
  ResourceNotFoundException: 404,
  MissingParameter: 400,
  "AWS.SimpleQueueService.MissingParameter": 400,
  ValidationError: 400,
  InvalidParameterValue: 400,
};

// Service-thrown error.
class SqsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// MD5 helpers — must match real SQS exactly so the SDK's local validation passes
// ---------------------------------------------------------------------------

function md5Hex(input) {
  return createHash("md5").update(input).digest("hex");
}

// AWS message-attribute MD5: a canonical encoding of the attribute map.
// https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-message-metadata.html
function encodeLengthPrefixed(hash, str) {
  const buf = Buffer.from(str, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  hash.update(len);
  hash.update(buf);
}

function md5OfMessageAttributes(attributes) {
  if (!attributes || Object.keys(attributes).length === 0) return undefined;
  const hash = createHash("md5");
  const names = Object.keys(attributes).sort();
  for (const name of names) {
    const attr = attributes[name];
    const dataType = attr.DataType;
    encodeLengthPrefixed(hash, name);
    encodeLengthPrefixed(hash, dataType);
    if (attr.StringValue !== undefined && attr.StringValue !== null) {
      hash.update(Buffer.from([1])); // String/Number transport type
      encodeLengthPrefixed(hash, String(attr.StringValue));
    } else if (attr.BinaryValue !== undefined && attr.BinaryValue !== null) {
      hash.update(Buffer.from([2])); // Binary transport type
      const bin = Buffer.isBuffer(attr.BinaryValue)
        ? attr.BinaryValue
        : Buffer.from(attr.BinaryValue);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(bin.length, 0);
      hash.update(len);
      hash.update(bin);
    }
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const FIFO_SUFFIX = ".fifo";

function isValidQueueName(name, fifo) {
  if (typeof name !== "string" || name.length === 0 || name.length > 80) return false;
  const base = fifo ? name.slice(0, -FIFO_SUFFIX.length) : name;
  return /^[A-Za-z0-9_-]+$/.test(base);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class SqsServer {
  constructor(port = 4568, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // queues: Map<queueName, Queue>
    // Queue = {
    //   name, url, arn, attributes: {...},
    //   tags: Map<string,string>,
    //   messages: Message[],          // visible/available, ordered
    //   inflight: Map<receiptHandle, { message, visibleAt, timer }>,
    //   fifo, contentDedup,
    //   dedupCache: Map<dedupId, expiresAt>,
    //   permissions: Map<label, {awsAccountIds, actions}>,
    //   createdAt,
    // }
    this.queues = new Map();
    // Track recently deleted queue names for QueueDeletedRecently semantics.
    this.recentlyDeleted = new Map();
    this.moveTasks = new Map();
    this.moveTaskCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new SqsError("InternalFailure", error.message, 500));
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
      // Clear any pending visibility timers so the process can exit cleanly.
      for (const queue of this.queues.values()) {
        for (const entry of queue.inflight.values()) {
          if (entry.timer) clearTimeout(entry.timer);
        }
      }
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
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

  queueUrl(name) {
    return `http://${this.host}:${this.port}/${this.accountId}/${name}`;
  }

  queueArn(name) {
    return `arn:aws:sqs:${this.region}:${this.accountId}:${name}`;
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    // Internal/health endpoints (not part of SQS).
    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "sqs",
        queues: this.queues.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-sqs");

    if (method !== "POST") {
      return this.sendError(
        res,
        new SqsError("AccessDenied", "Only POST is supported by the parlel sqs fake.", 405),
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
        new SqsError("InvalidAddress", "Request body is not valid JSON.", 400),
      );
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof SqsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateQueue":
        return this.createQueue(input);
      case "DeleteQueue":
        return this.deleteQueue(input);
      case "GetQueueUrl":
        return this.getQueueUrl(input);
      case "ListQueues":
        return this.listQueues(input);
      case "GetQueueAttributes":
        return this.getQueueAttributes(input);
      case "SetQueueAttributes":
        return this.setQueueAttributes(input);
      case "PurgeQueue":
        return this.purgeQueue(input);
      case "SendMessage":
        return this.sendMessage(input);
      case "SendMessageBatch":
        return this.sendMessageBatch(input);
      case "ReceiveMessage":
        return this.receiveMessage(input);
      case "DeleteMessage":
        return this.deleteMessage(input);
      case "DeleteMessageBatch":
        return this.deleteMessageBatch(input);
      case "ChangeMessageVisibility":
        return this.changeMessageVisibility(input);
      case "ChangeMessageVisibilityBatch":
        return this.changeMessageVisibilityBatch(input);
      case "TagQueue":
        return this.tagQueue(input);
      case "UntagQueue":
        return this.untagQueue(input);
      case "ListQueueTags":
        return this.listQueueTags(input);
      case "AddPermission":
        return this.addPermission(input);
      case "RemovePermission":
        return this.removePermission(input);
      case "ListDeadLetterSourceQueues":
        return this.listDeadLetterSourceQueues(input);
      case "StartMessageMoveTask":
        return this.startMessageMoveTask(input);
      case "CancelMessageMoveTask":
        return this.cancelMessageMoveTask(input);
      case "ListMessageMoveTasks":
        return this.listMessageMoveTasks(input);
      default:
        throw new SqsError(
          "InvalidAction",
          `The action ${operation || "(none)"} is not valid for this endpoint.`,
          400,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Queue resolution
  // -------------------------------------------------------------------------
  queueNameFromUrl(queueUrl) {
    if (typeof queueUrl !== "string" || queueUrl.length === 0) {
      throw new SqsError("InvalidAddress", "The address is not valid for this endpoint.");
    }
    // Accept full URLs and bare names. Use the last path segment.
    let name = queueUrl;
    if (queueUrl.includes("/")) {
      const parts = queueUrl.split("?")[0].split("/").filter(Boolean);
      name = parts[parts.length - 1];
    }
    return name;
  }

  requireQueue(queueUrl) {
    const name = this.queueNameFromUrl(queueUrl);
    const queue = this.queues.get(name);
    if (!queue) {
      throw new SqsError(
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
      );
    }
    return queue;
  }

  // -------------------------------------------------------------------------
  // Queue lifecycle
  // -------------------------------------------------------------------------
  createQueue(input) {
    const name = input.QueueName;
    if (!name) {
      throw new SqsError("MissingParameter", "The request must contain the parameter QueueName.");
    }
    const attributes = input.Attributes || {};
    const fifo = attributes.FifoQueue === "true" || attributes.FifoQueue === true;

    if (fifo && !name.endsWith(FIFO_SUFFIX)) {
      throw new SqsError(
        "InvalidParameterValue",
        "The name of a FIFO queue can only include alphanumeric characters, hyphens, or underscores, must end with .fifo suffix and be 1 to 80 in length.",
      );
    }
    if (!fifo && name.endsWith(FIFO_SUFFIX)) {
      throw new SqsError(
        "InvalidParameterValue",
        "The name of a non-FIFO queue can only include alphanumeric characters, hyphens, or underscores and be 1 to 80 in length.",
      );
    }
    if (!isValidQueueName(name, fifo)) {
      throw new SqsError(
        "InvalidParameterValue",
        "Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length.",
      );
    }

    const existing = this.queues.get(name);
    if (existing) {
      // Idempotent if attributes match; else QueueNameExists.
      const desired = this.normalizeCreateAttributes(attributes, fifo);
      for (const [k, v] of Object.entries(desired)) {
        if (existing.attributes[k] !== v) {
          throw new SqsError(
            "QueueAlreadyExists",
            `A queue already exists with the same name and a different value for attribute ${k}`,
            400,
          );
        }
      }
      return { QueueUrl: existing.url };
    }

    const queue = this.buildQueue(name, attributes, fifo, input.tags || input.Tags);
    this.queues.set(name, queue);
    return { QueueUrl: queue.url };
  }

  normalizeCreateAttributes(attributes, fifo) {
    const defaults = {
      DelaySeconds: "0",
      MaximumMessageSize: "262144",
      MessageRetentionPeriod: "345600",
      ReceiveMessageWaitTimeSeconds: "0",
      VisibilityTimeout: "30",
    };
    const merged = { ...defaults };
    for (const [k, v] of Object.entries(attributes || {})) {
      merged[k] = String(v);
    }
    if (fifo) {
      merged.FifoQueue = "true";
      if (merged.ContentBasedDeduplication === undefined) {
        merged.ContentBasedDeduplication = "false";
      }
    }
    return merged;
  }

  buildQueue(name, attributes, fifo, tags) {
    const merged = this.normalizeCreateAttributes(attributes, fifo);
    const now = Date.now();
    const tagMap = new Map();
    if (tags && typeof tags === "object") {
      for (const [k, v] of Object.entries(tags)) tagMap.set(k, String(v));
    }
    return {
      name,
      url: this.queueUrl(name),
      arn: this.queueArn(name),
      attributes: merged,
      tags: tagMap,
      messages: [],
      inflight: new Map(),
      fifo,
      contentDedup: merged.ContentBasedDeduplication === "true",
      dedupCache: new Map(),
      sequenceCounter: 0,
      permissions: new Map(),
      createdAt: Math.floor(now / 1000),
      purgeInProgress: false,
    };
  }

  deleteQueue(input) {
    const queue = this.requireQueue(input.QueueUrl);
    for (const entry of queue.inflight.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.queues.delete(queue.name);
    return {};
  }

  getQueueUrl(input) {
    const name = input.QueueName;
    if (!name) {
      throw new SqsError("MissingParameter", "The request must contain the parameter QueueName.");
    }
    const queue = this.queues.get(name);
    if (!queue) {
      throw new SqsError(
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
      );
    }
    return { QueueUrl: queue.url };
  }

  listQueues(input = {}) {
    const prefix = input.QueueNamePrefix || "";
    const max = input.MaxResults || undefined;
    let names = [...this.queues.keys()].filter((n) => n.startsWith(prefix));
    names.sort();
    let nextToken;
    if (max && names.length > max) {
      const start = input.NextToken ? parseInt(Buffer.from(input.NextToken, "base64").toString("utf8"), 10) || 0 : 0;
      const page = names.slice(start, start + max);
      if (start + max < names.length) {
        nextToken = Buffer.from(String(start + max)).toString("base64");
      }
      names = page;
    }
    const urls = names.map((n) => this.queues.get(n).url);
    const out = {};
    if (urls.length > 0) out.QueueUrls = urls;
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  // -------------------------------------------------------------------------
  // Queue attributes
  // -------------------------------------------------------------------------
  computeAttributes(queue, names) {
    this.sweepInflight(queue);
    const all = {
      ...queue.attributes,
      QueueArn: queue.arn,
      ApproximateNumberOfMessages: String(queue.messages.length),
      ApproximateNumberOfMessagesNotVisible: String(queue.inflight.size),
      ApproximateNumberOfMessagesDelayed: String(
        queue.messages.filter((m) => m.visibleAt > Date.now()).length,
      ),
      CreatedTimestamp: String(queue.createdAt),
      LastModifiedTimestamp: String(queue.createdAt),
    };
    const want = !names || names.length === 0 || names.includes("All") ? Object.keys(all) : names;
    const out = {};
    for (const n of want) {
      if (all[n] !== undefined) out[n] = String(all[n]);
    }
    return out;
  }

  getQueueAttributes(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const names = input.AttributeNames || [];
    const attrs = this.computeAttributes(queue, names);
    return Object.keys(attrs).length ? { Attributes: attrs } : {};
  }

  setQueueAttributes(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const attributes = input.Attributes || {};
    const allowed = new Set([
      "DelaySeconds",
      "MaximumMessageSize",
      "MessageRetentionPeriod",
      "Policy",
      "ReceiveMessageWaitTimeSeconds",
      "VisibilityTimeout",
      "RedrivePolicy",
      "RedriveAllowPolicy",
      "ContentBasedDeduplication",
      "KmsMasterKeyId",
      "KmsDataKeyReusePeriodSeconds",
      "SqsManagedSseEnabled",
      "DeduplicationScope",
      "FifoThroughputLimit",
    ]);
    for (const [k, v] of Object.entries(attributes)) {
      if (!allowed.has(k)) {
        throw new SqsError(
          "InvalidAttributeName",
          `Unknown Attribute ${k}.`,
        );
      }
      queue.attributes[k] = String(v);
      if (k === "ContentBasedDeduplication") {
        queue.contentDedup = String(v) === "true";
      }
    }
    return {};
  }

  purgeQueue(input) {
    const queue = this.requireQueue(input.QueueUrl);
    for (const entry of queue.inflight.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    queue.messages = [];
    queue.inflight.clear();
    queue.dedupCache.clear();
    return {};
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------
  buildMessage(queue, params) {
    const body = params.MessageBody;
    if (body === undefined || body === null || body === "") {
      throw new SqsError(
        "MissingParameter",
        "The request must contain the parameter MessageBody.",
      );
    }
    const maxSize = parseInt(queue.attributes.MaximumMessageSize || "262144", 10);
    if (Buffer.byteLength(String(body), "utf8") > maxSize) {
      throw new SqsError(
        "InvalidParameterValue",
        `One or more parameters are invalid. Reason: Message must be shorter than ${maxSize} bytes.`,
      );
    }

    if (queue.fifo) {
      if (!params.MessageGroupId) {
        throw new SqsError(
          "MissingParameter",
          "The request must contain the parameter MessageGroupId.",
        );
      }
      if (!params.MessageDeduplicationId && !queue.contentDedup) {
        throw new SqsError(
          "InvalidParameterValue",
          "The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly",
        );
      }
    } else if (params.MessageGroupId !== undefined && params.MessageGroupId !== null) {
      // SQS rejects MessageGroupId on standard queues.
      throw new SqsError(
        "InvalidParameterValue",
        "Value " + params.MessageGroupId + " for parameter MessageGroupId is invalid. Reason: The request includes a parameter that is not valid for this queue type.",
      );
    }

    const messageId = randomUUID();
    const md5OfBody = md5Hex(String(body));
    const md5OfAttrs = md5OfMessageAttributes(params.MessageAttributes);
    const md5OfSystemAttrs = md5OfMessageAttributes(params.MessageSystemAttributes);

    const delaySeconds =
      params.DelaySeconds !== undefined
        ? parseInt(params.DelaySeconds, 10)
        : parseInt(queue.attributes.DelaySeconds || "0", 10);

    let dedupId = params.MessageDeduplicationId;
    if (queue.fifo && !dedupId && queue.contentDedup) {
      dedupId = md5Hex(String(body));
    }

    const message = {
      messageId,
      body: String(body),
      md5OfBody,
      md5OfAttrs,
      md5OfSystemAttrs,
      attributes: params.MessageAttributes || undefined,
      systemAttributes: params.MessageSystemAttributes || undefined,
      messageGroupId: params.MessageGroupId,
      dedupId,
      sequenceNumber: queue.fifo ? String(++queue.sequenceCounter).padStart(20, "0") : undefined,
      sentTimestamp: Date.now(),
      receiveCount: 0,
      firstReceiveTimestamp: undefined,
      visibleAt: Date.now() + delaySeconds * 1000,
    };
    return { message, dedupId };
  }

  enqueue(queue, message, dedupId) {
    // FIFO deduplication within a 5-minute window.
    if (queue.fifo && dedupId) {
      this.sweepDedup(queue);
      if (queue.dedupCache.has(dedupId)) {
        // Duplicate — return existing acknowledgement without enqueueing.
        return false;
      }
      queue.dedupCache.set(dedupId, Date.now() + 5 * 60 * 1000);
    }
    queue.messages.push(message);
    return true;
  }

  sendMessage(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const { message, dedupId } = this.buildMessage(queue, input);
    this.enqueue(queue, message, dedupId);
    const out = {
      MessageId: message.messageId,
      MD5OfMessageBody: message.md5OfBody,
    };
    if (message.md5OfAttrs) out.MD5OfMessageAttributes = message.md5OfAttrs;
    if (message.md5OfSystemAttrs) out.MD5OfMessageSystemAttributes = message.md5OfSystemAttrs;
    if (queue.fifo) out.SequenceNumber = message.sequenceNumber;
    return out;
  }

  sendMessageBatch(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const entries = input.Entries || [];
    if (entries.length === 0) {
      throw new SqsError(
        "AWS.SimpleQueueService.EmptyBatchRequest",
        "There should be at least one SendMessageBatchRequestEntry in the request.",
      );
    }
    if (entries.length > 10) {
      throw new SqsError(
        "AWS.SimpleQueueService.TooManyEntriesInBatchRequest",
        "Maximum number of entries per request is 10. You have sent " + entries.length + ".",
      );
    }
    const ids = new Set();
    for (const e of entries) {
      if (!e.Id) {
        throw new SqsError("MissingParameter", "The request must contain the parameter Id.");
      }
      if (ids.has(e.Id)) {
        throw new SqsError(
          "AWS.SimpleQueueService.BatchEntryIdsNotDistinct",
          `Id ${e.Id} repeated.`,
        );
      }
      ids.add(e.Id);
    }

    const successful = [];
    const failed = [];
    for (const e of entries) {
      try {
        const { message, dedupId } = this.buildMessage(queue, e);
        this.enqueue(queue, message, dedupId);
        const entry = {
          Id: e.Id,
          MessageId: message.messageId,
          MD5OfMessageBody: message.md5OfBody,
        };
        if (message.md5OfAttrs) entry.MD5OfMessageAttributes = message.md5OfAttrs;
        if (message.md5OfSystemAttrs) entry.MD5OfMessageSystemAttributes = message.md5OfSystemAttrs;
        if (queue.fifo) entry.SequenceNumber = message.sequenceNumber;
        successful.push(entry);
      } catch (err) {
        failed.push({
          Id: e.Id,
          SenderFault: true,
          Code: err instanceof SqsError ? err.code : "InternalError",
          Message: err.message,
        });
      }
    }
    const out = {};
    out.Successful = successful;
    out.Failed = failed;
    return out;
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------
  sweepInflight(queue) {
    const now = Date.now();
    for (const [handle, entry] of queue.inflight) {
      if (entry.visibleAt <= now) {
        if (entry.timer) clearTimeout(entry.timer);
        queue.inflight.delete(handle);
        // Return to visible pool (front for FIFO ordering preservation).
        queue.messages.unshift(entry.message);
      }
    }
    // Keep ordering deterministic by sent time / sequence.
    queue.messages.sort((a, b) => {
      if (a.sequenceNumber && b.sequenceNumber) {
        return a.sequenceNumber.localeCompare(b.sequenceNumber);
      }
      return a.sentTimestamp - b.sentTimestamp;
    });
  }

  sweepDedup(queue) {
    const now = Date.now();
    for (const [id, expiry] of queue.dedupCache) {
      if (expiry <= now) queue.dedupCache.delete(id);
    }
  }

  receiveMessage(input) {
    const queue = this.requireQueue(input.QueueUrl);
    this.sweepInflight(queue);

    const max = input.MaxNumberOfMessages
      ? parseInt(input.MaxNumberOfMessages, 10)
      : MAX_RECEIVE_DEFAULT;
    if (max < 1 || max > 10) {
      throw new SqsError(
        "InvalidParameterValue",
        "Value " + max + " for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.",
      );
    }
    const visibilityTimeout =
      input.VisibilityTimeout !== undefined
        ? parseInt(input.VisibilityTimeout, 10)
        : parseInt(queue.attributes.VisibilityTimeout || "30", 10);

    const now = Date.now();
    const requestedAttrNames = input.MessageSystemAttributeNames || input.AttributeNames || [];
    const wantAll = requestedAttrNames.includes("All");
    const messageAttributeNames = input.MessageAttributeNames || [];

    const picked = [];
    const remaining = [];
    for (const message of queue.messages) {
      if (picked.length < max && message.visibleAt <= now) {
        picked.push(message);
      } else {
        remaining.push(message);
      }
    }
    queue.messages = remaining;

    const out = {};
    if (picked.length === 0) return out;

    const messages = picked.map((message) => {
      message.receiveCount += 1;
      if (!message.firstReceiveTimestamp) message.firstReceiveTimestamp = now;
      const receiptHandle = `${message.messageId}#${randomUUID()}`;

      const entry = {
        message,
        receiptHandle,
        visibleAt: now + visibilityTimeout * 1000,
        timer: null,
      };
      if (visibilityTimeout > 0) {
        entry.timer = setTimeout(() => {
          if (queue.inflight.has(receiptHandle)) {
            queue.inflight.delete(receiptHandle);
            queue.messages.push(message);
          }
        }, visibilityTimeout * 1000);
        if (entry.timer.unref) entry.timer.unref();
      } else {
        // visibility 0 -> immediately visible again, but still tracked for delete
        entry.visibleAt = now;
      }
      queue.inflight.set(receiptHandle, entry);

      const result = {
        MessageId: message.messageId,
        ReceiptHandle: receiptHandle,
        MD5OfBody: message.md5OfBody,
        Body: message.body,
      };

      // System attributes
      const sysAttrs = {};
      const wantAttr = (name) => wantAll || requestedAttrNames.includes(name);
      if (wantAttr("SentTimestamp")) sysAttrs.SentTimestamp = String(message.sentTimestamp);
      if (wantAttr("ApproximateReceiveCount")) {
        sysAttrs.ApproximateReceiveCount = String(message.receiveCount);
      }
      if (wantAttr("ApproximateFirstReceiveTimestamp")) {
        sysAttrs.ApproximateFirstReceiveTimestamp = String(message.firstReceiveTimestamp);
      }
      if (wantAttr("SenderId")) sysAttrs.SenderId = this.accountId;
      if (queue.fifo) {
        if (wantAttr("MessageGroupId") && message.messageGroupId) {
          sysAttrs.MessageGroupId = message.messageGroupId;
        }
        if (wantAttr("MessageDeduplicationId") && message.dedupId) {
          sysAttrs.MessageDeduplicationId = message.dedupId;
        }
        if (wantAttr("SequenceNumber") && message.sequenceNumber) {
          sysAttrs.SequenceNumber = message.sequenceNumber;
        }
      }
      if (Object.keys(sysAttrs).length > 0) result.Attributes = sysAttrs;

      // Message attributes
      if (message.attributes && messageAttributeNames.length > 0) {
        const wantAllMA = messageAttributeNames.includes("All");
        const filtered = {};
        for (const [k, v] of Object.entries(message.attributes)) {
          if (wantAllMA || messageAttributeNames.includes(k)) filtered[k] = v;
        }
        if (Object.keys(filtered).length > 0) {
          result.MessageAttributes = filtered;
          result.MD5OfMessageAttributes = md5OfMessageAttributes(filtered);
        }
      }

      return result;
    });

    out.Messages = messages;
    return out;
  }

  findInflight(queue, receiptHandle) {
    return queue.inflight.get(receiptHandle);
  }

  deleteMessage(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const handle = input.ReceiptHandle;
    if (!handle) {
      throw new SqsError("MissingParameter", "The request must contain the parameter ReceiptHandle.");
    }
    const entry = this.findInflight(queue, handle);
    if (!entry) {
      // Tolerate deletes of already-removed (idempotent) but reject malformed.
      if (typeof handle !== "string" || !handle.includes("#")) {
        throw new SqsError(
          "ReceiptHandleIsInvalid",
          `The input receipt handle "${handle}" is not a valid receipt handle.`,
        );
      }
      return {};
    }
    if (entry.timer) clearTimeout(entry.timer);
    queue.inflight.delete(handle);
    return {};
  }

  deleteMessageBatch(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const entries = input.Entries || [];
    if (entries.length === 0) {
      throw new SqsError(
        "AWS.SimpleQueueService.EmptyBatchRequest",
        "There should be at least one DeleteMessageBatchRequestEntry in the request.",
      );
    }
    if (entries.length > 10) {
      throw new SqsError(
        "AWS.SimpleQueueService.TooManyEntriesInBatchRequest",
        "Maximum number of entries per request is 10.",
      );
    }
    const ids = new Set();
    for (const e of entries) {
      if (ids.has(e.Id)) {
        throw new SqsError(
          "AWS.SimpleQueueService.BatchEntryIdsNotDistinct",
          `Id ${e.Id} repeated.`,
        );
      }
      ids.add(e.Id);
    }
    const successful = [];
    const failed = [];
    for (const e of entries) {
      const entry = this.findInflight(queue, e.ReceiptHandle);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        queue.inflight.delete(e.ReceiptHandle);
        successful.push({ Id: e.Id });
      } else if (typeof e.ReceiptHandle === "string" && e.ReceiptHandle.includes("#")) {
        // Already gone — SQS treats as success (idempotent delete).
        successful.push({ Id: e.Id });
      } else {
        failed.push({
          Id: e.Id,
          SenderFault: true,
          Code: "ReceiptHandleIsInvalid",
          Message: `The input receipt handle "${e.ReceiptHandle}" is not a valid receipt handle.`,
        });
      }
    }
    return { Successful: successful, Failed: failed };
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------
  applyVisibility(queue, receiptHandle, timeout) {
    const entry = this.findInflight(queue, receiptHandle);
    if (!entry) {
      throw new SqsError(
        "AWS.SimpleQueueService.MessageNotInflight",
        "Message is not inflight.",
      );
    }
    if (timeout === undefined || timeout === null) {
      throw new SqsError(
        "MissingParameter",
        "The request must contain the parameter VisibilityTimeout.",
      );
    }
    const t = parseInt(timeout, 10);
    if (Number.isNaN(t) || t < 0 || t > 43200) {
      throw new SqsError(
        "InvalidParameterValue",
        "Value " + timeout + " for parameter VisibilityTimeout is invalid. Reason: VisibilityTimeout must be an integer between 0 and 43200.",
      );
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.visibleAt = Date.now() + t * 1000;
    if (t === 0) {
      queue.inflight.delete(receiptHandle);
      queue.messages.push(entry.message);
    } else {
      entry.timer = setTimeout(() => {
        if (queue.inflight.has(receiptHandle)) {
          queue.inflight.delete(receiptHandle);
          queue.messages.push(entry.message);
        }
      }, t * 1000);
      if (entry.timer.unref) entry.timer.unref();
    }
  }

  changeMessageVisibility(input) {
    const queue = this.requireQueue(input.QueueUrl);
    this.applyVisibility(queue, input.ReceiptHandle, input.VisibilityTimeout);
    return {};
  }

  changeMessageVisibilityBatch(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const entries = input.Entries || [];
    if (entries.length === 0) {
      throw new SqsError(
        "AWS.SimpleQueueService.EmptyBatchRequest",
        "There should be at least one ChangeMessageVisibilityBatchRequestEntry in the request.",
      );
    }
    if (entries.length > 10) {
      throw new SqsError(
        "AWS.SimpleQueueService.TooManyEntriesInBatchRequest",
        "Maximum number of entries per request is 10.",
      );
    }
    const ids = new Set();
    for (const e of entries) {
      if (ids.has(e.Id)) {
        throw new SqsError(
          "AWS.SimpleQueueService.BatchEntryIdsNotDistinct",
          `Id ${e.Id} repeated.`,
        );
      }
      ids.add(e.Id);
    }
    const successful = [];
    const failed = [];
    for (const e of entries) {
      try {
        this.applyVisibility(queue, e.ReceiptHandle, e.VisibilityTimeout);
        successful.push({ Id: e.Id });
      } catch (err) {
        failed.push({
          Id: e.Id,
          SenderFault: true,
          Code: err instanceof SqsError ? err.code : "InternalError",
          Message: err.message,
        });
      }
    }
    return { Successful: successful, Failed: failed };
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  tagQueue(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const tags = input.Tags || {};
    for (const [k, v] of Object.entries(tags)) queue.tags.set(k, String(v));
    return {};
  }

  untagQueue(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const keys = input.TagKeys || [];
    for (const k of keys) queue.tags.delete(k);
    return {};
  }

  listQueueTags(input) {
    const queue = this.requireQueue(input.QueueUrl);
    if (queue.tags.size === 0) return {};
    const tags = {};
    for (const [k, v] of queue.tags) tags[k] = v;
    return { Tags: tags };
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------
  addPermission(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const label = input.Label;
    if (!label) {
      throw new SqsError("MissingParameter", "The request must contain the parameter Label.");
    }
    if (queue.permissions.has(label)) {
      throw new SqsError(
        "InvalidParameterValue",
        `Value ${label} for parameter Label is invalid. Reason: Already exists.`,
      );
    }
    const accountIds = input.AWSAccountIds || input.AWSAccountId || [];
    const actions = input.Actions || input.ActionName || [];
    if (!accountIds.length) {
      throw new SqsError("MissingParameter", "The request must contain the parameter AWSAccountIds.");
    }
    if (!actions.length) {
      throw new SqsError("MissingParameter", "The request must contain the parameter Actions.");
    }
    queue.permissions.set(label, { accountIds, actions });
    return {};
  }

  removePermission(input) {
    const queue = this.requireQueue(input.QueueUrl);
    const label = input.Label;
    if (!label) {
      throw new SqsError("MissingParameter", "The request must contain the parameter Label.");
    }
    if (!queue.permissions.has(label)) {
      throw new SqsError(
        "InvalidParameterValue",
        `Value ${label} for parameter Label is invalid. Reason: can't find label.`,
      );
    }
    queue.permissions.delete(label);
    return {};
  }

  // -------------------------------------------------------------------------
  // Dead-letter queues
  // -------------------------------------------------------------------------
  listDeadLetterSourceQueues(input) {
    const target = this.requireQueue(input.QueueUrl);
    const sources = [];
    for (const queue of this.queues.values()) {
      const redrive = queue.attributes.RedrivePolicy;
      if (!redrive) continue;
      try {
        const parsed = JSON.parse(redrive);
        if (parsed.deadLetterTargetArn === target.arn) {
          sources.push(queue.url);
        }
      } catch {
        /* ignore malformed redrive policy */
      }
    }
    const out = { queueUrls: sources };
    return out;
  }

  // -------------------------------------------------------------------------
  // Message move tasks (DLQ redrive)
  // -------------------------------------------------------------------------
  startMessageMoveTask(input) {
    const sourceArn = input.SourceArn;
    if (!sourceArn) {
      throw new SqsError("MissingParameter", "The request must contain the parameter SourceArn.");
    }
    const sourceName = sourceArn.split(":").pop();
    const source = this.queues.get(sourceName);
    if (!source) {
      throw new SqsError(
        "ResourceNotFoundException",
        "The resource that you specified for the SourceArn parameter doesn't exist.",
      );
    }
    let destination = null;
    if (input.DestinationArn) {
      const destName = input.DestinationArn.split(":").pop();
      destination = this.queues.get(destName) || null;
      if (!destination) {
        throw new SqsError(
          "ResourceNotFoundException",
          "The resource that you specified for the DestinationArn parameter doesn't exist.",
        );
      }
    } else {
      // Default destination: original source queues per redrive policy.
      for (const q of this.queues.values()) {
        const rp = q.attributes.RedrivePolicy;
        if (rp) {
          try {
            if (JSON.parse(rp).deadLetterTargetArn === sourceArn) {
              destination = q;
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }

    const taskHandle = Buffer.from(
      JSON.stringify({ taskId: randomUUID(), sourceArn }),
    ).toString("base64");
    const moved = source.messages.length;
    if (destination) {
      for (const m of source.messages) destination.messages.push(m);
    }
    source.messages = [];

    const task = {
      taskHandle,
      sourceArn,
      destinationArn: input.DestinationArn || (destination ? destination.arn : undefined),
      maxNumberOfMessagesPerSecond: input.MaxNumberOfMessagesPerSecond,
      approximateNumberOfMessagesMoved: moved,
      approximateNumberOfMessagesToMove: moved,
      status: "COMPLETED",
      startedTimestamp: Date.now(),
    };
    this.moveTasks.set(taskHandle, task);
    return { TaskHandle: taskHandle };
  }

  cancelMessageMoveTask(input) {
    const handle = input.TaskHandle;
    if (!handle) {
      throw new SqsError("MissingParameter", "The request must contain the parameter TaskHandle.");
    }
    const task = this.moveTasks.get(handle);
    if (!task) {
      throw new SqsError(
        "ResourceNotFoundException",
        "The task handle that you specified doesn't exist.",
      );
    }
    task.status = "CANCELLED";
    return { ApproximateNumberOfMessagesMoved: task.approximateNumberOfMessagesMoved };
  }

  listMessageMoveTasks(input) {
    const sourceArn = input.SourceArn;
    if (!sourceArn) {
      throw new SqsError("MissingParameter", "The request must contain the parameter SourceArn.");
    }
    const max = input.MaxResults || 1;
    const results = [];
    for (const task of [...this.moveTasks.values()].reverse()) {
      if (task.sourceArn === sourceArn && results.length < max) {
        const entry = {
          Status: task.status,
          SourceArn: task.sourceArn,
          ApproximateNumberOfMessagesMoved: task.approximateNumberOfMessagesMoved,
          ApproximateNumberOfMessagesToMove: task.approximateNumberOfMessagesToMove,
          StartedTimestamp: task.startedTimestamp,
        };
        if (task.destinationArn) entry.DestinationArn = task.destinationArn;
        if (task.maxNumberOfMessagesPerSecond !== undefined) {
          entry.MaxNumberOfMessagesPerSecond = task.maxNumberOfMessagesPerSecond;
        }
        if (task.status === "COMPLETED" || task.status === "CANCELLED") {
          entry.TaskHandle = task.taskHandle;
        }
        results.push(entry);
      }
    }
    return { Results: results };
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
    const code = error.code || "InternalFailure";
    const status = error.status || ERROR_STATUS[code] || 400;
    const fault = status >= 500 ? "Receiver" : "Sender";
    // Query-compatible error header consumed by @aws-sdk/client-sqs.
    res.setHeader("x-amzn-query-error", `${code};${fault}`);
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

export default SqsServer;
