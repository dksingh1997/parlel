// parlel/servicebus — a lightweight, dependency-free fake of Azure Service Bus.
//
// Speaks the Azure Service Bus REST API
// (https://learn.microsoft.com/rest/api/servicebus/) so that application code
// can drive it over plain HTTP with zero cost and zero side effects. Pure
// Node.js, no external npm dependencies. State is in-memory and ephemeral
// (resettable via reset() or POST /_parlel/reset).
//
// The real `@azure/service-bus` SDK speaks AMQP 1.0 for the data plane; that
// binary framing is intentionally out of scope for a tiny in-process fake.
// Instead we implement Azure's documented HTTP/REST surface, which mirrors the
// same logical operations 1:1 (send / peek-lock receive / complete / abandon /
// renew-lock / dead-letter / defer / schedule, plus the full Atom-based
// management API for queues, topics, subscriptions and rules). Application code
// and agents can therefore exercise every Service Bus concept without a broker.
//
// ---------------------------------------------------------------------------
// Implemented endpoints
// ---------------------------------------------------------------------------
// Management (Atom+XML entities, application/atom+xml;type=entry):
//   PUT    /{queue}                                  CreateQueue
//   GET    /{queue}                                  GetQueue
//   DELETE /{queue}                                  DeleteQueue
//   PUT    /{topic}                                  CreateTopic
//   GET    /{topic}                                  GetTopic
//   DELETE /{topic}                                  DeleteTopic
//   PUT    /{topic}/subscriptions/{sub}              CreateSubscription
//   GET    /{topic}/subscriptions/{sub}              GetSubscription
//   DELETE /{topic}/subscriptions/{sub}              DeleteSubscription
//   PUT    /{topic}/subscriptions/{sub}/rules/{rule} CreateRule
//   GET    /{topic}/subscriptions/{sub}/rules/{rule} GetRule
//   GET    /{topic}/subscriptions/{sub}/rules        ListRules
//   DELETE /{topic}/subscriptions/{sub}/rules/{rule} DeleteRule
//   GET    /$Resources/Queues                        ListQueues
//   GET    /$Resources/Topics                        ListTopics
//   GET    /{topic}/subscriptions                    ListSubscriptions
//
// Runtime / messaging (BrokerProperties header carries metadata):
//   POST   /{queue|topic}/messages                   Send (single)
//   POST   /{queue|topic}/messages?...               SendBatch (vnd.microsoft.servicebus.json)
//   POST   /{queue|sub-path}/messages/head?timeout=N PeekLock receive
//   DELETE /{queue|sub-path}/messages/head?timeout=N ReceiveAndDelete
//   DELETE /{path}/messages/{seqOrMsgId}/{lockToken}  Complete
//   PUT    /{path}/messages/{seqOrMsgId}/{lockToken}  Unlock (abandon)
//   POST   /{path}/messages/{seqOrMsgId}/{lockToken}  RenewLock
//   (subscription receive path: /{topic}/subscriptions/{sub}/messages/...)
//
// Dead-letter queues are addressed by the conventional sub-path suffix
//   /$DeadLetterQueue  (e.g. /{queue}/$DeadLetterQueue/messages/head)

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const ATOM_NS = "http://www.w3.org/2005/Atom";
const SB_NS = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";

// ---------------------------------------------------------------------------
// Error type — carries the HTTP status + a Service Bus detail string.
// ---------------------------------------------------------------------------
class ServiceBusError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code; // textual code e.g. "MessagingEntityNotFound"
  }
}

const Errors = {
  notFound: (msg = "The messaging entity could not be found.") =>
    new ServiceBusError(404, "MessagingEntityNotFound", msg),
  conflict: (msg = "The messaging entity already exists.") =>
    new ServiceBusError(409, "MessagingEntityAlreadyExists", msg),
  badRequest: (msg = "The request is malformed.") =>
    new ServiceBusError(400, "BadRequest", msg),
  gone: (msg = "The lock supplied is invalid or has expired.") =>
    new ServiceBusError(410, "LockTokenNotFound", msg),
};

// ---------------------------------------------------------------------------
// Minimal XML helpers (no external deps).
// ---------------------------------------------------------------------------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Extract the text content of the first <tag>...</tag> (namespace-agnostic).
function xmlValue(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return undefined;
  return m[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

function parseBool(v, dflt) {
  if (v === undefined) return dflt;
  return String(v).toLowerCase() === "true";
}
function parseIntOr(v, dflt) {
  if (v === undefined) return dflt;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n;
}

// ISO-8601 duration round-trip is not needed for behavior; we store as given.
function durOr(v, dflt) {
  return v === undefined || v === "" ? dflt : v;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------
export class ServicebusServer {
  constructor(port = 4592, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.namespace = options.namespace || "parlel";
    this.server = null;
    this.reset();
  }

  reset() {
    // queues: Map<name, QueueEntity>
    this.queues = new Map();
    // topics: Map<name, TopicEntity{ subscriptions: Map<name, SubEntity> }>
    this.topics = new Map();
    this._seq = 0; // monotonic sequence number generator
  }

  nextSeq() {
    this._seq += 1;
    return this._seq;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (error instanceof ServiceBusError) {
            this.sendError(res, error.status, error.code, error.message);
          } else {
            this.sendError(res, 500, "InternalServerError", error.message || "internal error");
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
  // Response helpers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }

  sendXml(res, status, xml, extraHeaders = {}) {
    res.writeHead(status, {
      "Content-Type": 'application/atom+xml;type=entry;charset=utf-8',
      ...extraHeaders,
    });
    res.end(xml);
  }

  sendError(res, status, code, message) {
    // Azure returns an XML <Error><Code>..</Code><Detail>..</Detail></Error>.
    const xml =
      `<Error><Code>${status}</Code>` +
      `<Detail>${xmlEscape(code)}: ${xmlEscape(message || "")}</Detail></Error>`;
    res.writeHead(status, { "Content-Type": "application/xml;charset=utf-8" });
    res.end(xml);
  }

  sendEmpty(res, status, extraHeaders = {}) {
    res.writeHead(status, extraHeaders);
    res.end();
  }

  // -------------------------------------------------------------------------
  // Entity factories
  // -------------------------------------------------------------------------
  makeQueue(name, props = {}) {
    return {
      kind: "queue",
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      lockDuration: durOr(props.lockDuration, "PT30S"),
      maxSizeInMegabytes: parseIntOr(props.maxSizeInMegabytes, 1024),
      requiresDuplicateDetection: parseBool(props.requiresDuplicateDetection, false),
      requiresSession: parseBool(props.requiresSession, false),
      defaultMessageTimeToLive: durOr(props.defaultMessageTimeToLive, "P14D"),
      deadLetteringOnMessageExpiration: parseBool(props.deadLetteringOnMessageExpiration, false),
      duplicateDetectionHistoryTimeWindow: durOr(props.duplicateDetectionHistoryTimeWindow, "PT10M"),
      maxDeliveryCount: parseIntOr(props.maxDeliveryCount, 10),
      enableBatchedOperations: parseBool(props.enableBatchedOperations, true),
      status: props.status || "Active",
      forwardTo: props.forwardTo || "",
      enablePartitioning: parseBool(props.enablePartitioning, false),
      // runtime
      messages: [], // active messages
      locked: new Map(), // lockToken -> message (peek-locked)
      deadletter: [], // dead-letter queue messages
      scheduled: [], // scheduled (future) messages
      deferred: new Map(), // sequenceNumber -> message
    };
  }

  makeTopic(name, props = {}) {
    return {
      kind: "topic",
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      maxSizeInMegabytes: parseIntOr(props.maxSizeInMegabytes, 1024),
      requiresDuplicateDetection: parseBool(props.requiresDuplicateDetection, false),
      defaultMessageTimeToLive: durOr(props.defaultMessageTimeToLive, "P14D"),
      duplicateDetectionHistoryTimeWindow: durOr(props.duplicateDetectionHistoryTimeWindow, "PT10M"),
      enableBatchedOperations: parseBool(props.enableBatchedOperations, true),
      status: props.status || "Active",
      supportOrdering: parseBool(props.supportOrdering, true),
      enablePartitioning: parseBool(props.enablePartitioning, false),
      subscriptions: new Map(),
    };
  }

  makeSubscription(name, props = {}) {
    return {
      kind: "subscription",
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      lockDuration: durOr(props.lockDuration, "PT30S"),
      requiresSession: parseBool(props.requiresSession, false),
      defaultMessageTimeToLive: durOr(props.defaultMessageTimeToLive, "P14D"),
      deadLetteringOnMessageExpiration: parseBool(props.deadLetteringOnMessageExpiration, false),
      deadLetteringOnFilterEvaluationExceptions: parseBool(
        props.deadLetteringOnFilterEvaluationExceptions,
        true,
      ),
      maxDeliveryCount: parseIntOr(props.maxDeliveryCount, 10),
      enableBatchedOperations: parseBool(props.enableBatchedOperations, true),
      status: props.status || "Active",
      forwardTo: props.forwardTo || "",
      // a subscription has its own message store + a set of rules.
      rules: new Map(),
      messages: [],
      locked: new Map(),
      deadletter: [],
      deferred: new Map(),
    };
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = (req.method || "GET").toUpperCase();
    const pathname = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    // Internal parlel endpoints.
    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "servicebus",
        queues: this.queues.size,
        topics: this.topics.size,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/_parlel/dump" && method === "GET") {
      return this.sendJson(res, 200, {
        queues: [...this.queues.keys()],
        topics: [...this.topics.entries()].map(([n, t]) => ({
          name: n,
          subscriptions: [...t.subscriptions.keys()],
        })),
      });
    }

    const segments = pathname.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
      return this.sendJson(res, 200, { service: "parlel/servicebus" });
    }

    // ---- $Resources listing ----
    if (segments[0] === "$Resources") {
      if (method !== "GET") throw Errors.badRequest("Only GET supported on $Resources");
      if (segments[1] === "Queues") return this.listQueues(res);
      if (segments[1] === "Topics") return this.listTopics(res);
      throw Errors.notFound("Unknown resource collection");
    }

    // ---- Messaging routes: detect "/messages" segment ----
    const msgIdx = segments.indexOf("messages");
    if (msgIdx !== -1) {
      return this.routeMessaging(req, res, method, segments, msgIdx, q);
    }

    // ---- subscriptions listing: /{topic}/subscriptions (GET, no name) ----
    if (
      segments.length === 2 &&
      segments[1] === "subscriptions" &&
      method === "GET"
    ) {
      return this.listSubscriptions(res, segments[0]);
    }

    // ---- rules listing: /{topic}/subscriptions/{sub}/rules (GET, no name) ----
    if (
      segments.length === 4 &&
      segments[1] === "subscriptions" &&
      segments[3] === "rules" &&
      method === "GET"
    ) {
      return this.listRules(res, segments[0], segments[2]);
    }

    // ---- Rule routes: /{topic}/subscriptions/{sub}/rules/{rule} ----
    if (segments.length === 5 && segments[1] === "subscriptions" && segments[3] === "rules") {
      const [topic, , sub, , rule] = segments;
      const body = (await this.readBody(req)).toString("utf8");
      if (method === "PUT") return this.createRule(res, topic, sub, rule, body);
      if (method === "GET") return this.getRule(res, topic, sub, rule);
      if (method === "DELETE") return this.deleteRule(res, topic, sub, rule);
      throw Errors.badRequest("Unsupported method on rule");
    }

    // ---- Subscription routes: /{topic}/subscriptions/{sub} ----
    if (segments.length === 3 && segments[1] === "subscriptions") {
      const [topic, , sub] = segments;
      const body = (await this.readBody(req)).toString("utf8");
      if (method === "PUT") return this.createSubscription(res, topic, sub, body);
      if (method === "GET") return this.getSubscription(res, topic, sub);
      if (method === "DELETE") return this.deleteSubscription(res, topic, sub);
      throw Errors.badRequest("Unsupported method on subscription");
    }

    // ---- Queue / Topic routes: /{name} ----
    if (segments.length === 1) {
      const name = segments[0];
      const body = (await this.readBody(req)).toString("utf8");
      if (method === "PUT") return this.createEntity(res, name, body);
      if (method === "GET") return this.getEntity(res, name);
      if (method === "DELETE") return this.deleteEntity(res, name);
      throw Errors.badRequest("Unsupported method on entity");
    }

    throw Errors.notFound("Unrecognized path");
  }

  // =========================================================================
  // Management: create / get / delete queue or topic
  // =========================================================================
  createEntity(res, name, body) {
    // Decide queue vs topic from the body's description element.
    const isTopic = /<TopicDescription/i.test(body);
    const isQueue = /<QueueDescription/i.test(body);

    if (isTopic && !isQueue) {
      if (this.topics.has(name) || this.queues.has(name)) throw Errors.conflict();
      const props = this.parseTopicProps(body);
      const topic = this.makeTopic(name, props);
      this.topics.set(name, topic);
      return this.sendXml(res, 201, this.topicEntryXml(topic));
    }
    // default to queue (QueueDescription or empty body)
    if (this.queues.has(name) || this.topics.has(name)) throw Errors.conflict();
    const props = this.parseQueueProps(body);
    const queue = this.makeQueue(name, props);
    this.queues.set(name, queue);
    return this.sendXml(res, 201, this.queueEntryXml(queue));
  }

  getEntity(res, name) {
    if (this.queues.has(name)) {
      return this.sendXml(res, 200, this.queueEntryXml(this.queues.get(name)));
    }
    if (this.topics.has(name)) {
      return this.sendXml(res, 200, this.topicEntryXml(this.topics.get(name)));
    }
    throw Errors.notFound();
  }

  deleteEntity(res, name) {
    if (this.queues.delete(name) || this.topics.delete(name)) {
      return this.sendEmpty(res, 200);
    }
    throw Errors.notFound();
  }

  listQueues(res) {
    const entries = [...this.queues.values()].map((q) => this.queueEntryXml(q, true)).join("");
    return this.sendXml(res, 200, this.feedXml("Queues", entries), {
      "Content-Type": "application/atom+xml;type=feed;charset=utf-8",
    });
  }

  listTopics(res) {
    const entries = [...this.topics.values()].map((t) => this.topicEntryXml(t, true)).join("");
    return this.sendXml(res, 200, this.feedXml("Topics", entries), {
      "Content-Type": "application/atom+xml;type=feed;charset=utf-8",
    });
  }

  // =========================================================================
  // Management: subscriptions
  // =========================================================================
  createSubscription(res, topicName, subName, body) {
    const topic = this.topics.get(topicName);
    if (!topic) throw Errors.notFound("The topic does not exist.");
    if (topic.subscriptions.has(subName)) throw Errors.conflict();
    const props = this.parseSubscriptionProps(body);
    const sub = this.makeSubscription(subName, props);
    // every subscription starts with the default $Default TrueFilter rule.
    sub.rules.set("$Default", {
      name: "$Default",
      filterType: "TrueFilter",
      sqlExpression: "1=1",
      action: "",
      createdAt: new Date().toISOString(),
    });
    topic.subscriptions.set(subName, sub);
    return this.sendXml(res, 201, this.subscriptionEntryXml(topicName, sub));
  }

  getSubscription(res, topicName, subName) {
    const topic = this.topics.get(topicName);
    if (!topic) throw Errors.notFound("The topic does not exist.");
    const sub = topic.subscriptions.get(subName);
    if (!sub) throw Errors.notFound();
    return this.sendXml(res, 200, this.subscriptionEntryXml(topicName, sub));
  }

  deleteSubscription(res, topicName, subName) {
    const topic = this.topics.get(topicName);
    if (!topic) throw Errors.notFound("The topic does not exist.");
    if (!topic.subscriptions.delete(subName)) throw Errors.notFound();
    return this.sendEmpty(res, 200);
  }

  listSubscriptions(res, topicName) {
    const topic = this.topics.get(topicName);
    if (!topic) throw Errors.notFound("The topic does not exist.");
    const entries = [...topic.subscriptions.values()]
      .map((s) => this.subscriptionEntryXml(topicName, s, true))
      .join("");
    return this.sendXml(res, 200, this.feedXml("Subscriptions", entries), {
      "Content-Type": "application/atom+xml;type=feed;charset=utf-8",
    });
  }

  // =========================================================================
  // Management: rules
  // =========================================================================
  createRule(res, topicName, subName, ruleName, body) {
    const sub = this.requireSub(topicName, subName);
    if (sub.rules.has(ruleName)) throw Errors.conflict();
    const rule = this.parseRuleProps(ruleName, body);
    sub.rules.set(ruleName, rule);
    return this.sendXml(res, 201, this.ruleEntryXml(topicName, subName, rule));
  }

  getRule(res, topicName, subName, ruleName) {
    const sub = this.requireSub(topicName, subName);
    const rule = sub.rules.get(ruleName);
    if (!rule) throw Errors.notFound();
    return this.sendXml(res, 200, this.ruleEntryXml(topicName, subName, rule));
  }

  deleteRule(res, topicName, subName, ruleName) {
    const sub = this.requireSub(topicName, subName);
    if (!sub.rules.delete(ruleName)) throw Errors.notFound();
    return this.sendEmpty(res, 200);
  }

  listRules(res, topicName, subName) {
    const sub = this.requireSub(topicName, subName);
    const entries = [...sub.rules.values()]
      .map((r) => this.ruleEntryXml(topicName, subName, r, true))
      .join("");
    return this.sendXml(res, 200, this.feedXml("Rules", entries), {
      "Content-Type": "application/atom+xml;type=feed;charset=utf-8",
    });
  }

  requireSub(topicName, subName) {
    const topic = this.topics.get(topicName);
    if (!topic) throw Errors.notFound("The topic does not exist.");
    const sub = topic.subscriptions.get(subName);
    if (!sub) throw Errors.notFound("The subscription does not exist.");
    return sub;
  }

  // =========================================================================
  // Prop parsers
  // =========================================================================
  parseQueueProps(body) {
    if (!body) return {};
    return {
      lockDuration: xmlValue(body, "LockDuration"),
      maxSizeInMegabytes: xmlValue(body, "MaxSizeInMegabytes"),
      requiresDuplicateDetection: xmlValue(body, "RequiresDuplicateDetection"),
      requiresSession: xmlValue(body, "RequiresSession"),
      defaultMessageTimeToLive: xmlValue(body, "DefaultMessageTimeToLive"),
      deadLetteringOnMessageExpiration: xmlValue(body, "DeadLetteringOnMessageExpiration"),
      duplicateDetectionHistoryTimeWindow: xmlValue(body, "DuplicateDetectionHistoryTimeWindow"),
      maxDeliveryCount: xmlValue(body, "MaxDeliveryCount"),
      enableBatchedOperations: xmlValue(body, "EnableBatchedOperations"),
      status: xmlValue(body, "Status"),
      forwardTo: xmlValue(body, "ForwardTo"),
      enablePartitioning: xmlValue(body, "EnablePartitioning"),
    };
  }

  parseTopicProps(body) {
    if (!body) return {};
    return {
      maxSizeInMegabytes: xmlValue(body, "MaxSizeInMegabytes"),
      requiresDuplicateDetection: xmlValue(body, "RequiresDuplicateDetection"),
      defaultMessageTimeToLive: xmlValue(body, "DefaultMessageTimeToLive"),
      duplicateDetectionHistoryTimeWindow: xmlValue(body, "DuplicateDetectionHistoryTimeWindow"),
      enableBatchedOperations: xmlValue(body, "EnableBatchedOperations"),
      status: xmlValue(body, "Status"),
      supportOrdering: xmlValue(body, "SupportOrdering"),
      enablePartitioning: xmlValue(body, "EnablePartitioning"),
    };
  }

  parseSubscriptionProps(body) {
    if (!body) return {};
    return {
      lockDuration: xmlValue(body, "LockDuration"),
      requiresSession: xmlValue(body, "RequiresSession"),
      defaultMessageTimeToLive: xmlValue(body, "DefaultMessageTimeToLive"),
      deadLetteringOnMessageExpiration: xmlValue(body, "DeadLetteringOnMessageExpiration"),
      deadLetteringOnFilterEvaluationExceptions: xmlValue(
        body,
        "DeadLetteringOnFilterEvaluationExceptions",
      ),
      maxDeliveryCount: xmlValue(body, "MaxDeliveryCount"),
      enableBatchedOperations: xmlValue(body, "EnableBatchedOperations"),
      status: xmlValue(body, "Status"),
      forwardTo: xmlValue(body, "ForwardTo"),
    };
  }

  parseRuleProps(ruleName, body) {
    const rule = {
      name: ruleName,
      filterType: "TrueFilter",
      sqlExpression: "1=1",
      correlationId: undefined,
      action: "",
      createdAt: new Date().toISOString(),
    };
    if (!body) return rule;
    if (/CorrelationFilter/i.test(body)) {
      rule.filterType = "CorrelationFilter";
      rule.correlationId = xmlValue(body, "CorrelationId");
      rule.label = xmlValue(body, "Label");
    } else if (/SqlFilter/i.test(body) || /FalseFilter/i.test(body) || /TrueFilter/i.test(body)) {
      if (/FalseFilter/i.test(body)) {
        rule.filterType = "FalseFilter";
        rule.sqlExpression = "1=0";
      } else if (/TrueFilter/i.test(body)) {
        rule.filterType = "TrueFilter";
        rule.sqlExpression = "1=1";
      } else {
        rule.filterType = "SqlFilter";
      }
      const expr = xmlValue(body, "SqlExpression");
      if (expr !== undefined) rule.sqlExpression = expr;
    }
    const action = xmlValue(body, "Action") ;
    // Action SqlExpression nests inside <Action>; capture the inner expression.
    if (/<Action/i.test(body)) {
      const actionBlock = body.match(/<Action[\s\S]*?<\/Action>/i);
      if (actionBlock) {
        const a = xmlValue(actionBlock[0], "SqlExpression");
        if (a !== undefined) rule.action = a;
      }
    }
    return rule;
  }

  // =========================================================================
  // XML serializers
  // =========================================================================
  feedXml(title, entries) {
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<feed xmlns="${ATOM_NS}"><title type="text">${title}</title>` +
      `<updated>${new Date().toISOString()}</updated>${entries}</feed>`
    );
  }

  wrapEntry(title, contentXml, asFeedEntry) {
    const now = new Date().toISOString();
    const inner =
      `<title type="text">${xmlEscape(title)}</title>` +
      `<updated>${now}</updated>` +
      `<content type="application/xml">${contentXml}</content>`;
    if (asFeedEntry) {
      return `<entry xmlns="${ATOM_NS}">${inner}</entry>`;
    }
    return `<?xml version="1.0" encoding="utf-8"?><entry xmlns="${ATOM_NS}">${inner}</entry>`;
  }

  queueEntryXml(q, asFeedEntry = false) {
    const d =
      `<QueueDescription xmlns="${SB_NS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
      `<LockDuration>${q.lockDuration}</LockDuration>` +
      `<MaxSizeInMegabytes>${q.maxSizeInMegabytes}</MaxSizeInMegabytes>` +
      `<RequiresDuplicateDetection>${q.requiresDuplicateDetection}</RequiresDuplicateDetection>` +
      `<RequiresSession>${q.requiresSession}</RequiresSession>` +
      `<DefaultMessageTimeToLive>${q.defaultMessageTimeToLive}</DefaultMessageTimeToLive>` +
      `<DeadLetteringOnMessageExpiration>${q.deadLetteringOnMessageExpiration}</DeadLetteringOnMessageExpiration>` +
      `<DuplicateDetectionHistoryTimeWindow>${q.duplicateDetectionHistoryTimeWindow}</DuplicateDetectionHistoryTimeWindow>` +
      `<MaxDeliveryCount>${q.maxDeliveryCount}</MaxDeliveryCount>` +
      `<EnableBatchedOperations>${q.enableBatchedOperations}</EnableBatchedOperations>` +
      `<SizeInBytes>0</SizeInBytes>` +
      `<MessageCount>${q.messages.length}</MessageCount>` +
      `<Status>${q.status}</Status>` +
      `<ForwardTo>${xmlEscape(q.forwardTo)}</ForwardTo>` +
      `<EnablePartitioning>${q.enablePartitioning}</EnablePartitioning>` +
      `<CountDetails>` +
      `<ActiveMessageCount>${q.messages.length}</ActiveMessageCount>` +
      `<DeadLetterMessageCount>${q.deadletter.length}</DeadLetterMessageCount>` +
      `<ScheduledMessageCount>${q.scheduled.length}</ScheduledMessageCount>` +
      `</CountDetails>` +
      `</QueueDescription>`;
    return this.wrapEntry(q.name, d, asFeedEntry);
  }

  topicEntryXml(t, asFeedEntry = false) {
    const d =
      `<TopicDescription xmlns="${SB_NS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
      `<MaxSizeInMegabytes>${t.maxSizeInMegabytes}</MaxSizeInMegabytes>` +
      `<RequiresDuplicateDetection>${t.requiresDuplicateDetection}</RequiresDuplicateDetection>` +
      `<DefaultMessageTimeToLive>${t.defaultMessageTimeToLive}</DefaultMessageTimeToLive>` +
      `<DuplicateDetectionHistoryTimeWindow>${t.duplicateDetectionHistoryTimeWindow}</DuplicateDetectionHistoryTimeWindow>` +
      `<EnableBatchedOperations>${t.enableBatchedOperations}</EnableBatchedOperations>` +
      `<SizeInBytes>0</SizeInBytes>` +
      `<Status>${t.status}</Status>` +
      `<SupportOrdering>${t.supportOrdering}</SupportOrdering>` +
      `<SubscriptionCount>${t.subscriptions.size}</SubscriptionCount>` +
      `<EnablePartitioning>${t.enablePartitioning}</EnablePartitioning>` +
      `</TopicDescription>`;
    return this.wrapEntry(t.name, d, asFeedEntry);
  }

  subscriptionEntryXml(topicName, s, asFeedEntry = false) {
    const total = s.messages.length;
    const d =
      `<SubscriptionDescription xmlns="${SB_NS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
      `<LockDuration>${s.lockDuration}</LockDuration>` +
      `<RequiresSession>${s.requiresSession}</RequiresSession>` +
      `<DefaultMessageTimeToLive>${s.defaultMessageTimeToLive}</DefaultMessageTimeToLive>` +
      `<DeadLetteringOnMessageExpiration>${s.deadLetteringOnMessageExpiration}</DeadLetteringOnMessageExpiration>` +
      `<DeadLetteringOnFilterEvaluationExceptions>${s.deadLetteringOnFilterEvaluationExceptions}</DeadLetteringOnFilterEvaluationExceptions>` +
      `<MessageCount>${total}</MessageCount>` +
      `<MaxDeliveryCount>${s.maxDeliveryCount}</MaxDeliveryCount>` +
      `<EnableBatchedOperations>${s.enableBatchedOperations}</EnableBatchedOperations>` +
      `<Status>${s.status}</Status>` +
      `<ForwardTo>${xmlEscape(s.forwardTo)}</ForwardTo>` +
      `<CountDetails>` +
      `<ActiveMessageCount>${s.messages.length}</ActiveMessageCount>` +
      `<DeadLetterMessageCount>${s.deadletter.length}</DeadLetterMessageCount>` +
      `</CountDetails>` +
      `</SubscriptionDescription>`;
    return this.wrapEntry(s.name, d, asFeedEntry);
  }

  ruleEntryXml(topicName, subName, r, asFeedEntry = false) {
    let filterXml;
    if (r.filterType === "CorrelationFilter") {
      filterXml =
        `<Filter i:type="CorrelationFilter">` +
        (r.correlationId !== undefined
          ? `<CorrelationId>${xmlEscape(r.correlationId)}</CorrelationId>`
          : "") +
        (r.label !== undefined ? `<Label>${xmlEscape(r.label)}</Label>` : "") +
        `</Filter>`;
    } else {
      filterXml =
        `<Filter i:type="SqlFilter">` +
        `<SqlExpression>${xmlEscape(r.sqlExpression)}</SqlExpression>` +
        `<CompatibilityLevel>20</CompatibilityLevel>` +
        `</Filter>`;
    }
    const actionXml = r.action
      ? `<Action i:type="SqlRuleAction"><SqlExpression>${xmlEscape(r.action)}</SqlExpression></Action>`
      : `<Action i:type="EmptyRuleAction"/>`;
    const d =
      `<RuleDescription xmlns="${SB_NS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
      filterXml +
      actionXml +
      `<Name>${xmlEscape(r.name)}</Name>` +
      `</RuleDescription>`;
    return this.wrapEntry(r.name, d, asFeedEntry);
  }

  // =========================================================================
  // Messaging routes
  // =========================================================================
  // Resolve the runtime "container" for a path's segments leading up to
  // "messages". Supports:
  //   queue                          -> queue
  //   queue/$DeadLetterQueue         -> queue (deadletter view)
  //   topic/subscriptions/sub        -> subscription
  //   topic/subscriptions/sub/$DeadLetterQueue -> subscription (deadletter)
  resolveContainer(prefixSegs) {
    let deadletter = false;
    let segs = [...prefixSegs];
    if (segs[segs.length - 1] === "$DeadLetterQueue") {
      deadletter = true;
      segs = segs.slice(0, -1);
    }
    if (segs.length === 1) {
      const queue = this.queues.get(segs[0]);
      if (!queue) throw Errors.notFound();
      return { container: queue, deadletter };
    }
    if (segs.length === 3 && segs[1] === "subscriptions") {
      const sub = this.requireSub(segs[0], segs[2]);
      return { container: sub, deadletter };
    }
    throw Errors.notFound("Unrecognized messaging path");
  }

  async routeMessaging(req, res, method, segments, msgIdx, q) {
    const prefix = segments.slice(0, msgIdx);
    const tail = segments.slice(msgIdx + 1); // after "messages"

    // POST /{entity}/messages  -> Send
    if (tail.length === 0 && method === "POST") {
      const body = await this.readBody(req);
      return this.sendMessage(req, res, prefix, body, q);
    }

    // {entity}/messages/head -> receive (peek-lock POST, receive-delete DELETE)
    if (tail.length === 1 && tail[0] === "head") {
      const { container, deadletter } = this.resolveContainer(prefix);
      const timeout = parseIntOr(q.get("timeout"), 60);
      if (method === "POST") {
        return this.receivePeekLock(res, container, deadletter, timeout);
      }
      if (method === "DELETE") {
        return this.receiveAndDelete(res, container, deadletter, timeout);
      }
      throw Errors.badRequest("Unsupported method on messages/head");
    }

    // {entity}/messages/{seqOrId}/{lockToken} -> complete/abandon/renew/deadletter/defer
    if (tail.length === 2) {
      const { container, deadletter } = this.resolveContainer(prefix);
      const [msgRef, lockToken] = tail;
      // The disposition for a PUT is selected by a header or ?disposition= query
      // param: abandon (default), deadletter, defer. (Azure encodes this in the
      // request; we accept either a header or the query string for ergonomics.)
      const disposition = (
        req.headers["disposition"] ||
        q.get("disposition") ||
        "abandon"
      ).toString().toLowerCase();
      if (method === "DELETE") {
        return this.completeMessage(res, container, deadletter, msgRef, lockToken);
      }
      if (method === "PUT") {
        if (disposition === "deadletter") {
          let reason = req.headers["deadletterreason"];
          return this.deadLetterMessage(res, container, deadletter, msgRef, lockToken, reason);
        }
        if (disposition === "defer") {
          return this.deferMessage(res, container, deadletter, msgRef, lockToken);
        }
        return this.abandonMessage(res, container, deadletter, msgRef, lockToken);
      }
      if (method === "POST") {
        return this.renewLock(res, container, deadletter, msgRef, lockToken);
      }
      throw Errors.badRequest("Unsupported method on locked message");
    }

    // {entity}/messages/{sequenceNumber} -> receive a deferred message by seq.
    if (tail.length === 1 && tail[0] !== "head" && method === "POST") {
      const { container, deadletter } = this.resolveContainer(prefix);
      return this.receiveDeferred(res, container, deadletter, tail[0]);
    }

    throw Errors.notFound("Unrecognized messaging path");
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------
  sendMessage(req, res, prefix, body, q) {
    // prefix is [queue] or [topic, subscriptions, sub] (sending to a sub is
    // invalid — you send to topics/queues). We only resolve queue/topic here.
    if (prefix.length !== 1) throw Errors.badRequest("Can only send to a queue or topic");
    const name = prefix[0];
    const queue = this.queues.get(name);
    const topic = this.topics.get(name);
    if (!queue && !topic) throw Errors.notFound();

    const contentType = (req.headers["content-type"] || "").toLowerCase();
    const isBatch = contentType.includes("vnd.microsoft.servicebus.json");

    let brokerProps = {};
    const bpHeader = req.headers["brokerproperties"];
    if (bpHeader) {
      try {
        brokerProps = JSON.parse(bpHeader);
      } catch {
        throw Errors.badRequest("Invalid BrokerProperties header JSON");
      }
    }

    // Custom (application) properties: any header that is not standard.
    const customProps = this.extractCustomProps(req.headers);

    if (isBatch) {
      let arr;
      try {
        arr = JSON.parse(body.toString("utf8"));
      } catch {
        throw Errors.badRequest("Invalid batch JSON");
      }
      if (!Array.isArray(arr)) throw Errors.badRequest("Batch body must be an array");
      for (const item of arr) {
        const props = item.BrokerProperties || {};
        const userProps = item.UserProperties || {};
        const data = item.Body !== undefined ? Buffer.from(String(item.Body)) : Buffer.alloc(0);
        this.enqueueSend(queue, topic, props, userProps, data);
      }
      return this.sendEmpty(res, 201);
    }

    const msg = this.enqueueSend(queue, topic, brokerProps, customProps, body);
    return this.sendEmpty(res, 201, {
      "BrokerProperties": JSON.stringify({
        MessageId: msg.messageId,
        SequenceNumber: msg.sequenceNumber,
      }),
    });
  }

  enqueueSend(queue, topic, brokerProps, customProps, dataBuf) {
    const msg = this.buildMessage(brokerProps, customProps, dataBuf);
    // Scheduled?
    const enqueueTime = brokerProps.ScheduledEnqueueTimeUtc
      ? Date.parse(brokerProps.ScheduledEnqueueTimeUtc)
      : 0;
    if (queue) {
      if (enqueueTime && enqueueTime > Date.now()) {
        queue.scheduled.push({ ...msg, scheduledFor: enqueueTime });
      } else {
        queue.messages.push(msg);
      }
    } else if (topic) {
      // Fan out to every subscription whose rules match.
      for (const sub of topic.subscriptions.values()) {
        if (this.subscriptionMatches(sub, msg)) {
          // each subscription gets its own copy with its own delivery state.
          sub.messages.push(this.cloneMessage(msg));
        }
      }
    }
    return msg;
  }

  buildMessage(brokerProps, customProps, dataBuf) {
    const messageId = brokerProps.MessageId || randomUUID();
    return {
      sequenceNumber: this.nextSeq(),
      messageId,
      lockToken: null,
      lockedUntil: 0,
      deliveryCount: 0,
      body: Buffer.isBuffer(dataBuf) ? dataBuf : Buffer.from(String(dataBuf || "")),
      properties: {
        MessageId: messageId,
        CorrelationId: brokerProps.CorrelationId,
        SessionId: brokerProps.SessionId,
        Label: brokerProps.Label,
        Subject: brokerProps.Label,
        ReplyTo: brokerProps.ReplyTo,
        ReplyToSessionId: brokerProps.ReplyToSessionId,
        To: brokerProps.To,
        ContentType: brokerProps.ContentType,
        PartitionKey: brokerProps.PartitionKey,
        TimeToLive: brokerProps.TimeToLive,
        ScheduledEnqueueTimeUtc: brokerProps.ScheduledEnqueueTimeUtc,
        EnqueuedTimeUtc: new Date().toUTCString(),
      },
      userProperties: { ...customProps },
      enqueuedAt: Date.now(),
    };
  }

  cloneMessage(msg) {
    return {
      ...msg,
      sequenceNumber: this.nextSeq(),
      lockToken: null,
      lockedUntil: 0,
      deliveryCount: 0,
      body: Buffer.from(msg.body),
      properties: { ...msg.properties },
      userProperties: { ...msg.userProperties },
    };
  }

  // SQL-ish rule matching against userProperties + system Label/CorrelationId.
  subscriptionMatches(sub, msg) {
    if (sub.rules.size === 0) return false;
    for (const rule of sub.rules.values()) {
      if (this.ruleMatches(rule, msg)) return true;
    }
    return false;
  }

  ruleMatches(rule, msg) {
    if (rule.filterType === "TrueFilter") return true;
    if (rule.filterType === "FalseFilter") return false;
    if (rule.filterType === "CorrelationFilter") {
      if (rule.correlationId !== undefined && rule.correlationId !== "") {
        if (msg.properties.CorrelationId !== rule.correlationId) return false;
      }
      if (rule.label !== undefined && rule.label !== "") {
        if (msg.properties.Label !== rule.label) return false;
      }
      return true;
    }
    // SqlFilter — support a useful subset: "prop = 'value'", "prop = N",
    // "prop > N", AND/OR, and "1=1"/"1=0".
    return this.evalSql(rule.sqlExpression, msg);
  }

  evalSql(expr, msg) {
    if (!expr) return true;
    const e = expr.trim();
    if (e === "1=1") return true;
    if (e === "1=0") return false;
    // Split on AND / OR (left-to-right, AND binds first crudely).
    if (/\bOR\b/i.test(e)) {
      return e.split(/\bOR\b/i).some((p) => this.evalSql(p, msg));
    }
    if (/\bAND\b/i.test(e)) {
      return e.split(/\bAND\b/i).every((p) => this.evalSql(p, msg));
    }
    const m = e.match(/^\s*([\w.]+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+?)\s*$/);
    if (!m) return true; // unknown expression -> permissive
    const [, lhsRaw, op, rhsRaw] = m;
    const lhs = this.lookupProp(lhsRaw, msg);
    let rhs = rhsRaw;
    let lhsVal = lhs;
    if (/^'.*'$/.test(rhs)) {
      rhs = rhs.slice(1, -1);
    } else if (!Number.isNaN(Number(rhs))) {
      rhs = Number(rhs);
      lhsVal = lhs === undefined ? undefined : Number(lhs);
    }
    switch (op) {
      case "=":
        return String(lhsVal) === String(rhs);
      case "!=":
      case "<>":
        return String(lhsVal) !== String(rhs);
      case ">":
        return Number(lhsVal) > Number(rhs);
      case "<":
        return Number(lhsVal) < Number(rhs);
      case ">=":
        return Number(lhsVal) >= Number(rhs);
      case "<=":
        return Number(lhsVal) <= Number(rhs);
      default:
        return false;
    }
  }

  lookupProp(name, msg) {
    const n = name.replace(/^sys\./i, "");
    if (msg.userProperties && n in msg.userProperties) return msg.userProperties[n];
    // system property aliases
    const sys = {
      Label: msg.properties.Label,
      CorrelationId: msg.properties.CorrelationId,
      MessageId: msg.properties.MessageId,
      SessionId: msg.properties.SessionId,
      To: msg.properties.To,
      ReplyTo: msg.properties.ReplyTo,
      ContentType: msg.properties.ContentType,
    };
    if (n in sys) return sys[n];
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Custom property extraction from headers
  // -------------------------------------------------------------------------
  extractCustomProps(headers) {
    const standard = new Set([
      "host", "content-type", "content-length", "brokerproperties",
      "authorization", "connection", "accept", "accept-encoding",
      "user-agent", "date", "transfer-encoding", "expect",
    ]);
    const props = {};
    for (const [k, v] of Object.entries(headers)) {
      if (standard.has(k.toLowerCase())) continue;
      if (k.toLowerCase().startsWith("x-")) continue;
      // Azure custom properties may be JSON-quoted; strip surrounding quotes.
      let val = Array.isArray(v) ? v[0] : v;
      if (typeof val === "string" && /^".*"$/.test(val)) val = val.slice(1, -1);
      props[k] = val;
    }
    return props;
  }

  // -------------------------------------------------------------------------
  // Receive: peek-lock
  // -------------------------------------------------------------------------
  activeList(container, deadletter) {
    return deadletter ? container.deadletter : container.messages;
  }

  promoteScheduled(container) {
    if (!container.scheduled || container.scheduled.length === 0) return;
    const now = Date.now();
    const ready = [];
    container.scheduled = container.scheduled.filter((m) => {
      if (m.scheduledFor <= now) {
        ready.push(m);
        return false;
      }
      return true;
    });
    for (const m of ready) container.messages.push(m);
  }

  reclaimExpiredLocks(container) {
    const now = Date.now();
    for (const [token, msg] of [...container.locked.entries()]) {
      if (msg.lockedUntil && msg.lockedUntil <= now) {
        container.locked.delete(token);
        msg.lockToken = null;
        msg.lockedUntil = 0;
        container.messages.unshift(msg);
      }
    }
  }

  receivePeekLock(res, container, deadletter, _timeout) {
    if (!deadletter) {
      this.promoteScheduled(container);
      this.reclaimExpiredLocks(container);
    }
    const list = this.activeList(container, deadletter);
    if (list.length === 0) {
      return this.sendEmpty(res, 204); // no message
    }
    const msg = list.shift();
    const lockToken = randomUUID();
    msg.lockToken = lockToken;
    msg.deliveryCount += 1;
    const lockMs = 30000;
    msg.lockedUntil = Date.now() + lockMs;
    if (!deadletter) {
      container.locked.set(lockToken, msg);
    } else {
      // dead-letter peek-lock: track in a side map keyed on token too.
      container.locked.set(lockToken, msg);
      msg._fromDeadletter = true;
    }
    return this.writeMessageResponse(res, container, msg, lockToken, deadletter);
  }

  receiveAndDelete(res, container, deadletter, _timeout) {
    if (!deadletter) {
      this.promoteScheduled(container);
      this.reclaimExpiredLocks(container);
    }
    const list = this.activeList(container, deadletter);
    if (list.length === 0) {
      return this.sendEmpty(res, 204);
    }
    const msg = list.shift();
    msg.deliveryCount += 1;
    return this.writeMessageResponse(res, container, msg, null, deadletter);
  }

  writeMessageResponse(res, container, msg, lockToken, deadletter) {
    const bp = {
      MessageId: msg.properties.MessageId,
      SequenceNumber: msg.sequenceNumber,
      DeliveryCount: msg.deliveryCount,
      EnqueuedTimeUtc: msg.properties.EnqueuedTimeUtc,
      State: "Active",
    };
    if (msg.properties.CorrelationId !== undefined) bp.CorrelationId = msg.properties.CorrelationId;
    if (msg.properties.SessionId !== undefined) bp.SessionId = msg.properties.SessionId;
    if (msg.properties.Label !== undefined) bp.Label = msg.properties.Label;
    if (msg.properties.ReplyTo !== undefined) bp.ReplyTo = msg.properties.ReplyTo;
    if (msg.properties.To !== undefined) bp.To = msg.properties.To;
    if (msg.properties.ContentType !== undefined) bp.ContentType = msg.properties.ContentType;
    if (msg.properties.PartitionKey !== undefined) bp.PartitionKey = msg.properties.PartitionKey;
    if (lockToken) {
      bp.LockToken = lockToken;
      bp.LockedUntilUtc = new Date(msg.lockedUntil).toUTCString();
    }
    // remove undefined keys
    for (const k of Object.keys(bp)) if (bp[k] === undefined) delete bp[k];

    const headers = {
      "Content-Type": msg.properties.ContentType || "application/octet-stream",
      "BrokerProperties": JSON.stringify(bp),
    };
    // surface custom properties back as headers
    for (const [k, v] of Object.entries(msg.userProperties || {})) {
      headers[k] = typeof v === "string" ? `"${v}"` : JSON.stringify(v);
    }
    let location = "";
    if (lockToken) {
      const base = this.containerPath(container, deadletter);
      location = `${base}/messages/${msg.sequenceNumber}/${lockToken}`;
      headers["Location"] = location;
    }
    res.writeHead(lockToken ? 201 : 200, headers);
    res.end(msg.body);
  }

  containerPath(container, deadletter) {
    let base;
    if (container.kind === "queue") {
      base = `/${container.name}`;
    } else {
      // subscription: need its topic. Find it.
      base = `/${this.findTopicForSub(container)}/subscriptions/${container.name}`;
    }
    if (deadletter) base += "/$DeadLetterQueue";
    return base;
  }

  findTopicForSub(sub) {
    for (const [tName, t] of this.topics.entries()) {
      for (const s of t.subscriptions.values()) {
        if (s === sub) return tName;
      }
    }
    return "unknown";
  }

  // -------------------------------------------------------------------------
  // Complete / abandon / renew / dead-letter
  // -------------------------------------------------------------------------
  findLocked(container, msgRef, lockToken) {
    const msg = container.locked.get(lockToken);
    if (!msg) return null;
    // msgRef may be sequenceNumber or messageId; accept either.
    if (String(msg.sequenceNumber) !== String(msgRef) &&
        String(msg.properties.MessageId) !== String(msgRef)) {
      // Still allow if token matches (Azure keys on token).
    }
    return msg;
  }

  completeMessage(res, container, deadletter, msgRef, lockToken) {
    const msg = this.findLocked(container, msgRef, lockToken);
    if (!msg) throw Errors.gone();
    container.locked.delete(lockToken);
    // message is permanently removed (completed).
    return this.sendEmpty(res, 200);
  }

  abandonMessage(res, container, deadletter, msgRef, lockToken) {
    const msg = this.findLocked(container, msgRef, lockToken);
    if (!msg) throw Errors.gone();
    container.locked.delete(lockToken);
    msg.lockToken = null;
    msg.lockedUntil = 0;
    // If max delivery exceeded, dead-letter it.
    const maxDelivery = container.maxDeliveryCount || 10;
    if (!deadletter && msg.deliveryCount >= maxDelivery) {
      msg.properties.DeadLetterReason = "MaxDeliveryCountExceeded";
      container.deadletter.push(msg);
    } else {
      // return to front of the active list it came from.
      const list = deadletter ? container.deadletter : container.messages;
      list.unshift(msg);
    }
    return this.sendEmpty(res, 200);
  }

  renewLock(res, container, deadletter, msgRef, lockToken) {
    const msg = this.findLocked(container, msgRef, lockToken);
    if (!msg) throw Errors.gone();
    msg.lockedUntil = Date.now() + 30000;
    return this.sendEmpty(res, 200, {
      "BrokerProperties": JSON.stringify({
        LockToken: lockToken,
        LockedUntilUtc: new Date(msg.lockedUntil).toUTCString(),
      }),
    });
  }

  // Explicitly dead-letter a locked message (SDK: deadLetterMessage()).
  deadLetterMessage(res, container, deadletter, msgRef, lockToken, reason) {
    const msg = this.findLocked(container, msgRef, lockToken);
    if (!msg) throw Errors.gone();
    container.locked.delete(lockToken);
    msg.lockToken = null;
    msg.lockedUntil = 0;
    msg.properties.DeadLetterReason =
      (Array.isArray(reason) ? reason[0] : reason) || "DeadLetteredBySender";
    if (container.deadletter) container.deadletter.push(msg);
    return this.sendEmpty(res, 200);
  }

  // Defer a locked message (SDK: deferMessage()). It can only be retrieved
  // afterwards by its sequence number.
  deferMessage(res, container, deadletter, msgRef, lockToken) {
    const msg = this.findLocked(container, msgRef, lockToken);
    if (!msg) throw Errors.gone();
    container.locked.delete(lockToken);
    msg.lockToken = null;
    msg.lockedUntil = 0;
    if (container.deferred) container.deferred.set(String(msg.sequenceNumber), msg);
    return this.sendEmpty(res, 200);
  }

  // Receive a previously-deferred message by sequence number
  // (SDK: receiveDeferredMessages()). Peek-locks it again.
  receiveDeferred(res, container, deadletter, seq) {
    if (!container.deferred || !container.deferred.has(String(seq))) {
      return this.sendEmpty(res, 204);
    }
    const msg = container.deferred.get(String(seq));
    container.deferred.delete(String(seq));
    const lockToken = randomUUID();
    msg.lockToken = lockToken;
    msg.deliveryCount += 1;
    msg.lockedUntil = Date.now() + 30000;
    container.locked.set(lockToken, msg);
    return this.writeMessageResponse(res, container, msg, lockToken, deadletter);
  }
}

// Allow `node server.js` to run a standalone instance.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PORT || "4592", 10);
  const server = new ServicebusServer(port);
  server.start().then(() => {
    // eslint-disable-next-line no-console
    console.log(`parlel/servicebus listening on http://127.0.0.1:${port}`);
  });
}
