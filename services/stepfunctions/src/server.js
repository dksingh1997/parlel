// parlel/stepfunctions — a lightweight, dependency-free fake of AWS Step
// Functions (AWS States Language / SFN).
//
// Speaks the Step Functions AWS JSON 1.0 wire protocol so application code using
// the real `@aws-sdk/client-sfn` client can run against it with zero cost and
// zero side effects. Pure Node.js, no external npm dependencies. State is
// in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-sfn v3):
//   * Requests are POST / with header `X-Amz-Target: AWSStepFunctions.<Operation>`
//     and `Content-Type: application/x-amz-json-1.0`. Body is JSON input.
//   * Success: 200, JSON output, `Content-Type: application/x-amz-json-1.0`.
//   * Error: non-2xx, JSON `{ "__type": "<Code>", "message": "<msg>" }` plus the
//     `x-amzn-errortype: <Code>` header. The SDK resolves the error name from
//     `__type` in the body first, then the header.
//   * `StartSyncExecution` and `TestState` normally use a `sync-` host prefix;
//     point the client at this server with `disableHostPrefix: true` (or just
//     POST to `/` — this fake serves every operation from one listener).
//
// As a bonus over a pure mock, this fake includes a real (if compact) Amazon
// States Language interpreter: Pass, Task, Choice, Wait, Succeed, Fail,
// Parallel, and Map states are actually executed, with JSONPath
// InputPath/OutputPath/ResultPath/Parameters/ResultSelector processing,
// Retry/Catch, intrinsic functions, and a recorded execution history — so
// StartExecution / DescribeExecution / GetExecutionHistory return real results.
//
// Task states resolve via a pluggable resolver. By default, a Task returns its
// effective input unchanged (an identity task), which is enough for most flow
// testing. A test/app can register `_parlelTask` resolvers per Resource ARN, or
// use the `.waitForTaskToken` integration pattern with the activity / callback
// task-token APIs (SendTaskSuccess / SendTaskFailure / SendTaskHeartbeat).

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.0";
const DEFAULT_ACCOUNT_ID = "123456789012";
const TARGET_PREFIX = "AWSStepFunctions";

// SFN error codes -> HTTP status. AWS JSON 1.0 returns 400 for most modeled
// client errors; 500 for internal faults.
const ERROR_STATUS = {
  ActivityDoesNotExist: 400,
  ActivityLimitExceeded: 400,
  ActivityWorkerLimitExceeded: 400,
  ConflictException: 400,
  ExecutionAlreadyExists: 400,
  ExecutionDoesNotExist: 400,
  ExecutionLimitExceeded: 400,
  ExecutionNotRedrivable: 400,
  InvalidArn: 400,
  InvalidDefinition: 400,
  InvalidExecutionInput: 400,
  InvalidLoggingConfiguration: 400,
  InvalidName: 400,
  InvalidOutput: 400,
  InvalidToken: 400,
  InvalidTracingConfiguration: 400,
  MissingRequiredParameter: 400,
  ResourceNotFound: 400,
  StateMachineAlreadyExists: 400,
  StateMachineDeleting: 400,
  StateMachineDoesNotExist: 400,
  StateMachineLimitExceeded: 400,
  StateMachineTypeNotSupported: 400,
  TaskDoesNotExist: 400,
  TaskTimedOut: 400,
  TooManyTags: 400,
  ValidationException: 400,
  ServiceQuotaExceededException: 400,
  KmsAccessDeniedException: 400,
  KmsInvalidStateException: 400,
  KmsThrottlingException: 400,
  InternalServerException: 500,
};

class SfnError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

const NAME_RE = /^[a-zA-Z0-9-_]+$/;
const ARN_RE = /^arn:aws[a-zA-Z-]*:states:/;

// A States.* failure used to drive ASL Retry/Catch on the error name.
class StatesError extends Error {
  constructor(errorName, cause) {
    super(cause || errorName);
    this.errorName = errorName;
    this.cause = cause;
  }
}

// ===========================================================================
// JSONPath / payload / intrinsic helpers (module scope, pure functions)
// ===========================================================================
function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

// Recursively convert Date instances to epoch-seconds numbers (awsJson1_0).
function datesToEpoch(value) {
  if (value instanceof Date) return value.getTime() / 1000;
  if (Array.isArray(value)) return value.map(datesToEpoch);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = datesToEpoch(v);
    }
    return out;
  }
  return value;
}

function safeParse(str) {
  if (str === undefined || str === null) return {};
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripPattern(resource) {
  return String(resource || "").replace(/\.(waitForTaskToken|sync|sync:2)$/, "");
}

function matchesError(errorEquals, errorName) {
  if (!Array.isArray(errorEquals)) return false;
  if (errorEquals.includes("States.ALL")) return true;
  if (errorEquals.includes(errorName)) return true;
  // States.TaskFailed is a catch-all for task errors except a few system ones.
  if (
    errorEquals.includes("States.TaskFailed") &&
    !["States.Timeout", "States.Permissions", "States.ResultPathMatchFailure"].includes(errorName)
  ) {
    return true;
  }
  return false;
}

// AWS States glob matching: '*' wildcard, '\' escapes.
function globMatch(pattern, value) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      re += escapeRegExp(pattern[++i]);
    } else if (ch === "*") {
      re += ".*";
    } else {
      re += escapeRegExp(ch);
    }
  }
  return new RegExp("^" + re + "$").test(value);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Apply InputPath / OutputPath. null => {}; undefined => identity.
function applyPath(value, path) {
  if (path === undefined) return value;
  if (path === null) return {};
  return queryPath(value, path);
}

// Evaluate a JSONPath against data (subset: $, $.a.b, $['a'], $.a[0], $$ context).
function queryPath(data, path, ctx) {
  if (typeof path !== "string") return path;
  if (path.startsWith("$$")) return queryContext(ctx, path.slice(1));
  if (path === "$") return data;
  if (!path.startsWith("$")) return path;
  const tokens = tokenizePath(path.slice(1));
  let current = data;
  for (const tok of tokens) {
    if (current === undefined || current === null) {
      throw new StatesError("States.Runtime", `Invalid path '${path}': item does not exist.`);
    }
    current = current[tok];
  }
  if (current === undefined) {
    throw new StatesError("States.Runtime", `Invalid path '${path}': item does not exist.`);
  }
  return current;
}

function hasPath(data, path, ctx) {
  try {
    queryPath(data, path, ctx);
    return true;
  } catch {
    return false;
  }
}

function queryContext(ctx, path) {
  // path begins with '$' referencing the Context Object.
  if (path === "$") return ctx;
  const tokens = tokenizePath(path.slice(1));
  let current = ctx;
  for (const tok of tokens) {
    if (current == null) {
      throw new StatesError("States.Runtime", `Invalid context path '${path}'.`);
    }
    current = current[tok];
  }
  return current;
}

function tokenizePath(p) {
  // Convert ".a.b[0]['c']" into ['a','b',0,'c'].
  const tokens = [];
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === ".") {
      i++;
      let name = "";
      while (i < p.length && p[i] !== "." && p[i] !== "[") name += p[i++];
      if (name) tokens.push(name);
    } else if (ch === "[") {
      i++;
      if (p[i] === "'" || p[i] === '"') {
        const quote = p[i++];
        let name = "";
        while (i < p.length && p[i] !== quote) name += p[i++];
        i++; // closing quote
        if (p[i] === "]") i++;
        tokens.push(name);
      } else {
        let num = "";
        while (i < p.length && p[i] !== "]") num += p[i++];
        i++; // closing ]
        tokens.push(Number(num));
      }
    } else {
      // bare leading token
      let name = "";
      while (i < p.length && p[i] !== "." && p[i] !== "[") name += p[i++];
      if (name) tokens.push(name);
    }
  }
  return tokens;
}

// Set a value at a JSONPath (used by ResultPath). Creates intermediate objects.
function setPath(data, path, value) {
  if (path === "$") return value;
  const tokens = tokenizePath(path.slice(1));
  if (tokens.length === 0) return value;
  let current = data;
  if (current === undefined || current === null || typeof current !== "object") current = {};
  let cursor = current;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    if (cursor[tok] === undefined || cursor[tok] === null || typeof cursor[tok] !== "object") {
      cursor[tok] = typeof tokens[i + 1] === "number" ? [] : {};
    }
    cursor = cursor[tok];
  }
  cursor[tokens[tokens.length - 1]] = value;
  return current;
}

// Intrinsic functions: States.Format, States.StringToJson, States.JsonToString,
// States.Array, States.ArrayLength, States.MathAdd, States.MathRandom,
// States.StringSplit, States.UUID, States.ArrayGetItem, States.ArrayContains,
// States.ArrayRange, States.ArrayPartition, States.ArrayUnique, States.Base64Encode,
// States.Base64Decode, States.Hash, States.JsonMerge, States.MathAdd.
function evalIntrinsic(expr, input, ctx) {
  const match = expr.match(/^States\.([A-Za-z]+)\((.*)\)$/s);
  if (!match) throw new StatesError("States.IntrinsicFailure", `Invalid intrinsic: ${expr}`);
  const fn = match[1];
  const args = parseIntrinsicArgs(match[2], input, ctx);
  switch (fn) {
    case "Format": {
      const [tmpl, ...rest] = args;
      let idx = 0;
      return String(tmpl).replace(/\{\}/g, () => formatArg(rest[idx++]));
    }
    case "StringToJson":
      return args[0] === undefined || args[0] === "" ? null : JSON.parse(args[0]);
    case "JsonToString":
      return JSON.stringify(args[0]);
    case "Array":
      return args;
    case "ArrayLength":
      return Array.isArray(args[0]) ? args[0].length : 0;
    case "ArrayGetItem":
      return args[0][args[1]];
    case "ArrayContains":
      return Array.isArray(args[0]) && args[0].some((x) => JSON.stringify(x) === JSON.stringify(args[1]));
    case "ArrayRange": {
      const [start, end, step] = args;
      const out = [];
      for (let v = start; step > 0 ? v <= end : v >= end; v += step) out.push(v);
      return out;
    }
    case "ArrayPartition": {
      const [arr, size] = args;
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    }
    case "ArrayUnique": {
      const seen = new Set();
      return args[0].filter((x) => {
        const k = JSON.stringify(x);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case "MathAdd":
      return args[0] + args[1];
    case "MathRandom": {
      const [lo, hi] = args;
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }
    case "StringSplit":
      return String(args[0]).split(args[1]).filter((s) => s.length > 0);
    case "UUID":
      return randomUUID();
    case "Base64Encode":
      return Buffer.from(String(args[0]), "utf8").toString("base64");
    case "Base64Decode":
      return Buffer.from(String(args[0]), "base64").toString("utf8");
    case "Hash": {
      const [data, algo] = args;
      const map = { MD5: "md5", "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };
      return createHash(map[algo] || "sha256").update(String(data)).digest("hex");
    }
    case "JsonMerge": {
      const [a, b] = args;
      return { ...a, ...b };
    }
    default:
      throw new StatesError("States.IntrinsicFailure", `Unsupported intrinsic States.${fn}`);
  }
}

function formatArg(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function parseIntrinsicArgs(argStr, input, ctx) {
  const args = [];
  let i = 0;
  const s = argStr.trim();
  while (i < s.length) {
    while (i < s.length && (s[i] === " " || s[i] === ",")) i++;
    if (i >= s.length) break;
    if (s[i] === "'") {
      // single-quoted string literal, '\'' escapes
      i++;
      let str = "";
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && s[i + 1] === "'") {
          str += "'";
          i += 2;
        } else {
          str += s[i++];
        }
      }
      i++; // closing quote
      args.push(str);
    } else {
      let token = "";
      let depth = 0;
      while (i < s.length && (depth > 0 || (s[i] !== "," ))) {
        if (s[i] === "(") depth++;
        if (s[i] === ")") depth--;
        token += s[i++];
      }
      token = token.trim();
      if (token.startsWith("$$")) args.push(queryContext(ctx, token.slice(1)));
      else if (token.startsWith("$")) args.push(queryPath(input, token, ctx));
      else if (/^States\./.test(token)) args.push(evalIntrinsic(token, input, ctx));
      else if (token === "true") args.push(true);
      else if (token === "false") args.push(false);
      else if (token === "null") args.push(null);
      else if (!Number.isNaN(Number(token))) args.push(Number(token));
      else args.push(token);
    }
  }
  return args;
}

export class StepfunctionsServer {
  constructor(port = 4577, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // stateMachines: Map<arn, StateMachine>
    //   StateMachine = { name, arn, definition, roleArn, type, status,
    //     creationDate, loggingConfiguration, tracingConfiguration,
    //     encryptionConfiguration, revisionId, description,
    //     tags: Map, versions: Map<number,Version>, versionCounter,
    //     aliases: Map<name, Alias> }
    this.stateMachines = new Map();
    // activities: Map<arn, Activity> = { name, arn, creationDate, tags, tasks: [] }
    this.activities = new Map();
    // executions: Map<arn, Execution>
    this.executions = new Map();
    // taskTokens: Map<token, { executionArn, resolve, reject, heartbeatAt }>
    this.taskTokens = new Map();
    // mapRuns: Map<arn, MapRun>
    this.mapRuns = new Map();
    // per-Resource task resolvers registered out of band (parlel extension)
    this.taskResolvers = new Map();
    this.smNameIndex = new Map(); // name -> arn (latest)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new SfnError("InternalServerException", error.message, 500));
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
      // Reject any in-flight waitForTaskToken promises so timers clear.
      for (const entry of this.taskTokens.values()) {
        if (entry.reject) {
          try {
            entry.reject(new StatesError("States.Timeout", "server stopped"));
          } catch {
            // ignore
          }
        }
      }
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
  stateMachineArn(name) {
    return `arn:aws:states:${this.region}:${this.accountId}:stateMachine:${name}`;
  }

  activityArn(name) {
    return `arn:aws:states:${this.region}:${this.accountId}:activity:${name}`;
  }

  executionArn(smName, execName) {
    return `arn:aws:states:${this.region}:${this.accountId}:execution:${smName}:${execName}`;
  }

  expressExecutionArn(smName, execName) {
    return `arn:aws:states:${this.region}:${this.accountId}:express:${smName}:${execName}:${randomUUID()}`;
  }

  mapRunArn(smName, execName, mapStateLabel) {
    return `arn:aws:states:${this.region}:${this.accountId}:mapRun:${smName}/${execName}:${mapStateLabel}`;
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
        service: "stepfunctions",
        stateMachines: this.stateMachines.size,
        executions: this.executions.size,
        activities: this.activities.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-stepfunctions");

    if (method !== "POST") {
      return this.sendError(
        res,
        new SfnError("ValidationException", "Only POST is supported by the parlel stepfunctions fake.", 400),
      );
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new SfnError("ValidationException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = await this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof SfnError) return this.sendError(res, error);
      throw error;
    }
  }

  async dispatch(operation, input) {
    switch (operation) {
      // State machines
      case "CreateStateMachine":
        return this.createStateMachine(input);
      case "UpdateStateMachine":
        return this.updateStateMachine(input);
      case "DeleteStateMachine":
        return this.deleteStateMachine(input);
      case "DescribeStateMachine":
        return this.describeStateMachine(input);
      case "ListStateMachines":
        return this.listStateMachines(input);
      case "ValidateStateMachineDefinition":
        return this.validateStateMachineDefinition(input);
      // Versions
      case "PublishStateMachineVersion":
        return this.publishStateMachineVersion(input);
      case "ListStateMachineVersions":
        return this.listStateMachineVersions(input);
      case "DeleteStateMachineVersion":
        return this.deleteStateMachineVersion(input);
      // Aliases
      case "CreateStateMachineAlias":
        return this.createStateMachineAlias(input);
      case "UpdateStateMachineAlias":
        return this.updateStateMachineAlias(input);
      case "DescribeStateMachineAlias":
        return this.describeStateMachineAlias(input);
      case "ListStateMachineAliases":
        return this.listStateMachineAliases(input);
      case "DeleteStateMachineAlias":
        return this.deleteStateMachineAlias(input);
      // Executions
      case "StartExecution":
        return this.startExecution(input);
      case "StartSyncExecution":
        return this.startSyncExecution(input);
      case "StopExecution":
        return this.stopExecution(input);
      case "DescribeExecution":
        return this.describeExecution(input);
      case "ListExecutions":
        return this.listExecutions(input);
      case "GetExecutionHistory":
        return this.getExecutionHistory(input);
      case "DescribeStateMachineForExecution":
        return this.describeStateMachineForExecution(input);
      case "RedriveExecution":
        return this.redriveExecution(input);
      // Activities
      case "CreateActivity":
        return this.createActivity(input);
      case "DeleteActivity":
        return this.deleteActivity(input);
      case "DescribeActivity":
        return this.describeActivity(input);
      case "ListActivities":
        return this.listActivities(input);
      case "GetActivityTask":
        return this.getActivityTask(input);
      // Task tokens / callbacks
      case "SendTaskSuccess":
        return this.sendTaskSuccess(input);
      case "SendTaskFailure":
        return this.sendTaskFailure(input);
      case "SendTaskHeartbeat":
        return this.sendTaskHeartbeat(input);
      // Map runs
      case "DescribeMapRun":
        return this.describeMapRun(input);
      case "ListMapRuns":
        return this.listMapRuns(input);
      case "UpdateMapRun":
        return this.updateMapRun(input);
      // State testing
      case "TestState":
        return this.testState(input);
      // Tags
      case "TagResource":
        return this.tagResource(input);
      case "UntagResource":
        return this.untagResource(input);
      case "ListTagsForResource":
        return this.listTagsForResource(input);
      default:
        throw new SfnError(
          "ValidationException",
          `Unknown operation ${operation || "(none)"} for ${TARGET_PREFIX}.`,
          400,
        );
    }
  }

  // =========================================================================
  // STATE MACHINES
  // =========================================================================
  parseDefinition(definition) {
    if (typeof definition !== "string") {
      throw new SfnError("InvalidDefinition", "Definition must be a JSON string.");
    }
    let parsed;
    try {
      parsed = JSON.parse(definition);
    } catch {
      throw new SfnError("InvalidDefinition", "Definition is not valid JSON.");
    }
    this.validateAsl(parsed);
    return parsed;
  }

  validateAsl(def) {
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      throw new SfnError("InvalidDefinition", "Definition must be a JSON object.");
    }
    if (typeof def.StartAt !== "string" || !def.StartAt) {
      throw new SfnError("InvalidDefinition", "SCHEMA_VALIDATION_FAILED: Missing 'StartAt' field.");
    }
    if (!def.States || typeof def.States !== "object") {
      throw new SfnError("InvalidDefinition", "SCHEMA_VALIDATION_FAILED: Missing 'States' field.");
    }
    if (!Object.prototype.hasOwnProperty.call(def.States, def.StartAt)) {
      throw new SfnError(
        "InvalidDefinition",
        `SCHEMA_VALIDATION_FAILED: 'StartAt' references unknown state '${def.StartAt}'.`,
      );
    }
    const valid = new Set(["Pass", "Task", "Choice", "Wait", "Succeed", "Fail", "Parallel", "Map"]);
    for (const [name, state] of Object.entries(def.States)) {
      if (!state || typeof state !== "object") {
        throw new SfnError("InvalidDefinition", `SCHEMA_VALIDATION_FAILED: State '${name}' is not an object.`);
      }
      if (!valid.has(state.Type)) {
        throw new SfnError(
          "InvalidDefinition",
          `SCHEMA_VALIDATION_FAILED: State '${name}' has invalid Type '${state.Type}'.`,
        );
      }
      const terminal = state.Type === "Succeed" || state.Type === "Fail" || state.End === true;
      const hasNext = typeof state.Next === "string";
      if (!terminal && !hasNext && state.Type !== "Choice") {
        throw new SfnError(
          "InvalidDefinition",
          `SCHEMA_VALIDATION_FAILED: State '${name}' must have 'Next' or 'End: true'.`,
        );
      }
      if (hasNext && !Object.prototype.hasOwnProperty.call(def.States, state.Next)) {
        throw new SfnError(
          "InvalidDefinition",
          `SCHEMA_VALIDATION_FAILED: State '${name}' Next references unknown state '${state.Next}'.`,
        );
      }
    }
  }

  createStateMachine(input) {
    const name = input.name;
    if (typeof name !== "string" || !name) {
      throw new SfnError("InvalidName", "State machine name is required.");
    }
    if (!NAME_RE.test(name) || name.length > 80) {
      throw new SfnError("InvalidName", `Invalid State Machine name: '${name}'.`);
    }
    if (!input.roleArn || typeof input.roleArn !== "string") {
      throw new SfnError("MissingRequiredParameter", "roleArn is required.");
    }
    const type = input.type || "STANDARD";
    if (type !== "STANDARD" && type !== "EXPRESS") {
      throw new SfnError("ValidationException", `Invalid type '${type}'.`);
    }
    const definition = this.parseDefinition(input.definition);
    const arn = this.stateMachineArn(name);

    const existing = this.stateMachines.get(arn);
    if (existing) {
      // Idempotent create only if everything matches; otherwise conflict.
      if (existing.rawDefinition === input.definition && existing.roleArn === input.roleArn) {
        return { stateMachineArn: arn, creationDate: existing.creationDate };
      }
      throw new SfnError("StateMachineAlreadyExists", `State Machine Already Exists: '${arn}'.`);
    }

    const now = Math.floor(Date.now() / 1000);
    const sm = {
      name,
      arn,
      definition,
      rawDefinition: input.definition,
      roleArn: input.roleArn,
      type,
      status: "ACTIVE",
      creationDate: now,
      description: input.description,
      loggingConfiguration: input.loggingConfiguration || { level: "OFF" },
      tracingConfiguration: input.tracingConfiguration || { enabled: false },
      encryptionConfiguration: input.encryptionConfiguration || { type: "AWS_OWNED_KEY" },
      revisionId: randomUUID(),
      tags: new Map(),
      versions: new Map(),
      versionCounter: 0,
      aliases: new Map(),
    };
    if (Array.isArray(input.tags)) {
      this.validateAndApplyTags(sm.tags, input.tags);
    }
    this.stateMachines.set(arn, sm);
    this.smNameIndex.set(name, arn);

    const result = { stateMachineArn: arn, creationDate: now };
    if (input.publish) {
      const v = this.publishVersion(sm, input.versionDescription);
      result.stateMachineVersionArn = v.arn;
    }
    return result;
  }

  resolveStateMachine(arn, { allowVersionAlias = true } = {}) {
    if (typeof arn !== "string" || !ARN_RE.test(arn)) {
      throw new SfnError("InvalidArn", `Invalid Arn: '${arn}'.`);
    }
    // Direct state machine match
    const direct = this.stateMachines.get(arn);
    if (direct) return { sm: direct };

    if (allowVersionAlias) {
      // Version ARN: ...:stateMachine:Name:<version>
      const versionMatch = arn.match(/:stateMachine:([^:]+):(\d+)$/);
      if (versionMatch) {
        const baseArn = this.stateMachineArn(versionMatch[1]);
        const sm = this.stateMachines.get(baseArn);
        const v = sm && sm.versions.get(Number(versionMatch[2]));
        if (sm && v) return { sm, version: v };
      }
      // Alias ARN: ...:stateMachine:Name:aliasName (non-numeric qualifier)
      const aliasMatch = arn.match(/:stateMachine:([^:]+):([^:]+)$/);
      if (aliasMatch && !/^\d+$/.test(aliasMatch[2])) {
        const baseArn = this.stateMachineArn(aliasMatch[1]);
        const sm = this.stateMachines.get(baseArn);
        const alias = sm && sm.aliases.get(aliasMatch[2]);
        if (sm && alias) return { sm, alias };
      }
    }
    throw new SfnError("StateMachineDoesNotExist", `State Machine Does Not Exist: '${arn}'.`);
  }

  describeStateMachine(input) {
    const { sm, version } = this.resolveStateMachine(input.stateMachineArn);
    const def = version ? version.definition : sm.definition;
    const rawDef = version ? version.rawDefinition : sm.rawDefinition;
    const roleArn = version ? version.roleArn : sm.roleArn;
    const arn = version ? version.arn : sm.arn;
    return {
      stateMachineArn: arn,
      name: sm.name,
      status: sm.status,
      definition: rawDef,
      roleArn,
      type: sm.type,
      creationDate: new Date((version ? version.creationDate : sm.creationDate) * 1000),
      loggingConfiguration: sm.loggingConfiguration,
      tracingConfiguration: sm.tracingConfiguration,
      encryptionConfiguration: sm.encryptionConfiguration,
      revisionId: version ? version.revisionId : sm.revisionId,
      description: version ? version.description : sm.description,
      ...(version ? {} : {}),
      label: undefined,
    };
  }

  updateStateMachine(input) {
    const { sm } = this.resolveStateMachine(input.stateMachineArn, { allowVersionAlias: false });
    if (
      input.definition === undefined &&
      input.roleArn === undefined &&
      input.loggingConfiguration === undefined &&
      input.tracingConfiguration === undefined &&
      input.encryptionConfiguration === undefined &&
      !input.publish
    ) {
      throw new SfnError("MissingRequiredParameter", "MissingRequiredParameter: Must update at least one field.");
    }
    if (input.definition !== undefined) {
      sm.definition = this.parseDefinition(input.definition);
      sm.rawDefinition = input.definition;
    }
    if (input.roleArn !== undefined) sm.roleArn = input.roleArn;
    if (input.loggingConfiguration !== undefined) sm.loggingConfiguration = input.loggingConfiguration;
    if (input.tracingConfiguration !== undefined) sm.tracingConfiguration = input.tracingConfiguration;
    if (input.encryptionConfiguration !== undefined) sm.encryptionConfiguration = input.encryptionConfiguration;
    sm.revisionId = randomUUID();
    const updateDate = new Date();
    const result = { updateDate };
    if (input.publish) {
      const v = this.publishVersion(sm, input.versionDescription);
      result.stateMachineVersionArn = v.arn;
    }
    return result;
  }

  deleteStateMachine(input) {
    if (typeof input.stateMachineArn !== "string" || !ARN_RE.test(input.stateMachineArn)) {
      throw new SfnError("InvalidArn", `Invalid Arn: '${input.stateMachineArn}'.`);
    }
    // Delete is idempotent — returns success even if absent.
    this.stateMachines.delete(input.stateMachineArn);
    return {};
  }

  listStateMachines(input) {
    const items = [...this.stateMachines.values()].map((sm) => ({
      stateMachineArn: sm.arn,
      name: sm.name,
      type: sm.type,
      creationDate: new Date(sm.creationDate * 1000),
    }));
    return this.paginate(items, input, "stateMachines");
  }

  validateStateMachineDefinition(input) {
    const diagnostics = [];
    let result = "OK";
    try {
      const parsed = JSON.parse(input.definition);
      this.validateAsl(parsed);
    } catch (err) {
      result = "FAIL";
      diagnostics.push({
        severity: "ERROR",
        code: "SCHEMA_VALIDATION_FAILED",
        message: err.message,
      });
    }
    return { result, diagnostics };
  }

  // =========================================================================
  // VERSIONS
  // =========================================================================
  publishVersion(sm, description) {
    sm.versionCounter += 1;
    const num = sm.versionCounter;
    const version = {
      number: num,
      arn: `${sm.arn}:${num}`,
      definition: sm.definition,
      rawDefinition: sm.rawDefinition,
      roleArn: sm.roleArn,
      revisionId: sm.revisionId,
      description,
      creationDate: Math.floor(Date.now() / 1000),
    };
    sm.versions.set(num, version);
    return version;
  }

  publishStateMachineVersion(input) {
    const { sm } = this.resolveStateMachine(input.stateMachineArn, { allowVersionAlias: false });
    const v = this.publishVersion(sm, input.description);
    return { stateMachineVersionArn: v.arn, creationDate: new Date(v.creationDate * 1000) };
  }

  listStateMachineVersions(input) {
    const { sm } = this.resolveStateMachine(input.stateMachineArn, { allowVersionAlias: false });
    const items = [...sm.versions.values()]
      .sort((a, b) => b.number - a.number)
      .map((v) => ({ stateMachineVersionArn: v.arn, creationDate: new Date(v.creationDate * 1000) }));
    return this.paginate(items, input, "stateMachineVersions");
  }

  deleteStateMachineVersion(input) {
    const arn = input.stateMachineVersionArn;
    if (typeof arn !== "string" || !ARN_RE.test(arn)) {
      throw new SfnError("InvalidArn", `Invalid Arn: '${arn}'.`);
    }
    const match = arn.match(/:stateMachine:([^:]+):(\d+)$/);
    if (match) {
      const sm = this.stateMachines.get(this.stateMachineArn(match[1]));
      if (sm) sm.versions.delete(Number(match[2]));
    }
    return {};
  }

  // =========================================================================
  // ALIASES
  // =========================================================================
  parseAliasArn(aliasArn) {
    const m = (aliasArn || "").match(/:stateMachine:([^:]+):([^:]+)$/);
    if (!m || /^\d+$/.test(m[2])) {
      throw new SfnError("InvalidArn", `Invalid Alias Arn: '${aliasArn}'.`);
    }
    const sm = this.stateMachines.get(this.stateMachineArn(m[1]));
    if (!sm) throw new SfnError("ResourceNotFound", `Resource not found: '${aliasArn}'.`);
    return { sm, aliasName: m[2] };
  }

  validateRoutingConfig(sm, routing) {
    if (!Array.isArray(routing) || routing.length < 1) {
      throw new SfnError("ValidationException", "routingConfiguration must contain at least one entry.");
    }
    let total = 0;
    for (const r of routing) {
      const m = (r.stateMachineVersionArn || "").match(/:stateMachine:([^:]+):(\d+)$/);
      if (!m || !sm.versions.get(Number(m[2]))) {
        throw new SfnError("ResourceNotFound", `Version not found: '${r.stateMachineVersionArn}'.`);
      }
      total += r.weight || 0;
    }
    if (total !== 100) {
      throw new SfnError("ValidationException", "routingConfiguration weights must sum to 100.");
    }
  }

  createStateMachineAlias(input) {
    const name = input.name;
    if (typeof name !== "string" || !NAME_RE.test(name) || name.length > 80) {
      throw new SfnError("InvalidName", `Invalid Alias name: '${name}'.`);
    }
    const routing = input.routingConfiguration;
    const arnFromRouting = routing && routing[0] && routing[0].stateMachineVersionArn;
    const m = (arnFromRouting || "").match(/:stateMachine:([^:]+):\d+$/);
    if (!m) throw new SfnError("InvalidArn", `Invalid version Arn in routingConfiguration.`);
    const sm = this.stateMachines.get(this.stateMachineArn(m[1]));
    if (!sm) throw new SfnError("ResourceNotFound", `State machine not found for alias.`);
    this.validateRoutingConfig(sm, routing);
    if (sm.aliases.has(name)) {
      throw new SfnError("ConflictException", `Alias already exists: '${name}'.`);
    }
    const aliasArn = `${sm.arn}:${name}`;
    const alias = {
      name,
      arn: aliasArn,
      description: input.description,
      routingConfiguration: routing,
      creationDate: Math.floor(Date.now() / 1000),
      updateDate: Math.floor(Date.now() / 1000),
    };
    sm.aliases.set(name, alias);
    return { stateMachineAliasArn: aliasArn, creationDate: new Date(alias.creationDate * 1000) };
  }

  updateStateMachineAlias(input) {
    const { sm, aliasName } = this.parseAliasArn(input.stateMachineAliasArn);
    const alias = sm.aliases.get(aliasName);
    if (!alias) throw new SfnError("ResourceNotFound", `Alias not found: '${input.stateMachineAliasArn}'.`);
    if (input.routingConfiguration !== undefined) {
      this.validateRoutingConfig(sm, input.routingConfiguration);
      alias.routingConfiguration = input.routingConfiguration;
    }
    if (input.description !== undefined) alias.description = input.description;
    alias.updateDate = Math.floor(Date.now() / 1000);
    return { updateDate: new Date(alias.updateDate * 1000) };
  }

  describeStateMachineAlias(input) {
    const { sm, aliasName } = this.parseAliasArn(input.stateMachineAliasArn);
    const alias = sm.aliases.get(aliasName);
    if (!alias) throw new SfnError("ResourceNotFound", `Alias not found: '${input.stateMachineAliasArn}'.`);
    return {
      stateMachineAliasArn: alias.arn,
      name: alias.name,
      description: alias.description,
      routingConfiguration: alias.routingConfiguration,
      creationDate: new Date(alias.creationDate * 1000),
      updateDate: new Date(alias.updateDate * 1000),
    };
  }

  listStateMachineAliases(input) {
    const { sm } = this.resolveStateMachine(input.stateMachineArn, { allowVersionAlias: false });
    const items = [...sm.aliases.values()].map((a) => ({
      stateMachineAliasArn: a.arn,
      creationDate: new Date(a.creationDate * 1000),
    }));
    return this.paginate(items, input, "stateMachineAliases");
  }

  deleteStateMachineAlias(input) {
    const { sm, aliasName } = this.parseAliasArn(input.stateMachineAliasArn);
    sm.aliases.delete(aliasName);
    return {};
  }

  // =========================================================================
  // ACTIVITIES
  // =========================================================================
  createActivity(input) {
    const name = input.name;
    if (typeof name !== "string" || !name) {
      throw new SfnError("InvalidName", "Activity name is required.");
    }
    if (!NAME_RE.test(name) || name.length > 80) {
      throw new SfnError("InvalidName", `Invalid Activity name: '${name}'.`);
    }
    const arn = this.activityArn(name);
    const existing = this.activities.get(arn);
    if (existing) {
      return { activityArn: arn, creationDate: new Date(existing.creationDate * 1000) };
    }
    const now = Math.floor(Date.now() / 1000);
    const activity = { name, arn, creationDate: now, tags: new Map(), tasks: [] };
    if (Array.isArray(input.tags)) this.validateAndApplyTags(activity.tags, input.tags);
    this.activities.set(arn, activity);
    return { activityArn: arn, creationDate: new Date(now * 1000) };
  }

  describeActivity(input) {
    if (typeof input.activityArn !== "string" || !ARN_RE.test(input.activityArn)) {
      throw new SfnError("InvalidArn", `Invalid Arn: '${input.activityArn}'.`);
    }
    const activity = this.activities.get(input.activityArn);
    if (!activity) throw new SfnError("ActivityDoesNotExist", `Activity Does Not Exist: '${input.activityArn}'.`);
    return {
      activityArn: activity.arn,
      name: activity.name,
      creationDate: new Date(activity.creationDate * 1000),
    };
  }

  deleteActivity(input) {
    if (typeof input.activityArn !== "string" || !ARN_RE.test(input.activityArn)) {
      throw new SfnError("InvalidArn", `Invalid Arn: '${input.activityArn}'.`);
    }
    this.activities.delete(input.activityArn);
    return {};
  }

  listActivities(input) {
    const items = [...this.activities.values()].map((a) => ({
      activityArn: a.arn,
      name: a.name,
      creationDate: new Date(a.creationDate * 1000),
    }));
    return this.paginate(items, input, "activities");
  }

  getActivityTask(input) {
    if (typeof input.activityArn !== "string" || !ARN_RE.test(input.activityArn)) {
      throw new SfnError("InvalidArn", `Invalid Arn: '${input.activityArn}'.`);
    }
    const activity = this.activities.get(input.activityArn);
    if (!activity) throw new SfnError("ActivityDoesNotExist", `Activity Does Not Exist: '${input.activityArn}'.`);
    const pending = activity.tasks.shift();
    if (!pending) {
      // Real SFN long-polls up to 60s and returns nulls on timeout. We return
      // immediately with empty fields, which the SDK exposes as undefined.
      return { taskToken: undefined, input: undefined };
    }
    return { taskToken: pending.taskToken, input: pending.input };
  }

  // =========================================================================
  // EXECUTIONS
  // =========================================================================
  validateExecutionInput(input) {
    if (input === undefined || input === null || input === "") return "{}";
    if (typeof input !== "string") {
      throw new SfnError("InvalidExecutionInput", "Execution input must be a JSON string.");
    }
    try {
      JSON.parse(input);
    } catch {
      throw new SfnError("InvalidExecutionInput", "Invalid State Machine Execution Input: not valid JSON.");
    }
    return input;
  }

  startExecution(input) {
    const { sm, version, alias } = this.resolveStateMachine(input.stateMachineArn);
    const execName = input.name || randomUUID();
    if (!NAME_RE.test(execName) && !/^[\x20-\x7E]+$/.test(execName)) {
      throw new SfnError("InvalidName", `Invalid Execution name: '${execName}'.`);
    }
    const rawInput = this.validateExecutionInput(input.input);
    const execArn = this.executionArn(sm.name, execName);

    const existing = this.executions.get(execArn);
    if (existing) {
      if (existing.rawInput === rawInput) {
        return { executionArn: execArn, startDate: new Date(existing.startDate * 1000) };
      }
      throw new SfnError("ExecutionAlreadyExists", `Execution Already Exists: '${execArn}'.`);
    }

    const effectiveVersionArn = alias
      ? this.pickAliasVersion(sm, alias)
      : version
      ? version.arn
      : null;
    const def = version ? version.definition : sm.definition;

    const now = Date.now();
    const execution = {
      arn: execArn,
      name: execName,
      stateMachineArn: sm.arn,
      stateMachineVersionArn: effectiveVersionArn,
      stateMachineAliasArn: alias ? alias.arn : null,
      type: sm.type,
      status: "RUNNING",
      startDate: now / 1000,
      stopDate: null,
      rawInput,
      input: rawInput,
      output: null,
      error: null,
      cause: null,
      events: [],
      eventCounter: 0,
      redriveCount: 0,
      redriveStatus: "NOT_REDRIVABLE",
      traceHeader: input.traceHeader,
      definition: def,
      smName: sm.name,
    };
    this.executions.set(execArn, execution);

    // Run synchronously to completion (or until a callback pauses it). For the
    // fake, STANDARD executions still resolve synchronously unless a Task uses
    // waitForTaskToken, in which case the execution stays RUNNING.
    this.runExecution(execution).catch(() => {
      // Failures are recorded into the execution record itself.
    });

    return { executionArn: execArn, startDate: new Date(now) };
  }

  pickAliasVersion(sm, alias) {
    // Weighted pick; deterministic-ish (highest weight wins ties on first).
    let best = alias.routingConfiguration[0];
    for (const r of alias.routingConfiguration) {
      if ((r.weight || 0) > (best.weight || 0)) best = r;
    }
    return best.stateMachineVersionArn;
  }

  async startSyncExecution(input) {
    const { sm } = this.resolveStateMachine(input.stateMachineArn);
    if (sm.type !== "EXPRESS") {
      throw new SfnError(
        "StateMachineTypeNotSupported",
        "StartSyncExecution is not supported for STANDARD state machines.",
      );
    }
    const execName = input.name || randomUUID();
    const rawInput = this.validateExecutionInput(input.input);
    const execArn = this.expressExecutionArn(sm.name, execName);
    const now = Date.now();
    const execution = {
      arn: execArn,
      name: execName,
      stateMachineArn: sm.arn,
      type: "EXPRESS",
      status: "RUNNING",
      startDate: now / 1000,
      stopDate: null,
      rawInput,
      input: rawInput,
      output: null,
      error: null,
      cause: null,
      events: [],
      eventCounter: 0,
      definition: sm.definition,
      smName: sm.name,
      sync: true,
    };
    await this.runExecution(execution);
    return {
      executionArn: execArn,
      stateMachineArn: sm.arn,
      name: execName,
      startDate: new Date(execution.startDate * 1000),
      stopDate: new Date((execution.stopDate || Date.now() / 1000) * 1000),
      status: execution.status,
      input: rawInput,
      output: execution.output,
      error: execution.error || undefined,
      cause: execution.cause || undefined,
      billingDetails: { billedMemoryUsedInMB: 64, billedDurationInMilliseconds: 100 },
    };
  }

  stopExecution(input) {
    const execution = this.executions.get(input.executionArn);
    if (!execution) {
      throw new SfnError("ExecutionDoesNotExist", `Execution Does Not Exist: '${input.executionArn}'.`);
    }
    if (execution.status === "RUNNING") {
      execution.status = "ABORTED";
      execution.stopDate = Date.now() / 1000;
      execution.error = input.error || null;
      execution.cause = input.cause || null;
      execution.redriveStatus = "REDRIVABLE";
      this.addEvent(execution, "ExecutionAborted", {
        executionAbortedEventDetails: { error: input.error, cause: input.cause },
      });
    }
    return { stopDate: new Date((execution.stopDate || Date.now() / 1000) * 1000) };
  }

  describeExecution(input) {
    const execution = this.executions.get(input.executionArn);
    if (!execution) {
      throw new SfnError("ExecutionDoesNotExist", `Execution Does Not Exist: '${input.executionArn}'.`);
    }
    const out = {
      executionArn: execution.arn,
      stateMachineArn: execution.stateMachineArn,
      name: execution.name,
      status: execution.status,
      startDate: new Date(execution.startDate * 1000),
      input: execution.input,
      inputDetails: { included: true },
    };
    if (execution.stopDate) out.stopDate = new Date(execution.stopDate * 1000);
    if (execution.output !== null) {
      out.output = execution.output;
      out.outputDetails = { included: true };
    }
    if (execution.error) out.error = execution.error;
    if (execution.cause) out.cause = execution.cause;
    if (execution.stateMachineVersionArn) out.stateMachineVersionArn = execution.stateMachineVersionArn;
    if (execution.stateMachineAliasArn) out.stateMachineAliasArn = execution.stateMachineAliasArn;
    out.redriveCount = execution.redriveCount || 0;
    out.redriveStatus = execution.redriveStatus || "NOT_REDRIVABLE";
    if (execution.redriveDate) out.redriveDate = new Date(execution.redriveDate * 1000);
    return out;
  }

  listExecutions(input) {
    let items = [...this.executions.values()];
    if (input.stateMachineArn) {
      const { sm } = this.resolveStateMachine(input.stateMachineArn, { allowVersionAlias: false });
      items = items.filter((e) => e.stateMachineArn === sm.arn && !e.sync);
    } else {
      items = items.filter((e) => !e.sync);
    }
    if (input.statusFilter) {
      items = items.filter((e) => e.status === input.statusFilter);
    }
    items.sort((a, b) => b.startDate - a.startDate);
    const mapped = items.map((e) => {
      const item = {
        executionArn: e.arn,
        stateMachineArn: e.stateMachineArn,
        name: e.name,
        status: e.status,
        startDate: new Date(e.startDate * 1000),
      };
      if (e.stopDate) item.stopDate = new Date(e.stopDate * 1000);
      if (e.stateMachineVersionArn) item.stateMachineVersionArn = e.stateMachineVersionArn;
      if (e.stateMachineAliasArn) item.stateMachineAliasArn = e.stateMachineAliasArn;
      item.redriveCount = e.redriveCount || 0;
      return item;
    });
    return this.paginate(mapped, input, "executions");
  }

  describeStateMachineForExecution(input) {
    const execution = this.executions.get(input.executionArn);
    if (!execution) {
      throw new SfnError("ExecutionDoesNotExist", `Execution Does Not Exist: '${input.executionArn}'.`);
    }
    const sm = this.stateMachines.get(execution.stateMachineArn);
    if (!sm) throw new SfnError("StateMachineDoesNotExist", "Underlying state machine deleted.");
    return {
      stateMachineArn: sm.arn,
      name: sm.name,
      definition: sm.rawDefinition,
      roleArn: sm.roleArn,
      updateDate: new Date(sm.creationDate * 1000),
      loggingConfiguration: sm.loggingConfiguration,
      tracingConfiguration: sm.tracingConfiguration,
      encryptionConfiguration: sm.encryptionConfiguration,
      revisionId: sm.revisionId,
      mapRunArn: undefined,
    };
  }

  getExecutionHistory(input) {
    const execution = this.executions.get(input.executionArn);
    if (!execution) {
      throw new SfnError("ExecutionDoesNotExist", `Execution Does Not Exist: '${input.executionArn}'.`);
    }
    let events = execution.events.slice();
    if (input.reverseOrder) events = events.slice().reverse();
    const result = this.paginate(events, input, "events");
    return result;
  }

  redriveExecution(input) {
    const execution = this.executions.get(input.executionArn);
    if (!execution) {
      throw new SfnError("ExecutionDoesNotExist", `Execution Does Not Exist: '${input.executionArn}'.`);
    }
    if (execution.status === "RUNNING") {
      throw new SfnError("ExecutionNotRedrivable", "Execution is still running.");
    }
    if (execution.redriveStatus !== "REDRIVABLE") {
      throw new SfnError("ExecutionNotRedrivable", "Execution is not redrivable.");
    }
    execution.status = "RUNNING";
    execution.stopDate = null;
    execution.output = null;
    execution.error = null;
    execution.cause = null;
    execution.redriveCount = (execution.redriveCount || 0) + 1;
    execution.redriveDate = Date.now() / 1000;
    this.addEvent(execution, "ExecutionRedriven", {
      executionRedrivenEventDetails: { redriveCount: execution.redriveCount },
    });
    this.runExecution(execution, { redrive: true }).catch(() => {});
    return { redriveDate: new Date(execution.redriveDate * 1000) };
  }

  // =========================================================================
  // TASK TOKENS / CALLBACKS
  // =========================================================================
  sendTaskSuccess(input) {
    if (!input.taskToken) throw new SfnError("InvalidToken", "Missing Required Parameter: taskToken.");
    let output;
    try {
      output = input.output === undefined ? {} : JSON.parse(input.output);
    } catch {
      throw new SfnError("InvalidOutput", "Invalid Output: not valid JSON.");
    }
    const entry = this.taskTokens.get(input.taskToken);
    if (!entry) throw new SfnError("TaskDoesNotExist", "Task Does Not Exist or token invalid.");
    this.taskTokens.delete(input.taskToken);
    entry.resolve(output);
    return {};
  }

  sendTaskFailure(input) {
    if (!input.taskToken) throw new SfnError("InvalidToken", "Missing Required Parameter: taskToken.");
    const entry = this.taskTokens.get(input.taskToken);
    if (!entry) throw new SfnError("TaskDoesNotExist", "Task Does Not Exist or token invalid.");
    this.taskTokens.delete(input.taskToken);
    entry.reject(new StatesError(input.error || "States.TaskFailed", input.cause));
    return {};
  }

  sendTaskHeartbeat(input) {
    if (!input.taskToken) throw new SfnError("InvalidToken", "Missing Required Parameter: taskToken.");
    const entry = this.taskTokens.get(input.taskToken);
    if (!entry) throw new SfnError("TaskDoesNotExist", "Task Does Not Exist or token invalid.");
    entry.heartbeatAt = Date.now();
    return {};
  }

  // =========================================================================
  // MAP RUNS
  // =========================================================================
  describeMapRun(input) {
    const mapRun = this.mapRuns.get(input.mapRunArn);
    if (!mapRun) throw new SfnError("ResourceNotFound", `Map Run Does Not Exist: '${input.mapRunArn}'.`);
    return {
      mapRunArn: mapRun.arn,
      executionArn: mapRun.executionArn,
      status: mapRun.status,
      startDate: new Date(mapRun.startDate * 1000),
      stopDate: mapRun.stopDate ? new Date(mapRun.stopDate * 1000) : undefined,
      maxConcurrency: mapRun.maxConcurrency || 0,
      toleratedFailurePercentage: mapRun.toleratedFailurePercentage || 0,
      toleratedFailureCount: mapRun.toleratedFailureCount || 0,
      itemCounts: mapRun.itemCounts,
      executionCounts: mapRun.executionCounts,
      redriveCount: mapRun.redriveCount || 0,
    };
  }

  listMapRuns(input) {
    const execution = this.executions.get(input.executionArn);
    if (!execution) {
      throw new SfnError("ExecutionDoesNotExist", `Execution Does Not Exist: '${input.executionArn}'.`);
    }
    const items = [...this.mapRuns.values()]
      .filter((m) => m.executionArn === input.executionArn)
      .map((m) => ({
        executionArn: m.executionArn,
        mapRunArn: m.arn,
        stateMachineArn: m.stateMachineArn,
        startDate: new Date(m.startDate * 1000),
        stopDate: m.stopDate ? new Date(m.stopDate * 1000) : undefined,
      }));
    return this.paginate(items, input, "mapRuns");
  }

  updateMapRun(input) {
    const mapRun = this.mapRuns.get(input.mapRunArn);
    if (!mapRun) throw new SfnError("ResourceNotFound", `Map Run Does Not Exist: '${input.mapRunArn}'.`);
    if (input.maxConcurrency !== undefined) mapRun.maxConcurrency = input.maxConcurrency;
    if (input.toleratedFailurePercentage !== undefined)
      mapRun.toleratedFailurePercentage = input.toleratedFailurePercentage;
    if (input.toleratedFailureCount !== undefined) mapRun.toleratedFailureCount = input.toleratedFailureCount;
    return {};
  }

  // =========================================================================
  // TEST STATE
  // =========================================================================
  async testState(input) {
    if (!input.definition) throw new SfnError("MissingRequiredParameter", "definition is required.");
    let state;
    try {
      state = JSON.parse(input.definition);
    } catch {
      throw new SfnError("InvalidDefinition", "Definition is not valid JSON.");
    }
    if (!state || typeof state.Type !== "string") {
      throw new SfnError("InvalidDefinition", "Definition must declare a state Type.");
    }
    let inputValue = {};
    if (input.input !== undefined) {
      try {
        inputValue = JSON.parse(input.input);
      } catch {
        throw new SfnError("InvalidExecutionInput", "input is not valid JSON.");
      }
    }
    try {
      const ctx = { Execution: { Input: inputValue }, StateMachine: {}, State: { Name: "TestState" } };
      const { output, nextState, fail } = await this.executeState("TestState", state, inputValue, ctx, null);
      if (fail) {
        return { error: fail.error, cause: fail.cause, status: "FAILED" };
      }
      return {
        output: output === undefined ? undefined : JSON.stringify(output),
        nextState: nextState || undefined,
        status: "SUCCEEDED",
      };
    } catch (err) {
      const name = err instanceof StatesError ? err.errorName : "States.Runtime";
      return {
        error: name,
        cause: err.cause || err.message,
        status: "FAILED",
      };
    }
  }

  // =========================================================================
  // TAGS
  // =========================================================================
  resolveTaggable(arn) {
    if (typeof arn !== "string" || !ARN_RE.test(arn)) {
      throw new SfnError("InvalidArn", `Invalid Arn: '${arn}'.`);
    }
    const sm = this.stateMachines.get(arn);
    if (sm) return sm;
    const act = this.activities.get(arn);
    if (act) return act;
    throw new SfnError("ResourceNotFound", `Resource not found: '${arn}'.`);
  }

  validateAndApplyTags(store, tags) {
    if (tags.length > 50) throw new SfnError("TooManyTags", "TooManyTags: limit of 50 tags exceeded.");
    for (const tag of tags) {
      if (!tag || typeof tag.key !== "string") {
        throw new SfnError("ValidationException", "Each tag must have a key.");
      }
      store.set(tag.key, tag.value || "");
    }
  }

  tagResource(input) {
    const target = this.resolveTaggable(input.resourceArn);
    if (Array.isArray(input.tags)) this.validateAndApplyTags(target.tags, input.tags);
    return {};
  }

  untagResource(input) {
    const target = this.resolveTaggable(input.resourceArn);
    if (Array.isArray(input.tagKeys)) {
      for (const key of input.tagKeys) target.tags.delete(key);
    }
    return {};
  }

  listTagsForResource(input) {
    const target = this.resolveTaggable(input.resourceArn);
    return { tags: [...target.tags.entries()].map(([key, value]) => ({ key, value })) };
  }

  // =========================================================================
  // EXECUTION HISTORY EVENTS
  // =========================================================================
  addEvent(execution, type, details = {}, previousId) {
    execution.eventCounter += 1;
    const id = execution.eventCounter;
    const event = {
      timestamp: new Date(),
      type,
      id,
      previousEventId: previousId === undefined ? Math.max(0, id - 1) : previousId,
      ...details,
    };
    execution.events.push(event);
    return id;
  }

  // =========================================================================
  // AMAZON STATES LANGUAGE INTERPRETER
  // =========================================================================
  async runExecution(execution, { redrive = false } = {}) {
    const def = execution.definition;
    const ctx = {
      Execution: {
        Id: execution.arn,
        Input: safeParse(execution.rawInput),
        Name: execution.name,
        RoleArn: "arn:aws:iam::" + this.accountId + ":role/parlel",
        StartTime: new Date(execution.startDate * 1000).toISOString(),
      },
      StateMachine: { Id: execution.stateMachineArn, Name: execution.smName },
      State: {},
    };

    if (!redrive) {
      this.addEvent(execution, "ExecutionStarted", {
        executionStartedEventDetails: {
          input: execution.rawInput,
          inputDetails: { included: true },
          roleArn: ctx.Execution.RoleArn,
        },
        previousEventId: 0,
      });
    }

    let stateName = def.StartAt;
    let currentInput = safeParse(execution.rawInput);
    const maxSteps = 10000;
    let steps = 0;

    try {
      while (stateName) {
        if (++steps > maxSteps) throw new StatesError("States.Runtime", "Exceeded maximum state transitions.");
        if (execution.status === "ABORTED") return;
        const state = def.States[stateName];
        if (!state) throw new StatesError("States.Runtime", `No such state: ${stateName}`);

        ctx.State = { Name: stateName, EnteredTime: new Date().toISOString() };
        const enterEventType = this.stateEnterEvent(state.Type);
        this.addEvent(execution, enterEventType, {
          stateEnteredEventDetails: { name: stateName, input: JSON.stringify(currentInput ?? null) },
        });

        const { output, nextState, end, fail } = await this.executeState(
          stateName,
          state,
          currentInput,
          ctx,
          execution,
        );

        if (fail) {
          // Fail state already recorded; finalize as FAILED.
          this.finishExecution(execution, "FAILED", undefined, fail.error, fail.cause);
          return;
        }

        const exitEventType = this.stateExitEvent(state.Type);
        if (exitEventType) {
          this.addEvent(execution, exitEventType, {
            stateExitedEventDetails: {
              name: stateName,
              output: JSON.stringify(output ?? null),
              outputDetails: { included: true },
            },
          });
        }

        if (end || state.Type === "Succeed") {
          this.finishExecution(execution, "SUCCEEDED", output);
          return;
        }
        currentInput = output;
        stateName = nextState;
        if (!stateName) {
          // Choice with no match & no default, etc.
          this.finishExecution(execution, "SUCCEEDED", output);
          return;
        }
      }
    } catch (err) {
      const errorName = err instanceof StatesError ? err.errorName : "States.Runtime";
      const cause = err instanceof StatesError ? err.cause : err.message;
      this.addEvent(execution, "ExecutionFailed", {
        executionFailedEventDetails: { error: errorName, cause: cause || "" },
      });
      this.finishExecution(execution, "FAILED", undefined, errorName, cause, { alreadyRecorded: true });
    }
  }

  finishExecution(execution, status, output, error, cause, opts = {}) {
    execution.status = status;
    execution.stopDate = Date.now() / 1000;
    if (status === "SUCCEEDED") {
      execution.output = JSON.stringify(output ?? null);
      this.addEvent(execution, "ExecutionSucceeded", {
        executionSucceededEventDetails: { output: execution.output, outputDetails: { included: true } },
      });
      execution.redriveStatus = "NOT_REDRIVABLE";
    } else if (status === "FAILED") {
      execution.error = error || "States.Runtime";
      execution.cause = cause || "";
      execution.redriveStatus = "REDRIVABLE";
      if (!opts.alreadyRecorded) {
        this.addEvent(execution, "ExecutionFailed", {
          executionFailedEventDetails: { error: execution.error, cause: execution.cause },
        });
      }
    }
  }

  stateEnterEvent(type) {
    return (
      {
        Task: "TaskStateEntered",
        Pass: "PassStateEntered",
        Choice: "ChoiceStateEntered",
        Wait: "WaitStateEntered",
        Succeed: "SucceedStateEntered",
        Fail: "FailStateEntered",
        Parallel: "ParallelStateEntered",
        Map: "MapStateEntered",
      }[type] || "TaskStateEntered"
    );
  }

  stateExitEvent(type) {
    // Fail does not emit a StateExited event.
    if (type === "Fail") return null;
    return (
      {
        Task: "TaskStateExited",
        Pass: "PassStateExited",
        Choice: "ChoiceStateExited",
        Wait: "WaitStateExited",
        Succeed: "SucceedStateExited",
        Parallel: "ParallelStateExited",
        Map: "MapStateExited",
      }[type] || "TaskStateExited"
    );
  }

  // Execute a single state. Returns { output, nextState, end, fail }.
  async executeState(stateName, state, rawInput, ctx, execution) {
    switch (state.Type) {
      case "Pass":
        return this.runPass(state, rawInput, ctx);
      case "Succeed":
        return this.runSucceed(state, rawInput, ctx);
      case "Fail":
        return this.runFail(state, rawInput, ctx);
      case "Wait":
        return this.runWait(state, rawInput, ctx);
      case "Choice":
        return this.runChoice(state, rawInput, ctx);
      case "Task":
        return this.runTaskWithRetry(stateName, state, rawInput, ctx, execution);
      case "Parallel":
        return this.runParallelWithRetry(stateName, state, rawInput, ctx, execution);
      case "Map":
        return this.runMapWithRetry(stateName, state, rawInput, ctx, execution);
      default:
        throw new StatesError("States.Runtime", `Unsupported state type: ${state.Type}`);
    }
  }

  applyInputProcessing(state, rawInput, ctx) {
    let effective = applyPath(rawInput, state.InputPath);
    if (state.Parameters !== undefined) {
      effective = this.resolvePayload(state.Parameters, effective, ctx);
    }
    return effective;
  }

  applyResultProcessing(state, rawInput, result, ctx) {
    let value = result;
    if (state.ResultSelector !== undefined) {
      value = this.resolvePayload(state.ResultSelector, value, ctx);
    }
    let combined = rawInput;
    if (state.ResultPath === null) {
      combined = rawInput;
    } else if (state.ResultPath !== undefined) {
      combined = setPath(clone(rawInput), state.ResultPath, value);
    } else {
      combined = value;
    }
    return applyPath(combined, state.OutputPath);
  }

  runPass(state, rawInput, ctx) {
    const effective = this.applyInputProcessing(state, rawInput, ctx);
    const result = state.Result !== undefined ? clone(state.Result) : effective;
    const output = this.applyResultProcessing(state, rawInput, result, ctx);
    return { output, nextState: state.Next, end: state.End === true };
  }

  runSucceed(state, rawInput, ctx) {
    const output = applyPath(applyPath(rawInput, state.InputPath), state.OutputPath);
    return { output, end: true };
  }

  runFail(state, rawInput, ctx) {
    const error = state.Error !== undefined ? String(state.Error) : undefined;
    const cause = state.Cause !== undefined ? String(state.Cause) : undefined;
    if (state.ErrorPath) {
      // JSONPath / intrinsic-based error
    }
    return { fail: { error: error || "States.Fail", cause } };
  }

  async runWait(state, rawInput, ctx) {
    const effective = applyPath(rawInput, state.InputPath);
    let seconds = 0;
    if (typeof state.Seconds === "number") seconds = state.Seconds;
    else if (state.SecondsPath) seconds = Number(queryPath(rawInput, state.SecondsPath, ctx)) || 0;
    else if (state.Timestamp) {
      const ts = new Date(state.Timestamp).getTime();
      seconds = Math.max(0, (ts - Date.now()) / 1000);
    } else if (state.TimestampPath) {
      const ts = new Date(queryPath(rawInput, state.TimestampPath, ctx)).getTime();
      seconds = Math.max(0, (ts - Date.now()) / 1000);
    }
    // Cap real waits so tests stay fast; semantics preserved for small waits.
    const capped = Math.min(seconds, 2);
    if (capped > 0) await delay(capped * 1000);
    const output = applyPath(effective, state.OutputPath);
    return { output, nextState: state.Next, end: state.End === true };
  }

  runChoice(state, rawInput, ctx) {
    const effective = applyPath(rawInput, state.InputPath);
    if (Array.isArray(state.Choices)) {
      for (const rule of state.Choices) {
        if (this.evalChoiceRule(rule, effective, ctx)) {
          const output = applyPath(effective, state.OutputPath);
          return { output, nextState: rule.Next };
        }
      }
    }
    if (state.Default) {
      const output = applyPath(effective, state.OutputPath);
      return { output, nextState: state.Default };
    }
    throw new StatesError("States.NoChoiceMatched", `No choice matched and no Default in state.`);
  }

  evalChoiceRule(rule, input, ctx) {
    if (Array.isArray(rule.And)) return rule.And.every((r) => this.evalChoiceRule(r, input, ctx));
    if (Array.isArray(rule.Or)) return rule.Or.some((r) => this.evalChoiceRule(r, input, ctx));
    if (rule.Not) return !this.evalChoiceRule(rule.Not, input, ctx);

    const variable = rule.Variable ? queryPath(input, rule.Variable, ctx) : undefined;
    const ops = [
      "StringEquals", "StringEqualsPath", "StringLessThan", "StringLessThanPath",
      "StringGreaterThan", "StringGreaterThanPath", "StringLessThanEquals", "StringLessThanEqualsPath",
      "StringGreaterThanEquals", "StringGreaterThanEqualsPath", "StringMatches",
      "NumericEquals", "NumericEqualsPath", "NumericLessThan", "NumericLessThanPath",
      "NumericGreaterThan", "NumericGreaterThanPath", "NumericLessThanEquals", "NumericLessThanEqualsPath",
      "NumericGreaterThanEquals", "NumericGreaterThanEqualsPath",
      "BooleanEquals", "BooleanEqualsPath",
      "TimestampEquals", "TimestampEqualsPath", "TimestampLessThan", "TimestampLessThanPath",
      "TimestampGreaterThan", "TimestampGreaterThanPath", "TimestampLessThanEquals", "TimestampLessThanEqualsPath",
      "TimestampGreaterThanEquals", "TimestampGreaterThanEqualsPath",
      "IsNull", "IsPresent", "IsNumeric", "IsString", "IsBoolean", "IsTimestamp",
    ];
    for (const op of ops) {
      if (Object.prototype.hasOwnProperty.call(rule, op)) {
        let compare = rule[op];
        if (op.endsWith("Path")) compare = queryPath(input, compare, ctx);
        return this.applyComparator(op, variable, compare, rule, input, ctx);
      }
    }
    return false;
  }

  applyComparator(op, variable, compare, rule, input, ctx) {
    const base = op.replace(/Path$/, "");
    switch (base) {
      case "IsPresent":
        return rule.Variable !== undefined && hasPath(input, rule.Variable, ctx) === compare;
      case "IsNull":
        return (variable === null) === compare;
      case "IsNumeric":
        return (typeof variable === "number") === compare;
      case "IsString":
        return (typeof variable === "string") === compare;
      case "IsBoolean":
        return (typeof variable === "boolean") === compare;
      case "IsTimestamp":
        return (typeof variable === "string" && !Number.isNaN(Date.parse(variable))) === compare;
      case "StringEquals":
        return variable === compare;
      case "StringLessThan":
        return variable < compare;
      case "StringGreaterThan":
        return variable > compare;
      case "StringLessThanEquals":
        return variable <= compare;
      case "StringGreaterThanEquals":
        return variable >= compare;
      case "StringMatches":
        return typeof variable === "string" && globMatch(compare, variable);
      case "NumericEquals":
        return variable === compare;
      case "NumericLessThan":
        return variable < compare;
      case "NumericGreaterThan":
        return variable > compare;
      case "NumericLessThanEquals":
        return variable <= compare;
      case "NumericGreaterThanEquals":
        return variable >= compare;
      case "BooleanEquals":
        return variable === compare;
      case "TimestampEquals":
        return Date.parse(variable) === Date.parse(compare);
      case "TimestampLessThan":
        return Date.parse(variable) < Date.parse(compare);
      case "TimestampGreaterThan":
        return Date.parse(variable) > Date.parse(compare);
      case "TimestampLessThanEquals":
        return Date.parse(variable) <= Date.parse(compare);
      case "TimestampGreaterThanEquals":
        return Date.parse(variable) >= Date.parse(compare);
      default:
        return false;
    }
  }

  // --- Task ---------------------------------------------------------------
  async runTaskWithRetry(stateName, state, rawInput, ctx, execution) {
    return this.withRetryCatch(stateName, state, rawInput, ctx, execution, async (effective) => {
      return this.runTask(stateName, state, effective, rawInput, ctx, execution);
    });
  }

  async runTask(stateName, state, effective, rawInput, ctx, execution) {
    const resource = state.Resource || "";
    if (execution) {
      this.addEvent(execution, "TaskScheduled", {
        taskScheduledEventDetails: {
          resourceType: "parlel",
          resource,
          region: this.region,
          parameters: JSON.stringify(effective ?? null),
        },
      });
      this.addEvent(execution, "TaskStarted", {
        taskStartedEventDetails: { resourceType: "parlel", resource },
      });
    }

    let result;
    const isWaitForToken = /\.waitForTaskToken$/.test(resource);
    const registered = this.taskResolvers.get(resource) || this.taskResolvers.get(stripPattern(resource));

    if (isWaitForToken) {
      const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      // If the task targets an activity, enqueue for GetActivityTask.
      const activityArn = effective && effective._activityArn;
      result = await new Promise((resolve, reject) => {
        this.taskTokens.set(token, {
          executionArn: execution ? execution.arn : null,
          resolve,
          reject,
          heartbeatAt: Date.now(),
        });
        const activity = activityArn && this.activities.get(activityArn);
        if (activity) {
          activity.tasks.push({ taskToken: token, input: JSON.stringify(effective ?? null) });
        }
        if (registered) {
          // Allow a registered resolver to settle the token asynchronously.
          Promise.resolve(registered({ ...effective, taskToken: token }, ctx)).then(
            (val) => {
              if (this.taskTokens.has(token)) {
                this.taskTokens.delete(token);
                resolve(val);
              }
            },
            (e) => {
              if (this.taskTokens.has(token)) {
                this.taskTokens.delete(token);
                reject(e instanceof StatesError ? e : new StatesError("States.TaskFailed", String(e.message || e)));
              }
            },
          );
        }
        // Expose token to callers via execution record for test-driven callbacks.
        if (execution) execution.pendingToken = token;
      });
    } else if (registered) {
      result = await Promise.resolve(registered(effective, ctx));
    } else {
      // Default: identity task. Returns the effective input as the result.
      result = effective === undefined ? {} : effective;
    }

    if (execution) {
      this.addEvent(execution, "TaskSucceeded", {
        taskSucceededEventDetails: {
          resourceType: "parlel",
          resource,
          output: JSON.stringify(result ?? null),
          outputDetails: { included: true },
        },
      });
    }

    const output = this.applyResultProcessing(state, rawInput, result, ctx);
    return { output, nextState: state.Next, end: state.End === true };
  }

  // --- Parallel -----------------------------------------------------------
  async runParallelWithRetry(stateName, state, rawInput, ctx, execution) {
    return this.withRetryCatch(stateName, state, rawInput, ctx, execution, async (effective) => {
      if (execution) this.addEvent(execution, "ParallelStateStarted", {});
      const branches = state.Branches || [];
      const results = await Promise.all(
        branches.map((branch) => this.runBranch(branch, effective, ctx)),
      );
      if (execution) this.addEvent(execution, "ParallelStateSucceeded", {});
      const output = this.applyResultProcessing(state, rawInput, results, ctx);
      return { output, nextState: state.Next, end: state.End === true };
    });
  }

  async runBranch(branch, branchInput, ctx) {
    let stateName = branch.StartAt;
    let current = branchInput;
    let steps = 0;
    while (stateName) {
      if (++steps > 10000) throw new StatesError("States.Runtime", "branch step limit");
      const state = branch.States[stateName];
      if (!state) throw new StatesError("States.Runtime", `No such state: ${stateName}`);
      const { output, nextState, end, fail } = await this.executeState(stateName, state, current, ctx, null);
      if (fail) throw new StatesError(fail.error, fail.cause);
      if (end || state.Type === "Succeed") return output;
      current = output;
      stateName = nextState;
      if (!stateName) return output;
    }
    return current;
  }

  // --- Map ----------------------------------------------------------------
  async runMapWithRetry(stateName, state, rawInput, ctx, execution) {
    return this.withRetryCatch(stateName, state, rawInput, ctx, execution, async (effective) => {
      if (execution) this.addEvent(execution, "MapStateStarted", { mapStateStartedEventDetails: { length: 0 } });
      let items = effective;
      if (state.ItemsPath) items = queryPath(effective, state.ItemsPath, ctx);
      if (state.Items !== undefined) items = this.resolvePayload(state.Items, effective, ctx);
      if (!Array.isArray(items)) {
        throw new StatesError("States.Runtime", "Map state items did not resolve to an array.");
      }
      const processor = state.ItemProcessor || state.Iterator;
      if (!processor) throw new StatesError("States.Runtime", "Map state requires ItemProcessor/Iterator.");
      const maxConcurrency = state.MaxConcurrency || 0;

      // Optionally create a MapRun record for distributed-style maps.
      let mapRun = null;
      const isDistributed =
        processor.ProcessorConfig && processor.ProcessorConfig.Mode === "DISTRIBUTED";
      if (isDistributed && execution) {
        const label = stateName;
        const arn = this.mapRunArn(execution.smName, execution.name, label);
        mapRun = {
          arn,
          executionArn: execution.arn,
          stateMachineArn: execution.stateMachineArn,
          status: "RUNNING",
          startDate: Date.now() / 1000,
          stopDate: null,
          maxConcurrency,
          toleratedFailurePercentage: state.ToleratedFailurePercentage || 0,
          toleratedFailureCount: state.ToleratedFailureCount || 0,
          itemCounts: { total: items.length, pending: 0, running: 0, succeeded: 0, failed: 0, aborted: 0, timedOut: 0, resultsWritten: items.length },
          executionCounts: { total: items.length, pending: 0, running: 0, succeeded: 0, failed: 0, aborted: 0, timedOut: 0, resultsWritten: items.length },
          redriveCount: 0,
        };
        this.mapRuns.set(arn, mapRun);
        this.addEvent(execution, "MapRunStarted", { mapRunStartedEventDetails: { mapRunArn: arn } });
      }

      const runOne = async (item, index) => {
        let itemInput = item;
        if (state.ItemSelector !== undefined || state.Parameters !== undefined) {
          const selector = state.ItemSelector || state.Parameters;
          const itemCtx = {
            ...ctx,
            Map: { Item: { Index: index, Value: item } },
          };
          itemInput = this.resolvePayload(selector, item, itemCtx);
        }
        return this.runBranch(processor, itemInput, {
          ...ctx,
          Map: { Item: { Index: index, Value: item } },
        });
      };

      const results = [];
      if (maxConcurrency && maxConcurrency > 0) {
        for (let i = 0; i < items.length; i += maxConcurrency) {
          const chunk = items.slice(i, i + maxConcurrency);
          const settled = await Promise.all(chunk.map((it, j) => runOne(it, i + j)));
          results.push(...settled);
        }
      } else {
        const settled = await Promise.all(items.map((it, i) => runOne(it, i)));
        results.push(...settled);
      }

      if (mapRun) {
        mapRun.status = "SUCCEEDED";
        mapRun.stopDate = Date.now() / 1000;
        mapRun.itemCounts.succeeded = items.length;
        mapRun.executionCounts.succeeded = items.length;
        this.addEvent(execution, "MapRunSucceeded", {});
      }
      if (execution) this.addEvent(execution, "MapStateSucceeded", {});

      const output = this.applyResultProcessing(state, rawInput, results, ctx);
      return { output, nextState: state.Next, end: state.End === true };
    });
  }

  // --- Retry / Catch wrapper ---------------------------------------------
  async withRetryCatch(stateName, state, rawInput, ctx, execution, body) {
    const effective = this.applyInputProcessing(state, rawInput, ctx);
    const retriers = Array.isArray(state.Retry) ? state.Retry : [];
    const retryCounts = new Array(retriers.length).fill(0);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await body(effective);
      } catch (err) {
        const errorName = err instanceof StatesError ? err.errorName : "States.TaskFailed";
        const cause = err instanceof StatesError ? err.cause : err.message;

        // Try retriers
        let retried = false;
        for (let i = 0; i < retriers.length; i++) {
          const r = retriers[i];
          if (matchesError(r.ErrorEquals, errorName)) {
            const max = r.MaxAttempts === undefined ? 3 : r.MaxAttempts;
            if (retryCounts[i] < max) {
              retryCounts[i] += 1;
              if (execution) {
                this.addEvent(execution, "TaskFailed", {
                  taskFailedEventDetails: { error: errorName, cause: cause || "", resourceType: "parlel", resource: state.Resource || "" },
                });
              }
              const interval = (r.IntervalSeconds || 1) * Math.pow(r.BackoffRate || 2.0, retryCounts[i] - 1);
              await delay(Math.min(interval, 1) * 50); // sped up for tests
              retried = true;
              break;
            }
          }
        }
        if (retried) continue;

        // Try catchers
        const catchers = Array.isArray(state.Catch) ? state.Catch : [];
        for (const c of catchers) {
          if (matchesError(c.ErrorEquals, errorName)) {
            if (execution) {
              this.addEvent(execution, "TaskFailed", {
                taskFailedEventDetails: { error: errorName, cause: cause || "", resourceType: "parlel", resource: state.Resource || "" },
              });
            }
            const errorOutput = { Error: errorName, Cause: cause || "" };
            let combined = rawInput;
            if (c.ResultPath === null) combined = rawInput;
            else if (c.ResultPath !== undefined) combined = setPath(clone(rawInput), c.ResultPath, errorOutput);
            else combined = errorOutput;
            return { output: combined, nextState: c.Next };
          }
        }

        // No handler: propagate as a state failure.
        if (execution) {
          this.addEvent(execution, "TaskFailed", {
            taskFailedEventDetails: { error: errorName, cause: cause || "", resourceType: "parlel", resource: state.Resource || "" },
          });
        }
        return { fail: { error: errorName, cause } };
      }
    }
  }

  // --- Payload (Parameters / ResultSelector / ItemSelector) ---------------
  resolvePayload(template, input, ctx) {
    if (Array.isArray(template)) return template.map((t) => this.resolvePayload(t, input, ctx));
    if (template && typeof template === "object") {
      const out = {};
      for (const [key, value] of Object.entries(template)) {
        if (key.endsWith(".$")) {
          const realKey = key.slice(0, -2);
          if (typeof value === "string") {
            out[realKey] = this.resolveValueExpression(value, input, ctx);
          } else {
            out[realKey] = this.resolvePayload(value, input, ctx);
          }
        } else {
          out[key] = this.resolvePayload(value, input, ctx);
        }
      }
      return out;
    }
    return template;
  }

  resolveValueExpression(expr, input, ctx) {
    if (typeof expr !== "string") return expr;
    if (expr.startsWith("$$")) return queryContext(ctx, expr.slice(1));
    if (expr.startsWith("$")) return queryPath(input, expr, ctx);
    // Intrinsic function call, e.g. States.Format('Hello {}', $.name)
    if (/^States\./.test(expr)) return evalIntrinsic(expr, input, ctx);
    return expr;
  }

  // =========================================================================
  // PAGINATION
  // =========================================================================
  paginate(items, input, key) {
    const maxResults = input.maxResults && input.maxResults > 0 ? input.maxResults : items.length;
    let start = 0;
    if (input.nextToken) {
      const decoded = Number(Buffer.from(input.nextToken, "base64").toString("utf8"));
      if (!Number.isNaN(decoded)) start = decoded;
    }
    const page = items.slice(start, start + maxResults);
    const out = { [key]: page };
    const nextStart = start + maxResults;
    if (nextStart < items.length) {
      out.nextToken = Buffer.from(String(nextStart)).toString("base64");
    }
    return out;
  }

  // =========================================================================
  // RESPONSE WRITERS
  // =========================================================================
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    // AWS JSON 1.0 serializes timestamps as epoch-seconds (a number). The SDK's
    // deserializer calls parseEpochTimestamp(), so any Date must be emitted as a
    // numeric epoch-seconds value, not an ISO string. JSON.stringify calls a
    // Date's toJSON() before the replacer can see it, so we transform first.
    res.end(JSON.stringify(datesToEpoch(obj)));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.setHeader("x-amzn-errortype", code);
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify({ __type: code, message: error.message || code }));
  }
}

export default StepfunctionsServer;
