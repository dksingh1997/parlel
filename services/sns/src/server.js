// parlel/sns — a lightweight, dependency-free fake of AWS SNS.
//
// Speaks the AWS Query wire protocol (protocol version 2010-03-31) so that
// application code using the real `@aws-sdk/client-sns` client can run against
// it with zero cost and zero side effects. Pure Node.js, no external npm
// dependencies. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-sns v3):
//   * Requests are POST / with `Content-Type: application/x-www-form-urlencoded`.
//     The body carries `Action=<Operation>&Version=2010-03-31&...flattened params`.
//   * Lists are flattened as `<Name>.member.<n>.<...>`; maps (e.g. Attributes,
//     Tags) as `<Name>.entry.<n>.{key,value}` or `<Name>.entry.<n>.{Name,Value}`.
//   * Success: 200, XML `<XxxResponse xmlns="...">`
//       `<XxxResult>...</XxxResult>`
//       `<ResponseMetadata><RequestId>...</RequestId></ResponseMetadata>`
//     `</XxxResponse>`.
//   * Error: non-2xx, XML `<ErrorResponse xmlns="...">`
//       `<Error><Type>Sender|Receiver</Type><Code>...</Code><Message>...</Message></Error>`
//       `<RequestId>...</RequestId></ErrorResponse>`.

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const SNS_NAMESPACE = "http://sns.amazonaws.com/doc/2010-03-31/";
const API_VERSION = "2010-03-31";
const DEFAULT_ACCOUNT_ID = "000000000000";

// SNS error codes -> HTTP status. (Sender == client fault, Receiver == server.)
const ERROR_STATUS = {
  AuthorizationError: 403,
  AuthorizationErrorException: 403,
  EndpointDisabled: 400,
  EndpointDisabledException: 400,
  FilterPolicyLimitExceeded: 403,
  FilterPolicyLimitExceededException: 403,
  InternalError: 500,
  InternalErrorException: 500,
  InvalidParameter: 400,
  InvalidParameterException: 400,
  ParameterValueInvalid: 400,
  InvalidParameterValue: 400,
  InvalidSecurity: 403,
  KMSAccessDenied: 400,
  KMSDisabled: 400,
  KMSInvalidState: 400,
  KMSNotFound: 400,
  KMSOptInRequired: 403,
  KMSThrottling: 400,
  NotFound: 404,
  NotFoundException: 404,
  ResourceNotFound: 404,
  ResourceNotFoundException: 404,
  PlatformApplicationDisabled: 400,
  PlatformApplicationDisabledException: 400,
  StaleTag: 400,
  StaleTagException: 400,
  SubscriptionLimitExceeded: 403,
  SubscriptionLimitExceededException: 403,
  TagLimitExceeded: 400,
  TagLimitExceededException: 400,
  TagPolicy: 400,
  TagPolicyException: 400,
  Throttled: 429,
  ThrottledException: 429,
  TopicLimitExceeded: 403,
  TopicLimitExceededException: 403,
  ConcurrentAccess: 400,
  ConcurrentAccessException: 400,
  ValidationError: 400,
  EmptyBatchRequest: 400,
  EmptyBatchRequestException: 400,
  TooManyEntriesInBatchRequest: 400,
  TooManyEntriesInBatchRequestException: 400,
  BatchEntryIdsNotDistinct: 400,
  BatchEntryIdsNotDistinctException: 400,
  BatchRequestTooLong: 400,
  BatchRequestTooLongException: 400,
  InvalidBatchEntryId: 400,
  InvalidBatchEntryIdException: 400,
  OptedOut: 400,
  UserError: 400,
  VerificationException: 400,
};

class SnsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Field names whose object values must be serialized as AWS query string maps
// (<entry><key/><value/></entry>) rather than as nested elements.
const MAP_FIELDS = new Set(["Attributes", "attributes"]);

// Serialize a JS value into XML nodes given a tag name.
//   * null/undefined -> omitted
//   * arrays -> repeated <tag><member>...</member></tag> wrapper
//   * map fields (Attributes/attributes) -> <tag><entry><key/><value/></entry></tag>
//   * other objects -> nested elements
function xmlNode(tag, value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    const members = value.map((v) => xmlNode("member", v)).join("");
    return `<${tag}>${members}</${tag}>`;
  }
  if (typeof value === "object") {
    if (MAP_FIELDS.has(tag)) {
      return xmlMap(tag, value);
    }
    const inner = Object.entries(value)
      .map(([k, v]) => xmlNode(k, v))
      .join("");
    return `<${tag}>${inner}</${tag}>`;
  }
  if (typeof value === "boolean") {
    return `<${tag}>${value ? "true" : "false"}</${tag}>`;
  }
  return `<${tag}>${xmlEscape(value)}</${tag}>`;
}

// Serialize a map (Attributes/Tags) as <tag><entry><key/><value/></entry>...</tag>.
function xmlMap(tag, map, keyName = "key", valueName = "value") {
  if (!map || Object.keys(map).length === 0) {
    return `<${tag}/>`;
  }
  const entries = Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(
      ([k, v]) =>
        `<entry><${keyName}>${xmlEscape(k)}</${keyName}><${valueName}>${xmlEscape(
          v,
        )}</${valueName}></entry>`,
    )
    .join("");
  return `<${tag}>${entries}</${tag}>`;
}

// ---------------------------------------------------------------------------
// AWS query form-encoded request parser
// ---------------------------------------------------------------------------
//
// Turns `A.member.1.Name=x&A.member.1.Value=y&A.member.2.Name=z` into a nested
// structure. Numeric path segments build arrays; everything else builds objects.

function parseForm(body) {
  const flat = {};
  const params = new URLSearchParams(body);
  for (const [key, value] of params.entries()) {
    flat[key] = value;
  }
  return unflatten(flat);
}

function unflatten(flat) {
  const root = {};
  for (const rawKey of Object.keys(flat)) {
    const value = flat[rawKey];
    const parts = rawKey.split(".");
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      if (last) {
        cursor[part] = value;
      } else {
        if (cursor[part] === undefined) cursor[part] = {};
        cursor = cursor[part];
      }
    }
  }
  return normalizeNode(root);
}

// Recursively convert objects whose keys are "member"/"entry"/numeric into
// the shapes SNS uses (arrays + key/value maps).
function normalizeNode(node) {
  if (node === null || typeof node !== "object") return node;

  const keys = Object.keys(node);

  // member-style list: { member: { "1": {...}, "2": {...} } }
  if (keys.length === 1 && (keys[0] === "member" || keys[0] === "entry")) {
    const container = node[keys[0]];
    const indices = Object.keys(container)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const list = indices.map((idx) => normalizeNode(container[idx]));
    if (keys[0] === "entry") {
      // Could be a key/value map.
      const asMap = entriesToMap(list);
      if (asMap) return asMap;
    }
    return list;
  }

  // Direct numeric-indexed list: { "1": {...}, "2": {...} }
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return keys
      .sort((a, b) => Number(a) - Number(b))
      .map((idx) => normalizeNode(node[idx]));
  }

  const out = {};
  for (const k of keys) {
    out[k] = normalizeNode(node[k]);
  }
  return out;
}

// If a list of objects all look like {key,value} or {Name,Value}, build a map.
function entriesToMap(list) {
  const map = {};
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const k =
      item.key !== undefined
        ? item.key
        : item.Key !== undefined
          ? item.Key
          : item.Name;
    const v =
      item.value !== undefined
        ? item.value
        : item.Value !== undefined
          ? item.Value
          : item.AttributeValue;
    if (k === undefined) return null;
    map[k] = v === undefined ? "" : v;
  }
  return map;
}

function md5Hex(input) {
  return createHash("md5").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class SnsServer {
  constructor(port = 4569, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    // Endpoint to deliver SQS / HTTP notifications to (optional, off by default).
    this.deliver = options.deliver || null;
    this.reset();
  }

  reset() {
    // topics: Map<topicArn, Topic>
    //   Topic = { arn, name, attributes:{}, tags:Map, displayName }
    this.topics = new Map();
    // subscriptions: Map<subscriptionArn, Subscription>
    this.subscriptions = new Map();
    // pending confirmations: Map<token, {topicArn, endpoint, protocol}>
    this.pendingConfirmations = new Map();
    // platform applications: Map<arn, {arn, name, platform, attributes}>
    this.platformApplications = new Map();
    // platform endpoints: Map<arn, {arn, applicationArn, token, attributes}>
    this.platformEndpoints = new Map();
    // SMS account-level attributes
    this.smsAttributes = {};
    // opted-out phone numbers
    this.optedOut = new Set();
    // SMS sandbox phone numbers: Map<phoneNumber, {status}>
    this.sandboxNumbers = new Map();
    this.sandboxAccountStatus = "Enabled"; // "InSandbox" | "Enabled"
    // data protection policies: Map<resourceArn, policyJson>
    this.dataProtectionPolicies = new Map();
    // captured published messages (for test assertions): array
    this.published = [];
    this.subscriptionCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new SnsError("InternalError", error.message, 500));
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

  topicArn(name) {
    return `arn:aws:sns:${this.region}:${this.accountId}:${name}`;
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    // Internal/health endpoints (not part of SNS).
    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "sns",
        topics: this.topics.size,
        subscriptions: this.subscriptions.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-sns");

    if (method !== "POST") {
      return this.sendError(
        res,
        new SnsError("InvalidParameter", "Only POST is supported by the parlel sns fake.", 405),
      );
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(
        res,
        new SnsError("InvalidParameter", "Request body could not be parsed.", 400),
      );
    }

    const operation = input.Action;
    try {
      const { result, resultTag } = this.dispatch(operation, input);
      return this.sendXml(res, 200, operation, resultTag, result);
    } catch (error) {
      if (error instanceof SnsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      // Topics
      CreateTopic: () => this.createTopic(input),
      DeleteTopic: () => this.deleteTopic(input),
      ListTopics: () => this.listTopics(input),
      GetTopicAttributes: () => this.getTopicAttributes(input),
      SetTopicAttributes: () => this.setTopicAttributes(input),
      // Subscriptions
      Subscribe: () => this.subscribe(input),
      Unsubscribe: () => this.unsubscribe(input),
      ConfirmSubscription: () => this.confirmSubscription(input),
      ListSubscriptions: () => this.listSubscriptions(input),
      ListSubscriptionsByTopic: () => this.listSubscriptionsByTopic(input),
      GetSubscriptionAttributes: () => this.getSubscriptionAttributes(input),
      SetSubscriptionAttributes: () => this.setSubscriptionAttributes(input),
      // Publishing
      Publish: () => this.publish(input),
      PublishBatch: () => this.publishBatch(input),
      // Permissions
      AddPermission: () => this.addPermission(input),
      RemovePermission: () => this.removePermission(input),
      // Tags
      TagResource: () => this.tagResource(input),
      UntagResource: () => this.untagResource(input),
      ListTagsForResource: () => this.listTagsForResource(input),
      // Data protection policy
      GetDataProtectionPolicy: () => this.getDataProtectionPolicy(input),
      PutDataProtectionPolicy: () => this.putDataProtectionPolicy(input),
      // SMS
      GetSMSAttributes: () => this.getSMSAttributes(input),
      SetSMSAttributes: () => this.setSMSAttributes(input),
      CheckIfPhoneNumberIsOptedOut: () => this.checkIfPhoneNumberIsOptedOut(input),
      OptInPhoneNumber: () => this.optInPhoneNumber(input),
      ListPhoneNumbersOptedOut: () => this.listPhoneNumbersOptedOut(input),
      ListOriginationNumbers: () => this.listOriginationNumbers(input),
      // SMS sandbox
      GetSMSSandboxAccountStatus: () => this.getSMSSandboxAccountStatus(input),
      CreateSMSSandboxPhoneNumber: () => this.createSMSSandboxPhoneNumber(input),
      VerifySMSSandboxPhoneNumber: () => this.verifySMSSandboxPhoneNumber(input),
      DeleteSMSSandboxPhoneNumber: () => this.deleteSMSSandboxPhoneNumber(input),
      ListSMSSandboxPhoneNumbers: () => this.listSMSSandboxPhoneNumbers(input),
      // Platform applications & endpoints (mobile push)
      CreatePlatformApplication: () => this.createPlatformApplication(input),
      DeletePlatformApplication: () => this.deletePlatformApplication(input),
      GetPlatformApplicationAttributes: () => this.getPlatformApplicationAttributes(input),
      SetPlatformApplicationAttributes: () => this.setPlatformApplicationAttributes(input),
      ListPlatformApplications: () => this.listPlatformApplications(input),
      CreatePlatformEndpoint: () => this.createPlatformEndpoint(input),
      DeleteEndpoint: () => this.deleteEndpoint(input),
      GetEndpointAttributes: () => this.getEndpointAttributes(input),
      SetEndpointAttributes: () => this.setEndpointAttributes(input),
      ListEndpointsByPlatformApplication: () => this.listEndpointsByPlatformApplication(input),
    };
    const handler = handlers[operation];
    if (!handler) {
      throw new SnsError(
        "InvalidAction",
        `The action ${operation || "(none)"} is not valid for this endpoint.`,
        400,
      );
    }
    return handler();
  }

  // -------------------------------------------------------------------------
  // Topics
  // -------------------------------------------------------------------------
  validateTopicName(name) {
    if (typeof name !== "string" || name.length === 0 || name.length > 256) {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: Topic Name",
      );
    }
    const fifo = name.endsWith(".fifo");
    const base = fifo ? name.slice(0, -5) : name;
    if (!/^[A-Za-z0-9_-]+$/.test(base)) {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: Topic Name - must be made up of only uppercase and lowercase ASCII letters, numbers, underscores, and hyphens, and must be between 1 and 256 characters long.",
      );
    }
    return fifo;
  }

  createTopic(input) {
    const name = input.Name;
    if (!name) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Topic Name");
    }
    const fifo = this.validateTopicName(name);
    const arn = this.topicArn(name);
    const attributes = input.Attributes || {};

    if (fifo && attributes.FifoTopic !== "true" && attributes.FifoTopic !== true) {
      // FIFO inferred from name suffix.
      attributes.FifoTopic = "true";
    }
    if (!fifo && (attributes.FifoTopic === "true" || attributes.FifoTopic === true)) {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: Name - FIFO topic names must end with .fifo",
      );
    }

    const existing = this.topics.get(arn);
    if (existing) {
      // Idempotent: same name returns same ARN.
      return { result: { TopicArn: arn }, resultTag: "CreateTopicResult" };
    }

    const tags = this.coerceTags(input.Tags);

    const topic = {
      arn,
      name,
      fifo,
      tags,
      attributes: {
        DisplayName: attributes.DisplayName || "",
        Policy:
          attributes.Policy ||
          JSON.stringify(this.defaultTopicPolicy(arn)),
        DeliveryPolicy: attributes.DeliveryPolicy || "",
        FifoTopic: fifo ? "true" : undefined,
        ContentBasedDeduplication: fifo
          ? attributes.ContentBasedDeduplication || "false"
          : undefined,
        KmsMasterKeyId: attributes.KmsMasterKeyId,
        SignatureVersion: attributes.SignatureVersion || "1",
        TracingConfig: attributes.TracingConfig,
      },
    };
    this.topics.set(arn, topic);
    return { result: { TopicArn: arn }, resultTag: "CreateTopicResult" };
  }

  defaultTopicPolicy(arn) {
    return {
      Version: "2008-10-17",
      Id: "__default_policy_ID",
      Statement: [
        {
          Sid: "__default_statement_ID",
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: [
            "SNS:Publish",
            "SNS:Subscribe",
            "SNS:GetTopicAttributes",
            "SNS:SetTopicAttributes",
          ],
          Resource: arn,
        },
      ],
    };
  }

  // Tags arrive either as a list of {Key,Value} (member-style) or as a map.
  coerceTags(input) {
    const tags = {};
    if (!input) return tags;
    if (Array.isArray(input)) {
      for (const t of input) {
        if (t && t.Key !== undefined) tags[t.Key] = t.Value ?? "";
      }
    } else if (typeof input === "object") {
      for (const [k, v] of Object.entries(input)) tags[k] = String(v);
    }
    return tags;
  }

  requireTopic(arn) {
    if (!arn) {
      throw new SnsError("InvalidParameter", "Invalid parameter: TopicArn Reason: An ARN must be specified");
    }
    const topic = this.topics.get(arn);
    if (!topic) {
      throw new SnsError("NotFound", "Topic does not exist", 404);
    }
    return topic;
  }

  deleteTopic(input) {
    const arn = input.TopicArn;
    if (!arn) {
      throw new SnsError("InvalidParameter", "Invalid parameter: TopicArn Reason: An ARN must be specified");
    }
    // SNS DeleteTopic is idempotent: deleting a missing topic still succeeds.
    this.topics.delete(arn);
    // Remove subscriptions to this topic.
    for (const [subArn, sub] of this.subscriptions) {
      if (sub.topicArn === arn) this.subscriptions.delete(subArn);
    }
    return { result: {}, resultTag: "DeleteTopicResult" };
  }

  listTopics(input) {
    const all = [...this.topics.keys()].sort();
    const { page, nextToken } = this.paginate(all, input.NextToken, 100);
    const result = {
      Topics: page.map((arn) => ({ TopicArn: arn })),
    };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListTopicsResult" };
  }

  getTopicAttributes(input) {
    const topic = this.requireTopic(input.TopicArn);
    const subsForTopic = [...this.subscriptions.values()].filter(
      (s) => s.topicArn === topic.arn,
    );
    const confirmed = subsForTopic.filter((s) => s.confirmed);
    const attrs = {
      TopicArn: topic.arn,
      Owner: this.accountId,
      DisplayName: topic.attributes.DisplayName || "",
      SubscriptionsConfirmed: String(confirmed.length),
      SubscriptionsPending: String(subsForTopic.length - confirmed.length),
      SubscriptionsDeleted: "0",
      Policy: topic.attributes.Policy,
      EffectiveDeliveryPolicy: JSON.stringify({
        http: {
          defaultHealthyRetryPolicy: {
            minDelayTarget: 20,
            maxDelayTarget: 20,
            numRetries: 3,
            numMaxDelayRetries: 0,
            numNoDelayRetries: 0,
            numMinDelayRetries: 0,
            backoffFunction: "linear",
          },
          disableSubscriptionOverrides: false,
        },
      }),
    };
    for (const key of [
      "DeliveryPolicy",
      "FifoTopic",
      "ContentBasedDeduplication",
      "KmsMasterKeyId",
      "SignatureVersion",
      "TracingConfig",
    ]) {
      if (topic.attributes[key] !== undefined && topic.attributes[key] !== "") {
        attrs[key] = topic.attributes[key];
      }
    }
    return {
      result: { Attributes: attrs },
      resultTag: "GetTopicAttributesResult",
    };
  }

  setTopicAttributes(input) {
    const topic = this.requireTopic(input.TopicArn);
    const name = input.AttributeName;
    if (!name) {
      throw new SnsError("InvalidParameter", "Invalid parameter: AttributeName");
    }
    const mutable = new Set([
      "Policy",
      "DisplayName",
      "DeliveryPolicy",
      "KmsMasterKeyId",
      "ContentBasedDeduplication",
      "SignatureVersion",
      "TracingConfig",
    ]);
    if (!mutable.has(name)) {
      throw new SnsError(
        "InvalidParameter",
        `Invalid parameter: AttributeName Reason: ${name} is not a mutable attribute`,
      );
    }
    topic.attributes[name] = input.AttributeValue ?? "";
    return { result: {}, resultTag: "SetTopicAttributesResult" };
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------
  subscribe(input) {
    const topic = this.requireTopic(input.TopicArn);
    const protocol = input.Protocol;
    const endpoint = input.Endpoint;
    if (!protocol) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Protocol");
    }
    const validProtocols = new Set([
      "http",
      "https",
      "email",
      "email-json",
      "sms",
      "sqs",
      "application",
      "lambda",
      "firehose",
    ]);
    if (!validProtocols.has(protocol)) {
      throw new SnsError(
        "InvalidParameter",
        `Invalid parameter: Does not support this protocol string: ${protocol}`,
      );
    }
    if (!endpoint) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Endpoint");
    }

    // Protocols that auto-confirm (no out-of-band confirmation needed).
    const autoConfirm = new Set(["sqs", "lambda", "application", "firehose"]);
    const returnSubscriptionArn =
      input.ReturnSubscriptionArn === "true" || input.ReturnSubscriptionArn === true;

    const confirmed = autoConfirm.has(protocol);
    const subId = randomUUID();
    const subArn = `${topic.arn}:${subId}`;

    const attributes = {};
    if (input.Attributes && typeof input.Attributes === "object") {
      for (const [k, v] of Object.entries(input.Attributes)) attributes[k] = String(v);
    }

    const sub = {
      arn: subArn,
      topicArn: topic.arn,
      protocol,
      endpoint,
      owner: this.accountId,
      confirmed,
      attributes: {
        ConfirmationWasAuthenticated: confirmed ? "true" : "false",
        PendingConfirmation: confirmed ? "false" : "true",
        Endpoint: endpoint,
        Protocol: protocol,
        TopicArn: topic.arn,
        SubscriptionArn: confirmed ? subArn : "PendingConfirmation",
        Owner: this.accountId,
        RawMessageDelivery: attributes.RawMessageDelivery || "false",
        ...attributes,
      },
    };

    if (confirmed) {
      this.subscriptions.set(subArn, sub);
      return {
        result: { SubscriptionArn: subArn },
        resultTag: "SubscribeResult",
      };
    }

    // Pending confirmation flow for http/https/email/email-json/sms.
    const token = md5Hex(`${subArn}:${Date.now()}:${randomUUID()}`).repeat(2).slice(0, 64);
    this.pendingConfirmations.set(token, {
      topicArn: topic.arn,
      endpoint,
      protocol,
      subArn,
      attributes: sub.attributes,
    });
    // Store the pending subscription so it appears in listings as PendingConfirmation.
    this.subscriptions.set(subArn, sub);

    return {
      result: {
        SubscriptionArn: returnSubscriptionArn ? subArn : "pending confirmation",
      },
      resultTag: "SubscribeResult",
    };
  }

  confirmSubscription(input) {
    const topic = this.requireTopic(input.TopicArn);
    const token = input.Token;
    if (!token) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Token");
    }
    const pending = this.pendingConfirmations.get(token);
    if (!pending || pending.topicArn !== topic.arn) {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: Token Reason: The subscription token was not found or has expired",
      );
    }
    const sub = this.subscriptions.get(pending.subArn);
    if (sub) {
      sub.confirmed = true;
      sub.attributes.PendingConfirmation = "false";
      sub.attributes.ConfirmationWasAuthenticated =
        input.AuthenticateOnUnsubscribe === "true" ? "true" : "false";
      sub.attributes.SubscriptionArn = sub.arn;
    }
    this.pendingConfirmations.delete(token);
    return {
      result: { SubscriptionArn: pending.subArn },
      resultTag: "ConfirmSubscriptionResult",
    };
  }

  unsubscribe(input) {
    const arn = input.SubscriptionArn;
    if (!arn) {
      throw new SnsError("InvalidParameter", "Invalid parameter: SubscriptionArn");
    }
    if (arn === "PendingConfirmation" || arn === "pending confirmation") {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: SubscriptionArn Reason: An ARN must be specified",
      );
    }
    const sub = this.subscriptions.get(arn);
    if (!sub) {
      throw new SnsError("NotFound", "Subscription does not exist", 404);
    }
    if (!sub.confirmed && sub.attributes.ConfirmationWasAuthenticated === "false") {
      // Real SNS allows unsubscribe but may require auth; we allow it.
    }
    this.subscriptions.delete(arn);
    return { result: {}, resultTag: "UnsubscribeResult" };
  }

  listSubscriptions(input) {
    const all = [...this.subscriptions.values()];
    const { page, nextToken } = this.paginate(all, input.NextToken, 100);
    const result = {
      Subscriptions: page.map((s) => this.subscriptionSummary(s)),
    };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListSubscriptionsResult" };
  }

  listSubscriptionsByTopic(input) {
    const topic = this.requireTopic(input.TopicArn);
    const all = [...this.subscriptions.values()].filter(
      (s) => s.topicArn === topic.arn,
    );
    const { page, nextToken } = this.paginate(all, input.NextToken, 100);
    const result = {
      Subscriptions: page.map((s) => this.subscriptionSummary(s)),
    };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListSubscriptionsByTopicResult" };
  }

  subscriptionSummary(sub) {
    return {
      SubscriptionArn: sub.confirmed ? sub.arn : "PendingConfirmation",
      Owner: sub.owner,
      Protocol: sub.protocol,
      Endpoint: sub.endpoint,
      TopicArn: sub.topicArn,
    };
  }

  getSubscriptionAttributes(input) {
    const arn = input.SubscriptionArn;
    const sub = this.subscriptions.get(arn);
    if (!sub) {
      throw new SnsError("NotFound", "Subscription does not exist", 404);
    }
    return {
      result: { Attributes: { ...sub.attributes } },
      resultTag: "GetSubscriptionAttributesResult",
    };
  }

  setSubscriptionAttributes(input) {
    const arn = input.SubscriptionArn;
    const sub = this.subscriptions.get(arn);
    if (!sub) {
      throw new SnsError("NotFound", "Subscription does not exist", 404);
    }
    const name = input.AttributeName;
    const mutable = new Set([
      "DeliveryPolicy",
      "RawMessageDelivery",
      "FilterPolicy",
      "FilterPolicyScope",
      "RedrivePolicy",
      "SubscriptionRoleArn",
    ]);
    if (!mutable.has(name)) {
      throw new SnsError(
        "InvalidParameter",
        `Invalid parameter: AttributeName Reason: ${name} is not a valid attribute`,
      );
    }
    sub.attributes[name] = input.AttributeValue ?? "";
    return { result: {}, resultTag: "SetSubscriptionAttributesResult" };
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------
  validatePublishTarget(input) {
    const targets = [input.TopicArn, input.TargetArn, input.PhoneNumber].filter(
      (t) => t !== undefined && t !== null && t !== "",
    );
    if (targets.length === 0) {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: Either TopicArn or TargetArn or PhoneNumber must be specified.",
      );
    }
    if (targets.length > 1) {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: Only one of TopicArn, TargetArn, or PhoneNumber can be specified.",
      );
    }
  }

  publish(input) {
    this.validatePublishTarget(input);
    const message = input.Message;
    if (message === undefined || message === null || message === "") {
      throw new SnsError("InvalidParameter", "Invalid parameter: Empty message");
    }

    if (input.TopicArn) {
      const topic = this.requireTopic(input.TopicArn);
      if (topic.fifo && !input.MessageGroupId) {
        throw new SnsError(
          "InvalidParameter",
          "Invalid parameter: The MessageGroupId parameter is required for FIFO topics",
        );
      }
      if (
        topic.fifo &&
        !input.MessageDeduplicationId &&
        topic.attributes.ContentBasedDeduplication !== "true"
      ) {
        throw new SnsError(
          "InvalidParameter",
          "Invalid parameter: The topic should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly",
        );
      }
    } else if (input.TargetArn) {
      if (
        !this.platformEndpoints.has(input.TargetArn) &&
        !this.topics.has(input.TargetArn)
      ) {
        throw new SnsError("NotFound", "Endpoint does not exist", 404);
      }
    }

    if (input.MessageStructure && input.MessageStructure !== "json") {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: MessageStructure Reason: Must be json or empty",
      );
    }
    if (input.MessageStructure === "json") {
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        throw new SnsError(
          "InvalidParameter",
          "Invalid parameter: Message Structure - JSON message body failed to parse",
        );
      }
      if (parsed.default === undefined) {
        throw new SnsError(
          "InvalidParameter",
          "Invalid parameter: Message Structure - No default entry in JSON message body",
        );
      }
    }

    const messageId = randomUUID();
    const record = {
      messageId,
      topicArn: input.TopicArn,
      targetArn: input.TargetArn,
      phoneNumber: input.PhoneNumber,
      message,
      subject: input.Subject,
      messageStructure: input.MessageStructure,
      messageAttributes: input.MessageAttributes,
      messageGroupId: input.MessageGroupId,
      messageDeduplicationId: input.MessageDeduplicationId,
      timestamp: Date.now(),
    };
    this.published.push(record);

    const result = { MessageId: messageId };
    if (input.TopicArn) {
      const topic = this.topics.get(input.TopicArn);
      if (topic && topic.fifo) {
        result.SequenceNumber = String(this.published.length).padStart(20, "0");
      }
    }
    return { result, resultTag: "PublishResult" };
  }

  publishBatch(input) {
    const topic = this.requireTopic(input.TopicArn);
    let entries = input.PublishBatchRequestEntries;
    if (!entries) entries = [];
    if (!Array.isArray(entries)) entries = [entries];

    if (entries.length === 0) {
      throw new SnsError(
        "EmptyBatchRequest",
        "The batch request doesn't contain any entries.",
      );
    }
    if (entries.length > 10) {
      throw new SnsError(
        "TooManyEntriesInBatchRequest",
        "The batch request contains more entries than permissible.",
      );
    }
    const ids = new Set();
    for (const e of entries) {
      if (!e.Id) {
        throw new SnsError(
          "InvalidParameter",
          "Invalid parameter: Entry Id is required",
        );
      }
      if (ids.has(e.Id)) {
        throw new SnsError(
          "BatchEntryIdsNotDistinct",
          `Two or more batch entries in the request have the same Id: ${e.Id}`,
        );
      }
      ids.add(e.Id);
    }

    const successful = [];
    const failed = [];
    for (const e of entries) {
      try {
        if (topic.fifo && !e.MessageGroupId) {
          throw new SnsError(
            "InvalidParameter",
            "Invalid parameter: The MessageGroupId parameter is required for FIFO topics",
          );
        }
        if (e.Message === undefined || e.Message === null || e.Message === "") {
          throw new SnsError("InvalidParameter", "Invalid parameter: Empty message");
        }
        const messageId = randomUUID();
        this.published.push({
          messageId,
          topicArn: topic.arn,
          message: e.Message,
          subject: e.Subject,
          messageStructure: e.MessageStructure,
          messageAttributes: e.MessageAttributes,
          messageGroupId: e.MessageGroupId,
          messageDeduplicationId: e.MessageDeduplicationId,
          timestamp: Date.now(),
        });
        const entry = { Id: e.Id, MessageId: messageId };
        if (topic.fifo) {
          entry.SequenceNumber = String(this.published.length).padStart(20, "0");
        }
        successful.push(entry);
      } catch (err) {
        failed.push({
          Id: e.Id,
          Code: err instanceof SnsError ? err.code : "InternalError",
          Message: err.message,
          SenderFault: "true",
        });
      }
    }
    return {
      result: { Successful: successful, Failed: failed },
      resultTag: "PublishBatchResult",
    };
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------
  addPermission(input) {
    const topic = this.requireTopic(input.TopicArn);
    if (!input.Label) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Label");
    }
    const accountIds = this.asList(input.AWSAccountId);
    const actions = this.asList(input.ActionName);
    if (accountIds.length === 0) {
      throw new SnsError("InvalidParameter", "Invalid parameter: AWSAccountId");
    }
    if (actions.length === 0) {
      throw new SnsError("InvalidParameter", "Invalid parameter: ActionName");
    }
    if (!topic.permissions) topic.permissions = new Map();
    topic.permissions.set(input.Label, { accountIds, actions });
    return { result: {}, resultTag: "AddPermissionResult" };
  }

  removePermission(input) {
    const topic = this.requireTopic(input.TopicArn);
    if (!input.Label) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Label");
    }
    if (topic.permissions) topic.permissions.delete(input.Label);
    return { result: {}, resultTag: "RemovePermissionResult" };
  }

  asList(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return Object.values(value);
    return [value];
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  resourceTags(resourceArn) {
    const topic = this.topics.get(resourceArn);
    if (!topic) {
      throw new SnsError(
        "ResourceNotFound",
        "Resource does not exist",
        404,
      );
    }
    if (!topic.tags) topic.tags = {};
    return topic.tags;
  }

  tagResource(input) {
    const tags = this.resourceTags(input.ResourceArn);
    const incoming = this.coerceTags(input.Tags);
    for (const [k, v] of Object.entries(incoming)) tags[k] = v;
    return { result: {}, resultTag: "TagResourceResult" };
  }

  untagResource(input) {
    const tags = this.resourceTags(input.ResourceArn);
    const keys = this.asList(input.TagKeys);
    for (const k of keys) delete tags[k];
    return { result: {}, resultTag: "UntagResourceResult" };
  }

  listTagsForResource(input) {
    const tags = this.resourceTags(input.ResourceArn);
    const list = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
    return {
      result: { Tags: list },
      resultTag: "ListTagsForResourceResult",
    };
  }

  // -------------------------------------------------------------------------
  // Data protection policy
  // -------------------------------------------------------------------------
  getDataProtectionPolicy(input) {
    this.requireTopic(input.ResourceArn);
    const policy = this.dataProtectionPolicies.get(input.ResourceArn) || "";
    return {
      result: { DataProtectionPolicy: policy },
      resultTag: "GetDataProtectionPolicyResult",
    };
  }

  putDataProtectionPolicy(input) {
    this.requireTopic(input.ResourceArn);
    this.dataProtectionPolicies.set(input.ResourceArn, input.DataProtectionPolicy ?? "");
    return { result: {}, resultTag: "PutDataProtectionPolicyResult" };
  }

  // -------------------------------------------------------------------------
  // SMS
  // -------------------------------------------------------------------------
  getSMSAttributes(input) {
    const requested = this.asList(input.attributes);
    let attrs;
    if (requested.length > 0) {
      attrs = {};
      for (const name of requested) {
        if (this.smsAttributes[name] !== undefined) attrs[name] = this.smsAttributes[name];
      }
    } else {
      attrs = { ...this.smsAttributes };
    }
    return {
      result: { attributes: attrs },
      resultTag: "GetSMSAttributesResult",
    };
  }

  setSMSAttributes(input) {
    const attrs = input.attributes || {};
    for (const [k, v] of Object.entries(attrs)) {
      this.smsAttributes[k] = String(v);
    }
    return { result: {}, resultTag: "SetSMSAttributesResult" };
  }

  checkIfPhoneNumberIsOptedOut(input) {
    const phone = input.phoneNumber;
    if (!phone) {
      throw new SnsError("InvalidParameter", "Invalid parameter: phoneNumber");
    }
    return {
      result: { isOptedOut: this.optedOut.has(phone) },
      resultTag: "CheckIfPhoneNumberIsOptedOutResult",
    };
  }

  optInPhoneNumber(input) {
    const phone = input.phoneNumber;
    if (!phone) {
      throw new SnsError("InvalidParameter", "Invalid parameter: phoneNumber");
    }
    this.optedOut.delete(phone);
    return { result: {}, resultTag: "OptInPhoneNumberResult" };
  }

  listPhoneNumbersOptedOut(input) {
    const all = [...this.optedOut];
    const { page, nextToken } = this.paginate(all, input.nextToken, 100);
    const result = { phoneNumbers: page };
    if (nextToken) result.nextToken = nextToken;
    return { result, resultTag: "ListPhoneNumbersOptedOutResult" };
  }

  listOriginationNumbers(input) {
    // No origination numbers in the fake by default.
    const result = { PhoneNumbers: [] };
    return { result, resultTag: "ListOriginationNumbersResult" };
  }

  // -------------------------------------------------------------------------
  // SMS sandbox
  // -------------------------------------------------------------------------
  getSMSSandboxAccountStatus() {
    return {
      result: { IsInSandbox: this.sandboxAccountStatus === "InSandbox" },
      resultTag: "GetSMSSandboxAccountStatusResult",
    };
  }

  createSMSSandboxPhoneNumber(input) {
    const phone = input.PhoneNumber;
    if (!phone) {
      throw new SnsError("InvalidParameter", "Invalid parameter: PhoneNumber");
    }
    this.sandboxNumbers.set(phone, { status: "Pending", code: "123456" });
    return { result: {}, resultTag: "CreateSMSSandboxPhoneNumberResult" };
  }

  verifySMSSandboxPhoneNumber(input) {
    const phone = input.PhoneNumber;
    const code = input.OneTimePassword;
    const entry = this.sandboxNumbers.get(phone);
    if (!entry) {
      throw new SnsError("ResourceNotFound", "PhoneNumber not found in sandbox", 404);
    }
    if (code !== entry.code) {
      throw new SnsError(
        "VerificationException",
        "Invalid OTP. Verification failed.",
      );
    }
    entry.status = "Verified";
    return { result: {}, resultTag: "VerifySMSSandboxPhoneNumberResult" };
  }

  deleteSMSSandboxPhoneNumber(input) {
    const phone = input.PhoneNumber;
    if (!this.sandboxNumbers.has(phone)) {
      throw new SnsError("ResourceNotFound", "PhoneNumber not found in sandbox", 404);
    }
    this.sandboxNumbers.delete(phone);
    return { result: {}, resultTag: "DeleteSMSSandboxPhoneNumberResult" };
  }

  listSMSSandboxPhoneNumbers(input) {
    const all = [...this.sandboxNumbers.entries()].map(([PhoneNumber, v]) => ({
      PhoneNumber,
      Status: v.status,
    }));
    const { page, nextToken } = this.paginate(all, input.NextToken, 100);
    const result = { PhoneNumbers: page };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListSMSSandboxPhoneNumbersResult" };
  }

  // -------------------------------------------------------------------------
  // Platform applications & endpoints (mobile push)
  // -------------------------------------------------------------------------
  createPlatformApplication(input) {
    const name = input.Name;
    const platform = input.Platform;
    if (!name) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Name");
    }
    if (!platform) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Platform");
    }
    const arn = `arn:aws:sns:${this.region}:${this.accountId}:app/${platform}/${name}`;
    const attributes = input.Attributes || {};
    this.platformApplications.set(arn, {
      arn,
      name,
      platform,
      attributes: { Enabled: "true", ...attributes },
    });
    return {
      result: { PlatformApplicationArn: arn },
      resultTag: "CreatePlatformApplicationResult",
    };
  }

  requirePlatformApplication(arn) {
    const app = this.platformApplications.get(arn);
    if (!app) {
      throw new SnsError("NotFound", "PlatformApplication does not exist", 404);
    }
    return app;
  }

  deletePlatformApplication(input) {
    this.platformApplications.delete(input.PlatformApplicationArn);
    for (const [eArn, ep] of this.platformEndpoints) {
      if (ep.applicationArn === input.PlatformApplicationArn) {
        this.platformEndpoints.delete(eArn);
      }
    }
    return { result: {}, resultTag: "DeletePlatformApplicationResult" };
  }

  getPlatformApplicationAttributes(input) {
    const app = this.requirePlatformApplication(input.PlatformApplicationArn);
    return {
      result: { Attributes: { ...app.attributes } },
      resultTag: "GetPlatformApplicationAttributesResult",
    };
  }

  setPlatformApplicationAttributes(input) {
    const app = this.requirePlatformApplication(input.PlatformApplicationArn);
    const attrs = input.Attributes || {};
    for (const [k, v] of Object.entries(attrs)) app.attributes[k] = String(v);
    return {
      result: {},
      resultTag: "SetPlatformApplicationAttributesResult",
    };
  }

  listPlatformApplications(input) {
    const all = [...this.platformApplications.values()].map((a) => ({
      PlatformApplicationArn: a.arn,
      Attributes: { ...a.attributes },
    }));
    const { page, nextToken } = this.paginate(all, input.NextToken, 100);
    const result = { PlatformApplications: page };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListPlatformApplicationsResult" };
  }

  createPlatformEndpoint(input) {
    const app = this.requirePlatformApplication(input.PlatformApplicationArn);
    const token = input.Token;
    if (!token) {
      throw new SnsError("InvalidParameter", "Invalid parameter: Token");
    }
    // Idempotent on (applicationArn, token).
    for (const ep of this.platformEndpoints.values()) {
      if (ep.applicationArn === app.arn && ep.token === token) {
        return {
          result: { EndpointArn: ep.arn },
          resultTag: "CreatePlatformEndpointResult",
        };
      }
    }
    const id = randomUUID();
    const arn = `arn:aws:sns:${this.region}:${this.accountId}:endpoint/${app.platform}/${app.name}/${id}`;
    const attributes = input.Attributes || {};
    this.platformEndpoints.set(arn, {
      arn,
      applicationArn: app.arn,
      token,
      attributes: {
        Enabled: "true",
        Token: token,
        CustomUserData: input.CustomUserData || "",
        ...attributes,
      },
    });
    return {
      result: { EndpointArn: arn },
      resultTag: "CreatePlatformEndpointResult",
    };
  }

  requireEndpoint(arn) {
    const ep = this.platformEndpoints.get(arn);
    if (!ep) {
      throw new SnsError("NotFound", "Endpoint does not exist", 404);
    }
    return ep;
  }

  deleteEndpoint(input) {
    this.platformEndpoints.delete(input.EndpointArn);
    return { result: {}, resultTag: "DeleteEndpointResult" };
  }

  getEndpointAttributes(input) {
    const ep = this.requireEndpoint(input.EndpointArn);
    return {
      result: { Attributes: { ...ep.attributes } },
      resultTag: "GetEndpointAttributesResult",
    };
  }

  setEndpointAttributes(input) {
    const ep = this.requireEndpoint(input.EndpointArn);
    const attrs = input.Attributes || {};
    for (const [k, v] of Object.entries(attrs)) ep.attributes[k] = String(v);
    return { result: {}, resultTag: "SetEndpointAttributesResult" };
  }

  listEndpointsByPlatformApplication(input) {
    const app = this.requirePlatformApplication(input.PlatformApplicationArn);
    const all = [...this.platformEndpoints.values()]
      .filter((ep) => ep.applicationArn === app.arn)
      .map((ep) => ({ EndpointArn: ep.arn, Attributes: { ...ep.attributes } }));
    const { page, nextToken } = this.paginate(all, input.NextToken, 100);
    const result = { Endpoints: page };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListEndpointsByPlatformApplicationResult" };
  }

  // -------------------------------------------------------------------------
  // Pagination helper (NextToken is a base64 offset)
  // -------------------------------------------------------------------------
  paginate(items, nextToken, pageSize) {
    let start = 0;
    if (nextToken) {
      const decoded = parseInt(
        Buffer.from(String(nextToken), "base64").toString("utf8"),
        10,
      );
      if (!Number.isNaN(decoded)) start = decoded;
    }
    const page = items.slice(start, start + pageSize);
    let token;
    if (start + pageSize < items.length) {
      token = Buffer.from(String(start + pageSize)).toString("base64");
    }
    return { page, nextToken: token };
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  buildResultXml(result) {
    let xml = "";
    for (const [key, value] of Object.entries(result)) {
      xml += xmlNode(key, value);
    }
    return xml;
  }

  sendXml(res, status, operation, resultTag, result) {
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    const responseTag = `${operation}Response`;
    const resultXml = this.buildResultXml(result);
    const hasResultBody = resultXml.length > 0;
    const resultBlock = hasResultBody
      ? `<${resultTag}>${resultXml}</${resultTag}>`
      : `<${resultTag}/>`;
    const xml =
      `<${responseTag} xmlns="${SNS_NAMESPACE}">` +
      resultBlock +
      `<ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata>` +
      `</${responseTag}>`;
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    res.end(`<?xml version="1.0"?>\n${xml}`);
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalError";
    const status = error.status || ERROR_STATUS[code] || 400;
    const fault = status >= 500 ? "Receiver" : "Sender";
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    const xml =
      `<ErrorResponse xmlns="${SNS_NAMESPACE}">` +
      `<Error>` +
      `<Type>${fault}</Type>` +
      `<Code>${xmlEscape(code)}</Code>` +
      `<Message>${xmlEscape(error.message || code)}</Message>` +
      `</Error>` +
      `<RequestId>${requestId}</RequestId>` +
      `</ErrorResponse>`;
    res.end(`<?xml version="1.0"?>\n${xml}`);
  }
}

export default SnsServer;
export const API_VERSION_SNS = API_VERSION;
