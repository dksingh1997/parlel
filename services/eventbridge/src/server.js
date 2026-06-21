// parlel/eventbridge — a lightweight, dependency-free fake of AWS EventBridge.
//
// Speaks the AWS JSON 1.1 wire protocol so that application code using the real
// `@aws-sdk/client-eventbridge` client can run against it with zero cost and
// zero side effects. Pure Node.js, no external npm dependencies. State is
// in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-eventbridge v3):
//   * Requests are POST / with header `X-Amz-Target: AWSEvents.<Operation>`
//     and `Content-Type: application/x-amz-json-1.1`. Body is JSON input.
//   * Timestamp fields (CreationTime, LastModifiedTime, ...) are epoch-seconds
//     numbers on the wire (the SDK rehydrates them into Date objects).
//   * Success: 200, JSON output, `Content-Type: application/x-amz-json-1.1`.
//   * Error: non-2xx, JSON `{ "__type": "<Code>", "message": "<msg>" }` plus an
//     `x-amzn-errortype` header.
//
// The fake also implements EventBridge content-based event-pattern matching
// (used by PutRule / TestEventPattern / PutEvents routing) including prefix,
// suffix, anything-but, numeric, exists, cidr, equals-ignore-case and
// wildcard matchers.

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";
const TARGET_PREFIX = "AWSEvents";
const DEFAULT_EVENT_BUS = "default";

// EventBridge error codes -> HTTP status. Sender (client) faults are 400,
// Receiver (server) faults are 500. These all appear in the real model.
const ERROR_STATUS = {
  ConcurrentModificationException: 400,
  IllegalStatusException: 400,
  InternalException: 500,
  InvalidEventPatternException: 400,
  InvalidStateException: 400,
  LimitExceededException: 400,
  ManagedRuleException: 400,
  OperationDisabledException: 400,
  PolicyLengthExceededException: 400,
  ResourceAlreadyExistsException: 400,
  ResourceNotFoundException: 400,
  ValidationException: 400,
  ThrottlingException: 429,
  AccessDeniedException: 403,
};

class EventBridgeError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// Timestamps are returned as epoch-seconds numbers across the JSON 1.1 wire.
function epochSeconds(ms = Date.now()) {
  return Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Event pattern matching (EventBridge content filtering)
// ---------------------------------------------------------------------------

// Match a single event value against one pattern rule entry. The rule may be a
// literal scalar or one of the EventBridge matcher objects.
function matchValue(eventValue, rule) {
  // Literal scalar match.
  if (rule === null || typeof rule !== "object") {
    return eventValue === rule;
  }

  if (Array.isArray(rule)) {
    // A list at the leaf is an OR of literals/matchers.
    return rule.some((r) => matchValue(eventValue, r));
  }

  // Matcher object: { prefix }, { suffix }, { "anything-but" }, etc.
  for (const [op, operand] of Object.entries(rule)) {
    switch (op) {
      case "prefix": {
        if (typeof operand === "object" && operand !== null) {
          // { prefix: { "equals-ignore-case": "x" } }
          if (operand["equals-ignore-case"] !== undefined) {
            return (
              typeof eventValue === "string" &&
              eventValue.toLowerCase().startsWith(String(operand["equals-ignore-case"]).toLowerCase())
            );
          }
          return false;
        }
        return typeof eventValue === "string" && eventValue.startsWith(operand);
      }
      case "suffix": {
        if (typeof operand === "object" && operand !== null) {
          if (operand["equals-ignore-case"] !== undefined) {
            return (
              typeof eventValue === "string" &&
              eventValue.toLowerCase().endsWith(String(operand["equals-ignore-case"]).toLowerCase())
            );
          }
          return false;
        }
        return typeof eventValue === "string" && eventValue.endsWith(operand);
      }
      case "equals-ignore-case": {
        return (
          typeof eventValue === "string" &&
          eventValue.toLowerCase() === String(operand).toLowerCase()
        );
      }
      case "wildcard": {
        return typeof eventValue === "string" && wildcardMatch(eventValue, operand);
      }
      case "cidr": {
        return typeof eventValue === "string" && cidrMatch(eventValue, operand);
      }
      case "exists": {
        // exists is handled at the field level; reaching here means the field
        // was present, so { exists: true } matches and { exists: false } fails.
        return operand === true;
      }
      case "anything-but": {
        return !matchAnythingBut(eventValue, operand);
      }
      case "numeric": {
        return numericMatch(eventValue, operand);
      }
      default:
        return false;
    }
  }
  return false;
}

function matchAnythingBut(eventValue, operand) {
  if (Array.isArray(operand)) {
    return operand.includes(eventValue);
  }
  if (operand !== null && typeof operand === "object") {
    if (operand.prefix !== undefined) {
      return typeof eventValue === "string" && eventValue.startsWith(operand.prefix);
    }
    if (operand.suffix !== undefined) {
      return typeof eventValue === "string" && eventValue.endsWith(operand.suffix);
    }
    if (operand["equals-ignore-case"] !== undefined) {
      const list = Array.isArray(operand["equals-ignore-case"])
        ? operand["equals-ignore-case"]
        : [operand["equals-ignore-case"]];
      return (
        typeof eventValue === "string" &&
        list.some((v) => eventValue.toLowerCase() === String(v).toLowerCase())
      );
    }
    if (operand.wildcard !== undefined) {
      const list = Array.isArray(operand.wildcard) ? operand.wildcard : [operand.wildcard];
      return typeof eventValue === "string" && list.some((p) => wildcardMatch(eventValue, p));
    }
  }
  return eventValue === operand;
}

function numericMatch(eventValue, conditions) {
  if (typeof eventValue !== "number") return false;
  // conditions is a flat array like ["<", 0, ">=", 10]
  for (let i = 0; i < conditions.length; i += 2) {
    const op = conditions[i];
    const num = Number(conditions[i + 1]);
    switch (op) {
      case "=":
        if (!(eventValue === num)) return false;
        break;
      case "<":
        if (!(eventValue < num)) return false;
        break;
      case "<=":
        if (!(eventValue <= num)) return false;
        break;
      case ">":
        if (!(eventValue > num)) return false;
        break;
      case ">=":
        if (!(eventValue >= num)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function wildcardMatch(value, pattern) {
  // EventBridge wildcard only supports '*' (matches any sequence).
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function cidrMatch(ip, cidr) {
  const [range, bitsRaw] = String(cidr).split("/");
  const bits = parseInt(bitsRaw, 10);
  if (Number.isNaN(bits)) return false;
  const toInt = (addr) =>
    addr.split(".").reduce((acc, oct) => (acc << 8) + (parseInt(oct, 10) & 255), 0) >>> 0;
  try {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(ip) & mask) === (toInt(range) & mask);
  } catch {
    return false;
  }
}

// Recursively evaluate an EventBridge event pattern against an event object.
function matchPattern(pattern, event) {
  if (pattern === null || typeof pattern !== "object" || Array.isArray(pattern)) {
    return false;
  }
  for (const [key, rule] of Object.entries(pattern)) {
    const eventValue = event ? event[key] : undefined;

    if (Array.isArray(rule)) {
      // Leaf: list of allowed values / matchers (OR). Handle exists specially.
      const existsRule = rule.find(
        (r) => r && typeof r === "object" && r.exists !== undefined,
      );
      if (existsRule) {
        const present = event !== undefined && event !== null && key in event;
        if (existsRule.exists === true && !present) return false;
        if (existsRule.exists === false && present) return false;
        // Other entries in the list still get OR-evaluated if value present.
        const others = rule.filter((r) => r !== existsRule);
        if (others.length && present) {
          if (!others.some((r) => matchValue(eventValue, r))) return false;
        }
        continue;
      }
      if (!rule.some((r) => matchValue(eventValue, r))) return false;
    } else if (rule !== null && typeof rule === "object") {
      // Nested object: $or special form or a deeper pattern.
      if (key === "$or" || key === "$and") {
        // Not commonly used; treat array form below.
        return false;
      }
      if (!matchPattern(rule, eventValue)) return false;
    } else {
      // Scalar leaf (rare; EventBridge requires lists, but be lenient).
      if (eventValue !== rule) return false;
    }
  }
  return true;
}

// Validate an event pattern is structurally legal JSON object with list leaves.
function validateEventPattern(patternStr) {
  let pattern;
  try {
    pattern = JSON.parse(patternStr);
  } catch {
    throw new EventBridgeError(
      "InvalidEventPatternException",
      "Event pattern is not valid. Reason: Invalid JSON",
    );
  }
  if (pattern === null || typeof pattern !== "object" || Array.isArray(pattern)) {
    throw new EventBridgeError(
      "InvalidEventPatternException",
      "Event pattern is not valid. Reason: Pattern must be a JSON object",
    );
  }
  return pattern;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class EventbridgeServer {
  constructor(port = 4573, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // eventBuses: Map<name, EventBus>
    //   EventBus = { name, arn, policy, description, kmsKeyId, deadLetterConfig,
    //                tags:Map, createdAt, lastModified }
    this.eventBuses = new Map();
    // rules: Map<"busName/ruleName", Rule>
    this.rules = new Map();
    // targets: Map<"busName/ruleName", Map<targetId, Target>>
    this.targets = new Map();
    // archives: Map<name, Archive>
    this.archives = new Map();
    // replays: Map<name, Replay>
    this.replays = new Map();
    // connections: Map<name, Connection>
    this.connections = new Map();
    // apiDestinations: Map<name, ApiDestination>
    this.apiDestinations = new Map();
    // endpoints: Map<name, Endpoint>
    this.endpoints = new Map();
    // partnerEventSources: Map<name, PartnerEventSource>
    this.partnerEventSources = new Map();
    // captured PutEvents entries (for test assertions): array
    this.putEvents = [];
    // events routed to matched rules: array of { ruleArn, eventBus, event }
    this.routedEvents = [];

    // Seed the default event bus.
    const now = Date.now();
    this.eventBuses.set(DEFAULT_EVENT_BUS, {
      name: DEFAULT_EVENT_BUS,
      arn: this.eventBusArn(DEFAULT_EVENT_BUS),
      policy: undefined,
      description: "Default event bus",
      kmsKeyId: undefined,
      deadLetterConfig: undefined,
      tags: new Map(),
      createdAt: now,
      lastModified: now,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new EventBridgeError("InternalException", error.message, 500));
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

  // -------------------------------------------------------------------------
  // ARN helpers
  // -------------------------------------------------------------------------
  eventBusArn(name) {
    return `arn:aws:events:${this.region}:${this.accountId}:event-bus/${name}`;
  }

  ruleArn(ruleName, busName) {
    if (busName && busName !== DEFAULT_EVENT_BUS) {
      return `arn:aws:events:${this.region}:${this.accountId}:rule/${busName}/${ruleName}`;
    }
    return `arn:aws:events:${this.region}:${this.accountId}:rule/${ruleName}`;
  }

  archiveArn(name) {
    return `arn:aws:events:${this.region}:${this.accountId}:archive/${name}`;
  }

  replayArn(name) {
    return `arn:aws:events:${this.region}:${this.accountId}:replay/${name}`;
  }

  connectionArn(name) {
    return `arn:aws:events:${this.region}:${this.accountId}:connection/${name}/${randomUUID()}`;
  }

  apiDestinationArn(name) {
    return `arn:aws:events:${this.region}:${this.accountId}:api-destination/${name}/${randomUUID()}`;
  }

  endpointArn(name) {
    return `arn:aws:events:${this.region}:${this.accountId}:endpoint/${name}`;
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
        service: "eventbridge",
        eventBuses: this.eventBuses.size,
        rules: this.rules.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-eventbridge");

    if (method !== "POST") {
      return this.sendError(
        res,
        new EventBridgeError("AccessDeniedException", "Only POST is supported by the parlel eventbridge fake.", 405),
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
        new EventBridgeError("ValidationException", "Request body is not valid JSON.", 400),
      );
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof EventBridgeError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      // Event buses
      case "CreateEventBus":
        return this.createEventBus(input);
      case "DeleteEventBus":
        return this.deleteEventBus(input);
      case "DescribeEventBus":
        return this.describeEventBus(input);
      case "ListEventBuses":
        return this.listEventBuses(input);
      case "UpdateEventBus":
        return this.updateEventBus(input);
      // Permissions
      case "PutPermission":
        return this.putPermission(input);
      case "RemovePermission":
        return this.removePermission(input);
      // Rules
      case "PutRule":
        return this.putRule(input);
      case "DeleteRule":
        return this.deleteRule(input);
      case "DescribeRule":
        return this.describeRule(input);
      case "DisableRule":
        return this.disableRule(input);
      case "EnableRule":
        return this.enableRule(input);
      case "ListRules":
        return this.listRules(input);
      case "ListRuleNamesByTarget":
        return this.listRuleNamesByTarget(input);
      // Targets
      case "PutTargets":
        return this.putTargets(input);
      case "RemoveTargets":
        return this.removeTargets(input);
      case "ListTargetsByRule":
        return this.listTargetsByRule(input);
      // Events
      case "PutEvents":
        return this.putEventsOp(input);
      case "PutPartnerEvents":
        return this.putPartnerEvents(input);
      case "TestEventPattern":
        return this.testEventPattern(input);
      // Archives
      case "CreateArchive":
        return this.createArchive(input);
      case "DeleteArchive":
        return this.deleteArchive(input);
      case "DescribeArchive":
        return this.describeArchive(input);
      case "ListArchives":
        return this.listArchives(input);
      case "UpdateArchive":
        return this.updateArchive(input);
      // Replays
      case "StartReplay":
        return this.startReplay(input);
      case "CancelReplay":
        return this.cancelReplay(input);
      case "DescribeReplay":
        return this.describeReplay(input);
      case "ListReplays":
        return this.listReplays(input);
      // Connections
      case "CreateConnection":
        return this.createConnection(input);
      case "DeleteConnection":
        return this.deleteConnection(input);
      case "DescribeConnection":
        return this.describeConnection(input);
      case "ListConnections":
        return this.listConnections(input);
      case "UpdateConnection":
        return this.updateConnection(input);
      case "DeauthorizeConnection":
        return this.deauthorizeConnection(input);
      // API destinations
      case "CreateApiDestination":
        return this.createApiDestination(input);
      case "DeleteApiDestination":
        return this.deleteApiDestination(input);
      case "DescribeApiDestination":
        return this.describeApiDestination(input);
      case "ListApiDestinations":
        return this.listApiDestinations(input);
      case "UpdateApiDestination":
        return this.updateApiDestination(input);
      // Endpoints (global)
      case "CreateEndpoint":
        return this.createEndpoint(input);
      case "DeleteEndpoint":
        return this.deleteEndpoint(input);
      case "DescribeEndpoint":
        return this.describeEndpoint(input);
      case "ListEndpoints":
        return this.listEndpoints(input);
      case "UpdateEndpoint":
        return this.updateEndpoint(input);
      // Partner event sources
      case "CreatePartnerEventSource":
        return this.createPartnerEventSource(input);
      case "DeletePartnerEventSource":
        return this.deletePartnerEventSource(input);
      case "DescribePartnerEventSource":
        return this.describePartnerEventSource(input);
      case "ListPartnerEventSources":
        return this.listPartnerEventSources(input);
      case "ListPartnerEventSourceAccounts":
        return this.listPartnerEventSourceAccounts(input);
      // Event sources (partner-managed, consumer side)
      case "DescribeEventSource":
        return this.describeEventSource(input);
      case "ListEventSources":
        return this.listEventSources(input);
      case "ActivateEventSource":
        return this.activateEventSource(input);
      case "DeactivateEventSource":
        return this.deactivateEventSource(input);
      // Tagging
      case "TagResource":
        return this.tagResource(input);
      case "UntagResource":
        return this.untagResource(input);
      case "ListTagsForResource":
        return this.listTagsForResource(input);
      default:
        throw new EventBridgeError(
          "ValidationException",
          `The action ${operation || "(none)"} is not valid for this endpoint.`,
          400,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------
  validateName(name, field = "Name", maxLen = 256) {
    if (typeof name !== "string" || name.length === 0 || name.length > maxLen) {
      throw new EventBridgeError(
        "ValidationException",
        `Invalid ${field}: must be between 1 and ${maxLen} characters.`,
      );
    }
    if (!/^[.\-_A-Za-z0-9]+$/.test(name)) {
      throw new EventBridgeError(
        "ValidationException",
        `Invalid ${field}: may contain only letters, numbers, periods, hyphens, and underscores.`,
      );
    }
  }

  // EventBus name in target requests; defaults to "default".
  resolveBusName(input) {
    let bus = input.EventBusName || DEFAULT_EVENT_BUS;
    // EventBusName may be an ARN.
    if (typeof bus === "string" && bus.startsWith("arn:")) {
      bus = bus.split("/").pop();
    }
    return bus;
  }

  requireBus(busName) {
    const bus = this.eventBuses.get(busName);
    if (!bus) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `Event bus ${busName} does not exist.`,
      );
    }
    return bus;
  }

  coerceTags(list) {
    const map = new Map();
    for (const t of list || []) {
      if (t && t.Key !== undefined) map.set(t.Key, t.Value ?? "");
    }
    return map;
  }

  tagList(map) {
    return [...map.entries()].map(([Key, Value]) => ({ Key, Value }));
  }

  // -------------------------------------------------------------------------
  // Event buses
  // -------------------------------------------------------------------------
  createEventBus(input) {
    const name = input.Name;
    this.validateName(name, "Name");
    if (this.eventBuses.has(name)) {
      throw new EventBridgeError(
        "ResourceAlreadyExistsException",
        `Event bus ${name} already exists.`,
      );
    }
    const now = Date.now();
    const bus = {
      name,
      arn: this.eventBusArn(name),
      policy: undefined,
      description: input.Description,
      kmsKeyId: input.KmsKeyIdentifier,
      deadLetterConfig: input.DeadLetterConfig,
      eventSourceName: input.EventSourceName,
      tags: this.coerceTags(input.Tags),
      createdAt: now,
      lastModified: now,
    };
    this.eventBuses.set(name, bus);
    const out = { EventBusArn: bus.arn };
    if (input.Description !== undefined) out.Description = input.Description;
    return out;
  }

  deleteEventBus(input) {
    const name = input.Name;
    if (name === DEFAULT_EVENT_BUS) {
      throw new EventBridgeError(
        "ValidationException",
        "Cannot delete the default event bus.",
      );
    }
    // DeleteEventBus is idempotent in AWS (no error if missing).
    if (this.eventBuses.has(name)) {
      this.eventBuses.delete(name);
      // Remove rules + targets bound to this bus.
      for (const key of [...this.rules.keys()]) {
        if (key.startsWith(`${name}/`)) {
          this.rules.delete(key);
          this.targets.delete(key);
        }
      }
    }
    return {};
  }

  describeEventBus(input = {}) {
    const name = input.Name ? (input.Name.startsWith("arn:") ? input.Name.split("/").pop() : input.Name) : DEFAULT_EVENT_BUS;
    const bus = this.requireBus(name);
    const out = {
      Name: bus.name,
      Arn: bus.arn,
      CreationTime: epochSeconds(bus.createdAt),
      LastModifiedTime: epochSeconds(bus.lastModified),
    };
    if (bus.description !== undefined) out.Description = bus.description;
    if (bus.policy !== undefined) out.Policy = bus.policy;
    if (bus.kmsKeyId !== undefined) out.KmsKeyIdentifier = bus.kmsKeyId;
    if (bus.deadLetterConfig !== undefined) out.DeadLetterConfig = bus.deadLetterConfig;
    return out;
  }

  listEventBuses(input = {}) {
    let buses = [...this.eventBuses.values()];
    if (input.NamePrefix) {
      buses = buses.filter((b) => b.name.startsWith(input.NamePrefix));
    }
    buses.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(buses, input.NextToken, input.Limit || 100);
    const out = {
      EventBuses: page.map((b) => {
        const e = {
          Name: b.name,
          Arn: b.arn,
          CreationTime: epochSeconds(b.createdAt),
          LastModifiedTime: epochSeconds(b.lastModified),
        };
        if (b.description !== undefined) e.Description = b.description;
        if (b.policy !== undefined) e.Policy = b.policy;
        return e;
      }),
    };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  updateEventBus(input = {}) {
    const name = input.Name || DEFAULT_EVENT_BUS;
    const bus = this.requireBus(name);
    if (input.Description !== undefined) bus.description = input.Description;
    if (input.KmsKeyIdentifier !== undefined) bus.kmsKeyId = input.KmsKeyIdentifier;
    if (input.DeadLetterConfig !== undefined) bus.deadLetterConfig = input.DeadLetterConfig;
    bus.lastModified = Date.now();
    const out = { Name: bus.name, Arn: bus.arn };
    if (bus.description !== undefined) out.Description = bus.description;
    if (bus.kmsKeyId !== undefined) out.KmsKeyIdentifier = bus.kmsKeyId;
    if (bus.deadLetterConfig !== undefined) out.DeadLetterConfig = bus.deadLetterConfig;
    return out;
  }

  // -------------------------------------------------------------------------
  // Permissions (resource policy on an event bus)
  // -------------------------------------------------------------------------
  putPermission(input = {}) {
    const busName = this.resolveBusName(input);
    const bus = this.requireBus(busName);
    if (input.Policy) {
      // Policy-document form replaces the entire policy.
      bus.policy = input.Policy;
    } else {
      if (!input.Action || !input.Principal || !input.StatementId) {
        throw new EventBridgeError(
          "ValidationException",
          "PutPermission requires either Policy or Action+Principal+StatementId.",
        );
      }
      let policy;
      try {
        policy = bus.policy ? JSON.parse(bus.policy) : { Version: "2012-10-17", Statement: [] };
      } catch {
        policy = { Version: "2012-10-17", Statement: [] };
      }
      policy.Statement = (policy.Statement || []).filter((s) => s.Sid !== input.StatementId);
      policy.Statement.push({
        Sid: input.StatementId,
        Effect: "Allow",
        Principal:
          input.Principal === "*" ? "*" : { AWS: `arn:aws:iam::${input.Principal}:root` },
        Action: input.Action,
        Resource: bus.arn,
        ...(input.Condition ? { Condition: { [input.Condition.Type]: { [input.Condition.Key]: input.Condition.Value } } } : {}),
      });
      bus.policy = JSON.stringify(policy);
    }
    bus.lastModified = Date.now();
    return {};
  }

  removePermission(input = {}) {
    const busName = this.resolveBusName(input);
    const bus = this.requireBus(busName);
    if (input.RemoveAllPermissions === true) {
      bus.policy = undefined;
      bus.lastModified = Date.now();
      return {};
    }
    if (!input.StatementId) {
      throw new EventBridgeError(
        "ValidationException",
        "RemovePermission requires StatementId or RemoveAllPermissions.",
      );
    }
    if (!bus.policy) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `StatementId ${input.StatementId} was not found.`,
      );
    }
    let policy;
    try {
      policy = JSON.parse(bus.policy);
    } catch {
      policy = { Statement: [] };
    }
    const before = (policy.Statement || []).length;
    policy.Statement = (policy.Statement || []).filter((s) => s.Sid !== input.StatementId);
    if (policy.Statement.length === before) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `StatementId ${input.StatementId} was not found.`,
      );
    }
    bus.policy = policy.Statement.length ? JSON.stringify(policy) : undefined;
    bus.lastModified = Date.now();
    return {};
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------
  ruleKey(busName, ruleName) {
    return `${busName}/${ruleName}`;
  }

  putRule(input = {}) {
    const name = input.Name;
    this.validateName(name, "Name", 64);
    const busName = this.resolveBusName(input);
    this.requireBus(busName);

    if (!input.EventPattern && !input.ScheduleExpression) {
      throw new EventBridgeError(
        "ValidationException",
        "Parameter(s) EventPattern or ScheduleExpression must be specified.",
      );
    }
    if (input.EventPattern) {
      validateEventPattern(input.EventPattern);
    }
    const state = input.State || "ENABLED";
    if (!["ENABLED", "DISABLED", "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"].includes(state)) {
      throw new EventBridgeError("ValidationException", `Invalid State: ${state}`);
    }

    const key = this.ruleKey(busName, name);
    const existing = this.rules.get(key);
    const now = Date.now();
    const rule = {
      name,
      busName,
      arn: this.ruleArn(name, busName),
      eventPattern: input.EventPattern,
      scheduleExpression: input.ScheduleExpression,
      state,
      description: input.Description,
      roleArn: input.RoleArn,
      eventBusName: busName,
      managedBy: existing ? existing.managedBy : undefined,
      tags: existing ? existing.tags : this.coerceTags(input.Tags),
      createdAt: existing ? existing.createdAt : now,
    };
    this.rules.set(key, rule);
    if (!this.targets.has(key)) this.targets.set(key, new Map());
    return { RuleArn: rule.arn };
  }

  requireRule(busName, ruleName) {
    const rule = this.rules.get(this.ruleKey(busName, ruleName));
    if (!rule) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `Rule ${ruleName} does not exist on EventBus ${busName}.`,
      );
    }
    return rule;
  }

  deleteRule(input = {}) {
    const busName = this.resolveBusName(input);
    const key = this.ruleKey(busName, input.Name);
    const rule = this.rules.get(key);
    if (rule && rule.managedBy && input.Force !== true) {
      throw new EventBridgeError(
        "ManagedRuleException",
        "This rule is managed by an AWS service and cannot be deleted without Force.",
      );
    }
    const targets = this.targets.get(key);
    if (targets && targets.size > 0 && input.Force !== true) {
      throw new EventBridgeError(
        "ValidationException",
        "Rule can't be deleted since it has targets. Remove all targets before deleting the rule, or set Force=true.",
      );
    }
    // DeleteRule is idempotent.
    this.rules.delete(key);
    this.targets.delete(key);
    return {};
  }

  describeRule(input = {}) {
    const busName = this.resolveBusName(input);
    const rule = this.requireRule(busName, input.Name);
    const out = {
      Name: rule.name,
      Arn: rule.arn,
      State: rule.state,
      EventBusName: rule.busName,
      CreatedBy: this.accountId,
    };
    if (rule.eventPattern !== undefined) out.EventPattern = rule.eventPattern;
    if (rule.scheduleExpression !== undefined) out.ScheduleExpression = rule.scheduleExpression;
    if (rule.description !== undefined) out.Description = rule.description;
    if (rule.roleArn !== undefined) out.RoleArn = rule.roleArn;
    if (rule.managedBy !== undefined) out.ManagedBy = rule.managedBy;
    return out;
  }

  setRuleState(input, state) {
    const busName = this.resolveBusName(input);
    const rule = this.requireRule(busName, input.Name);
    rule.state = state;
    return {};
  }

  enableRule(input) {
    return this.setRuleState(input, "ENABLED");
  }

  disableRule(input) {
    return this.setRuleState(input, "DISABLED");
  }

  ruleSummary(rule) {
    const out = {
      Name: rule.name,
      Arn: rule.arn,
      State: rule.state,
      EventBusName: rule.busName,
    };
    if (rule.eventPattern !== undefined) out.EventPattern = rule.eventPattern;
    if (rule.scheduleExpression !== undefined) out.ScheduleExpression = rule.scheduleExpression;
    if (rule.description !== undefined) out.Description = rule.description;
    if (rule.roleArn !== undefined) out.RoleArn = rule.roleArn;
    if (rule.managedBy !== undefined) out.ManagedBy = rule.managedBy;
    return out;
  }

  listRules(input = {}) {
    const busName = this.resolveBusName(input);
    this.requireBus(busName);
    let rules = [...this.rules.values()].filter((r) => r.busName === busName);
    if (input.NamePrefix) {
      rules = rules.filter((r) => r.name.startsWith(input.NamePrefix));
    }
    rules.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(rules, input.NextToken, input.Limit || 100);
    const out = { Rules: page.map((r) => this.ruleSummary(r)) };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  listRuleNamesByTarget(input = {}) {
    const targetArn = input.TargetArn;
    if (!targetArn) {
      throw new EventBridgeError("ValidationException", "TargetArn is required.");
    }
    const busName = this.resolveBusName(input);
    const matched = [];
    for (const [key, targetMap] of this.targets) {
      if (!key.startsWith(`${busName}/`)) continue;
      for (const t of targetMap.values()) {
        if (t.Arn === targetArn) {
          const rule = this.rules.get(key);
          if (rule) matched.push(rule.name);
          break;
        }
      }
    }
    matched.sort();
    const { page, nextToken } = this.paginate(matched, input.NextToken, input.Limit || 100);
    const out = { RuleNames: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  // -------------------------------------------------------------------------
  // Targets
  // -------------------------------------------------------------------------
  putTargets(input = {}) {
    const busName = this.resolveBusName(input);
    const rule = this.requireRule(busName, input.Rule);
    const targets = input.Targets || [];
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new EventBridgeError("ValidationException", "Targets list must not be empty.");
    }
    if (targets.length > 5) {
      throw new EventBridgeError(
        "LimitExceededException",
        "You can only add up to 5 targets per request.",
      );
    }
    const key = this.ruleKey(busName, rule.name);
    if (!this.targets.has(key)) this.targets.set(key, new Map());
    const store = this.targets.get(key);

    const failedEntries = [];
    let failedCount = 0;
    for (const t of targets) {
      if (!t.Id || !t.Arn) {
        failedCount += 1;
        failedEntries.push({
          TargetId: t.Id,
          ErrorCode: "ValidationException",
          ErrorMessage: "Target Id and Arn are required.",
        });
        continue;
      }
      store.set(t.Id, { ...t });
    }
    const out = { FailedEntryCount: failedCount, FailedEntries: failedEntries };
    return out;
  }

  removeTargets(input = {}) {
    const busName = this.resolveBusName(input);
    const rule = this.requireRule(busName, input.Rule);
    const key = this.ruleKey(busName, rule.name);
    const store = this.targets.get(key) || new Map();
    const ids = input.Ids || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new EventBridgeError("ValidationException", "Ids list must not be empty.");
    }
    const failedEntries = [];
    let failedCount = 0;
    for (const id of ids) {
      if (!store.has(id)) {
        // Removing a missing target is not an error in AWS unless Force semantics
        // differ; we treat it as a soft failure entry to mirror behaviour.
        failedCount += 0; // AWS returns success for missing ids.
      }
      store.delete(id);
    }
    return { FailedEntryCount: failedCount, FailedEntries: failedEntries };
  }

  listTargetsByRule(input = {}) {
    const busName = this.resolveBusName(input);
    const rule = this.requireRule(busName, input.Rule);
    const key = this.ruleKey(busName, rule.name);
    const store = this.targets.get(key) || new Map();
    const all = [...store.values()];
    const { page, nextToken } = this.paginate(all, input.NextToken, input.Limit || 100);
    const out = { Targets: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  // -------------------------------------------------------------------------
  // PutEvents / PutPartnerEvents
  // -------------------------------------------------------------------------
  putEventsOp(input = {}) {
    const entries = input.Entries || [];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new EventBridgeError("ValidationException", "Entries list must not be empty.");
    }
    if (entries.length > 10) {
      throw new EventBridgeError(
        "ValidationException",
        "1 validation error detected: Value at 'entries' failed to satisfy constraint: Member must have length less than or equal to 10.",
      );
    }
    const resultEntries = [];
    let failedCount = 0;
    for (const entry of entries) {
      // EventBridge requires Source, DetailType and Detail; missing fields yield
      // a per-entry error rather than a request failure.
      const missing = [];
      if (!entry.Source) missing.push("Source");
      if (!entry.DetailType) missing.push("DetailType");
      if (entry.Detail === undefined) missing.push("Detail");
      if (missing.length) {
        failedCount += 1;
        resultEntries.push({
          ErrorCode: "ValidationException",
          ErrorMessage: `Parameter(s) ${missing.join(", ")} not valid. Reason: required.`,
        });
        continue;
      }
      // Detail must be a JSON object string.
      if (entry.Detail !== undefined) {
        try {
          const parsed = JSON.parse(entry.Detail);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not object");
          }
        } catch {
          failedCount += 1;
          resultEntries.push({
            ErrorCode: "MalformedDetail",
            ErrorMessage: "Detail is malformed.",
          });
          continue;
        }
      }

      const eventId = randomUUID();
      const busName = entry.EventBusName
        ? entry.EventBusName.startsWith("arn:")
          ? entry.EventBusName.split("/").pop()
          : entry.EventBusName
        : DEFAULT_EVENT_BUS;

      const record = {
        eventId,
        source: entry.Source,
        detailType: entry.DetailType,
        detail: entry.Detail,
        resources: entry.Resources || [],
        time: entry.Time || new Date().toISOString(),
        eventBusName: busName,
        traceHeader: entry.TraceHeader,
        receivedAt: Date.now(),
      };
      this.putEvents.push(record);
      this.routeEvent(record);

      resultEntries.push({ EventId: eventId });
    }
    return { FailedEntryCount: failedCount, Entries: resultEntries };
  }

  // Build the canonical event envelope used for pattern matching and route it
  // to any matching, enabled rules on the same event bus.
  routeEvent(record) {
    let detailObj = {};
    try {
      detailObj = record.detail ? JSON.parse(record.detail) : {};
    } catch {
      detailObj = {};
    }
    const envelope = {
      id: record.eventId,
      "detail-type": record.detailType,
      source: record.source,
      account: this.accountId,
      time: record.time,
      region: this.region,
      resources: record.resources,
      detail: detailObj,
    };
    for (const [key, rule] of this.rules) {
      if (!key.startsWith(`${record.eventBusName}/`)) continue;
      if (rule.state !== "ENABLED" && rule.state !== "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS") continue;
      if (!rule.eventPattern) continue;
      let pattern;
      try {
        pattern = JSON.parse(rule.eventPattern);
      } catch {
        continue;
      }
      if (matchPattern(pattern, envelope)) {
        this.routedEvents.push({
          ruleArn: rule.arn,
          ruleName: rule.name,
          eventBus: record.eventBusName,
          event: envelope,
        });
      }
    }
  }

  putPartnerEvents(input = {}) {
    const entries = input.Entries || [];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new EventBridgeError("ValidationException", "Entries list must not be empty.");
    }
    const resultEntries = [];
    let failedCount = 0;
    for (const entry of entries) {
      if (!entry.Source) {
        failedCount += 1;
        resultEntries.push({
          ErrorCode: "ValidationException",
          ErrorMessage: "Parameter Source is required.",
        });
        continue;
      }
      resultEntries.push({ EventId: randomUUID() });
    }
    return { FailedEntryCount: failedCount, Entries: resultEntries };
  }

  // -------------------------------------------------------------------------
  // TestEventPattern
  // -------------------------------------------------------------------------
  testEventPattern(input = {}) {
    if (!input.EventPattern) {
      throw new EventBridgeError("ValidationException", "EventPattern is required.");
    }
    if (!input.Event) {
      throw new EventBridgeError("ValidationException", "Event is required.");
    }
    const pattern = validateEventPattern(input.EventPattern);
    let event;
    try {
      event = JSON.parse(input.Event);
    } catch {
      throw new EventBridgeError(
        "InvalidEventPatternException",
        "Event is not valid JSON.",
      );
    }
    // EventBridge requires the test event to carry the standard envelope fields.
    for (const f of ["id", "account", "source", "time", "region", "detail-type"]) {
      if (event[f] === undefined) {
        throw new EventBridgeError(
          "ValidationException",
          `Event must contain the field "${f}".`,
        );
      }
    }
    return { Result: matchPattern(pattern, event) };
  }

  // -------------------------------------------------------------------------
  // Archives
  // -------------------------------------------------------------------------
  createArchive(input = {}) {
    const name = input.ArchiveName;
    this.validateName(name, "ArchiveName", 48);
    if (this.archives.has(name)) {
      throw new EventBridgeError(
        "ResourceAlreadyExistsException",
        `Archive ${name} already exists.`,
      );
    }
    if (!input.EventSourceArn) {
      throw new EventBridgeError("ValidationException", "EventSourceArn is required.");
    }
    if (input.EventPattern) validateEventPattern(input.EventPattern);
    const now = Date.now();
    const archive = {
      name,
      arn: this.archiveArn(name),
      eventSourceArn: input.EventSourceArn,
      description: input.Description,
      eventPattern: input.EventPattern,
      retentionDays: input.RetentionDays ?? 0,
      state: "ENABLED",
      eventCount: 0,
      sizeBytes: 0,
      createdAt: now,
    };
    this.archives.set(name, archive);
    return {
      ArchiveArn: archive.arn,
      State: archive.state,
      StateReason: undefined,
      CreationTime: epochSeconds(now),
    };
  }

  requireArchive(name) {
    const a = this.archives.get(name);
    if (!a) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `Archive ${name} does not exist.`,
      );
    }
    return a;
  }

  deleteArchive(input = {}) {
    this.requireArchive(input.ArchiveName);
    this.archives.delete(input.ArchiveName);
    return {};
  }

  describeArchive(input = {}) {
    const a = this.requireArchive(input.ArchiveName);
    const out = {
      ArchiveArn: a.arn,
      ArchiveName: a.name,
      EventSourceArn: a.eventSourceArn,
      State: a.state,
      RetentionDays: a.retentionDays,
      EventCount: a.eventCount,
      SizeBytes: a.sizeBytes,
      CreationTime: epochSeconds(a.createdAt),
    };
    if (a.description !== undefined) out.Description = a.description;
    if (a.eventPattern !== undefined) out.EventPattern = a.eventPattern;
    return out;
  }

  listArchives(input = {}) {
    let archives = [...this.archives.values()];
    if (input.NamePrefix) archives = archives.filter((a) => a.name.startsWith(input.NamePrefix));
    if (input.EventSourceArn) archives = archives.filter((a) => a.eventSourceArn === input.EventSourceArn);
    if (input.State) archives = archives.filter((a) => a.state === input.State);
    archives.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(archives, input.NextToken, input.Limit || 100);
    const out = {
      Archives: page.map((a) => ({
        ArchiveName: a.name,
        EventSourceArn: a.eventSourceArn,
        State: a.state,
        RetentionDays: a.retentionDays,
        EventCount: a.eventCount,
        SizeBytes: a.sizeBytes,
        CreationTime: epochSeconds(a.createdAt),
      })),
    };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  updateArchive(input = {}) {
    const a = this.requireArchive(input.ArchiveName);
    if (input.EventPattern !== undefined) {
      if (input.EventPattern) validateEventPattern(input.EventPattern);
      a.eventPattern = input.EventPattern;
    }
    if (input.Description !== undefined) a.description = input.Description;
    if (input.RetentionDays !== undefined) a.retentionDays = input.RetentionDays;
    return {
      ArchiveArn: a.arn,
      State: a.state,
      CreationTime: epochSeconds(a.createdAt),
    };
  }

  // -------------------------------------------------------------------------
  // Replays
  // -------------------------------------------------------------------------
  startReplay(input = {}) {
    const name = input.ReplayName;
    this.validateName(name, "ReplayName", 64);
    if (this.replays.has(name)) {
      throw new EventBridgeError(
        "ResourceAlreadyExistsException",
        `Replay ${name} already exists.`,
      );
    }
    if (!input.EventSourceArn) {
      throw new EventBridgeError("ValidationException", "EventSourceArn is required.");
    }
    if (!input.Destination || !input.Destination.Arn) {
      throw new EventBridgeError("ValidationException", "Destination.Arn is required.");
    }
    if (input.EventStartTime === undefined || input.EventEndTime === undefined) {
      throw new EventBridgeError(
        "ValidationException",
        "EventStartTime and EventEndTime are required.",
      );
    }
    const now = Date.now();
    const replay = {
      name,
      arn: this.replayArn(name),
      eventSourceArn: input.EventSourceArn,
      destination: input.Destination,
      eventStartTime: input.EventStartTime,
      eventEndTime: input.EventEndTime,
      description: input.Description,
      // Replays complete instantly in the fake.
      state: "COMPLETED",
      stateReason: "Replay completed.",
      startTime: now,
      endTime: now,
      lastReplayedTime: now,
    };
    this.replays.set(name, replay);
    return {
      ReplayArn: replay.arn,
      State: "STARTING",
      StateReason: undefined,
      ReplayStartTime: epochSeconds(now),
    };
  }

  requireReplay(name) {
    const r = this.replays.get(name);
    if (!r) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `Replay ${name} does not exist.`,
      );
    }
    return r;
  }

  cancelReplay(input = {}) {
    const r = this.requireReplay(input.ReplayName);
    if (r.state === "COMPLETED") {
      throw new EventBridgeError(
        "IllegalStatusException",
        "Replay has already completed and cannot be cancelled.",
      );
    }
    r.state = "CANCELLED";
    r.stateReason = "Replay cancelled.";
    return { ReplayArn: r.arn, State: r.state, StateReason: r.stateReason };
  }

  describeReplay(input = {}) {
    const r = this.requireReplay(input.ReplayName);
    const out = {
      ReplayName: r.name,
      ReplayArn: r.arn,
      EventSourceArn: r.eventSourceArn,
      Destination: r.destination,
      State: r.state,
      EventStartTime: r.eventStartTime,
      EventEndTime: r.eventEndTime,
      EventLastReplayedTime: epochSeconds(r.lastReplayedTime),
      ReplayStartTime: epochSeconds(r.startTime),
      ReplayEndTime: epochSeconds(r.endTime),
    };
    if (r.description !== undefined) out.Description = r.description;
    if (r.stateReason !== undefined) out.StateReason = r.stateReason;
    return out;
  }

  listReplays(input = {}) {
    let replays = [...this.replays.values()];
    if (input.NamePrefix) replays = replays.filter((r) => r.name.startsWith(input.NamePrefix));
    if (input.State) replays = replays.filter((r) => r.state === input.State);
    if (input.EventSourceArn) replays = replays.filter((r) => r.eventSourceArn === input.EventSourceArn);
    replays.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(replays, input.NextToken, input.Limit || 100);
    const out = {
      Replays: page.map((r) => ({
        ReplayName: r.name,
        EventSourceArn: r.eventSourceArn,
        State: r.state,
        StateReason: r.stateReason,
        EventStartTime: r.eventStartTime,
        EventEndTime: r.eventEndTime,
        EventLastReplayedTime: epochSeconds(r.lastReplayedTime),
        ReplayStartTime: epochSeconds(r.startTime),
        ReplayEndTime: epochSeconds(r.endTime),
      })),
    };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------
  createConnection(input = {}) {
    const name = input.Name;
    this.validateName(name, "Name", 64);
    if (this.connections.has(name)) {
      throw new EventBridgeError(
        "ResourceAlreadyExistsException",
        `Connection ${name} already exists.`,
      );
    }
    if (!input.AuthorizationType) {
      throw new EventBridgeError("ValidationException", "AuthorizationType is required.");
    }
    if (!input.AuthParameters) {
      throw new EventBridgeError("ValidationException", "AuthParameters is required.");
    }
    const now = Date.now();
    const conn = {
      name,
      arn: this.connectionArn(name),
      authorizationType: input.AuthorizationType,
      authParameters: input.AuthParameters,
      description: input.Description,
      state: "AUTHORIZED",
      secretArn: `arn:aws:secretsmanager:${this.region}:${this.accountId}:secret:events!connection/${name}/${randomUUID()}`,
      createdAt: now,
      lastModified: now,
      lastAuthorized: now,
    };
    this.connections.set(name, conn);
    return {
      ConnectionArn: conn.arn,
      ConnectionState: conn.state,
      CreationTime: epochSeconds(now),
      LastModifiedTime: epochSeconds(now),
    };
  }

  requireConnection(name) {
    // Name may be an ARN.
    let key = name;
    if (typeof name === "string" && name.startsWith("arn:")) {
      const part = name.split(":connection/").pop();
      if (part) key = part.split("/")[0];
    }
    const c = this.connections.get(key);
    if (!c) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `Connection ${name} does not exist.`,
      );
    }
    return c;
  }

  deleteConnection(input = {}) {
    const c = this.requireConnection(input.Name);
    this.connections.delete(c.name);
    return {
      ConnectionArn: c.arn,
      ConnectionState: "DELETING",
      CreationTime: epochSeconds(c.createdAt),
      LastModifiedTime: epochSeconds(c.lastModified),
      LastAuthorizedTime: epochSeconds(c.lastAuthorized),
    };
  }

  describeConnection(input = {}) {
    const c = this.requireConnection(input.Name);
    const out = {
      ConnectionArn: c.arn,
      Name: c.name,
      ConnectionState: c.state,
      AuthorizationType: c.authorizationType,
      SecretArn: c.secretArn,
      CreationTime: epochSeconds(c.createdAt),
      LastModifiedTime: epochSeconds(c.lastModified),
      LastAuthorizedTime: epochSeconds(c.lastAuthorized),
    };
    if (c.description !== undefined) out.Description = c.description;
    // AuthParameters are returned redacted by AWS; echo a redacted shape.
    out.AuthParameters = this.redactAuthParameters(c.authParameters);
    return out;
  }

  redactAuthParameters(params) {
    if (!params || typeof params !== "object") return params;
    const clone = JSON.parse(JSON.stringify(params));
    // AWS hides secret values like API key value, password, client secret.
    if (clone.ApiKeyAuthParameters) {
      delete clone.ApiKeyAuthParameters.ApiKeyValue;
    }
    if (clone.BasicAuthParameters) {
      delete clone.BasicAuthParameters.Password;
    }
    if (clone.OAuthParameters && clone.OAuthParameters.ClientParameters) {
      delete clone.OAuthParameters.ClientParameters.ClientSecret;
    }
    return clone;
  }

  listConnections(input = {}) {
    let conns = [...this.connections.values()];
    if (input.NamePrefix) conns = conns.filter((c) => c.name.startsWith(input.NamePrefix));
    if (input.ConnectionState) conns = conns.filter((c) => c.state === input.ConnectionState);
    conns.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(conns, input.NextToken, input.Limit || 100);
    const out = {
      Connections: page.map((c) => ({
        ConnectionArn: c.arn,
        Name: c.name,
        ConnectionState: c.state,
        AuthorizationType: c.authorizationType,
        CreationTime: epochSeconds(c.createdAt),
        LastModifiedTime: epochSeconds(c.lastModified),
        LastAuthorizedTime: epochSeconds(c.lastAuthorized),
      })),
    };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  updateConnection(input = {}) {
    const c = this.requireConnection(input.Name);
    if (input.AuthorizationType !== undefined) c.authorizationType = input.AuthorizationType;
    if (input.AuthParameters !== undefined) c.authParameters = input.AuthParameters;
    if (input.Description !== undefined) c.description = input.Description;
    c.lastModified = Date.now();
    c.lastAuthorized = Date.now();
    c.state = "AUTHORIZED";
    return {
      ConnectionArn: c.arn,
      ConnectionState: c.state,
      CreationTime: epochSeconds(c.createdAt),
      LastModifiedTime: epochSeconds(c.lastModified),
      LastAuthorizedTime: epochSeconds(c.lastAuthorized),
    };
  }

  deauthorizeConnection(input = {}) {
    const c = this.requireConnection(input.Name);
    c.state = "DEAUTHORIZED";
    c.lastModified = Date.now();
    return {
      ConnectionArn: c.arn,
      ConnectionState: c.state,
      CreationTime: epochSeconds(c.createdAt),
      LastModifiedTime: epochSeconds(c.lastModified),
      LastAuthorizedTime: epochSeconds(c.lastAuthorized),
    };
  }

  // -------------------------------------------------------------------------
  // API destinations
  // -------------------------------------------------------------------------
  createApiDestination(input = {}) {
    const name = input.Name;
    this.validateName(name, "Name", 64);
    if (this.apiDestinations.has(name)) {
      throw new EventBridgeError(
        "ResourceAlreadyExistsException",
        `ApiDestination ${name} already exists.`,
      );
    }
    if (!input.ConnectionArn) {
      throw new EventBridgeError("ValidationException", "ConnectionArn is required.");
    }
    if (!input.InvocationEndpoint) {
      throw new EventBridgeError("ValidationException", "InvocationEndpoint is required.");
    }
    if (!input.HttpMethod) {
      throw new EventBridgeError("ValidationException", "HttpMethod is required.");
    }
    const now = Date.now();
    const dest = {
      name,
      arn: this.apiDestinationArn(name),
      connectionArn: input.ConnectionArn,
      invocationEndpoint: input.InvocationEndpoint,
      httpMethod: input.HttpMethod,
      invocationRateLimitPerSecond: input.InvocationRateLimitPerSecond ?? 300,
      description: input.Description,
      state: "ACTIVE",
      createdAt: now,
      lastModified: now,
    };
    this.apiDestinations.set(name, dest);
    return {
      ApiDestinationArn: dest.arn,
      ApiDestinationState: dest.state,
      CreationTime: epochSeconds(now),
      LastModifiedTime: epochSeconds(now),
    };
  }

  requireApiDestination(name) {
    let key = name;
    if (typeof name === "string" && name.startsWith("arn:")) {
      const part = name.split(":api-destination/").pop();
      if (part) key = part.split("/")[0];
    }
    const d = this.apiDestinations.get(key);
    if (!d) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `ApiDestination ${name} does not exist.`,
      );
    }
    return d;
  }

  deleteApiDestination(input = {}) {
    this.requireApiDestination(input.Name);
    const d = this.requireApiDestination(input.Name);
    this.apiDestinations.delete(d.name);
    return {};
  }

  describeApiDestination(input = {}) {
    const d = this.requireApiDestination(input.Name);
    const out = {
      ApiDestinationArn: d.arn,
      Name: d.name,
      ApiDestinationState: d.state,
      ConnectionArn: d.connectionArn,
      InvocationEndpoint: d.invocationEndpoint,
      HttpMethod: d.httpMethod,
      InvocationRateLimitPerSecond: d.invocationRateLimitPerSecond,
      CreationTime: epochSeconds(d.createdAt),
      LastModifiedTime: epochSeconds(d.lastModified),
    };
    if (d.description !== undefined) out.Description = d.description;
    return out;
  }

  listApiDestinations(input = {}) {
    let dests = [...this.apiDestinations.values()];
    if (input.NamePrefix) dests = dests.filter((d) => d.name.startsWith(input.NamePrefix));
    if (input.ConnectionArn) dests = dests.filter((d) => d.connectionArn === input.ConnectionArn);
    dests.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(dests, input.NextToken, input.Limit || 100);
    const out = {
      ApiDestinations: page.map((d) => ({
        ApiDestinationArn: d.arn,
        Name: d.name,
        ApiDestinationState: d.state,
        ConnectionArn: d.connectionArn,
        InvocationEndpoint: d.invocationEndpoint,
        HttpMethod: d.httpMethod,
        InvocationRateLimitPerSecond: d.invocationRateLimitPerSecond,
        CreationTime: epochSeconds(d.createdAt),
        LastModifiedTime: epochSeconds(d.lastModified),
      })),
    };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  updateApiDestination(input = {}) {
    const d = this.requireApiDestination(input.Name);
    if (input.ConnectionArn !== undefined) d.connectionArn = input.ConnectionArn;
    if (input.InvocationEndpoint !== undefined) d.invocationEndpoint = input.InvocationEndpoint;
    if (input.HttpMethod !== undefined) d.httpMethod = input.HttpMethod;
    if (input.InvocationRateLimitPerSecond !== undefined) {
      d.invocationRateLimitPerSecond = input.InvocationRateLimitPerSecond;
    }
    if (input.Description !== undefined) d.description = input.Description;
    d.lastModified = Date.now();
    return {
      ApiDestinationArn: d.arn,
      ApiDestinationState: d.state,
      CreationTime: epochSeconds(d.createdAt),
      LastModifiedTime: epochSeconds(d.lastModified),
    };
  }

  // -------------------------------------------------------------------------
  // Global endpoints
  // -------------------------------------------------------------------------
  createEndpoint(input = {}) {
    const name = input.Name;
    this.validateName(name, "Name", 64);
    if (this.endpoints.has(name)) {
      throw new EventBridgeError(
        "ResourceAlreadyExistsException",
        `Endpoint ${name} already exists.`,
      );
    }
    if (!input.RoutingConfig) {
      throw new EventBridgeError("ValidationException", "RoutingConfig is required.");
    }
    if (!input.EventBuses || input.EventBuses.length === 0) {
      throw new EventBridgeError("ValidationException", "EventBuses is required.");
    }
    const now = Date.now();
    const endpoint = {
      name,
      arn: this.endpointArn(name),
      routingConfig: input.RoutingConfig,
      replicationConfig: input.ReplicationConfig,
      eventBuses: input.EventBuses,
      roleArn: input.RoleArn,
      description: input.Description,
      endpointId: randomUUID().slice(0, 8),
      state: "ACTIVE",
      createdAt: now,
      lastModified: now,
    };
    endpoint.endpointUrl = `https://${endpoint.endpointId}.endpoint.events.amazonaws.com`;
    this.endpoints.set(name, endpoint);
    return {
      Name: endpoint.name,
      Arn: endpoint.arn,
      RoutingConfig: endpoint.routingConfig,
      ReplicationConfig: endpoint.replicationConfig,
      EventBuses: endpoint.eventBuses,
      RoleArn: endpoint.roleArn,
      State: "CREATING",
    };
  }

  requireEndpoint(name) {
    const e = this.endpoints.get(name);
    if (!e) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `Endpoint ${name} does not exist.`,
      );
    }
    return e;
  }

  deleteEndpoint(input = {}) {
    this.requireEndpoint(input.Name);
    this.endpoints.delete(input.Name);
    return {};
  }

  describeEndpoint(input = {}) {
    const e = this.requireEndpoint(input.Name);
    const out = {
      Name: e.name,
      Arn: e.arn,
      RoutingConfig: e.routingConfig,
      EventBuses: e.eventBuses,
      State: e.state,
      EndpointId: e.endpointId,
      EndpointUrl: e.endpointUrl,
      CreationTime: epochSeconds(e.createdAt),
      LastModifiedTime: epochSeconds(e.lastModified),
    };
    if (e.replicationConfig !== undefined) out.ReplicationConfig = e.replicationConfig;
    if (e.roleArn !== undefined) out.RoleArn = e.roleArn;
    if (e.description !== undefined) out.Description = e.description;
    return out;
  }

  listEndpoints(input = {}) {
    let endpoints = [...this.endpoints.values()];
    if (input.NamePrefix) endpoints = endpoints.filter((e) => e.name.startsWith(input.NamePrefix));
    if (input.HomeRegion) {
      // No-op filter in the fake; home region is always the configured region.
    }
    endpoints.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(endpoints, input.NextToken, input.MaxResults || 100);
    const out = {
      Endpoints: page.map((e) => ({
        Name: e.name,
        Arn: e.arn,
        RoutingConfig: e.routingConfig,
        ReplicationConfig: e.replicationConfig,
        EventBuses: e.eventBuses,
        RoleArn: e.roleArn,
        EndpointId: e.endpointId,
        EndpointUrl: e.endpointUrl,
        State: e.state,
        Description: e.description,
        CreationTime: epochSeconds(e.createdAt),
        LastModifiedTime: epochSeconds(e.lastModified),
      })),
    };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  updateEndpoint(input = {}) {
    const e = this.requireEndpoint(input.Name);
    if (input.RoutingConfig !== undefined) e.routingConfig = input.RoutingConfig;
    if (input.ReplicationConfig !== undefined) e.replicationConfig = input.ReplicationConfig;
    if (input.EventBuses !== undefined) e.eventBuses = input.EventBuses;
    if (input.RoleArn !== undefined) e.roleArn = input.RoleArn;
    if (input.Description !== undefined) e.description = input.Description;
    e.lastModified = Date.now();
    return {
      Name: e.name,
      Arn: e.arn,
      RoutingConfig: e.routingConfig,
      ReplicationConfig: e.replicationConfig,
      EventBuses: e.eventBuses,
      RoleArn: e.roleArn,
      EndpointId: e.endpointId,
      EndpointUrl: e.endpointUrl,
      State: "UPDATING",
    };
  }

  // -------------------------------------------------------------------------
  // Partner event sources (producer side)
  // -------------------------------------------------------------------------
  createPartnerEventSource(input = {}) {
    const name = input.Name;
    if (!name) {
      throw new EventBridgeError("ValidationException", "Name is required.");
    }
    if (!input.Account) {
      throw new EventBridgeError("ValidationException", "Account is required.");
    }
    if (this.partnerEventSources.has(name)) {
      throw new EventBridgeError(
        "ResourceAlreadyExistsException",
        `Partner event source ${name} already exists.`,
      );
    }
    const now = Date.now();
    const pes = {
      name,
      account: input.Account,
      arn: `arn:aws:events:${this.region}::event-source/aws.partner/${name}`,
      state: "PENDING",
      createdBy: name.split("/")[0],
      createdAt: now,
    };
    this.partnerEventSources.set(name, pes);
    return { EventSourceArn: pes.arn };
  }

  requirePartnerEventSource(name) {
    const p = this.partnerEventSources.get(name);
    if (!p) {
      throw new EventBridgeError(
        "ResourceNotFoundException",
        `Partner event source ${name} does not exist.`,
      );
    }
    return p;
  }

  deletePartnerEventSource(input = {}) {
    // Idempotent.
    this.partnerEventSources.delete(input.Name);
    return {};
  }

  describePartnerEventSource(input = {}) {
    const p = this.requirePartnerEventSource(input.Name);
    return { Arn: p.arn, Name: p.name };
  }

  listPartnerEventSources(input = {}) {
    const prefix = input.NamePrefix || "";
    let list = [...this.partnerEventSources.values()].filter((p) => p.name.startsWith(prefix));
    list.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(list, input.NextToken, input.Limit || 100);
    const out = {
      PartnerEventSources: page.map((p) => ({ Arn: p.arn, Name: p.name })),
    };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  listPartnerEventSourceAccounts(input = {}) {
    const p = this.requirePartnerEventSource(input.EventSourceName);
    const out = {
      PartnerEventSourceAccounts: [
        {
          Account: p.account,
          CreationTime: epochSeconds(p.createdAt),
          State: p.state,
        },
      ],
    };
    return out;
  }

  // -------------------------------------------------------------------------
  // Event sources (partner-managed, consumer side)
  // -------------------------------------------------------------------------
  describeEventSource(input = {}) {
    const p = this.requirePartnerEventSource(input.Name);
    return {
      Arn: p.arn,
      Name: p.name,
      CreatedBy: p.createdBy,
      CreationTime: epochSeconds(p.createdAt),
      State: p.state,
    };
  }

  listEventSources(input = {}) {
    const prefix = input.NamePrefix || "";
    let list = [...this.partnerEventSources.values()].filter((p) => p.name.startsWith(prefix));
    list.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(list, input.NextToken, input.Limit || 100);
    const out = {
      EventSources: page.map((p) => ({
        Arn: p.arn,
        Name: p.name,
        CreatedBy: p.createdBy,
        CreationTime: epochSeconds(p.createdAt),
        State: p.state,
      })),
    };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  activateEventSource(input = {}) {
    const p = this.requirePartnerEventSource(input.Name);
    p.state = "ACTIVE";
    return {};
  }

  deactivateEventSource(input = {}) {
    const p = this.requirePartnerEventSource(input.Name);
    p.state = "DELETED";
    return {};
  }

  // -------------------------------------------------------------------------
  // Tagging
  // -------------------------------------------------------------------------
  // Resolve a taggable resource (rule, event bus, or archive) by ARN.
  resolveTaggable(arn) {
    if (typeof arn !== "string") {
      throw new EventBridgeError("ValidationException", "ResourceARN is required.");
    }
    if (arn.includes(":event-bus/")) {
      const name = arn.split(":event-bus/").pop();
      const bus = this.eventBuses.get(name);
      if (bus) return bus;
    }
    if (arn.includes(":rule/")) {
      const tail = arn.split(":rule/").pop();
      // tail is either "ruleName" or "busName/ruleName".
      const parts = tail.split("/");
      let busName = DEFAULT_EVENT_BUS;
      let ruleName = tail;
      if (parts.length === 2) {
        busName = parts[0];
        ruleName = parts[1];
      }
      const rule = this.rules.get(this.ruleKey(busName, ruleName));
      if (rule) return rule;
    }
    if (arn.includes(":archive/")) {
      const name = arn.split(":archive/").pop();
      const a = this.archives.get(name);
      if (a) return a;
    }
    throw new EventBridgeError(
      "ResourceNotFoundException",
      `Resource ${arn} does not exist.`,
    );
  }

  tagResource(input = {}) {
    const res = this.resolveTaggable(input.ResourceARN);
    if (!res.tags) res.tags = new Map();
    for (const t of input.Tags || []) {
      if (t && t.Key !== undefined) res.tags.set(t.Key, t.Value ?? "");
    }
    return {};
  }

  untagResource(input = {}) {
    const res = this.resolveTaggable(input.ResourceARN);
    if (!res.tags) res.tags = new Map();
    for (const k of input.TagKeys || []) res.tags.delete(k);
    return {};
  }

  listTagsForResource(input = {}) {
    const res = this.resolveTaggable(input.ResourceARN);
    return { Tags: this.tagList(res.tags || new Map()) };
  }

  // -------------------------------------------------------------------------
  // Pagination helper (NextToken is a base64 offset)
  // -------------------------------------------------------------------------
  paginate(items, nextToken, pageSize) {
    const size = pageSize && pageSize > 0 ? pageSize : 100;
    let start = 0;
    if (nextToken) {
      const decoded = parseInt(
        Buffer.from(String(nextToken), "base64").toString("utf8"),
        10,
      );
      if (!Number.isNaN(decoded)) start = decoded;
    }
    const page = items.slice(start, start + size);
    let token;
    if (start + size < items.length) {
      token = Buffer.from(String(start + size)).toString("base64");
    }
    return { page, nextToken: token };
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
    const code = error.code || "InternalException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(
      JSON.stringify({
        __type: code,
        message: error.message || code,
        Message: error.message || code,
      }),
    );
  }
}

export default EventbridgeServer;
export const TARGET_PREFIX_EVENTBRIDGE = TARGET_PREFIX;
export { matchPattern, validateEventPattern };
