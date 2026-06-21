// parlel/ssm — a lightweight, dependency-free fake of AWS Systems Manager (SSM)
// Parameter Store.
//
// Speaks the AWS JSON 1.1 wire protocol so that application code using the real
// `@aws-sdk/client-ssm` client can run against it with zero cost and zero side
// effects. Pure Node.js, no external npm dependencies. State is in-memory and
// ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-ssm v3):
//   * Requests are POST / with header `X-Amz-Target: AmazonSSM.<Operation>`
//     and `Content-Type: application/x-amz-json-1.1`. Body is JSON input.
//   * Timestamp fields (LastModifiedDate, ...) are epoch-seconds numbers.
//   * Success: 200, JSON output, `Content-Type: application/x-amz-json-1.1`.
//   * Error: non-2xx, JSON `{ "__type": "<Code>", "message": "<msg>" }`.
//
// Scope: the Parameter Store surface — the part of SSM that application code
// actually uses for configuration and secrets — plus the universal tagging,
// resource-policy and service-setting operations that apply to parameters.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";
const TARGET_PREFIX = "AmazonSSM";

// SSM error codes -> HTTP status. Sender (client) faults are 400, Receiver
// (server) faults 500. The real client maps `__type` -> error.name.
const ERROR_STATUS = {
  ParameterNotFound: 400,
  ParameterAlreadyExists: 400,
  ParameterLimitExceeded: 400,
  ParameterMaxVersionLimitExceeded: 400,
  ParameterVersionNotFound: 400,
  ParameterVersionLabelLimitExceeded: 400,
  ParameterPatternMismatchException: 400,
  InvalidKeyId: 400,
  InvalidParameters: 400,
  InvalidFilterKey: 400,
  InvalidFilterValue: 400,
  InvalidFilterOption: 400,
  InvalidNextToken: 400,
  InvalidAllowedPatternException: 400,
  InvalidPolicyTypeException: 400,
  InvalidPolicyAttributeException: 400,
  IncompatiblePolicyException: 400,
  PoliciesLimitExceededException: 400,
  HierarchyLevelLimitExceededException: 400,
  HierarchyTypeMismatchException: 400,
  InvalidResourceId: 400,
  InvalidResourceType: 400,
  TooManyUpdates: 400,
  TooManyTagsError: 400,
  UnsupportedParameterType: 400,
  UnsupportedInventorySchemaVersionException: 400,
  ValidationException: 400,
  ResourcePolicyNotFoundException: 400,
  ResourcePolicyConflictException: 400,
  ResourcePolicyInvalidParameterException: 400,
  ResourcePolicyLimitExceededException: 400,
  MalformedResourcePolicyDocumentException: 400,
  ServiceSettingNotFound: 400,
  DoesNotExistException: 400,
  InternalServerError: 500,
  InternalFailure: 500,
  AccessDeniedException: 403,
  UnrecognizedClientException: 403,
};

class SsmError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Timestamps are returned as epoch-seconds numbers across the JSON 1.1 wire.
function epochSeconds(ms = Date.now()) {
  return Math.floor(ms / 1000);
}

const VALID_PARAMETER_TYPES = new Set(["String", "StringList", "SecureString"]);
const VALID_TIERS = new Set(["Standard", "Advanced", "Intelligent-Tiering"]);

// Standard tier name limit; Advanced tier allows larger values.
const STANDARD_VALUE_LIMIT = 4096;
const ADVANCED_VALUE_LIMIT = 8192;
const MAX_PARAMETER_VERSIONS = 100;
const MAX_LABELS_PER_VERSION = 10;

const NAME_PATTERN = /^(\/[A-Za-z0-9._-]+)+$|^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class SsmServer {
  constructor(port = 4578, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // parameters: Map<name, Parameter>
    // Parameter = {
    //   name, type, keyId, description, allowedPattern, tier, dataType,
    //   policies (string|undefined),
    //   currentVersion (number),
    //   createdAt, lastModifiedDate,
    //   versions: Map<version, {
    //     version, value, type, keyId, description, allowedPattern, tier,
    //     dataType, policies, labels:Set<string>, lastModifiedDate, user,
    //   }>,
    //   labels: Map<label, version>,
    //   tags: Map<key,value>,
    // }
    this.parameters = new Map();
    // resourcePolicies: Map<resourceArn, Map<policyId, {policy, hash}>>
    this.resourcePolicies = new Map();
    // serviceSettings: Map<settingId, {value, status, lastModifiedDate, user}>
    this.serviceSettings = new Map();
    // tags for non-parameter resources keyed by `${ResourceType}\u0000${ResourceId}`
    this.resourceTags = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new SsmError("InternalFailure", error.message, 500));
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

  parameterArn(name) {
    const tail = name.startsWith("/") ? name.slice(1) : name;
    return `arn:aws:ssm:${this.region}:${this.accountId}:parameter/${tail}`;
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    // Internal/health endpoints (not part of SSM).
    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "ssm",
        parameters: this.parameters.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-ssm");

    if (method !== "POST") {
      return this.sendError(
        res,
        new SsmError("AccessDeniedException", "Only POST is supported by the parlel ssm fake.", 405),
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
        new SsmError("ValidationException", "Request body is not valid JSON.", 400),
      );
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof SsmError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      // Parameter CRUD
      case "PutParameter":
        return this.putParameter(input);
      case "GetParameter":
        return this.getParameter(input);
      case "GetParameters":
        return this.getParameters(input);
      case "GetParametersByPath":
        return this.getParametersByPath(input);
      case "DeleteParameter":
        return this.deleteParameter(input);
      case "DeleteParameters":
        return this.deleteParameters(input);
      case "DescribeParameters":
        return this.describeParameters(input);
      case "GetParameterHistory":
        return this.getParameterHistory(input);
      // Version labels
      case "LabelParameterVersion":
        return this.labelParameterVersion(input);
      case "UnlabelParameterVersion":
        return this.unlabelParameterVersion(input);
      // Tagging
      case "AddTagsToResource":
        return this.addTagsToResource(input);
      case "RemoveTagsFromResource":
        return this.removeTagsFromResource(input);
      case "ListTagsForResource":
        return this.listTagsForResource(input);
      // Resource policies
      case "PutResourcePolicy":
        return this.putResourcePolicy(input);
      case "GetResourcePolicies":
        return this.getResourcePolicies(input);
      case "DeleteResourcePolicy":
        return this.deleteResourcePolicy(input);
      // Service settings
      case "GetServiceSetting":
        return this.getServiceSetting(input);
      case "UpdateServiceSetting":
        return this.updateServiceSetting(input);
      case "ResetServiceSetting":
        return this.resetServiceSetting(input);
      default:
        throw new SsmError(
          "ValidationException",
          `The action ${operation || "(none)"} is not valid or not supported by the parlel ssm fake.`,
          400,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Parameter resolution: name may carry a selector (:version or :label).
  // -------------------------------------------------------------------------
  splitSelector(rawName) {
    if (typeof rawName !== "string" || rawName.length === 0) {
      throw new SsmError("ValidationException", "Parameter name must be a non-empty string.");
    }
    // A selector follows the LAST colon, but full ARNs contain colons too.
    // SSM parameter names cannot contain ':', so any ':' is a selector marker.
    const idx = rawName.indexOf(":");
    if (idx === -1) return { name: rawName, selector: undefined };
    // Guard against ARNs (start with "arn:aws:ssm:...:parameter/..").
    if (rawName.startsWith("arn:")) {
      const arnTail = rawName.split(":parameter").pop() || "";
      // arnTail is like "/my/param" or "/my/param:2"
      const sub = arnTail.indexOf(":");
      const path = sub === -1 ? arnTail : arnTail.slice(0, sub);
      const selector = sub === -1 ? undefined : arnTail.slice(sub + 1);
      return { name: path, selector, fromArn: true, arn: rawName };
    }
    return { name: rawName.slice(0, idx), selector: rawName.slice(idx + 1) };
  }

  resolveByArnName(name) {
    if (this.parameters.has(name)) return this.parameters.get(name);
    // ARN parameter path is "/x/y"; stored name may be "x/y" without leading slash
    // or vice versa. Try both forms.
    const alt = name.startsWith("/") ? name.slice(1) : `/${name}`;
    if (this.parameters.has(alt)) return this.parameters.get(alt);
    return undefined;
  }

  // Resolve a (name, selector) into a concrete version object.
  resolveVersion(param, selector) {
    if (selector === undefined || selector === "") {
      return param.versions.get(param.currentVersion);
    }
    // Numeric selector -> version number.
    if (/^\d+$/.test(selector)) {
      const v = Number(selector);
      const version = param.versions.get(v);
      if (!version) {
        throw new SsmError(
          "ParameterVersionNotFound",
          `Systems Manager could not find version ${v} of ${param.name}. Verify the version and try again.`,
        );
      }
      return version;
    }
    // Label selector.
    if (param.labels.has(selector)) {
      return param.versions.get(param.labels.get(selector));
    }
    throw new SsmError(
      "ParameterNotFound",
      `Systems Manager could not find the label ${selector} for parameter ${param.name}.`,
    );
  }

  // -------------------------------------------------------------------------
  // PutParameter
  // -------------------------------------------------------------------------
  putParameter(input) {
    const name = input.Name;
    if (!name || typeof name !== "string") {
      throw new SsmError("ValidationException", "The parameter Name is required.");
    }
    if (name.length > 2048) {
      throw new SsmError(
        "ValidationException",
        "1 validation error detected: Value at 'name' failed to satisfy constraint: Member must have length less than or equal to 2048.",
      );
    }
    if (name.startsWith("aws") || name.startsWith("ssm")) {
      // reserved prefixes (case-insensitive) at the start of a hierarchy
      const lower = name.toLowerCase().replace(/^\//, "");
      if (lower.startsWith("aws") || lower.startsWith("ssm")) {
        throw new SsmError(
          "ValidationException",
          "No parameter names can start with the reserved prefixes 'aws' or 'ssm'.",
        );
      }
    }
    if (!NAME_PATTERN.test(name)) {
      throw new SsmError(
        "ValidationException",
        `Parameter name: can't be prefixed with "aws" or "ssm" (case-insensitive). The parameter name "${name}" is invalid.`,
      );
    }
    if (input.Value === undefined || input.Value === null) {
      throw new SsmError("ValidationException", "The parameter Value is required.");
    }
    if (typeof input.Value !== "string") {
      throw new SsmError("ValidationException", "The parameter Value must be a string.");
    }

    const type = input.Type;
    const existing = this.parameters.get(name);

    if (!existing && !type) {
      throw new SsmError(
        "ValidationException",
        "A parameter type is required when you create a parameter.",
      );
    }
    if (type !== undefined && !VALID_PARAMETER_TYPES.has(type)) {
      throw new SsmError(
        "ValidationException",
        `1 validation error detected: Value '${type}' at 'type' failed to satisfy constraint: Member must satisfy enum value set: [SecureString, StringList, String].`,
      );
    }

    const tier = input.Tier && input.Tier !== "Intelligent-Tiering" ? input.Tier : (input.Tier || "Standard");
    if (input.Tier !== undefined && !VALID_TIERS.has(input.Tier)) {
      throw new SsmError(
        "ValidationException",
        `1 validation error detected: Value '${input.Tier}' at 'tier' failed to satisfy constraint.`,
      );
    }
    // Resolve Intelligent-Tiering down to a concrete tier based on size.
    const effectiveTier = this.resolveTier(input.Tier, input.Value, input.Policies);
    const valueLimit = effectiveTier === "Advanced" ? ADVANCED_VALUE_LIMIT : STANDARD_VALUE_LIMIT;
    if (Buffer.byteLength(input.Value, "utf8") > valueLimit) {
      throw new SsmError(
        "ValidationException",
        `1 validation error detected: Value at 'value' failed to satisfy constraint: Member must have length less than or equal to ${valueLimit}.`,
      );
    }

    // StringList values can't contain empty members.
    if ((type === "StringList" || (!type && existing && existing.type === "StringList"))) {
      // ok — comma separated; AWS does not strictly validate here
    }

    // Tags can only be supplied on creation; not together with Overwrite.
    const tags = input.Tags || [];
    if (tags.length && input.Overwrite === true) {
      throw new SsmError(
        "ValidationException",
        "Tags and Overwrite can't be used together. To create a parameter with tags, use the AddTagsToResource action with the existing parameter.",
      );
    }

    const now = Date.now();

    if (existing) {
      if (input.Overwrite !== true) {
        throw new SsmError(
          "ParameterAlreadyExists",
          `The parameter already exists. To overwrite this value, set the overwrite option in the request to true.`,
        );
      }
      if (tags.length) {
        throw new SsmError(
          "ValidationException",
          "Tags can't be specified when overwriting an existing parameter.",
        );
      }
      // New version.
      const newVersion = existing.currentVersion + 1;
      const versionObj = {
        version: newVersion,
        value: input.Value,
        type: type || existing.type,
        keyId: this.resolveKeyId(type || existing.type, input.KeyId),
        description: input.Description !== undefined ? input.Description : undefined,
        allowedPattern: input.AllowedPattern !== undefined ? input.AllowedPattern : existing.allowedPattern,
        tier: effectiveTier,
        dataType: input.DataType || "text",
        policies: input.Policies,
        labels: new Set(),
        lastModifiedDate: now,
        user: `arn:aws:iam::${this.accountId}:user/parlel`,
      };
      this.enforceAllowedPattern(versionObj.allowedPattern, input.Value);
      existing.versions.set(newVersion, versionObj);
      existing.currentVersion = newVersion;
      existing.type = versionObj.type;
      existing.keyId = versionObj.keyId;
      existing.description = versionObj.description;
      existing.allowedPattern = versionObj.allowedPattern;
      existing.tier = effectiveTier;
      existing.dataType = versionObj.dataType;
      existing.policies = input.Policies;
      existing.lastModifiedDate = now;
      this.pruneOldVersions(existing);
      return { Version: newVersion, Tier: effectiveTier };
    }

    // Create.
    this.enforceAllowedPattern(input.AllowedPattern, input.Value);
    const tagMap = new Map();
    for (const t of tags) {
      if (t && t.Key !== undefined) tagMap.set(t.Key, t.Value ?? "");
    }
    const versionObj = {
      version: 1,
      value: input.Value,
      type,
      keyId: this.resolveKeyId(type, input.KeyId),
      description: input.Description,
      allowedPattern: input.AllowedPattern,
      tier: effectiveTier,
      dataType: input.DataType || "text",
      policies: input.Policies,
      labels: new Set(),
      lastModifiedDate: now,
      user: `arn:aws:iam::${this.accountId}:user/parlel`,
    };
    const param = {
      name,
      arn: this.parameterArn(name),
      type,
      keyId: versionObj.keyId,
      description: input.Description,
      allowedPattern: input.AllowedPattern,
      tier: effectiveTier,
      dataType: versionObj.dataType,
      policies: input.Policies,
      currentVersion: 1,
      createdAt: now,
      lastModifiedDate: now,
      versions: new Map([[1, versionObj]]),
      labels: new Map(),
      tags: tagMap,
    };
    this.parameters.set(name, param);
    return { Version: 1, Tier: effectiveTier };
  }

  resolveTier(requestedTier, value, policies) {
    if (requestedTier === "Advanced") return "Advanced";
    if (requestedTier === "Intelligent-Tiering") {
      const size = Buffer.byteLength(value || "", "utf8");
      if (size > STANDARD_VALUE_LIMIT || policies) return "Advanced";
      return "Standard";
    }
    return "Standard";
  }

  resolveKeyId(type, keyId) {
    if (type === "SecureString") {
      return keyId || `alias/aws/ssm`;
    }
    return undefined;
  }

  enforceAllowedPattern(pattern, value) {
    if (!pattern) return;
    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      throw new SsmError(
        "InvalidAllowedPatternException",
        `The allowed pattern is not a valid regular expression: ${pattern}`,
      );
    }
    if (!re.test(value)) {
      throw new SsmError(
        "ParameterPatternMismatchException",
        `Parameter value, cannot be validated against AllowedPattern: ${pattern}`,
      );
    }
  }

  pruneOldVersions(param) {
    if (param.versions.size <= MAX_PARAMETER_VERSIONS) return;
    // Remove oldest versions that have no labels attached.
    const sorted = [...param.versions.keys()].sort((a, b) => a - b);
    for (const v of sorted) {
      if (param.versions.size <= MAX_PARAMETER_VERSIONS) break;
      const ver = param.versions.get(v);
      if (ver.labels.size === 0 && v !== param.currentVersion) {
        param.versions.delete(v);
      }
    }
  }

  requireParameter(name) {
    const param = this.parameters.get(name) || this.resolveByArnName(name);
    if (!param) {
      throw new SsmError(
        "ParameterNotFound",
        `Systems Manager could not find the parameter ${name}.`,
      );
    }
    return param;
  }

  // -------------------------------------------------------------------------
  // GetParameter
  // -------------------------------------------------------------------------
  getParameter(input) {
    const raw = input.Name;
    const { name, selector } = this.splitSelector(raw);
    const param = this.parameters.get(name) || this.resolveByArnName(name);
    if (!param) {
      throw new SsmError(
        "ParameterNotFound",
        `Systems Manager could not find the parameter ${raw}.`,
      );
    }
    const version = this.resolveVersion(param, selector);
    return { Parameter: this.parameterView(param, version, raw, selector) };
  }

  parameterView(param, version, requestedName, selector) {
    let selectorOut;
    if (selector !== undefined && selector !== "") {
      selectorOut = `:${selector}`;
    }
    const out = {
      Name: param.name,
      Type: version.type,
      Value: version.value,
      Version: version.version,
      LastModifiedDate: epochSeconds(version.lastModifiedDate),
      ARN: param.arn,
      DataType: version.dataType || "text",
    };
    if (selectorOut) out.Selector = selectorOut;
    return out;
  }

  // -------------------------------------------------------------------------
  // GetParameters (batch)
  // -------------------------------------------------------------------------
  getParameters(input) {
    const names = input.Names;
    if (!Array.isArray(names) || names.length === 0) {
      throw new SsmError(
        "ValidationException",
        "1 validation error detected: Value at 'names' failed to satisfy constraint: Member must have length greater than or equal to 1.",
      );
    }
    if (names.length > 10) {
      throw new SsmError(
        "ValidationException",
        "1 validation error detected: Value at 'names' failed to satisfy constraint: Member must have length less than or equal to 10.",
      );
    }
    const parameters = [];
    const invalid = [];
    for (const raw of names) {
      try {
        const { name, selector } = this.splitSelector(raw);
        const param = this.parameters.get(name) || this.resolveByArnName(name);
        if (!param) {
          invalid.push(raw);
          continue;
        }
        const version = this.resolveVersion(param, selector);
        parameters.push(this.parameterView(param, version, raw, selector));
      } catch (err) {
        if (err instanceof SsmError && (err.code === "ParameterVersionNotFound" || err.code === "ParameterNotFound")) {
          invalid.push(raw);
        } else {
          throw err;
        }
      }
    }
    return { Parameters: parameters, InvalidParameters: invalid };
  }

  // -------------------------------------------------------------------------
  // GetParametersByPath
  // -------------------------------------------------------------------------
  getParametersByPath(input) {
    const path = input.Path;
    if (!path || typeof path !== "string" || !path.startsWith("/")) {
      throw new SsmError(
        "ValidationException",
        "The parameter path must be a fully qualified hierarchy beginning with '/'.",
      );
    }
    const recursive = input.Recursive === true;
    const prefix = path.endsWith("/") ? path : `${path}/`;

    let matches = [...this.parameters.values()].filter((p) => {
      if (!p.name.startsWith(prefix)) return false;
      if (recursive) return true;
      // Non-recursive: only one level below the path.
      const rest = p.name.slice(prefix.length);
      return !rest.includes("/");
    });

    matches = this.applyParameterStringFilters(matches, input.ParameterFilters || []);
    matches.sort((a, b) => a.name.localeCompare(b.name));

    const { page, nextToken } = this.paginate(matches, input.MaxResults, input.NextToken);
    return {
      Parameters: page.map((p) => {
        const version = p.versions.get(p.currentVersion);
        return this.parameterView(p, version, p.name);
      }),
      ...(nextToken ? { NextToken: nextToken } : {}),
    };
  }

  applyParameterStringFilters(list, filters) {
    for (const filter of filters) {
      const key = filter.Key;
      const option = filter.Option || "Equals";
      const values = (filter.Values || []).map(String);
      list = list.filter((p) => {
        const current = p.versions.get(p.currentVersion);
        switch (key) {
          case "Name": {
            return values.some((v) => {
              if (option === "BeginsWith") return p.name.startsWith(v);
              if (option === "Contains") return p.name.includes(v);
              return p.name === v;
            });
          }
          case "Type":
            return values.includes(current.type);
          case "KeyId":
            return values.includes(current.keyId);
          case "Tier":
            return values.includes(p.tier);
          case "DataType":
            return values.includes(current.dataType || "text");
          case "Label":
            return values.some((v) => p.labels.has(v));
          default: {
            // tag:<key>
            if (typeof key === "string" && key.startsWith("tag:")) {
              const tagKey = key.slice(4);
              const tagVal = p.tags.get(tagKey);
              if (tagVal === undefined) return false;
              return values.length === 0 || values.includes(tagVal);
            }
            throw new SsmError(
              "InvalidFilterKey",
              `The filter key ${key} is not valid for GetParametersByPath.`,
            );
          }
        }
      });
    }
    return list;
  }

  // -------------------------------------------------------------------------
  // DescribeParameters
  // -------------------------------------------------------------------------
  describeParameters(input) {
    let list = [...this.parameters.values()];

    // ParametersFilter (legacy): Key in {Name, Type, KeyId} with Values.
    for (const filter of input.Filters || []) {
      const key = filter.Key;
      const values = (filter.Values || []).map(String);
      if (!["Name", "Type", "KeyId"].includes(key)) {
        throw new SsmError("InvalidFilterKey", `The filter key ${key} is not valid.`);
      }
      list = list.filter((p) => {
        const current = p.versions.get(p.currentVersion);
        if (key === "Name") return values.some((v) => p.name.includes(v));
        if (key === "Type") return values.includes(current.type);
        if (key === "KeyId") return values.includes(current.keyId);
        return false;
      });
    }

    // ParameterStringFilters (modern).
    list = this.applyParameterStringFilters(list, input.ParameterFilters || []);

    list.sort((a, b) => a.name.localeCompare(b.name));
    const { page, nextToken } = this.paginate(list, input.MaxResults, input.NextToken);

    return {
      Parameters: page.map((p) => this.parameterMetadata(p)),
      ...(nextToken ? { NextToken: nextToken } : {}),
    };
  }

  parameterMetadata(param) {
    const current = param.versions.get(param.currentVersion);
    const out = {
      Name: param.name,
      ARN: param.arn,
      Type: current.type,
      LastModifiedDate: epochSeconds(param.lastModifiedDate),
      LastModifiedUser: current.user,
      Version: param.currentVersion,
      Tier: param.tier,
      DataType: current.dataType || "text",
    };
    if (current.keyId !== undefined) out.KeyId = current.keyId;
    if (current.description !== undefined) out.Description = current.description;
    if (current.allowedPattern !== undefined) out.AllowedPattern = current.allowedPattern;
    out.Policies = this.parsePolicies(current.policies);
    return out;
  }

  parsePolicies(policies) {
    if (!policies) return [];
    try {
      const parsed = JSON.parse(policies);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr.map((p) => ({
        PolicyText: JSON.stringify(p),
        PolicyType: p.Type,
        PolicyStatus: "Finished",
      }));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // GetParameterHistory
  // -------------------------------------------------------------------------
  getParameterHistory(input) {
    const param = this.requireParameter(input.Name);
    const versions = [...param.versions.values()].sort((a, b) => a.version - b.version);
    const { page, nextToken } = this.paginate(versions, input.MaxResults, input.NextToken);
    return {
      Parameters: page.map((v) => {
        const out = {
          Name: param.name,
          Type: v.type,
          Value: v.value,
          Version: v.version,
          LastModifiedDate: epochSeconds(v.lastModifiedDate),
          LastModifiedUser: v.user,
          Tier: v.tier,
          DataType: v.dataType || "text",
          Labels: [...v.labels],
          Policies: this.parsePolicies(v.policies),
        };
        if (v.keyId !== undefined) out.KeyId = v.keyId;
        if (v.description !== undefined) out.Description = v.description;
        if (v.allowedPattern !== undefined) out.AllowedPattern = v.allowedPattern;
        return out;
      }),
      ...(nextToken ? { NextToken: nextToken } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // DeleteParameter / DeleteParameters
  // -------------------------------------------------------------------------
  deleteParameter(input) {
    const name = input.Name;
    const param = this.parameters.get(name) || this.resolveByArnName(name);
    if (!param) {
      throw new SsmError(
        "ParameterNotFound",
        `Systems Manager could not find the parameter ${name} to delete.`,
      );
    }
    this.parameters.delete(param.name);
    return {};
  }

  deleteParameters(input) {
    const names = input.Names;
    if (!Array.isArray(names) || names.length === 0) {
      throw new SsmError(
        "ValidationException",
        "1 validation error detected: Value at 'names' failed to satisfy constraint: Member must have length greater than or equal to 1.",
      );
    }
    const deleted = [];
    const invalid = [];
    for (const raw of names) {
      const param = this.parameters.get(raw) || this.resolveByArnName(raw);
      if (param) {
        this.parameters.delete(param.name);
        deleted.push(raw);
      } else {
        invalid.push(raw);
      }
    }
    return { DeletedParameters: deleted, InvalidParameters: invalid };
  }

  // -------------------------------------------------------------------------
  // LabelParameterVersion / UnlabelParameterVersion
  // -------------------------------------------------------------------------
  labelParameterVersion(input) {
    const param = this.requireParameter(input.Name);
    const version = input.ParameterVersion !== undefined ? Number(input.ParameterVersion) : param.currentVersion;
    if (!param.versions.has(version)) {
      throw new SsmError(
        "ParameterVersionNotFound",
        `Systems Manager could not find version ${version} of ${param.name}.`,
      );
    }
    const labels = input.Labels || [];
    if (!labels.length) {
      throw new SsmError("ValidationException", "At least one label must be specified.");
    }
    const versionObj = param.versions.get(version);
    const invalidLabels = [];
    const appliedLabels = [];

    for (const label of labels) {
      // Labels can't begin with a number, can't be only digits, max 100 chars,
      // no spaces, max 10 labels per version.
      if (/^\d/.test(label) || /^aws/i.test(label) || /^ssm/i.test(label) || /\s/.test(label) || label.length > 100) {
        invalidLabels.push(label);
        continue;
      }
      if (versionObj.labels.size >= MAX_LABELS_PER_VERSION && !versionObj.labels.has(label)) {
        invalidLabels.push(label);
        continue;
      }
      // Move label from any other version.
      if (param.labels.has(label)) {
        const prevVersion = param.labels.get(label);
        if (prevVersion !== version) {
          param.versions.get(prevVersion).labels.delete(label);
        }
      }
      versionObj.labels.add(label);
      param.labels.set(label, version);
      appliedLabels.push(label);
    }

    return {
      InvalidLabels: invalidLabels,
      ParameterVersion: version,
    };
  }

  unlabelParameterVersion(input) {
    const param = this.requireParameter(input.Name);
    const version = Number(input.ParameterVersion);
    if (!param.versions.has(version)) {
      throw new SsmError(
        "ParameterVersionNotFound",
        `Systems Manager could not find version ${version} of ${param.name}.`,
      );
    }
    const labels = input.Labels || [];
    const removed = [];
    const invalid = [];
    const versionObj = param.versions.get(version);
    for (const label of labels) {
      if (versionObj.labels.has(label)) {
        versionObj.labels.delete(label);
        param.labels.delete(label);
        removed.push(label);
      } else {
        invalid.push(label);
      }
    }
    return { RemovedLabels: removed, InvalidLabels: invalid };
  }

  // -------------------------------------------------------------------------
  // Tagging
  // -------------------------------------------------------------------------
  resolveTaggable(resourceType, resourceId) {
    if (resourceType === "Parameter") {
      const param = this.parameters.get(resourceId) || this.resolveByArnName(resourceId);
      if (!param) {
        throw new SsmError(
          "InvalidResourceId",
          `The resource ${resourceId} of type Parameter does not exist.`,
        );
      }
      return param.tags;
    }
    // Other resource types are tracked in a generic store.
    const key = `${resourceType}\u0000${resourceId}`;
    if (!this.resourceTags.has(key)) this.resourceTags.set(key, new Map());
    return this.resourceTags.get(key);
  }

  addTagsToResource(input) {
    const { ResourceType, ResourceId, Tags } = input;
    if (!ResourceType || !ResourceId) {
      throw new SsmError("ValidationException", "ResourceType and ResourceId are required.");
    }
    const tags = this.resolveTaggable(ResourceType, ResourceId);
    for (const t of Tags || []) {
      if (t && t.Key !== undefined) tags.set(t.Key, t.Value ?? "");
    }
    return {};
  }

  removeTagsFromResource(input) {
    const { ResourceType, ResourceId, TagKeys } = input;
    if (!ResourceType || !ResourceId) {
      throw new SsmError("ValidationException", "ResourceType and ResourceId are required.");
    }
    const tags = this.resolveTaggable(ResourceType, ResourceId);
    for (const k of TagKeys || []) tags.delete(k);
    return {};
  }

  listTagsForResource(input) {
    const { ResourceType, ResourceId } = input;
    if (!ResourceType || !ResourceId) {
      throw new SsmError("ValidationException", "ResourceType and ResourceId are required.");
    }
    const tags = this.resolveTaggable(ResourceType, ResourceId);
    return {
      TagList: [...tags.entries()].map(([Key, Value]) => ({ Key, Value })),
    };
  }

  // -------------------------------------------------------------------------
  // Resource policies
  // -------------------------------------------------------------------------
  putResourcePolicy(input) {
    const { ResourceArn, Policy } = input;
    if (!ResourceArn) {
      throw new SsmError("ValidationException", "ResourceArn is required.");
    }
    if (!Policy) {
      throw new SsmError("ResourcePolicyInvalidParameterException", "Policy is required.");
    }
    try {
      JSON.parse(Policy);
    } catch {
      throw new SsmError(
        "MalformedResourcePolicyDocumentException",
        "The resource policy is not a valid JSON document.",
      );
    }
    if (!this.resourcePolicies.has(ResourceArn)) {
      this.resourcePolicies.set(ResourceArn, new Map());
    }
    const store = this.resourcePolicies.get(ResourceArn);
    const policyId = input.PolicyId || randomUUID();
    const policyHash = randomUUID();
    // If updating, PolicyHash must match (optimistic concurrency).
    if (input.PolicyId && store.has(input.PolicyId) && input.PolicyHash) {
      const existing = store.get(input.PolicyId);
      if (existing.hash !== input.PolicyHash) {
        throw new SsmError(
          "ResourcePolicyConflictException",
          "The PolicyHash provided does not match the current policy hash.",
        );
      }
    }
    store.set(policyId, { policy: Policy, hash: policyHash });
    return { PolicyId: policyId, PolicyHash: policyHash };
  }

  getResourcePolicies(input) {
    const { ResourceArn } = input;
    if (!ResourceArn) {
      throw new SsmError("ValidationException", "ResourceArn is required.");
    }
    const store = this.resourcePolicies.get(ResourceArn) || new Map();
    const entries = [...store.entries()];
    const { page, nextToken } = this.paginate(entries, input.MaxResults, input.NextToken);
    return {
      Policies: page.map(([id, p]) => ({
        PolicyId: id,
        PolicyHash: p.hash,
        Policy: p.policy,
      })),
      ...(nextToken ? { NextToken: nextToken } : {}),
    };
  }

  deleteResourcePolicy(input) {
    const { ResourceArn, PolicyId } = input;
    if (!ResourceArn || !PolicyId) {
      throw new SsmError("ValidationException", "ResourceArn and PolicyId are required.");
    }
    const store = this.resourcePolicies.get(ResourceArn);
    if (!store || !store.has(PolicyId)) {
      throw new SsmError(
        "ResourcePolicyNotFoundException",
        "No resource policy was found for the specified PolicyId.",
      );
    }
    store.delete(PolicyId);
    return {};
  }

  // -------------------------------------------------------------------------
  // Service settings
  // -------------------------------------------------------------------------
  defaultServiceSetting(settingId) {
    const defaults = {
      "/ssm/parameter-store/high-throughput-enabled": "false",
      "/ssm/parameter-store/default-parameter-tier": "Standard",
    };
    const value = defaults[settingId];
    return {
      SettingId: settingId,
      SettingValue: value !== undefined ? value : "false",
      LastModifiedDate: epochSeconds(),
      LastModifiedUser: "Default",
      ARN: `arn:aws:ssm:${this.region}:${this.accountId}:servicesetting${settingId}`,
      Status: "Default",
    };
  }

  getServiceSetting(input) {
    const settingId = input.SettingId;
    if (!settingId) {
      throw new SsmError("ValidationException", "SettingId is required.");
    }
    const stored = this.serviceSettings.get(settingId);
    if (!stored) {
      return { ServiceSetting: this.defaultServiceSetting(settingId) };
    }
    return {
      ServiceSetting: {
        SettingId: settingId,
        SettingValue: stored.value,
        LastModifiedDate: epochSeconds(stored.lastModifiedDate),
        LastModifiedUser: stored.user,
        ARN: `arn:aws:ssm:${this.region}:${this.accountId}:servicesetting${settingId}`,
        Status: "Customized",
      },
    };
  }

  updateServiceSetting(input) {
    const { SettingId, SettingValue } = input;
    if (!SettingId || SettingValue === undefined) {
      throw new SsmError("ValidationException", "SettingId and SettingValue are required.");
    }
    this.serviceSettings.set(SettingId, {
      value: SettingValue,
      lastModifiedDate: Date.now(),
      user: `arn:aws:iam::${this.accountId}:user/parlel`,
    });
    return {};
  }

  resetServiceSetting(input) {
    const { SettingId } = input;
    if (!SettingId) {
      throw new SsmError("ValidationException", "SettingId is required.");
    }
    this.serviceSettings.delete(SettingId);
    return { ServiceSetting: this.defaultServiceSetting(SettingId) };
  }

  // -------------------------------------------------------------------------
  // Pagination helper. NextToken encodes an integer offset.
  // -------------------------------------------------------------------------
  paginate(list, maxResults, nextToken) {
    const max = maxResults ? Number(maxResults) : list.length || 1;
    let start = 0;
    if (nextToken) {
      const decoded = Number(Buffer.from(String(nextToken), "base64").toString("utf8"));
      if (!Number.isFinite(decoded) || decoded < 0) {
        throw new SsmError("InvalidNextToken", "The specified token is not valid.");
      }
      start = decoded;
    }
    const page = list.slice(start, start + max);
    let token;
    if (start + max < list.length) {
      token = Buffer.from(String(start + max)).toString("base64");
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
    const code = error.code || "InternalFailure";
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

export default SsmServer;
