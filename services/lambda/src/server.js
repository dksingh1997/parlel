// parlel/lambda — a lightweight, dependency-free fake of AWS Lambda.
//
// Speaks the AWS Lambda REST-JSON (restJson1) wire protocol so application code
// using the real `@aws-sdk/client-lambda` client can run against it with zero
// cost and zero side effects. Pure Node.js, no external npm dependencies. State
// is in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-lambda v3):
//   * Lambda is a REST service: each operation maps to an HTTP METHOD + URI path
//     under versioned prefixes, e.g.
//        POST   /2015-03-31/functions
//        GET    /2015-03-31/functions/{name}
//        POST   /2015-03-31/functions/{name}/invocations
//        PUT    /2015-03-31/functions/{name}/configuration
//        POST   /2017-03-31/tags/{arn}
//   * Request input is JSON in the body (Content-Type: application/json), except
//     Invoke whose body is the raw payload (application/octet-stream).
//   * Success: 200/201/202/204 with JSON output body.
//   * Invoke success: HTTP status carries `StatusCode`; the raw function result
//     is the response BODY (Payload); `X-Amz-Function-Error`,
//     `X-Amz-Executed-Version`, `X-Amz-Log-Result` are headers.
//   * Error: non-2xx, JSON `{ "__type": "<Code>", "message": "<msg>" }` plus the
//     `x-amzn-errortype: <Code>` header (restJson1 reads the header first).
//
// As a bonus over a pure mock, this fake will actually EXECUTE simple Node.js
// handler source supplied either via Code.ZipFile (a single index.js / handler
// file, raw or zip-wrapped best-effort) or via the parlel-specific
// `_parlelHandler` field, so Invoke returns real, meaningful payloads.

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

const JSON_CONTENT_TYPE = "application/json";
const DEFAULT_ACCOUNT_ID = "123456789012";

// Lambda error codes -> HTTP status. (restJson1.)
const ERROR_STATUS = {
  ResourceNotFoundException: 404,
  ProvisionedConcurrencyConfigNotFoundException: 404,
  ResourceConflictException: 409,
  ResourceInUseException: 400,
  InvalidParameterValueException: 400,
  PreconditionFailedException: 412,
  TooManyRequestsException: 429,
  CodeStorageExceededException: 400,
  ServiceException: 500,
  PolicyLengthExceededException: 400,
  RequestTooLargeException: 413,
  UnsupportedMediaTypeException: 415,
  InvalidRequestContentException: 400,
  Lambda$ValidationException: 400,
  ValidationException: 400,
  KMSAccessDeniedException: 502,
  EC2ThrottledException: 502,
  ENILimitReachedException: 502,
};

class LambdaError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

const VALID_RUNTIMES = new Set([
  "nodejs", "nodejs4.3", "nodejs6.10", "nodejs8.10", "nodejs10.x", "nodejs12.x",
  "nodejs14.x", "nodejs16.x", "nodejs18.x", "nodejs20.x", "nodejs22.x",
  "python3.8", "python3.9", "python3.10", "python3.11", "python3.12", "python3.13",
  "java8", "java8.al2", "java11", "java17", "java21",
  "dotnet6", "dotnet8", "dotnetcore2.1", "dotnetcore3.1",
  "go1.x", "ruby2.7", "ruby3.2", "ruby3.3",
  "provided", "provided.al2", "provided.al2023",
]);

const FUNCTION_NAME_RE = /^[a-zA-Z0-9-_]+$/;

export class LambdaServer {
  constructor(port = 4571, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // functions: Map<name, FunctionRecord>
    // FunctionRecord = {
    //   name, arn, runtime, role, handler, description, timeout, memorySize,
    //   codeSize, codeSha256, revisionId, lastModified, state, environment,
    //   versions: Map<version, VersionRecord>, nextVersion,
    //   aliases: Map<aliasName, AliasRecord>,
    //   tags: Map<string,string>, policy: { statements: Map },
    //   reservedConcurrency: number|undefined,
    //   urlConfig: object|undefined,
    //   codeSource: string|undefined,  // executable handler source ($LATEST)
    //   ...config fields
    // }
    this.functions = new Map();
    // eventSourceMappings: Map<uuid, mapping>
    this.eventSourceMappings = new Map();
    // layers: Map<layerName, { nextVersion, versions: Map<versionNumber, layerVersion> }>
    this.layers = new Map();
    // account-wide tag store keyed by ARN (for non-function ARNs too).
    this.account = {
      totalCodeSize: 0,
      concurrentExecutions: 1000,
      unreservedConcurrentExecutions: 1000,
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new LambdaError("ServiceException", error.message, 500));
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

  functionArn(name, qualifier) {
    const base = `arn:aws:lambda:${this.region}:${this.accountId}:function:${name}`;
    return qualifier && qualifier !== "$LATEST" ? `${base}:${qualifier}` : base;
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = decodeURIComponent(url.pathname);

    // Internal/health endpoints (not part of Lambda).
    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "lambda",
        functions: this.functions.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-lambda");

    const rawBody = await this.readBody(req);

    try {
      const route = this.route(method, url, path);
      if (!route) {
        throw new LambdaError(
          "ResourceNotFoundException",
          `The resource path ${path} for HTTP method ${method} could not be found.`,
          404,
        );
      }
      // Invoke is special: body is the raw payload, response is the raw payload.
      if (route.op === "Invoke") {
        return this.invoke(res, route.params, url, rawBody, req.headers);
      }
      let input = {};
      if (rawBody.length) {
        try {
          input = JSON.parse(rawBody.toString("utf8"));
        } catch {
          throw new LambdaError(
            "InvalidRequestContentException",
            "Could not parse request body into json.",
            400,
          );
        }
      }
      const { status, output } = this.dispatch(route, input, url);
      return this.sendJson(res, status, output ?? {});
    } catch (error) {
      if (error instanceof LambdaError) return this.sendError(res, error);
      throw error;
    }
  }

  // Map METHOD + path to an operation and path params.
  route(method, url, path) {
    const seg = path.split("/").filter(Boolean); // e.g. ["2015-03-31","functions","fn"]
    const v = seg[0];

    // ---- 2015-03-31 function APIs ----
    if (v === "2015-03-31" && seg[1] === "functions") {
      // /functions
      if (seg.length === 2) {
        if (method === "POST") return { op: "CreateFunction" };
        if (method === "GET") return { op: "ListFunctions" };
      }
      const name = seg[2];
      // /functions/{name}
      if (seg.length === 3 && name) {
        if (method === "GET") return { op: "GetFunction", params: { name } };
        if (method === "DELETE") return { op: "DeleteFunction", params: { name } };
      }
      // /functions/{name}/...
      const sub = seg[3];
      if (name && sub) {
        if (sub === "invocations" && method === "POST") {
          return { op: "Invoke", params: { name } };
        }
        if (sub === "invoke-async" && method === "POST") {
          return { op: "InvokeAsync", params: { name } };
        }
        if (sub === "configuration") {
          if (method === "GET") return { op: "GetFunctionConfiguration", params: { name } };
          if (method === "PUT") return { op: "UpdateFunctionConfiguration", params: { name } };
        }
        if (sub === "code" && method === "PUT") {
          return { op: "UpdateFunctionCode", params: { name } };
        }
        if (sub === "versions") {
          if (method === "GET") return { op: "ListVersionsByFunction", params: { name } };
          if (method === "POST") return { op: "PublishVersion", params: { name } };
        }
        if (sub === "aliases") {
          const aliasName = seg[4];
          if (aliasName) {
            if (method === "GET") return { op: "GetAlias", params: { name, aliasName } };
            if (method === "PUT") return { op: "UpdateAlias", params: { name, aliasName } };
            if (method === "DELETE") return { op: "DeleteAlias", params: { name, aliasName } };
          } else {
            if (method === "GET") return { op: "ListAliases", params: { name } };
            if (method === "POST") return { op: "CreateAlias", params: { name } };
          }
        }
        if (sub === "policy") {
          const sid = seg[4];
          if (sid && method === "DELETE") return { op: "RemovePermission", params: { name, sid } };
          if (method === "GET") return { op: "GetPolicy", params: { name } };
          if (method === "POST") return { op: "AddPermission", params: { name } };
        }
      }
    }

    // ---- 2015-03-31 event source mappings ----
    if (v === "2015-03-31" && seg[1] === "event-source-mappings") {
      const uuid = seg[2];
      if (!uuid) {
        if (method === "POST") return { op: "CreateEventSourceMapping" };
        if (method === "GET") return { op: "ListEventSourceMappings" };
      } else {
        if (method === "GET") return { op: "GetEventSourceMapping", params: { uuid } };
        if (method === "PUT") return { op: "UpdateEventSourceMapping", params: { uuid } };
        if (method === "DELETE") return { op: "DeleteEventSourceMapping", params: { uuid } };
      }
    }

    // ---- 2018-10-31 layers ----
    if (v === "2018-10-31" && seg[1] === "layers") {
      const layerName = seg[2];
      if (!layerName) {
        if (method === "GET") return { op: "ListLayers" };
      } else if (seg[3] === "versions") {
        const versionNumber = seg[4];
        if (!versionNumber) {
          if (method === "POST") return { op: "PublishLayerVersion", params: { layerName } };
          if (method === "GET") return { op: "ListLayerVersions", params: { layerName } };
        } else {
          if (method === "GET") return { op: "GetLayerVersion", params: { layerName, versionNumber } };
          if (method === "DELETE") return { op: "DeleteLayerVersion", params: { layerName, versionNumber } };
        }
      }
    }

    // ---- 2019-09-30 provisioned concurrency ----
    if (v === "2019-09-30" && seg[1] === "functions" && seg[3] === "provisioned-concurrency") {
      const name = seg[2];
      if (method === "PUT") return { op: "PutProvisionedConcurrencyConfig", params: { name } };
      if (method === "DELETE") return { op: "DeleteProvisionedConcurrencyConfig", params: { name } };
      if (method === "GET") {
        if (url.searchParams.get("List")) return { op: "ListProvisionedConcurrencyConfigs", params: { name } };
        return { op: "GetProvisionedConcurrencyConfig", params: { name } };
      }
    }

    // ---- 2019-09-25 function event invoke config ----
    if (v === "2019-09-25" && seg[1] === "functions" && seg[3] === "event-invoke-config") {
      const name = seg[2];
      if (seg[4] === "list" && method === "GET") {
        return { op: "ListFunctionEventInvokeConfigs", params: { name } };
      }
      if (method === "GET") return { op: "GetFunctionEventInvokeConfig", params: { name } };
      if (method === "PUT") return { op: "PutFunctionEventInvokeConfig", params: { name } };
      if (method === "POST") return { op: "UpdateFunctionEventInvokeConfig", params: { name } };
      if (method === "DELETE") return { op: "DeleteFunctionEventInvokeConfig", params: { name } };
    }

    // ---- 2024-08-31 recursion config ----
    if (v === "2024-08-31" && seg[1] === "functions" && seg[3] === "recursion-config") {
      const name = seg[2];
      if (method === "GET") return { op: "GetFunctionRecursionConfig", params: { name } };
      if (method === "PUT") return { op: "PutFunctionRecursionConfig", params: { name } };
    }

    // ---- 2021-07-20 runtime management config ----
    if (v === "2021-07-20" && seg[1] === "functions" && seg[3] === "runtime-management-config") {
      const name = seg[2];
      if (method === "GET") return { op: "GetRuntimeManagementConfig", params: { name } };
      if (method === "PUT") return { op: "PutRuntimeManagementConfig", params: { name } };
    }

    // ---- 2017-03-31 tags ----
    if (v === "2017-03-31" && seg[1] === "tags") {
      const arn = seg.slice(2).join("/");
      if (arn) {
        if (method === "GET") return { op: "ListTags", params: { arn } };
        if (method === "POST") return { op: "TagResource", params: { arn } };
        if (method === "DELETE") return { op: "UntagResource", params: { arn } };
      }
    }

    // ---- concurrency: multiple version prefixes ----
    if (seg[1] === "functions" && seg[3] === "concurrency") {
      const name = seg[2];
      if (method === "PUT") return { op: "PutFunctionConcurrency", params: { name } };
      if (method === "DELETE") return { op: "DeleteFunctionConcurrency", params: { name } };
      if (method === "GET") return { op: "GetFunctionConcurrency", params: { name } };
    }

    // ---- function URL configs (2021-10-31) ----
    if (v === "2021-10-31" && seg[1] === "functions") {
      const name = seg[2];
      if (seg[3] === "url") {
        if (method === "POST") return { op: "CreateFunctionUrlConfig", params: { name } };
        if (method === "GET") return { op: "GetFunctionUrlConfig", params: { name } };
        if (method === "PUT") return { op: "UpdateFunctionUrlConfig", params: { name } };
        if (method === "DELETE") return { op: "DeleteFunctionUrlConfig", params: { name } };
      }
      if (seg[3] === "urls" && method === "GET") {
        return { op: "ListFunctionUrlConfigs", params: { name } };
      }
    }

    // ---- account settings (2016-08-19) ----
    if (v === "2016-08-19" && seg[1] === "account-settings" && method === "GET") {
      return { op: "GetAccountSettings" };
    }

    return null;
  }

  dispatch(route, input, url) {
    const p = route.params || {};
    switch (route.op) {
      case "CreateFunction":
        return { status: 201, output: this.createFunction(input) };
      case "ListFunctions":
        return { status: 200, output: this.listFunctions(url) };
      case "GetFunction":
        return { status: 200, output: this.getFunction(p.name, url) };
      case "DeleteFunction":
        return { status: 204, output: this.deleteFunction(p.name, url) };
      case "GetFunctionConfiguration":
        return { status: 200, output: this.getFunctionConfiguration(p.name, url) };
      case "UpdateFunctionConfiguration":
        return { status: 200, output: this.updateFunctionConfiguration(p.name, input) };
      case "UpdateFunctionCode":
        return { status: 200, output: this.updateFunctionCode(p.name, input) };
      case "ListVersionsByFunction":
        return { status: 200, output: this.listVersionsByFunction(p.name, url) };
      case "PublishVersion":
        return { status: 201, output: this.publishVersion(p.name, input) };
      case "CreateAlias":
        return { status: 201, output: this.createAlias(p.name, input) };
      case "GetAlias":
        return { status: 200, output: this.getAlias(p.name, p.aliasName) };
      case "UpdateAlias":
        return { status: 200, output: this.updateAlias(p.name, p.aliasName, input) };
      case "DeleteAlias":
        return { status: 204, output: this.deleteAlias(p.name, p.aliasName) };
      case "ListAliases":
        return { status: 200, output: this.listAliases(p.name, url) };
      case "AddPermission":
        return { status: 201, output: this.addPermission(p.name, input, url) };
      case "RemovePermission":
        return { status: 204, output: this.removePermission(p.name, p.sid, url) };
      case "GetPolicy":
        return { status: 200, output: this.getPolicy(p.name, url) };
      case "TagResource":
        return { status: 204, output: this.tagResource(p.arn, input) };
      case "UntagResource":
        return { status: 204, output: this.untagResource(p.arn, url) };
      case "ListTags":
        return { status: 200, output: this.listTags(p.arn) };
      case "PutFunctionConcurrency":
        return { status: 200, output: this.putFunctionConcurrency(p.name, input) };
      case "GetFunctionConcurrency":
        return { status: 200, output: this.getFunctionConcurrency(p.name) };
      case "DeleteFunctionConcurrency":
        return { status: 204, output: this.deleteFunctionConcurrency(p.name) };
      case "CreateFunctionUrlConfig":
        return { status: 201, output: this.createFunctionUrlConfig(p.name, input, url) };
      case "GetFunctionUrlConfig":
        return { status: 200, output: this.getFunctionUrlConfig(p.name, url) };
      case "UpdateFunctionUrlConfig":
        return { status: 200, output: this.updateFunctionUrlConfig(p.name, input, url) };
      case "DeleteFunctionUrlConfig":
        return { status: 204, output: this.deleteFunctionUrlConfig(p.name, url) };
      case "ListFunctionUrlConfigs":
        return { status: 200, output: this.listFunctionUrlConfigs(p.name) };
      case "GetAccountSettings":
        return { status: 200, output: this.getAccountSettings() };
      case "InvokeAsync":
        return { status: 202, output: this.invokeAsync(p.name, {}) };
      // event source mappings
      case "CreateEventSourceMapping":
        return { status: 202, output: this.createEventSourceMapping(input) };
      case "GetEventSourceMapping":
        return { status: 200, output: this.getEventSourceMapping(p.uuid) };
      case "ListEventSourceMappings":
        return { status: 200, output: this.listEventSourceMappings(url) };
      case "UpdateEventSourceMapping":
        return { status: 202, output: this.updateEventSourceMapping(p.uuid, input) };
      case "DeleteEventSourceMapping":
        return { status: 202, output: this.deleteEventSourceMapping(p.uuid) };
      // layers
      case "PublishLayerVersion":
        return { status: 201, output: this.publishLayerVersion(p.layerName, input) };
      case "ListLayers":
        return { status: 200, output: this.listLayers() };
      case "ListLayerVersions":
        return { status: 200, output: this.listLayerVersions(p.layerName) };
      case "GetLayerVersion":
        return { status: 200, output: this.getLayerVersion(p.layerName, p.versionNumber) };
      case "DeleteLayerVersion":
        return { status: 204, output: this.deleteLayerVersion(p.layerName, p.versionNumber) };
      // provisioned concurrency
      case "PutProvisionedConcurrencyConfig":
        return { status: 202, output: this.putProvisionedConcurrencyConfig(p.name, input, url) };
      case "GetProvisionedConcurrencyConfig":
        return { status: 200, output: this.getProvisionedConcurrencyConfig(p.name, url) };
      case "ListProvisionedConcurrencyConfigs":
        return { status: 200, output: this.listProvisionedConcurrencyConfigs(p.name) };
      case "DeleteProvisionedConcurrencyConfig":
        return { status: 204, output: this.deleteProvisionedConcurrencyConfig(p.name, url) };
      // event invoke config
      case "PutFunctionEventInvokeConfig":
        return { status: 200, output: this.putFunctionEventInvokeConfig(p.name, input, url, true) };
      case "UpdateFunctionEventInvokeConfig":
        return { status: 200, output: this.putFunctionEventInvokeConfig(p.name, input, url, false) };
      case "GetFunctionEventInvokeConfig":
        return { status: 200, output: this.getFunctionEventInvokeConfig(p.name, url) };
      case "ListFunctionEventInvokeConfigs":
        return { status: 200, output: this.listFunctionEventInvokeConfigs(p.name) };
      case "DeleteFunctionEventInvokeConfig":
        return { status: 204, output: this.deleteFunctionEventInvokeConfig(p.name, url) };
      // recursion config
      case "PutFunctionRecursionConfig":
        return { status: 200, output: this.putFunctionRecursionConfig(p.name, input) };
      case "GetFunctionRecursionConfig":
        return { status: 200, output: this.getFunctionRecursionConfig(p.name) };
      // runtime management config
      case "PutRuntimeManagementConfig":
        return { status: 200, output: this.putRuntimeManagementConfig(p.name, input) };
      case "GetRuntimeManagementConfig":
        return { status: 200, output: this.getRuntimeManagementConfig(p.name) };
      default:
        throw new LambdaError("ResourceNotFoundException", `Unknown operation ${route.op}.`, 404);
    }
  }

  // -------------------------------------------------------------------------
  // Function resolution
  // -------------------------------------------------------------------------
  // Accept bare name, full ARN, or partial ARN; optionally with :qualifier.
  parseFunctionRef(ref) {
    if (typeof ref !== "string" || ref.length === 0) {
      throw new LambdaError(
        "InvalidParameterValueException",
        "The function name cannot be empty.",
      );
    }
    let name = ref;
    let qualifier;
    if (ref.startsWith("arn:")) {
      const parts = ref.split(":");
      // arn:aws:lambda:region:acct:function:name[:qualifier]
      const fnIdx = parts.indexOf("function");
      if (fnIdx >= 0) {
        name = parts[fnIdx + 1];
        if (parts.length > fnIdx + 2) qualifier = parts[fnIdx + 2];
      }
    } else if (ref.includes(":")) {
      const idx = ref.lastIndexOf(":");
      name = ref.slice(0, idx);
      qualifier = ref.slice(idx + 1);
    }
    return { name, qualifier };
  }

  requireFunction(ref) {
    const { name, qualifier } = this.parseFunctionRef(ref);
    const fn = this.functions.get(name);
    if (!fn) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `Function not found: ${this.functionArn(name)}`,
        404,
      );
    }
    return { fn, qualifier };
  }

  qualifierFromUrl(url) {
    return url.searchParams.get("Qualifier") || undefined;
  }

  // -------------------------------------------------------------------------
  // Code handling — store executable source for real Invoke when possible.
  // -------------------------------------------------------------------------
  extractCode(code) {
    // Returns { size, sha256, source }. `source` is JS handler text if we can
    // recover it, else undefined (Invoke then returns a canned echo).
    let buf;
    if (code && code.ZipFile) {
      buf = Buffer.isBuffer(code.ZipFile)
        ? code.ZipFile
        : Buffer.from(code.ZipFile, typeof code.ZipFile === "string" ? "base64" : undefined);
    } else {
      // Code by reference (S3 etc.) — we can't fetch, store a small placeholder.
      buf = Buffer.from(JSON.stringify(code || {}));
    }
    const sha256 = createHash("sha256").update(buf).digest("base64");
    let source;
    const text = buf.toString("utf8");
    // Heuristic: if it looks like raw JS (not a real zip), keep it executable.
    if (!text.startsWith("PK\u0003\u0004") && /exports|module\.exports|=>|function/.test(text)) {
      source = text;
    }
    return { size: buf.length, sha256, source };
  }

  // -------------------------------------------------------------------------
  // Function lifecycle
  // -------------------------------------------------------------------------
  validateFunctionConfig(input, { create }) {
    const name = input.FunctionName;
    if (create) {
      if (!name) {
        throw new LambdaError("InvalidParameterValueException", "FunctionName is required.");
      }
      // Accept ARNs; validate bare name.
      const bare = name.startsWith("arn:") ? this.parseFunctionRef(name).name : name;
      if (bare.length < 1 || bare.length > 140 || !FUNCTION_NAME_RE.test(bare)) {
        throw new LambdaError(
          "InvalidParameterValueException",
          `1 validation error detected: Value '${name}' at 'functionName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9-_]+`,
        );
      }
      if (!input.Role) {
        throw new LambdaError("InvalidParameterValueException", "Role is required.");
      }
      if (!input.Code) {
        throw new LambdaError("InvalidParameterValueException", "Code is required.");
      }
      if (input.Runtime && !VALID_RUNTIMES.has(input.Runtime)) {
        throw new LambdaError(
          "InvalidParameterValueException",
          `Value ${input.Runtime} at 'runtime' failed to satisfy constraint: Member must satisfy enum value set.`,
        );
      }
    }
    if (input.MemorySize !== undefined) {
      const m = Number(input.MemorySize);
      if (Number.isNaN(m) || m < 128 || m > 10240) {
        throw new LambdaError(
          "InvalidParameterValueException",
          "'memorySize' failed to satisfy constraint: Member must have value between 128 and 10240.",
        );
      }
    }
    if (input.Timeout !== undefined) {
      const t = Number(input.Timeout);
      if (Number.isNaN(t) || t < 1) {
        throw new LambdaError(
          "InvalidParameterValueException",
          "'timeout' failed to satisfy constraint: Member must have minimum value of 1.",
        );
      }
    }
  }

  createFunction(input) {
    this.validateFunctionConfig(input, { create: true });
    const name = input.FunctionName.startsWith("arn:")
      ? this.parseFunctionRef(input.FunctionName).name
      : input.FunctionName;

    if (this.functions.has(name)) {
      throw new LambdaError(
        "ResourceConflictException",
        `Function already exist: ${name}`,
        409,
      );
    }

    const { size, sha256, source } = this.extractCode(input.Code);
    const now = new Date().toISOString();
    const fn = {
      name,
      runtime: input.Runtime,
      role: input.Role,
      handler: input.Handler,
      description: input.Description || "",
      timeout: input.Timeout ?? 3,
      memorySize: input.MemorySize ?? 128,
      codeSize: size,
      codeSha256: sha256,
      revisionId: randomUUID(),
      lastModified: now,
      state: "Active",
      lastUpdateStatus: "Successful",
      packageType: input.PackageType || "Zip",
      architectures: input.Architectures || ["x86_64"],
      environment: input.Environment?.Variables ? { ...input.Environment.Variables } : {},
      deadLetterArn: input.DeadLetterConfig?.TargetArn,
      kmsKeyArn: input.KMSKeyArn,
      tracingMode: input.TracingConfig?.Mode || "PassThrough",
      layers: (input.Layers || []).map((arn) => ({ Arn: arn, CodeSize: 0 })),
      ephemeralStorage: input.EphemeralStorage?.Size || 512,
      codeSource: input._parlelHandler || source,
      versions: new Map(),
      aliases: new Map(),
      tags: new Map(),
      policyStatements: new Map(),
      reservedConcurrency: undefined,
      urlConfig: undefined,
      nextVersion: 1,
    };
    if (input.Tags) {
      for (const [k, val] of Object.entries(input.Tags)) fn.tags.set(k, String(val));
    }
    this.functions.set(name, fn);
    this.account.totalCodeSize += size;

    let publishedVersion;
    if (input.Publish) {
      publishedVersion = this.snapshotVersion(fn);
    }

    return this.functionResponse(fn, publishedVersion || "$LATEST");
  }

  // Build a configuration object for a given qualifier.
  configuration(fn, qualifier) {
    let v = fn;
    let version = "$LATEST";
    if (qualifier && qualifier !== "$LATEST") {
      // alias?
      if (fn.aliases.has(qualifier)) {
        version = fn.aliases.get(qualifier).functionVersion;
      } else {
        version = qualifier;
      }
      const snap = fn.versions.get(version);
      if (!snap && version !== "$LATEST") {
        throw new LambdaError(
          "ResourceNotFoundException",
          `Function not found: ${this.functionArn(fn.name, qualifier)}`,
          404,
        );
      }
      if (snap) v = snap;
    }
    const arn = this.functionArn(fn.name, version === "$LATEST" ? undefined : version);
    return {
      FunctionName: fn.name,
      FunctionArn: arn,
      Runtime: v.runtime,
      Role: v.role,
      Handler: v.handler,
      CodeSize: v.codeSize,
      Description: v.description,
      Timeout: v.timeout,
      MemorySize: v.memorySize,
      LastModified: v.lastModified,
      CodeSha256: v.codeSha256,
      Version: version,
      VpcConfig: undefined,
      Environment: { Variables: { ...(v.environment || {}) } },
      TracingConfig: { Mode: v.tracingMode || "PassThrough" },
      RevisionId: v.revisionId,
      State: "Active",
      LastUpdateStatus: "Successful",
      PackageType: v.packageType || "Zip",
      Architectures: v.architectures || ["x86_64"],
      EphemeralStorage: { Size: v.ephemeralStorage || 512 },
      Layers: v.layers && v.layers.length ? v.layers : undefined,
    };
  }

  functionResponse(fn, qualifier) {
    const Configuration = this.configuration(fn, qualifier);
    return Configuration;
  }

  listFunctions(url) {
    const maxItems = parseInt(url.searchParams.get("MaxItems") || "0", 10);
    const marker = url.searchParams.get("Marker");
    let names = [...this.functions.keys()].sort();
    let start = 0;
    if (marker) start = parseInt(Buffer.from(marker, "base64").toString("utf8"), 10) || 0;
    let nextMarker;
    let page = names.slice(start);
    if (maxItems && page.length > maxItems) {
      page = page.slice(0, maxItems);
      const nextStart = start + maxItems;
      if (nextStart < names.length) {
        nextMarker = Buffer.from(String(nextStart)).toString("base64");
      }
    }
    const Functions = page.map((n) => this.configuration(this.functions.get(n), "$LATEST"));
    const out = { Functions };
    if (nextMarker) out.NextMarker = nextMarker;
    return out;
  }

  getFunction(name, url) {
    const { fn, qualifier } = this.requireFunction(name);
    const q = qualifier || this.qualifierFromUrl(url);
    const Configuration = this.configuration(fn, q);
    return {
      Configuration,
      Code: {
        RepositoryType: "S3",
        Location: `http://${this.host}:${this.port}/code/${fn.name}`,
      },
      Tags: fn.tags.size ? Object.fromEntries(fn.tags) : undefined,
      Concurrency:
        fn.reservedConcurrency !== undefined
          ? { ReservedConcurrentExecutions: fn.reservedConcurrency }
          : undefined,
    };
  }

  deleteFunction(name, url) {
    const { fn, qualifier } = this.requireFunction(name);
    const q = qualifier || this.qualifierFromUrl(url);
    if (q && q !== "$LATEST") {
      // delete a specific version
      if (!fn.versions.has(q)) {
        throw new LambdaError(
          "ResourceNotFoundException",
          `Function not found: ${this.functionArn(fn.name, q)}`,
          404,
        );
      }
      fn.versions.delete(q);
      return {};
    }
    this.account.totalCodeSize -= fn.codeSize;
    this.functions.delete(fn.name);
    return {};
  }

  getFunctionConfiguration(name, url) {
    const { fn, qualifier } = this.requireFunction(name);
    const q = qualifier || this.qualifierFromUrl(url);
    return this.configuration(fn, q);
  }

  updateFunctionConfiguration(name, input) {
    const { fn } = this.requireFunction(name);
    this.validateFunctionConfig(input, { create: false });
    if (input.Runtime !== undefined) {
      if (!VALID_RUNTIMES.has(input.Runtime)) {
        throw new LambdaError(
          "InvalidParameterValueException",
          `Value ${input.Runtime} at 'runtime' failed to satisfy constraint.`,
        );
      }
      fn.runtime = input.Runtime;
    }
    if (input.Role !== undefined) fn.role = input.Role;
    if (input.Handler !== undefined) fn.handler = input.Handler;
    if (input.Description !== undefined) fn.description = input.Description;
    if (input.Timeout !== undefined) fn.timeout = input.Timeout;
    if (input.MemorySize !== undefined) fn.memorySize = input.MemorySize;
    if (input.Environment !== undefined) {
      fn.environment = input.Environment?.Variables ? { ...input.Environment.Variables } : {};
    }
    if (input.TracingConfig?.Mode) fn.tracingMode = input.TracingConfig.Mode;
    if (input.Layers !== undefined) {
      fn.layers = input.Layers.map((arn) => ({ Arn: arn, CodeSize: 0 }));
    }
    if (input.EphemeralStorage?.Size) fn.ephemeralStorage = input.EphemeralStorage.Size;
    fn.lastModified = new Date().toISOString();
    fn.revisionId = randomUUID();
    return this.configuration(fn, "$LATEST");
  }

  updateFunctionCode(name, input) {
    const { fn } = this.requireFunction(name);
    // Real API requires exactly one code source: ZipFile, S3Bucket(+S3Key), or
    // ImageUri. Omitting all of them is an InvalidParameterValueException (400),
    // not a silent success. (API_UpdateFunctionCode.html.)
    if (
      input.ZipFile === undefined &&
      input.S3Bucket === undefined &&
      input.ImageUri === undefined &&
      input._parlelHandler === undefined
    ) {
      throw new LambdaError(
        "InvalidParameterValueException",
        "Please provide a source for function code.",
      );
    }
    const codeInput = {};
    if (input.ZipFile) codeInput.ZipFile = input.ZipFile;
    else if (input.ImageUri) codeInput.ImageUri = input.ImageUri;
    else codeInput.S3Bucket = input.S3Bucket;
    const { size, sha256, source } = this.extractCode(codeInput);
    this.account.totalCodeSize += size - fn.codeSize;
    fn.codeSize = size;
    fn.codeSha256 = sha256;
    if (input._parlelHandler !== undefined) fn.codeSource = input._parlelHandler;
    else if (source !== undefined) fn.codeSource = source;
    if (input.Architectures) fn.architectures = input.Architectures;
    fn.lastModified = new Date().toISOString();
    fn.revisionId = randomUUID();
    let publishedVersion;
    if (input.Publish) publishedVersion = this.snapshotVersion(fn);
    return this.configuration(fn, publishedVersion || "$LATEST");
  }

  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------
  snapshotVersion(fn) {
    const version = String(fn.nextVersion++);
    const snap = {
      runtime: fn.runtime,
      role: fn.role,
      handler: fn.handler,
      description: fn.description,
      timeout: fn.timeout,
      memorySize: fn.memorySize,
      codeSize: fn.codeSize,
      codeSha256: fn.codeSha256,
      revisionId: randomUUID(),
      lastModified: new Date().toISOString(),
      environment: { ...fn.environment },
      tracingMode: fn.tracingMode,
      packageType: fn.packageType,
      architectures: fn.architectures,
      layers: fn.layers,
      ephemeralStorage: fn.ephemeralStorage,
      codeSource: fn.codeSource,
    };
    fn.versions.set(version, snap);
    return version;
  }

  publishVersion(name, input) {
    const { fn } = this.requireFunction(name);
    if (input.CodeSha256 && input.CodeSha256 !== fn.codeSha256) {
      throw new LambdaError(
        "PreconditionFailedException",
        "CodeSha256 does not match the current code of the function.",
        412,
      );
    }
    if (input.RevisionId && input.RevisionId !== fn.revisionId) {
      throw new LambdaError(
        "PreconditionFailedException",
        "Revision id provided does not match the latest revision id.",
        412,
      );
    }
    const version = this.snapshotVersion(fn);
    if (input.Description !== undefined) fn.versions.get(version).description = input.Description;
    return this.configuration(fn, version);
  }

  listVersionsByFunction(name, url) {
    const { fn } = this.requireFunction(name);
    const versions = ["$LATEST", ...[...fn.versions.keys()].sort((a, b) => Number(a) - Number(b))];
    const Versions = versions.map((v) => this.configuration(fn, v));
    return { Versions };
  }

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------
  aliasResponse(fn, alias) {
    const out = {
      AliasArn: `${this.functionArn(fn.name)}:${alias.name}`,
      Name: alias.name,
      FunctionVersion: alias.functionVersion,
      Description: alias.description || "",
      RevisionId: alias.revisionId,
    };
    if (alias.routingConfig) out.RoutingConfig = alias.routingConfig;
    return out;
  }

  createAlias(name, input) {
    const { fn } = this.requireFunction(name);
    if (!input.Name) {
      throw new LambdaError("InvalidParameterValueException", "Alias Name is required.");
    }
    if (!input.FunctionVersion) {
      throw new LambdaError("InvalidParameterValueException", "FunctionVersion is required.");
    }
    if (fn.aliases.has(input.Name)) {
      throw new LambdaError(
        "ResourceConflictException",
        `Alias already exists: ${this.functionArn(fn.name)}:${input.Name}`,
        409,
      );
    }
    if (input.FunctionVersion !== "$LATEST" && !fn.versions.has(input.FunctionVersion)) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `Function not found: ${this.functionArn(fn.name, input.FunctionVersion)}`,
        404,
      );
    }
    const alias = {
      name: input.Name,
      functionVersion: input.FunctionVersion,
      description: input.Description || "",
      routingConfig: input.RoutingConfig,
      revisionId: randomUUID(),
    };
    fn.aliases.set(alias.name, alias);
    return this.aliasResponse(fn, alias);
  }

  requireAlias(fn, aliasName) {
    const alias = fn.aliases.get(aliasName);
    if (!alias) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `Cannot find alias arn: ${this.functionArn(fn.name)}:${aliasName}`,
        404,
      );
    }
    return alias;
  }

  getAlias(name, aliasName) {
    const { fn } = this.requireFunction(name);
    return this.aliasResponse(fn, this.requireAlias(fn, aliasName));
  }

  updateAlias(name, aliasName, input) {
    const { fn } = this.requireFunction(name);
    const alias = this.requireAlias(fn, aliasName);
    if (input.FunctionVersion !== undefined) {
      if (input.FunctionVersion !== "$LATEST" && !fn.versions.has(input.FunctionVersion)) {
        throw new LambdaError(
          "ResourceNotFoundException",
          `Function not found: ${this.functionArn(fn.name, input.FunctionVersion)}`,
          404,
        );
      }
      alias.functionVersion = input.FunctionVersion;
    }
    if (input.Description !== undefined) alias.description = input.Description;
    if (input.RoutingConfig !== undefined) alias.routingConfig = input.RoutingConfig;
    alias.revisionId = randomUUID();
    return this.aliasResponse(fn, alias);
  }

  deleteAlias(name, aliasName) {
    const { fn } = this.requireFunction(name);
    fn.aliases.delete(aliasName);
    return {};
  }

  listAliases(name, url) {
    const { fn } = this.requireFunction(name);
    const fnVersion = url.searchParams.get("FunctionVersion");
    let aliases = [...fn.aliases.values()];
    if (fnVersion) aliases = aliases.filter((a) => a.functionVersion === fnVersion);
    aliases.sort((a, b) => a.name.localeCompare(b.name));
    return { Aliases: aliases.map((a) => this.aliasResponse(fn, a)) };
  }

  // -------------------------------------------------------------------------
  // Resource policy / permissions
  // -------------------------------------------------------------------------
  addPermission(name, input, url) {
    const { fn } = this.requireFunction(name);
    if (!input.StatementId) {
      throw new LambdaError("InvalidParameterValueException", "StatementId is required.");
    }
    if (!input.Action) {
      throw new LambdaError("InvalidParameterValueException", "Action is required.");
    }
    if (!input.Principal) {
      throw new LambdaError("InvalidParameterValueException", "Principal is required.");
    }
    if (fn.policyStatements.has(input.StatementId)) {
      throw new LambdaError(
        "ResourceConflictException",
        `The statement id (${input.StatementId}) provided already exists. Please provide a new statement id, or remove the existing statement.`,
        409,
      );
    }
    const statement = {
      Sid: input.StatementId,
      Effect: "Allow",
      Principal: { Service: input.Principal },
      Action: input.Action,
      Resource: this.functionArn(fn.name, this.qualifierFromUrl(url)),
    };
    if (input.SourceArn) {
      statement.Condition = { ArnLike: { "AWS:SourceArn": input.SourceArn } };
    }
    if (input.SourceAccount) {
      statement.Condition = statement.Condition || {};
      statement.Condition.StringEquals = { "AWS:SourceAccount": input.SourceAccount };
    }
    fn.policyStatements.set(input.StatementId, statement);
    return { Statement: JSON.stringify(statement) };
  }

  removePermission(name, sid, url) {
    const { fn } = this.requireFunction(name);
    if (!fn.policyStatements.has(sid)) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `The resource you requested does not exist.`,
        404,
      );
    }
    fn.policyStatements.delete(sid);
    return {};
  }

  getPolicy(name, url) {
    const { fn } = this.requireFunction(name);
    if (fn.policyStatements.size === 0) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `The resource you requested does not exist.`,
        404,
      );
    }
    const policy = {
      Version: "2012-10-17",
      Id: "default",
      Statement: [...fn.policyStatements.values()],
    };
    return { Policy: JSON.stringify(policy), RevisionId: fn.revisionId };
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  tagTarget(arn) {
    const { name } = this.parseFunctionRef(arn);
    const fn = this.functions.get(name);
    if (!fn) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `Function not found: ${arn}`,
        404,
      );
    }
    return fn;
  }

  tagResource(arn, input) {
    const fn = this.tagTarget(arn);
    const tags = input.Tags || {};
    if (Object.keys(tags).length === 0) {
      throw new LambdaError("InvalidParameterValueException", "Tags must not be empty.");
    }
    for (const [k, v] of Object.entries(tags)) fn.tags.set(k, String(v));
    return {};
  }

  untagResource(arn, url) {
    const fn = this.tagTarget(arn);
    const keys = url.searchParams.getAll("tagKeys");
    if (keys.length === 0) {
      throw new LambdaError("InvalidParameterValueException", "TagKeys must not be empty.");
    }
    for (const k of keys) fn.tags.delete(k);
    return {};
  }

  listTags(arn) {
    const fn = this.tagTarget(arn);
    return { Tags: Object.fromEntries(fn.tags) };
  }

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------
  putFunctionConcurrency(name, input) {
    const { fn } = this.requireFunction(name);
    const n = Number(input.ReservedConcurrentExecutions);
    if (Number.isNaN(n) || n < 0) {
      throw new LambdaError(
        "InvalidParameterValueException",
        "ReservedConcurrentExecutions must be >= 0.",
      );
    }
    fn.reservedConcurrency = n;
    return { ReservedConcurrentExecutions: n };
  }

  getFunctionConcurrency(name) {
    const { fn } = this.requireFunction(name);
    return fn.reservedConcurrency !== undefined
      ? { ReservedConcurrentExecutions: fn.reservedConcurrency }
      : {};
  }

  deleteFunctionConcurrency(name) {
    const { fn } = this.requireFunction(name);
    fn.reservedConcurrency = undefined;
    return {};
  }

  // -------------------------------------------------------------------------
  // Function URL configs
  // -------------------------------------------------------------------------
  createFunctionUrlConfig(name, input, url) {
    const { fn } = this.requireFunction(name);
    if (fn.urlConfig) {
      throw new LambdaError(
        "ResourceConflictException",
        "FunctionUrlConfig exists for this Lambda function.",
        409,
      );
    }
    const now = new Date().toISOString();
    fn.urlConfig = {
      FunctionUrl: `https://${randomUUID().replace(/-/g, "")}.lambda-url.${this.region}.on.aws/`,
      FunctionArn: this.functionArn(fn.name),
      AuthType: input.AuthType || "NONE",
      Cors: input.Cors,
      InvokeMode: input.InvokeMode || "BUFFERED",
      CreationTime: now,
      LastModifiedTime: now,
    };
    return { ...fn.urlConfig };
  }

  getFunctionUrlConfig(name, url) {
    const { fn } = this.requireFunction(name);
    if (!fn.urlConfig) {
      throw new LambdaError(
        "ResourceNotFoundException",
        "The resource you requested does not exist.",
        404,
      );
    }
    return { ...fn.urlConfig };
  }

  updateFunctionUrlConfig(name, input, url) {
    const { fn } = this.requireFunction(name);
    if (!fn.urlConfig) {
      throw new LambdaError(
        "ResourceNotFoundException",
        "The resource you requested does not exist.",
        404,
      );
    }
    if (input.AuthType !== undefined) fn.urlConfig.AuthType = input.AuthType;
    if (input.Cors !== undefined) fn.urlConfig.Cors = input.Cors;
    if (input.InvokeMode !== undefined) fn.urlConfig.InvokeMode = input.InvokeMode;
    fn.urlConfig.LastModifiedTime = new Date().toISOString();
    return { ...fn.urlConfig };
  }

  deleteFunctionUrlConfig(name, url) {
    const { fn } = this.requireFunction(name);
    fn.urlConfig = undefined;
    return {};
  }

  listFunctionUrlConfigs(name) {
    const { fn } = this.requireFunction(name);
    const configs = fn.urlConfig ? [{ ...fn.urlConfig }] : [];
    return { FunctionUrlConfigs: configs };
  }

  // -------------------------------------------------------------------------
  // Account settings
  // -------------------------------------------------------------------------
  getAccountSettings() {
    return {
      AccountLimit: {
        TotalCodeSize: 80530636800,
        CodeSizeUnzipped: 262144000,
        CodeSizeZipped: 52428800,
        ConcurrentExecutions: this.account.concurrentExecutions,
        UnreservedConcurrentExecutions: this.account.unreservedConcurrentExecutions,
      },
      AccountUsage: {
        TotalCodeSize: this.account.totalCodeSize,
        FunctionCount: this.functions.size,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Invoke — actually run handler source when available.
  // -------------------------------------------------------------------------
  resolveExecutable(fn, qualifier) {
    if (!qualifier || qualifier === "$LATEST") return { source: fn.codeSource, version: "$LATEST" };
    if (fn.aliases.has(qualifier)) {
      const v = fn.aliases.get(qualifier).functionVersion;
      if (v === "$LATEST") return { source: fn.codeSource, version: "$LATEST" };
      const snap = fn.versions.get(v);
      if (!snap) {
        throw new LambdaError(
          "ResourceNotFoundException",
          `Function not found: ${this.functionArn(fn.name, qualifier)}`,
          404,
        );
      }
      return { source: snap.codeSource, version: v };
    }
    const snap = fn.versions.get(qualifier);
    if (!snap) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `Function not found: ${this.functionArn(fn.name, qualifier)}`,
        404,
      );
    }
    return { source: snap.codeSource, version: qualifier };
  }

  async runHandler(source, fn, eventBuf, version) {
    // Build an event object from the payload (JSON if possible, else raw string).
    let event;
    const text = eventBuf.length ? eventBuf.toString("utf8") : "";
    try {
      event = text ? JSON.parse(text) : {};
    } catch {
      event = text;
    }
    const logs = [];
    const sandboxConsole = {
      log: (...a) => logs.push(a.map(String).join(" ")),
      error: (...a) => logs.push(a.map(String).join(" ")),
      warn: (...a) => logs.push(a.map(String).join(" ")),
      info: (...a) => logs.push(a.map(String).join(" ")),
    };
    const context = {
      functionName: fn.name,
      functionVersion: version,
      invokedFunctionArn: this.functionArn(fn.name, version === "$LATEST" ? undefined : version),
      memoryLimitInMB: String(fn.memorySize),
      awsRequestId: randomUUID(),
      logGroupName: `/aws/lambda/${fn.name}`,
      logStreamName: new Date().toISOString(),
      getRemainingTimeInMillis: () => fn.timeout * 1000,
    };
    // Compile the handler module in a function scope (no vm dependency needed).
    const moduleObj = { exports: {} };
    const handlerName = (fn.handler || "index.handler").split(".").pop() || "handler";
    const factory = new Function(
      "module",
      "exports",
      "console",
      "process",
      `${source}\n;return module.exports;`,
    );
    const env = { ...process.env, ...(fn.environment || {}) };
    const fakeProcess = { env, version: process.version, platform: process.platform };
    const exportsObj = factory(moduleObj, moduleObj.exports, sandboxConsole, fakeProcess);
    const handlerFn =
      (exportsObj && exportsObj[handlerName]) ||
      (typeof exportsObj === "function" ? exportsObj : undefined) ||
      (moduleObj.exports && moduleObj.exports[handlerName]);
    if (typeof handlerFn !== "function") {
      throw new Error(
        `Bad handler: ${fn.handler} — exported ${handlerName} is not a function.`,
      );
    }
    // Support async (Promise) and callback styles.
    let result;
    if (handlerFn.length >= 3) {
      result = await new Promise((resolve, reject) => {
        const cb = (err, data) => (err ? reject(err) : resolve(data));
        const maybe = handlerFn(event, context, cb);
        if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
      });
    } else {
      result = await handlerFn(event, context);
    }
    return { result, logs };
  }

  async invoke(res, params, url, rawBody, headers = {}) {
    let fnInfo;
    try {
      fnInfo = this.requireFunction(params.name);
    } catch (error) {
      return this.sendError(res, error);
    }
    const { fn } = fnInfo;
    const qualifier = this.qualifierFromUrl(url) || fnInfo.qualifier || "$LATEST";
    // InvocationType / LogType are sent as headers by @aws-sdk/client-lambda
    // (X-Amz-Invocation-Type / X-Amz-Log-Type). Query params are accepted as a
    // fallback for raw HTTP callers.
    const invocationType =
      headers["x-amz-invocation-type"] ||
      url.searchParams.get("InvocationType") ||
      "RequestResponse";
    const logType =
      headers["x-amz-log-type"] || url.searchParams.get("LogType") || "None";

    if (!["RequestResponse", "Event", "DryRun"].includes(invocationType)) {
      return this.sendError(
        res,
        new LambdaError(
          "InvalidParameterValueException",
          `Invalid InvocationType: ${invocationType}`,
        ),
      );
    }

    let executable;
    try {
      executable = this.resolveExecutable(fn, qualifier);
    } catch (error) {
      return this.sendError(res, error);
    }
    const execVersion = executable.version;

    res.setHeader("X-Amz-Executed-Version", execVersion);

    if (invocationType === "DryRun") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (invocationType === "Event") {
      // Async: accept and return 202 with empty body.
      // Still attempt execution best-effort but ignore result/errors.
      if (executable.source) {
        this.runHandler(executable.source, fn, rawBody, execVersion).catch(() => {});
      }
      res.statusCode = 202;
      res.end();
      return;
    }

    // RequestResponse
    let payloadBuf;
    let functionError;
    let logs = [];
    try {
      if (executable.source) {
        const { result, logs: runLogs } = await this.runHandler(
          executable.source,
          fn,
          rawBody,
          execVersion,
        );
        logs = runLogs;
        payloadBuf = Buffer.from(
          result === undefined ? "null" : JSON.stringify(result),
          "utf8",
        );
      } else {
        // No executable source: echo the input payload (LocalStack-style).
        payloadBuf = rawBody.length ? rawBody : Buffer.from("null", "utf8");
      }
    } catch (err) {
      // Handler threw -> Lambda returns 200 with FunctionError + error payload.
      functionError = "Unhandled";
      const errorPayload = {
        errorType: err && err.name ? err.name : "Error",
        errorMessage: err && err.message ? err.message : String(err),
        trace: err && err.stack ? String(err.stack).split("\n") : [],
      };
      payloadBuf = Buffer.from(JSON.stringify(errorPayload), "utf8");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    if (functionError) res.setHeader("X-Amz-Function-Error", functionError);
    if (logType === "Tail") {
      const tail = logs.slice(-50).join("\n");
      res.setHeader(
        "X-Amz-Log-Result",
        Buffer.from(tail, "utf8").toString("base64"),
      );
    }
    res.end(payloadBuf);
  }

  invokeAsync(name) {
    this.requireFunction(name);
    return { Status: 202 };
  }

  // -------------------------------------------------------------------------
  // Event source mappings
  // -------------------------------------------------------------------------
  esmResponse(m) {
    return {
      UUID: m.uuid,
      EventSourceArn: m.eventSourceArn,
      FunctionArn: m.functionArn,
      BatchSize: m.batchSize,
      MaximumBatchingWindowInSeconds: m.maximumBatchingWindowInSeconds,
      State: m.state,
      StateTransitionReason: m.stateTransitionReason,
      LastModified: m.lastModified,
      LastProcessingResult: m.lastProcessingResult,
      StartingPosition: m.startingPosition,
      FunctionResponseTypes: m.functionResponseTypes,
    };
  }

  createEventSourceMapping(input) {
    if (!input.FunctionName) {
      throw new LambdaError("InvalidParameterValueException", "FunctionName is required.");
    }
    const { fn } = this.requireFunction(input.FunctionName);
    if (!input.EventSourceArn && !input.SelfManagedEventSource) {
      throw new LambdaError(
        "InvalidParameterValueException",
        "EventSourceArn is required.",
      );
    }
    const uuid = randomUUID();
    const now = Date.now() / 1000; // ESM LastModified is an epoch timestamp
    const mapping = {
      uuid,
      eventSourceArn: input.EventSourceArn,
      functionArn: this.functionArn(fn.name),
      batchSize: input.BatchSize ?? 10,
      maximumBatchingWindowInSeconds: input.MaximumBatchingWindowInSeconds ?? 0,
      state: input.Enabled === false ? "Disabled" : "Enabled",
      stateTransitionReason: "User action",
      lastModified: now,
      lastProcessingResult: "No records processed",
      startingPosition: input.StartingPosition,
      functionResponseTypes: input.FunctionResponseTypes,
    };
    this.eventSourceMappings.set(uuid, mapping);
    return this.esmResponse(mapping);
  }

  requireEsm(uuid) {
    const m = this.eventSourceMappings.get(uuid);
    if (!m) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `Event source mapping not found: ${uuid}`,
        404,
      );
    }
    return m;
  }

  getEventSourceMapping(uuid) {
    return this.esmResponse(this.requireEsm(uuid));
  }

  listEventSourceMappings(url) {
    const fnName = url.searchParams.get("FunctionName");
    const eventSourceArn = url.searchParams.get("EventSourceArn");
    let mappings = [...this.eventSourceMappings.values()];
    if (fnName) {
      const wantArn = this.functionArn(this.parseFunctionRef(fnName).name);
      mappings = mappings.filter((m) => m.functionArn === wantArn);
    }
    if (eventSourceArn) mappings = mappings.filter((m) => m.eventSourceArn === eventSourceArn);
    return { EventSourceMappings: mappings.map((m) => this.esmResponse(m)) };
  }

  updateEventSourceMapping(uuid, input) {
    const m = this.requireEsm(uuid);
    if (input.BatchSize !== undefined) m.batchSize = input.BatchSize;
    if (input.MaximumBatchingWindowInSeconds !== undefined) {
      m.maximumBatchingWindowInSeconds = input.MaximumBatchingWindowInSeconds;
    }
    if (input.Enabled !== undefined) m.state = input.Enabled ? "Enabled" : "Disabled";
    if (input.FunctionResponseTypes !== undefined) {
      m.functionResponseTypes = input.FunctionResponseTypes;
    }
    if (input.FunctionName) {
      const { fn } = this.requireFunction(input.FunctionName);
      m.functionArn = this.functionArn(fn.name);
    }
    m.lastModified = Date.now() / 1000;
    return this.esmResponse(m);
  }

  deleteEventSourceMapping(uuid) {
    const m = this.requireEsm(uuid);
    m.state = "Deleting";
    this.eventSourceMappings.delete(uuid);
    return this.esmResponse(m);
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------
  layerVersionArn(name, versionNumber) {
    return `arn:aws:lambda:${this.region}:${this.accountId}:layer:${name}:${versionNumber}`;
  }

  layerArn(name) {
    return `arn:aws:lambda:${this.region}:${this.accountId}:layer:${name}`;
  }

  publishLayerVersion(layerName, input) {
    if (!this.layers.has(layerName)) {
      this.layers.set(layerName, { nextVersion: 1, versions: new Map() });
    }
    const layer = this.layers.get(layerName);
    const versionNumber = layer.nextVersion++;
    let size = 0;
    if (input.Content && input.Content.ZipFile) {
      const buf = Buffer.isBuffer(input.Content.ZipFile)
        ? input.Content.ZipFile
        : Buffer.from(input.Content.ZipFile, "base64");
      size = buf.length;
    }
    const now = new Date().toISOString();
    const record = {
      versionNumber,
      description: input.Description || "",
      createdDate: now,
      compatibleRuntimes: input.CompatibleRuntimes || [],
      compatibleArchitectures: input.CompatibleArchitectures || [],
      licenseInfo: input.LicenseInfo,
      codeSize: size,
      codeSha256: createHash("sha256").update(String(size)).digest("base64"),
    };
    layer.versions.set(versionNumber, record);
    return this.layerVersionResponse(layerName, record);
  }

  layerVersionResponse(layerName, record) {
    return {
      LayerArn: this.layerArn(layerName),
      LayerVersionArn: this.layerVersionArn(layerName, record.versionNumber),
      Version: record.versionNumber,
      Description: record.description,
      CreatedDate: record.createdDate,
      CompatibleRuntimes: record.compatibleRuntimes,
      CompatibleArchitectures: record.compatibleArchitectures,
      LicenseInfo: record.licenseInfo,
      Content: {
        CodeSize: record.codeSize,
        CodeSha256: record.codeSha256,
        Location: `http://${this.host}:${this.port}/layers/${layerName}/${record.versionNumber}`,
      },
    };
  }

  listLayers() {
    const layers = [];
    for (const [name, layer] of this.layers) {
      const versions = [...layer.versions.values()].sort(
        (a, b) => b.versionNumber - a.versionNumber,
      );
      if (versions.length === 0) continue;
      const latest = versions[0];
      layers.push({
        LayerName: name,
        LayerArn: this.layerArn(name),
        LatestMatchingVersion: {
          LayerVersionArn: this.layerVersionArn(name, latest.versionNumber),
          Version: latest.versionNumber,
          Description: latest.description,
          CreatedDate: latest.createdDate,
          CompatibleRuntimes: latest.compatibleRuntimes,
        },
      });
    }
    return { Layers: layers };
  }

  requireLayer(layerName) {
    const layer = this.layers.get(layerName);
    if (!layer) {
      throw new LambdaError("ResourceNotFoundException", `Layer not found: ${layerName}`, 404);
    }
    return layer;
  }

  listLayerVersions(layerName) {
    const layer = this.layers.get(layerName);
    if (!layer) return { LayerVersions: [] };
    const versions = [...layer.versions.values()]
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .map((r) => ({
        LayerVersionArn: this.layerVersionArn(layerName, r.versionNumber),
        Version: r.versionNumber,
        Description: r.description,
        CreatedDate: r.createdDate,
        CompatibleRuntimes: r.compatibleRuntimes,
        CompatibleArchitectures: r.compatibleArchitectures,
        LicenseInfo: r.licenseInfo,
      }));
    return { LayerVersions: versions };
  }

  getLayerVersion(layerName, versionNumber) {
    const layer = this.requireLayer(layerName);
    const record = layer.versions.get(Number(versionNumber));
    if (!record) {
      throw new LambdaError(
        "ResourceNotFoundException",
        `Layer version not found: ${layerName}:${versionNumber}`,
        404,
      );
    }
    return this.layerVersionResponse(layerName, record);
  }

  deleteLayerVersion(layerName, versionNumber) {
    const layer = this.layers.get(layerName);
    if (layer) layer.versions.delete(Number(versionNumber));
    return {};
  }

  // -------------------------------------------------------------------------
  // Provisioned concurrency
  // -------------------------------------------------------------------------
  putProvisionedConcurrencyConfig(name, input, url) {
    const { fn } = this.requireFunction(name);
    const qualifier = this.qualifierFromUrl(url);
    if (!qualifier || qualifier === "$LATEST") {
      throw new LambdaError(
        "InvalidParameterValueException",
        "Provisioned concurrency requires a published version or alias qualifier.",
      );
    }
    const n = Number(input.ProvisionedConcurrentExecutions);
    if (Number.isNaN(n) || n < 1) {
      throw new LambdaError(
        "InvalidParameterValueException",
        "ProvisionedConcurrentExecutions must be >= 1.",
      );
    }
    if (!fn.provisionedConcurrency) fn.provisionedConcurrency = new Map();
    const now = new Date().toISOString();
    fn.provisionedConcurrency.set(qualifier, {
      qualifier,
      requested: n,
      available: n,
      allocated: n,
      status: "READY",
      lastModified: now,
    });
    return this.pcResponse(fn.provisionedConcurrency.get(qualifier));
  }

  pcResponse(c) {
    return {
      RequestedProvisionedConcurrentExecutions: c.requested,
      AvailableProvisionedConcurrentExecutions: c.available,
      AllocatedProvisionedConcurrentExecutions: c.allocated,
      Status: c.status,
      LastModified: c.lastModified,
    };
  }

  getProvisionedConcurrencyConfig(name, url) {
    const { fn } = this.requireFunction(name);
    const qualifier = this.qualifierFromUrl(url);
    const c = fn.provisionedConcurrency && fn.provisionedConcurrency.get(qualifier);
    if (!c) {
      throw new LambdaError(
        "ProvisionedConcurrencyConfigNotFoundException",
        "No Provisioned Concurrency Config found for this function.",
        404,
      );
    }
    return this.pcResponse(c);
  }

  listProvisionedConcurrencyConfigs(name) {
    const { fn } = this.requireFunction(name);
    const configs = [];
    if (fn.provisionedConcurrency) {
      for (const c of fn.provisionedConcurrency.values()) {
        configs.push({
          FunctionArn: this.functionArn(fn.name, c.qualifier),
          ...this.pcResponse(c),
        });
      }
    }
    return { ProvisionedConcurrencyConfigs: configs };
  }

  deleteProvisionedConcurrencyConfig(name, url) {
    const { fn } = this.requireFunction(name);
    const qualifier = this.qualifierFromUrl(url);
    if (fn.provisionedConcurrency) fn.provisionedConcurrency.delete(qualifier);
    return {};
  }

  // -------------------------------------------------------------------------
  // Function event invoke config (async retry settings)
  // -------------------------------------------------------------------------
  eicResponse(fn, qualifier, cfg) {
    return {
      LastModified: cfg.lastModified,
      FunctionArn: this.functionArn(fn.name, qualifier && qualifier !== "$LATEST" ? qualifier : undefined),
      MaximumRetryAttempts: cfg.maximumRetryAttempts,
      MaximumEventAgeInSeconds: cfg.maximumEventAgeInSeconds,
      DestinationConfig: cfg.destinationConfig,
    };
  }

  putFunctionEventInvokeConfig(name, input, url, replace) {
    const { fn } = this.requireFunction(name);
    const qualifier = this.qualifierFromUrl(url) || "$LATEST";
    if (!fn.eventInvokeConfigs) fn.eventInvokeConfigs = new Map();
    const existing = fn.eventInvokeConfigs.get(qualifier) || {};
    const cfg = replace
      ? {
          maximumRetryAttempts: input.MaximumRetryAttempts ?? 2,
          maximumEventAgeInSeconds: input.MaximumEventAgeInSeconds,
          destinationConfig: input.DestinationConfig,
        }
      : {
          maximumRetryAttempts:
            input.MaximumRetryAttempts !== undefined
              ? input.MaximumRetryAttempts
              : existing.maximumRetryAttempts ?? 2,
          maximumEventAgeInSeconds:
            input.MaximumEventAgeInSeconds !== undefined
              ? input.MaximumEventAgeInSeconds
              : existing.maximumEventAgeInSeconds,
          destinationConfig:
            input.DestinationConfig !== undefined
              ? input.DestinationConfig
              : existing.destinationConfig,
        };
    cfg.lastModified = Date.now() / 1000; // EIC LastModified is an epoch timestamp
    fn.eventInvokeConfigs.set(qualifier, cfg);
    return this.eicResponse(fn, qualifier, cfg);
  }

  getFunctionEventInvokeConfig(name, url) {
    const { fn } = this.requireFunction(name);
    const qualifier = this.qualifierFromUrl(url) || "$LATEST";
    const cfg = fn.eventInvokeConfigs && fn.eventInvokeConfigs.get(qualifier);
    if (!cfg) {
      throw new LambdaError(
        "ResourceNotFoundException",
        "The function does not have an EventInvokeConfig.",
        404,
      );
    }
    return this.eicResponse(fn, qualifier, cfg);
  }

  listFunctionEventInvokeConfigs(name) {
    const { fn } = this.requireFunction(name);
    const list = [];
    if (fn.eventInvokeConfigs) {
      for (const [qualifier, cfg] of fn.eventInvokeConfigs) {
        list.push(this.eicResponse(fn, qualifier, cfg));
      }
    }
    return { FunctionEventInvokeConfigs: list };
  }

  deleteFunctionEventInvokeConfig(name, url) {
    const { fn } = this.requireFunction(name);
    const qualifier = this.qualifierFromUrl(url) || "$LATEST";
    if (fn.eventInvokeConfigs) fn.eventInvokeConfigs.delete(qualifier);
    return {};
  }

  // -------------------------------------------------------------------------
  // Recursion config
  // -------------------------------------------------------------------------
  putFunctionRecursionConfig(name, input) {
    const { fn } = this.requireFunction(name);
    const value = input.RecursiveLoop || "Terminate";
    if (!["Allow", "Terminate"].includes(value)) {
      throw new LambdaError(
        "ValidationException",
        "RecursiveLoop must be 'Allow' or 'Terminate'.",
      );
    }
    fn.recursiveLoop = value;
    return { RecursiveLoop: value };
  }

  getFunctionRecursionConfig(name) {
    const { fn } = this.requireFunction(name);
    return { RecursiveLoop: fn.recursiveLoop || "Terminate" };
  }

  // -------------------------------------------------------------------------
  // Runtime management config
  // -------------------------------------------------------------------------
  putRuntimeManagementConfig(name, input) {
    const { fn } = this.requireFunction(name);
    const updateOn = input.UpdateRuntimeOn || "Auto";
    fn.runtimeManagement = {
      UpdateRuntimeOn: updateOn,
      RuntimeVersionArn: input.RuntimeVersionArn,
    };
    return {
      UpdateRuntimeOn: updateOn,
      FunctionArn: this.functionArn(fn.name),
      RuntimeVersionArn: input.RuntimeVersionArn,
    };
  }

  getRuntimeManagementConfig(name) {
    const { fn } = this.requireFunction(name);
    const rm = fn.runtimeManagement || { UpdateRuntimeOn: "Auto" };
    return {
      UpdateRuntimeOn: rm.UpdateRuntimeOn,
      RuntimeVersionArn: rm.RuntimeVersionArn,
      FunctionArn: this.functionArn(fn.name),
    };
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    if (status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "ServiceException";
    const status = error.status || ERROR_STATUS[code] || 400;
    // restJson1 resolves the error code from the x-amzn-errortype header first.
    res.setHeader("x-amzn-errortype", code);
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    // Canonical restJson1 Lambda error body: `__type` discriminator + lowercase
    // `message`. The real API does not emit a `Message` (capital-M) key.
    res.end(
      JSON.stringify({
        __type: code,
        message: error.message || code,
      }),
    );
  }
}

export default LambdaServer;
