// parlel/pubsub — a lightweight, dependency-free fake of Google Cloud Pub/Sub.
//
// Speaks the Pub/Sub v1 REST API (https://pubsub.googleapis.com/v1) so that
// application code using the real `@google-cloud/pubsub` client can run against
// it with zero cost and zero side effects. Pure Node.js, no external npm
// dependencies. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).
//
// Point the client at this server by setting:
//   PUBSUB_EMULATOR_HOST=127.0.0.1:4582
// and constructing the client so it uses the HTTP/1.1 REST transport (the
// google-gax fallback) instead of gRPC:
//   new PubSub({ projectId: "parlel", fallback: true, protocol: "http" })
//
// The gax REST fallback transcodes RPCs to these endpoints (google.api.http):
//
//   Publisher service
//   PUT    /v1/{name=projects/*/topics/*}                          CreateTopic
//   PATCH  /v1/{topic.name=projects/*/topics/*}                    UpdateTopic
//   POST   /v1/{topic=projects/*/topics/*}:publish                 Publish
//   GET    /v1/{topic=projects/*/topics/*}                         GetTopic
//   GET    /v1/{project=projects/*}/topics                         ListTopics
//   GET    /v1/{topic=projects/*/topics/*}/subscriptions           ListTopicSubscriptions
//   GET    /v1/{topic=projects/*/topics/*}/snapshots               ListTopicSnapshots
//   DELETE /v1/{topic=projects/*/topics/*}                         DeleteTopic
//   POST   /v1/{subscription=projects/*/subscriptions/*}:detach    DetachSubscription
//
//   Subscriber service
//   PUT    /v1/{name=projects/*/subscriptions/*}                   CreateSubscription
//   GET    /v1/{subscription=projects/*/subscriptions/*}           GetSubscription
//   PATCH  /v1/{subscription.name=projects/*/subscriptions/*}      UpdateSubscription
//   GET    /v1/{project=projects/*}/subscriptions                  ListSubscriptions
//   DELETE /v1/{subscription=projects/*/subscriptions/*}           DeleteSubscription
//   POST   /v1/{subscription=...}:modifyAckDeadline               ModifyAckDeadline
//   POST   /v1/{subscription=...}:acknowledge                     Acknowledge
//   POST   /v1/{subscription=...}:pull                            Pull
//   POST   /v1/{subscription=...}:modifyPushConfig               ModifyPushConfig
//   POST   /v1/{subscription=...}:seek                           Seek
//
//   Snapshots
//   GET    /v1/{snapshot=projects/*/snapshots/*}                   GetSnapshot
//   GET    /v1/{project=projects/*}/snapshots                      ListSnapshots
//   PUT    /v1/{name=projects/*/snapshots/*}                       CreateSnapshot
//   PATCH  /v1/{snapshot.name=projects/*/snapshots/*}              UpdateSnapshot
//   DELETE /v1/{snapshot=projects/*/snapshots/*}                   DeleteSnapshot
//
//   SchemaService
//   POST   /v1/{parent=projects/*}/schemas                         CreateSchema
//   GET    /v1/{name=projects/*/schemas/*}                         GetSchema
//   GET    /v1/{parent=projects/*}/schemas                         ListSchemas
//   GET    /v1/{name=projects/*/schemas/*}:listRevisions           ListSchemaRevisions
//   POST   /v1/{name=projects/*/schemas/*}:commit                  CommitSchema
//   POST   /v1/{name=projects/*/schemas/*}:rollback                RollbackSchema
//   DELETE /v1/{name=projects/*/schemas/*}:deleteRevision          DeleteSchemaRevision
//   DELETE /v1/{name=projects/*/schemas/*}                         DeleteSchema
//   POST   /v1/{parent=projects/*}/schemas:validate                ValidateSchema
//   POST   /v1/{parent=projects/*}/schemas:validateMessage         ValidateMessage
//
//   IAM (google.iam.v1)
//   POST   /v1/{resource=**}:setIamPolicy                          SetIamPolicy
//   POST   /v1/{resource=**}:getIamPolicy                          GetIamPolicy
//   POST   /v1/{resource=**}:testIamPermissions                    TestIamPermissions
//
//   StreamingPull (bidi gRPC stream) — intentionally unsupported in REST mode.

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// gRPC canonical status codes (used to derive HTTP status + error shape).
// ---------------------------------------------------------------------------
const GRPC = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};

// The google-gax REST decoder maps an error by the HTTP status code we send.
// We pick the HTTP status whose canonical mapping recovers the intended gRPC
// status on the client side.
const GRPC_TO_HTTP = {
  [GRPC.OK]: 200,
  [GRPC.CANCELLED]: 499,
  [GRPC.UNKNOWN]: 500,
  [GRPC.INVALID_ARGUMENT]: 400,
  [GRPC.DEADLINE_EXCEEDED]: 504,
  [GRPC.NOT_FOUND]: 404,
  // ALREADY_EXISTS has no HTTP status that decodes back to code 6 through the
  // gax REST table, and 409 decodes to ABORTED which the create-subscription
  // retry policy RETRIES. We therefore surface create-conflicts as
  // FAILED_PRECONDITION (412 -> code 9): a non-retryable, immediately-rejecting
  // status, matching the behavior callers expect from a duplicate create.
  [GRPC.ALREADY_EXISTS]: 412,
  [GRPC.PERMISSION_DENIED]: 403,
  [GRPC.RESOURCE_EXHAUSTED]: 429,
  [GRPC.FAILED_PRECONDITION]: 400,
  [GRPC.ABORTED]: 409,
  [GRPC.OUT_OF_RANGE]: 400,
  [GRPC.UNIMPLEMENTED]: 501,
  [GRPC.INTERNAL]: 500,
  [GRPC.UNAVAILABLE]: 503,
  [GRPC.DATA_LOSS]: 500,
  [GRPC.UNAUTHENTICATED]: 401,
};

const GRPC_STATUS_NAME = {
  [GRPC.OK]: "OK",
  [GRPC.CANCELLED]: "CANCELLED",
  [GRPC.UNKNOWN]: "UNKNOWN",
  [GRPC.INVALID_ARGUMENT]: "INVALID_ARGUMENT",
  [GRPC.DEADLINE_EXCEEDED]: "DEADLINE_EXCEEDED",
  [GRPC.NOT_FOUND]: "NOT_FOUND",
  [GRPC.ALREADY_EXISTS]: "ALREADY_EXISTS",
  [GRPC.PERMISSION_DENIED]: "PERMISSION_DENIED",
  [GRPC.RESOURCE_EXHAUSTED]: "RESOURCE_EXHAUSTED",
  [GRPC.FAILED_PRECONDITION]: "FAILED_PRECONDITION",
  [GRPC.ABORTED]: "ABORTED",
  [GRPC.OUT_OF_RANGE]: "OUT_OF_RANGE",
  [GRPC.UNIMPLEMENTED]: "UNIMPLEMENTED",
  [GRPC.INTERNAL]: "INTERNAL",
  [GRPC.UNAVAILABLE]: "UNAVAILABLE",
  [GRPC.DATA_LOSS]: "DATA_LOSS",
  [GRPC.UNAUTHENTICATED]: "UNAUTHENTICATED",
};

// Pub/Sub resource-id validation: 3-255 chars, must start with a letter, then
// letters, digits, dashes, dots, underscores, percent, plus, tilde. May not
// start with "goog".
const RESOURCE_ID_RE = /^[A-Za-z][A-Za-z0-9\-._~%+]{2,254}$/;

function isValidResourceId(id) {
  if (!RESOURCE_ID_RE.test(id)) return false;
  if (id.toLowerCase().startsWith("goog")) return false;
  return true;
}

class PubsubError extends Error {
  constructor(grpcCode, message) {
    super(message);
    this.grpcCode = grpcCode;
  }
}

// Schema enum normalizers — the REST fallback transport emits enum values as
// integers (enum-encoding=int) while gRPC uses the string names. Accept both.
const SCHEMA_TYPE = {
  0: "TYPE_UNSPECIFIED",
  1: "PROTOCOL_BUFFER",
  2: "AVRO",
  TYPE_UNSPECIFIED: "TYPE_UNSPECIFIED",
  PROTOCOL_BUFFER: "PROTOCOL_BUFFER",
  AVRO: "AVRO",
};
const SCHEMA_ENCODING = {
  0: "ENCODING_UNSPECIFIED",
  1: "JSON",
  2: "BINARY",
  ENCODING_UNSPECIFIED: "ENCODING_UNSPECIFIED",
  JSON: "JSON",
  BINARY: "BINARY",
};
function normSchemaType(t) {
  if (t === undefined || t === null) return "TYPE_UNSPECIFIED";
  return SCHEMA_TYPE[t] || "TYPE_UNSPECIFIED";
}
function normEncoding(e) {
  if (e === undefined || e === null) return "ENCODING_UNSPECIFIED";
  return SCHEMA_ENCODING[e] || "ENCODING_UNSPECIFIED";
}

const MIN_ACK_DEADLINE = 10;
const MAX_ACK_DEADLINE = 600;
const DEFAULT_ACK_DEADLINE = 10;

export class PubsubServer {
  constructor(port = 4582, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.projectId = options.projectId || "parlel";
    this.server = null;
    this.reset();
  }

  reset() {
    // topics: Map<fullName, { name, labels, messageStoragePolicy, kmsKeyName,
    //   schemaSettings, messageRetentionDuration, state }>
    this.topics = new Map();
    // subscriptions: Map<fullName, SubRecord>
    this.subscriptions = new Map();
    // snapshots: Map<fullName, { name, topic, expireTime, labels }>
    this.snapshots = new Map();
    // schemas: Map<fullName, { name, type, definition, revisionId, ... }>
    this.schemas = new Map();
    // policies: Map<resourceName, Policy>
    this.policies = new Map();
    // message store per subscription: each subscription holds a queue and a map
    // of outstanding (delivered, not-yet-acked) messages keyed by ackId.
    this._seq = 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (error instanceof PubsubError) {
            this.sendError(res, error.grpcCode, error.message);
          } else {
            this.sendError(res, GRPC.INTERNAL, error.message || "internal error");
          }
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

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    // Internal parlel endpoints (not part of Pub/Sub).
    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "pubsub",
        topics: this.topics.size,
        subscriptions: this.subscriptions.size,
        snapshots: this.snapshots.size,
        schemas: this.schemas.size,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/_parlel/dump" && method === "GET") {
      return this.sendJson(res, 200, {
        topics: [...this.topics.values()],
        subscriptions: [...this.subscriptions.values()].map((s) => s.def),
        snapshots: [...this.snapshots.values()],
        schemas: [...this.schemas.values()],
      });
    }

    const rawBody = await this.readBody(req);
    let body = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new PubsubError(GRPC.INVALID_ARGUMENT, "Invalid JSON body");
      }
    }

    if (!pathname.startsWith("/v1/")) {
      throw new PubsubError(GRPC.NOT_FOUND, "Not Found");
    }

    const rest = pathname.slice("/v1/".length); // projects/p/topics/t ...
    // Split off a trailing custom verb ":<verb>".
    const colon = rest.lastIndexOf(":");
    let verb = null;
    let resourcePath = rest;
    if (colon !== -1 && !rest.slice(colon + 1).includes("/")) {
      verb = rest.slice(colon + 1);
      resourcePath = rest.slice(0, colon);
    }

    const segs = resourcePath.split("/");
    // segs like: projects, {project}, topics|subscriptions|snapshots|schemas, {id}, [subcollection]

    // ---- custom verbs (POST/GET on resource:verb) ----
    if (verb) {
      switch (verb) {
        case "publish":
          return this.publish(res, resourcePath, body);
        case "detach":
          return this.detachSubscription(res, resourcePath);
        case "modifyAckDeadline":
          return this.modifyAckDeadline(res, resourcePath, body);
        case "acknowledge":
          return this.acknowledge(res, resourcePath, body);
        case "pull":
          return this.pull(res, resourcePath, body);
        case "modifyPushConfig":
          return this.modifyPushConfig(res, resourcePath, body);
        case "seek":
          return this.seek(res, resourcePath, body);
        case "listRevisions":
          return this.listSchemaRevisions(res, resourcePath, q);
        case "commit":
          return this.commitSchema(res, resourcePath, body);
        case "rollback":
          return this.rollbackSchema(res, resourcePath, body);
        case "deleteRevision":
          return this.deleteSchemaRevision(res, resourcePath, q);
        case "validate":
          return this.validateSchema(res, resourcePath, body);
        case "validateMessage":
          return this.validateMessage(res, resourcePath, body);
        case "getIamPolicy":
          return this.getIamPolicy(res, resourcePath);
        case "setIamPolicy":
          return this.setIamPolicy(res, resourcePath, body);
        case "testIamPermissions":
          return this.testIamPermissions(res, resourcePath, body);
        default:
          throw new PubsubError(GRPC.UNIMPLEMENTED, `Unknown verb: ${verb}`);
      }
    }

    // ---- collection-scoped: schemas under a project (POST create, GET list) ----
    // projects/{p}/schemas
    if (segs.length === 3 && segs[2] === "schemas") {
      const parent = `projects/${segs[1]}`;
      if (method === "POST") return this.createSchema(res, parent, q, body);
      if (method === "GET") return this.listSchemas(res, parent, q);
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    // projects/{p}/topics  (list) — already a collection
    if (segs.length === 3 && segs[2] === "topics" && method === "GET") {
      return this.listTopics(res, `projects/${segs[1]}`, q);
    }
    if (segs.length === 3 && segs[2] === "subscriptions" && method === "GET") {
      return this.listSubscriptions(res, `projects/${segs[1]}`, q);
    }
    if (segs.length === 3 && segs[2] === "snapshots" && method === "GET") {
      return this.listSnapshots(res, `projects/${segs[1]}`, q);
    }

    // sub-collections: topics/{t}/subscriptions, topics/{t}/snapshots
    if (segs.length === 5 && segs[2] === "topics" && segs[4] === "subscriptions" && method === "GET") {
      return this.listTopicSubscriptions(res, segs.slice(0, 4).join("/"), q);
    }
    if (segs.length === 5 && segs[2] === "topics" && segs[4] === "snapshots" && method === "GET") {
      return this.listTopicSnapshots(res, segs.slice(0, 4).join("/"), q);
    }

    // ---- single-resource operations ----
    // projects/{p}/topics/{t}
    if (segs.length === 4 && segs[2] === "topics") {
      const name = resourcePath;
      if (method === "PUT") return this.createTopic(res, name, body);
      if (method === "PATCH") return this.updateTopic(res, name, body);
      if (method === "GET") return this.getTopic(res, name);
      if (method === "DELETE") return this.deleteTopic(res, name);
    }
    if (segs.length === 4 && segs[2] === "subscriptions") {
      const name = resourcePath;
      if (method === "PUT") return this.createSubscription(res, name, body);
      if (method === "PATCH") return this.updateSubscription(res, name, body);
      if (method === "GET") return this.getSubscription(res, name);
      if (method === "DELETE") return this.deleteSubscription(res, name);
    }
    if (segs.length === 4 && segs[2] === "snapshots") {
      const name = resourcePath;
      if (method === "PUT") return this.createSnapshot(res, name, body);
      if (method === "PATCH") return this.updateSnapshot(res, name, body);
      if (method === "GET") return this.getSnapshot(res, name);
      if (method === "DELETE") return this.deleteSnapshot(res, name);
    }
    if (segs.length === 4 && segs[2] === "schemas") {
      const name = resourcePath;
      if (method === "GET") return this.getSchema(res, name, q);
      if (method === "DELETE") return this.deleteSchema(res, name);
    }

    throw new PubsubError(GRPC.NOT_FOUND, `Unrecognized path: /v1/${rest}`);
  }

  // =========================================================================
  // Topics
  // =========================================================================
  createTopic(res, name, body) {
    this._assertTopicName(name);
    if (this.topics.has(name)) {
      throw new PubsubError(GRPC.ALREADY_EXISTS, `Topic already exists: ${name}`);
    }
    const topic = {
      name,
      labels: body.labels || undefined,
      messageStoragePolicy: body.messageStoragePolicy || undefined,
      kmsKeyName: body.kmsKeyName || undefined,
      schemaSettings: body.schemaSettings || undefined,
      messageRetentionDuration: body.messageRetentionDuration || undefined,
      satisfiesPzs: body.satisfiesPzs || undefined,
      state: "ACTIVE",
    };
    this.topics.set(name, topic);
    return this.sendJson(res, 200, cleanTopic(topic));
  }

  updateTopic(res, name, body) {
    const topic = this.topics.get(name);
    if (!topic) throw new PubsubError(GRPC.NOT_FOUND, `Topic not found: ${name}`);
    const update = body.topic || {};
    const mask = (body.updateMask && fieldsOf(body.updateMask)) || Object.keys(update);
    for (const path of mask) {
      const field = path.split(".")[0];
      if (field === "name") continue; // immutable
      topic[field] = update[field];
    }
    return this.sendJson(res, 200, cleanTopic(topic));
  }

  getTopic(res, name) {
    const topic = this.topics.get(name);
    if (!topic) throw new PubsubError(GRPC.NOT_FOUND, `Topic not found: ${name}`);
    return this.sendJson(res, 200, cleanTopic(topic));
  }

  listTopics(res, parent, q) {
    const all = [...this.topics.values()]
      .filter((t) => t.name.startsWith(`${parent}/topics/`))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      topics: page.map(cleanTopic),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  listTopicSubscriptions(res, topicName, q) {
    if (!this.topics.has(topicName)) {
      throw new PubsubError(GRPC.NOT_FOUND, `Topic not found: ${topicName}`);
    }
    const subs = [...this.subscriptions.values()]
      .filter((s) => s.def.topic === topicName)
      .map((s) => s.def.name)
      .sort();
    const { page, nextPageToken } = paginate(subs, q);
    return this.sendJson(res, 200, {
      subscriptions: page,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  listTopicSnapshots(res, topicName, q) {
    if (!this.topics.has(topicName)) {
      throw new PubsubError(GRPC.NOT_FOUND, `Topic not found: ${topicName}`);
    }
    const snaps = [...this.snapshots.values()]
      .filter((s) => s.topic === topicName)
      .map((s) => s.name)
      .sort();
    const { page, nextPageToken } = paginate(snaps, q);
    return this.sendJson(res, 200, {
      snapshots: page,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  deleteTopic(res, name) {
    if (!this.topics.has(name)) {
      throw new PubsubError(GRPC.NOT_FOUND, `Topic not found: ${name}`);
    }
    this.topics.delete(name);
    // Subscriptions referencing the deleted topic survive but their topic is
    // set to the special sentinel "_deleted-topic_" (matching real Pub/Sub).
    for (const sub of this.subscriptions.values()) {
      if (sub.def.topic === name) sub.def.topic = "_deleted-topic_";
    }
    return this.sendJson(res, 200, {});
  }

  detachSubscription(res, subName) {
    const sub = this.subscriptions.get(subName);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${subName}`);
    sub.def.detached = true;
    return this.sendJson(res, 200, {});
  }

  // =========================================================================
  // Publish
  // =========================================================================
  publish(res, topicName, body) {
    const topic = this.topics.get(topicName);
    if (!topic) throw new PubsubError(GRPC.NOT_FOUND, `Topic not found: ${topicName}`);
    const messages = body.messages || [];
    if (messages.length === 0) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "No messages to publish");
    }
    const messageIds = [];
    for (const m of messages) {
      const hasData = m.data !== undefined && m.data !== null && m.data !== "";
      const hasAttrs = m.attributes && Object.keys(m.attributes).length > 0;
      if (!hasData && !hasAttrs) {
        throw new PubsubError(
          GRPC.INVALID_ARGUMENT,
          "Cannot publish an empty message: data and attributes are both empty",
        );
      }
      const id = String(++this._seq);
      const stored = {
        data: m.data || "",
        attributes: m.attributes || undefined,
        messageId: id,
        publishTime: nowTs(),
        orderingKey: m.orderingKey || undefined,
      };
      messageIds.push(id);
      // Fan out to every subscription attached to this topic.
      for (const sub of this.subscriptions.values()) {
        if (sub.def.topic === topicName) {
          sub.backlog.push({
            message: stored,
            deliveryAttempt: 0,
          });
        }
      }
    }
    return this.sendJson(res, 200, { messageIds });
  }

  // =========================================================================
  // Subscriptions
  // =========================================================================
  createSubscription(res, name, body) {
    this._assertSubscriptionName(name);
    if (this.subscriptions.has(name)) {
      throw new PubsubError(GRPC.ALREADY_EXISTS, `Subscription already exists: ${name}`);
    }
    const topicName = body.topic;
    if (!topicName) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "Subscription must specify a topic");
    }
    if (topicName !== "_deleted-topic_" && !this.topics.has(topicName)) {
      throw new PubsubError(GRPC.NOT_FOUND, `Topic not found: ${topicName}`);
    }
    let ackDeadline = body.ackDeadlineSeconds;
    if (ackDeadline === undefined || ackDeadline === 0) ackDeadline = DEFAULT_ACK_DEADLINE;
    if (ackDeadline < MIN_ACK_DEADLINE || ackDeadline > MAX_ACK_DEADLINE) {
      throw new PubsubError(
        GRPC.INVALID_ARGUMENT,
        `ackDeadlineSeconds must be between ${MIN_ACK_DEADLINE} and ${MAX_ACK_DEADLINE}`,
      );
    }
    const def = {
      name,
      topic: topicName,
      pushConfig: body.pushConfig && Object.keys(body.pushConfig).length ? body.pushConfig : undefined,
      bigqueryConfig: body.bigqueryConfig || undefined,
      cloudStorageConfig: body.cloudStorageConfig || undefined,
      ackDeadlineSeconds: ackDeadline,
      retainAckedMessages: body.retainAckedMessages || undefined,
      messageRetentionDuration: body.messageRetentionDuration || undefined,
      labels: body.labels || undefined,
      enableMessageOrdering: body.enableMessageOrdering || undefined,
      expirationPolicy: body.expirationPolicy || undefined,
      filter: body.filter || undefined,
      deadLetterPolicy: body.deadLetterPolicy || undefined,
      retryPolicy: body.retryPolicy || undefined,
      detached: body.detached || undefined,
      enableExactlyOnceDelivery: body.enableExactlyOnceDelivery || undefined,
      state: "ACTIVE",
    };
    const sub = { def, backlog: [], outstanding: new Map() };
    this.subscriptions.set(name, sub);
    return this.sendJson(res, 200, cleanSubscription(def));
  }

  getSubscription(res, name) {
    const sub = this.subscriptions.get(name);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${name}`);
    return this.sendJson(res, 200, cleanSubscription(sub.def));
  }

  updateSubscription(res, name, body) {
    const sub = this.subscriptions.get(name);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${name}`);
    const update = body.subscription || {};
    const mask = (body.updateMask && fieldsOf(body.updateMask)) || Object.keys(update);
    for (const path of mask) {
      const field = path.split(".")[0];
      if (field === "name" || field === "topic") continue; // immutable
      if (field === "ackDeadlineSeconds") {
        const v = update.ackDeadlineSeconds;
        if (v !== undefined && (v < MIN_ACK_DEADLINE || v > MAX_ACK_DEADLINE)) {
          throw new PubsubError(
            GRPC.INVALID_ARGUMENT,
            `ackDeadlineSeconds must be between ${MIN_ACK_DEADLINE} and ${MAX_ACK_DEADLINE}`,
          );
        }
      }
      sub.def[field] = update[field];
    }
    return this.sendJson(res, 200, cleanSubscription(sub.def));
  }

  listSubscriptions(res, parent, q) {
    const all = [...this.subscriptions.values()]
      .map((s) => s.def)
      .filter((d) => d.name.startsWith(`${parent}/subscriptions/`))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      subscriptions: page.map(cleanSubscription),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  deleteSubscription(res, name) {
    if (!this.subscriptions.has(name)) {
      throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${name}`);
    }
    this.subscriptions.delete(name);
    return this.sendJson(res, 200, {});
  }

  // =========================================================================
  // Pull / Ack / ModifyAckDeadline
  // =========================================================================
  pull(res, subName, body) {
    const sub = this.subscriptions.get(subName);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${subName}`);
    this._expireOutstanding(sub);
    let max = body.maxMessages;
    if (max === undefined || max === null) max = 1;
    if (max <= 0) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "maxMessages must be > 0");
    }
    const received = [];
    while (received.length < max && sub.backlog.length > 0) {
      const item = sub.backlog.shift();
      const ackId = makeAckId();
      const deliveryAttempt = (item.deliveryAttempt || 0) + 1;
      const deadlineSec = sub.def.ackDeadlineSeconds || DEFAULT_ACK_DEADLINE;
      sub.outstanding.set(ackId, {
        item: { ...item, deliveryAttempt },
        expiresAt: Date.now() + deadlineSec * 1000,
      });
      received.push({
        ackId,
        message: item.message,
        ...(sub.def.deadLetterPolicy ? { deliveryAttempt } : {}),
      });
    }
    return this.sendJson(res, 200, {
      ...(received.length ? { receivedMessages: received } : {}),
    });
  }

  acknowledge(res, subName, body) {
    const sub = this.subscriptions.get(subName);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${subName}`);
    const ackIds = body.ackIds || [];
    if (ackIds.length === 0) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "ackIds is required");
    }
    for (const ackId of ackIds) {
      sub.outstanding.delete(ackId);
    }
    return this.sendJson(res, 200, {});
  }

  modifyAckDeadline(res, subName, body) {
    const sub = this.subscriptions.get(subName);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${subName}`);
    const ackIds = body.ackIds || [];
    const seconds = body.ackDeadlineSeconds;
    if (seconds === undefined) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "ackDeadlineSeconds is required");
    }
    if (seconds < 0 || seconds > MAX_ACK_DEADLINE) {
      throw new PubsubError(
        GRPC.INVALID_ARGUMENT,
        `ackDeadlineSeconds must be between 0 and ${MAX_ACK_DEADLINE}`,
      );
    }
    for (const ackId of ackIds) {
      const out = sub.outstanding.get(ackId);
      if (!out) continue;
      if (seconds === 0) {
        // nack — return the message to the backlog immediately.
        sub.outstanding.delete(ackId);
        sub.backlog.unshift(out.item);
      } else {
        out.expiresAt = Date.now() + seconds * 1000;
      }
    }
    return this.sendJson(res, 200, {});
  }

  // Return outstanding messages whose ack deadline has elapsed to the backlog.
  _expireOutstanding(sub) {
    const now = Date.now();
    for (const [ackId, out] of [...sub.outstanding.entries()]) {
      if (out.expiresAt <= now) {
        sub.outstanding.delete(ackId);
        sub.backlog.push(out.item);
      }
    }
  }

  // =========================================================================
  // PushConfig / Seek
  // =========================================================================
  modifyPushConfig(res, subName, body) {
    const sub = this.subscriptions.get(subName);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${subName}`);
    const cfg = body.pushConfig;
    sub.def.pushConfig = cfg && Object.keys(cfg).length ? cfg : undefined;
    return this.sendJson(res, 200, {});
  }

  seek(res, subName, body) {
    const sub = this.subscriptions.get(subName);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${subName}`);
    if (body.snapshot) {
      const snap = this.snapshots.get(body.snapshot);
      if (!snap) throw new PubsubError(GRPC.NOT_FOUND, `Snapshot not found: ${body.snapshot}`);
      // Restore the snapshot's captured backlog (deep copy).
      sub.backlog = snap.backlog.map((i) => ({ ...i }));
      sub.outstanding.clear();
    } else if (body.time !== undefined) {
      // Seek to a timestamp: redeliver everything (return outstanding to backlog).
      // Messages published after `time` would be purged in real Pub/Sub; our
      // fake conservatively re-queues all outstanding messages.
      for (const out of sub.outstanding.values()) {
        sub.backlog.unshift(out.item);
      }
      sub.outstanding.clear();
    } else {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "Seek requires snapshot or time");
    }
    return this.sendJson(res, 200, {});
  }

  // =========================================================================
  // Snapshots
  // =========================================================================
  createSnapshot(res, name, body) {
    this._assertSnapshotName(name);
    if (this.snapshots.has(name)) {
      throw new PubsubError(GRPC.ALREADY_EXISTS, `Snapshot already exists: ${name}`);
    }
    const subName = body.subscription;
    if (!subName) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "subscription is required");
    }
    const sub = this.subscriptions.get(subName);
    if (!sub) throw new PubsubError(GRPC.NOT_FOUND, `Subscription not found: ${subName}`);
    const snap = {
      name,
      topic: sub.def.topic,
      expireTime: futureTs(7 * 24 * 3600),
      labels: body.labels || undefined,
      // Capture the current backlog + outstanding so seek can restore it.
      backlog: [
        ...sub.backlog.map((i) => ({ ...i })),
        ...[...sub.outstanding.values()].map((o) => ({ ...o.item })),
      ],
    };
    this.snapshots.set(name, snap);
    return this.sendJson(res, 200, cleanSnapshot(snap));
  }

  getSnapshot(res, name) {
    const snap = this.snapshots.get(name);
    if (!snap) throw new PubsubError(GRPC.NOT_FOUND, `Snapshot not found: ${name}`);
    return this.sendJson(res, 200, cleanSnapshot(snap));
  }

  updateSnapshot(res, name, body) {
    const snap = this.snapshots.get(name);
    if (!snap) throw new PubsubError(GRPC.NOT_FOUND, `Snapshot not found: ${name}`);
    const update = body.snapshot || {};
    const mask = (body.updateMask && fieldsOf(body.updateMask)) || Object.keys(update);
    for (const path of mask) {
      const field = path.split(".")[0];
      if (field === "name" || field === "topic") continue;
      snap[field] = update[field];
    }
    return this.sendJson(res, 200, cleanSnapshot(snap));
  }

  listSnapshots(res, parent, q) {
    const all = [...this.snapshots.values()]
      .filter((s) => s.name.startsWith(`${parent}/snapshots/`))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      snapshots: page.map(cleanSnapshot),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  deleteSnapshot(res, name) {
    if (!this.snapshots.has(name)) {
      throw new PubsubError(GRPC.NOT_FOUND, `Snapshot not found: ${name}`);
    }
    this.snapshots.delete(name);
    return this.sendJson(res, 200, {});
  }

  // =========================================================================
  // Schemas
  // =========================================================================
  createSchema(res, parent, q, body) {
    const schemaId = q.get("schemaId");
    if (!schemaId) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "schemaId is required");
    }
    const name = `${parent}/schemas/${schemaId}`;
    if (this.schemas.has(name)) {
      throw new PubsubError(GRPC.ALREADY_EXISTS, `Schema already exists: ${name}`);
    }
    const src = body.schema || body;
    const def = src.definition;
    const type = normSchemaType(src.type);
    if (!def) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "definition is required");
    }
    this._validateSchemaDefinition(type, def);
    const revisionId = shortRev();
    const schema = {
      name,
      type,
      definition: def,
      revisionId,
      revisionCreateTime: nowTs(),
      _revisions: [{ revisionId, definition: def, type, revisionCreateTime: nowTs() }],
    };
    this.schemas.set(name, schema);
    return this.sendJson(res, 200, cleanSchema(schema));
  }

  getSchema(res, name, q) {
    // name may include @revisionId
    const { base, revisionId } = splitRevision(name);
    const schema = this.schemas.get(base);
    if (!schema) throw new PubsubError(GRPC.NOT_FOUND, `Schema not found: ${base}`);
    const view = q.get("view");
    if (revisionId) {
      const rev = schema._revisions.find((r) => r.revisionId === revisionId);
      if (!rev) throw new PubsubError(GRPC.NOT_FOUND, `Revision not found: ${revisionId}`);
      return this.sendJson(res, 200, cleanSchema({ ...schema, ...rev, name: base }, view));
    }
    return this.sendJson(res, 200, cleanSchema(schema, view));
  }

  listSchemas(res, parent, q) {
    const view = q.get("view");
    const all = [...this.schemas.values()]
      .filter((s) => s.name.startsWith(`${parent}/schemas/`))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      schemas: page.map((s) => cleanSchema(s, view)),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  listSchemaRevisions(res, name, q) {
    const { base } = splitRevision(name);
    const schema = this.schemas.get(base);
    if (!schema) throw new PubsubError(GRPC.NOT_FOUND, `Schema not found: ${base}`);
    const view = q.get("view");
    const revs = schema._revisions
      .slice()
      .reverse()
      .map((r) => cleanSchema({ ...schema, ...r, name: base }, view));
    const { page, nextPageToken } = paginate(revs, q);
    return this.sendJson(res, 200, {
      schemas: page,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  commitSchema(res, name, body) {
    const schema = this.schemas.get(name);
    if (!schema) throw new PubsubError(GRPC.NOT_FOUND, `Schema not found: ${name}`);
    const incoming = body.schema || {};
    const def = incoming.definition;
    const type = incoming.type !== undefined ? normSchemaType(incoming.type) : schema.type;
    if (!def) throw new PubsubError(GRPC.INVALID_ARGUMENT, "definition is required");
    this._validateSchemaDefinition(type, def);
    const revisionId = shortRev();
    const rev = { revisionId, definition: def, type, revisionCreateTime: nowTs() };
    schema._revisions.push(rev);
    schema.definition = def;
    schema.type = type;
    schema.revisionId = revisionId;
    schema.revisionCreateTime = rev.revisionCreateTime;
    return this.sendJson(res, 200, cleanSchema(schema));
  }

  rollbackSchema(res, name, body) {
    const schema = this.schemas.get(name);
    if (!schema) throw new PubsubError(GRPC.NOT_FOUND, `Schema not found: ${name}`);
    const target = body.revisionId;
    const src = schema._revisions.find((r) => r.revisionId === target);
    if (!src) throw new PubsubError(GRPC.NOT_FOUND, `Revision not found: ${target}`);
    const revisionId = shortRev();
    const rev = {
      revisionId,
      definition: src.definition,
      type: src.type,
      revisionCreateTime: nowTs(),
    };
    schema._revisions.push(rev);
    schema.definition = src.definition;
    schema.type = src.type;
    schema.revisionId = revisionId;
    schema.revisionCreateTime = rev.revisionCreateTime;
    return this.sendJson(res, 200, cleanSchema(schema));
  }

  deleteSchemaRevision(res, name, q) {
    const { base, revisionId: inName } = splitRevision(name);
    const revisionId = inName || q.get("revisionId");
    const schema = this.schemas.get(base);
    if (!schema) throw new PubsubError(GRPC.NOT_FOUND, `Schema not found: ${base}`);
    if (schema._revisions.length <= 1) {
      throw new PubsubError(
        GRPC.INVALID_ARGUMENT,
        "Cannot delete the last revision of a schema",
      );
    }
    const idx = schema._revisions.findIndex((r) => r.revisionId === revisionId);
    if (idx === -1) throw new PubsubError(GRPC.NOT_FOUND, `Revision not found: ${revisionId}`);
    schema._revisions.splice(idx, 1);
    const latest = schema._revisions[schema._revisions.length - 1];
    schema.definition = latest.definition;
    schema.type = latest.type;
    schema.revisionId = latest.revisionId;
    schema.revisionCreateTime = latest.revisionCreateTime;
    return this.sendJson(res, 200, cleanSchema(schema));
  }

  deleteSchema(res, name) {
    const { base } = splitRevision(name);
    if (!this.schemas.has(base)) {
      throw new PubsubError(GRPC.NOT_FOUND, `Schema not found: ${base}`);
    }
    this.schemas.delete(base);
    return this.sendJson(res, 200, {});
  }

  validateSchema(res, parent, body) {
    const schema = body.schema || {};
    const def = schema.definition;
    const type = normSchemaType(schema.type);
    if (!def) throw new PubsubError(GRPC.INVALID_ARGUMENT, "definition is required");
    this._validateSchemaDefinition(type, def);
    return this.sendJson(res, 200, {});
  }

  validateMessage(res, parent, body) {
    // Resolve the schema either by name or inline.
    let type, def;
    if (body.name) {
      const { base } = splitRevision(body.name);
      const schema = this.schemas.get(base);
      if (!schema) throw new PubsubError(GRPC.NOT_FOUND, `Schema not found: ${base}`);
      type = schema.type;
      def = schema.definition;
    } else if (body.schema) {
      type = normSchemaType(body.schema.type);
      def = body.schema.definition;
    } else {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "name or schema is required");
    }
    const encoding = normEncoding(body.encoding);
    const raw = body.message;
    if (raw === undefined || raw === null) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "message is required");
    }
    // `message` is base64-encoded bytes in REST JSON.
    let decoded;
    try {
      decoded = Buffer.from(String(raw), "base64").toString("utf8");
    } catch {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "message could not be decoded");
    }
    // For our fake, a JSON-encoded payload must parse as JSON to be valid.
    if (encoding === "JSON" || encoding === "ENCODING_UNSPECIFIED") {
      try {
        JSON.parse(decoded);
      } catch {
        throw new PubsubError(
          GRPC.INVALID_ARGUMENT,
          "Message does not match the schema (invalid JSON)",
        );
      }
    }
    return this.sendJson(res, 200, {});
  }

  _validateSchemaDefinition(type, def) {
    if (type === "AVRO") {
      let parsed;
      try {
        parsed = JSON.parse(def);
      } catch {
        throw new PubsubError(GRPC.INVALID_ARGUMENT, "Invalid AVRO schema: not valid JSON");
      }
      if (!parsed || parsed.type !== "record" || !parsed.name || !Array.isArray(parsed.fields)) {
        throw new PubsubError(
          GRPC.INVALID_ARGUMENT,
          "Invalid AVRO schema: must be a record with a name and fields",
        );
      }
    } else if (type === "PROTOCOL_BUFFER") {
      if (!/\bmessage\s+\w+/.test(def)) {
        throw new PubsubError(
          GRPC.INVALID_ARGUMENT,
          "Invalid PROTOCOL_BUFFER schema: must declare a message",
        );
      }
    } else if (type === "TYPE_UNSPECIFIED") {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, "Schema type must be specified");
    }
  }

  // =========================================================================
  // IAM
  // =========================================================================
  getIamPolicy(res, resource) {
    this._assertResourceExists(resource);
    const policy = this.policies.get(resource) || { version: 1, etag: makeEtag(), bindings: [] };
    return this.sendJson(res, 200, policy);
  }

  setIamPolicy(res, resource, body) {
    this._assertResourceExists(resource);
    const incoming = body.policy || {};
    const policy = {
      version: incoming.version || 1,
      bindings: incoming.bindings || [],
      etag: makeEtag(),
    };
    this.policies.set(resource, policy);
    return this.sendJson(res, 200, policy);
  }

  testIamPermissions(res, resource, body) {
    this._assertResourceExists(resource);
    const permissions = body.permissions || [];
    // The fake grants every requested permission.
    return this.sendJson(res, 200, { permissions });
  }

  _assertResourceExists(resource) {
    if (this.topics.has(resource) || this.subscriptions.has(resource) || this.snapshots.has(resource)) {
      return;
    }
    throw new PubsubError(GRPC.NOT_FOUND, `Resource not found: ${resource}`);
  }

  // =========================================================================
  // Name validation helpers
  // =========================================================================
  _assertTopicName(name) {
    const m = name.match(/^projects\/[^/]+\/topics\/(.+)$/);
    if (!m || !isValidResourceId(m[1])) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, `Invalid topic name: ${name}`);
    }
  }

  _assertSubscriptionName(name) {
    const m = name.match(/^projects\/[^/]+\/subscriptions\/(.+)$/);
    if (!m || !isValidResourceId(m[1])) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, `Invalid subscription name: ${name}`);
    }
  }

  _assertSnapshotName(name) {
    const m = name.match(/^projects\/[^/]+\/snapshots\/(.+)$/);
    if (!m || !isValidResourceId(m[1])) {
      throw new PubsubError(GRPC.INVALID_ARGUMENT, `Invalid snapshot name: ${name}`);
    }
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    const data = JSON.stringify(obj);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(data);
  }

  sendError(res, grpcCode, message) {
    const httpStatus = GRPC_TO_HTTP[grpcCode] || 500;
    const status = GRPC_STATUS_NAME[grpcCode] || "UNKNOWN";
    const payload = {
      error: {
        code: httpStatus,
        message,
        status,
      },
    };
    res.statusCode = httpStatus;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
function nowTs() {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
}

function futureTs(seconds) {
  return new Date(Date.now() + seconds * 1000)
    .toISOString()
    .replace(/\.(\d{3})Z$/, ".$1000000Z");
}

function makeAckId() {
  return randomBytes(16).toString("base64").replace(/[+/=]/g, "");
}

function makeEtag() {
  return randomBytes(8).toString("base64");
}

function shortRev() {
  return randomUUID().slice(0, 8);
}

function fieldsOf(mask) {
  if (typeof mask === "string") return mask.split(",").map((s) => s.trim()).filter(Boolean);
  if (mask && Array.isArray(mask.paths)) return mask.paths;
  return [];
}

function splitRevision(name) {
  const at = name.lastIndexOf("@");
  if (at !== -1 && name.slice(at).indexOf("/") === -1) {
    return { base: name.slice(0, at), revisionId: name.slice(at + 1) };
  }
  return { base: name, revisionId: null };
}

// Stable pagination via pageSize + pageToken (token is the start offset).
function paginate(items, q) {
  const pageSize = parseInt(q.get("pageSize") || "0", 10) || 0;
  const startToken = q.get("pageToken");
  const start = startToken ? parseInt(Buffer.from(startToken, "base64").toString("utf8"), 10) || 0 : 0;
  if (pageSize <= 0) {
    return { page: items.slice(start), nextPageToken: null };
  }
  const page = items.slice(start, start + pageSize);
  const nextStart = start + pageSize;
  const nextPageToken =
    nextStart < items.length ? Buffer.from(String(nextStart), "utf8").toString("base64") : null;
  return { page, nextPageToken };
}

function cleanTopic(t) {
  return prune({
    name: t.name,
    labels: t.labels,
    messageStoragePolicy: t.messageStoragePolicy,
    kmsKeyName: t.kmsKeyName,
    schemaSettings: t.schemaSettings,
    messageRetentionDuration: t.messageRetentionDuration,
    satisfiesPzs: t.satisfiesPzs,
    state: t.state,
  });
}

function cleanSubscription(d) {
  return prune({
    name: d.name,
    topic: d.topic,
    pushConfig: d.pushConfig || {},
    bigqueryConfig: d.bigqueryConfig,
    cloudStorageConfig: d.cloudStorageConfig,
    ackDeadlineSeconds: d.ackDeadlineSeconds,
    retainAckedMessages: d.retainAckedMessages,
    messageRetentionDuration: d.messageRetentionDuration,
    labels: d.labels,
    enableMessageOrdering: d.enableMessageOrdering,
    expirationPolicy: d.expirationPolicy,
    filter: d.filter,
    deadLetterPolicy: d.deadLetterPolicy,
    retryPolicy: d.retryPolicy,
    detached: d.detached,
    enableExactlyOnceDelivery: d.enableExactlyOnceDelivery,
    state: d.state,
  });
}

function cleanSnapshot(s) {
  return prune({
    name: s.name,
    topic: s.topic,
    expireTime: s.expireTime,
    labels: s.labels,
  });
}

function cleanSchema(s, view) {
  const out = {
    name: s.name,
    type: s.type,
    revisionId: s.revisionId,
    revisionCreateTime: s.revisionCreateTime,
  };
  if (view !== "BASIC") {
    out.definition = s.definition;
  }
  return prune(out);
}

// Strip undefined values so JSON output matches the proto3-JSON wire format
// (absent optional fields are omitted).
function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export default PubsubServer;
