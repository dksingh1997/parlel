// parlel/cloudformation — a lightweight, dependency-free fake of AWS CloudFormation.
//
// Speaks the AWS Query wire protocol (API version 2010-05-15). Pure Node.js,
// no external npm dependencies. State is in-memory and ephemeral (resettable
// via reset() or POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const CFN_NAMESPACE = "http://cloudformation.amazonaws.com/doc/2010-05-15/";
const API_VERSION = "2010-05-15";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ValidationError: 400,
  AlreadyExistsException: 400,
  InvalidParameterValue: 400,
  InternalFailure: 500,
  AccessDenied: 403,
  ChangeSetNotFound: 404,
  StackNotFoundException: 404,
};

class CfnError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// XML helpers (copied from services/sns/src/server.js)
// ---------------------------------------------------------------------------

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlNode(tag, value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    const members = value.map((v) => xmlNode("member", v)).join("");
    return `<${tag}>${members}</${tag}>`;
  }
  if (typeof value === "object") {
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

function normalizeNode(node) {
  if (node === null || typeof node !== "object") return node;
  const keys = Object.keys(node);
  if (keys.length === 1 && (keys[0] === "member" || keys[0] === "entry")) {
    const container = node[keys[0]];
    const indices = Object.keys(container)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const list = indices.map((idx) => normalizeNode(container[idx]));
    if (keys[0] === "entry") {
      const asMap = entriesToMap(list);
      if (asMap) return asMap;
    }
    return list;
  }
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

function entriesToMap(list) {
  const map = {};
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const k =
      item.key !== undefined ? item.key : item.Key !== undefined ? item.Key : item.Name;
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class CloudformationServer {
  constructor(port = 4564, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // stacks: Map<stackName, Stack>
    this.stacks = new Map();
    // changeSets: Map<changeSetId, ChangeSet>
    this.changeSets = new Map();
    this.changeSetCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new CfnError("InternalFailure", error.message, 500));
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

  stackArn(name, id) {
    return `arn:aws:cloudformation:${this.region}:${this.accountId}:stack/${name}/${id}`;
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "cloudformation",
        stacks: this.stacks.size,
        changeSets: this.changeSets.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-cloudformation");

    if (method !== "POST") {
      return this.sendError(
        res,
        new CfnError("ValidationError", "Only POST is supported by the parlel cloudformation fake.", 405),
      );
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(res, new CfnError("ValidationError", "Request body could not be parsed.", 400));
    }

    const operation = input.Action;
    try {
      const { result, resultTag } = this.dispatch(operation, input);
      return this.sendXml(res, 200, operation, resultTag, result);
    } catch (error) {
      if (error instanceof CfnError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      CreateStack: () => this.createStack(input),
      DescribeStacks: () => this.describeStacks(input),
      UpdateStack: () => this.updateStack(input),
      DeleteStack: () => this.deleteStack(input),
      ListStacks: () => this.listStacks(input),
      GetTemplate: () => this.getTemplate(input),
      CreateChangeSet: () => this.createChangeSet(input),
      DescribeChangeSet: () => this.describeChangeSet(input),
      ExecuteChangeSet: () => this.executeChangeSet(input),
      ListChangeSets: () => this.listChangeSets(input),
      DescribeStackResources: () => this.describeStackResources(input),
      ListStackResources: () => this.listStackResources(input),
      ListExports: () => this.listExports(input),
      ValidateTemplate: () => this.validateTemplate(input),
    };
    const handler = handlers[operation];
    if (!handler) {
      throw new CfnError("ValidationError", `The action ${operation || "(none)"} is not valid for this endpoint.`, 400);
    }
    return handler();
  }

  // -------------------------------------------------------------------------
  // Template parsing
  // -------------------------------------------------------------------------
  parseTemplate(templateBody) {
    if (!templateBody) return { Resources: {}, Outputs: {}, Parameters: {} };
    let tpl;
    try {
      tpl = JSON.parse(templateBody);
    } catch {
      // Very small YAML-ish fallback: only accept JSON. Treat as empty.
      throw new CfnError("ValidationError", "Template format error: not well-formed JSON.");
    }
    return {
      Resources: tpl.Resources || {},
      Outputs: tpl.Outputs || {},
      Parameters: tpl.Parameters || {},
      raw: tpl,
    };
  }

  buildResources(parsed, stackName, stackId) {
    const resources = [];
    for (const [logicalId, def] of Object.entries(parsed.Resources || {})) {
      const type = (def && def.Type) || "AWS::CloudFormation::CustomResource";
      resources.push({
        LogicalResourceId: logicalId,
        PhysicalResourceId: `${stackName}-${logicalId}-${randomUUID().slice(0, 8)}`,
        ResourceType: type,
        ResourceStatus: "CREATE_COMPLETE",
        Timestamp: new Date().toISOString(),
        StackName: stackName,
        StackId: stackId,
      });
    }
    return resources;
  }

  buildOutputs(parsed, params) {
    const outputs = [];
    const paramMap = params || {};
    for (const [key, def] of Object.entries(parsed.Outputs || {})) {
      let value = def && def.Value;
      if (value && typeof value === "object") {
        // Resolve simple { Ref: x } or { "Fn::GetAtt": [...] }.
        if (value.Ref !== undefined) {
          value = paramMap[value.Ref] !== undefined ? paramMap[value.Ref] : value.Ref;
        } else {
          value = JSON.stringify(value);
        }
      }
      const out = {
        OutputKey: key,
        OutputValue: value === undefined ? "" : String(value),
      };
      if (def && def.Description) out.Description = def.Description;
      if (def && def.Export && def.Export.Name) {
        out.ExportName =
          typeof def.Export.Name === "object" ? JSON.stringify(def.Export.Name) : String(def.Export.Name);
      }
      outputs.push(out);
    }
    return outputs;
  }

  collectParameters(input, parsed) {
    const params = {};
    let list = input.Parameters;
    if (list) {
      if (!Array.isArray(list)) list = [list];
      for (const p of list) {
        if (p && p.ParameterKey !== undefined) {
          params[p.ParameterKey] = p.ParameterValue ?? "";
        }
      }
    }
    // Apply defaults from template.
    for (const [key, def] of Object.entries(parsed.Parameters || {})) {
      if (params[key] === undefined && def && def.Default !== undefined) {
        params[key] = String(def.Default);
      }
    }
    return params;
  }

  collectTags(input) {
    let list = input.Tags;
    const tags = [];
    if (list) {
      if (!Array.isArray(list)) list = [list];
      for (const t of list) {
        if (t && t.Key !== undefined) tags.push({ Key: t.Key, Value: t.Value ?? "" });
      }
    }
    return tags;
  }

  // -------------------------------------------------------------------------
  // Stack operations
  // -------------------------------------------------------------------------
  createStack(input) {
    const name = input.StackName;
    if (!name) throw new CfnError("ValidationError", "StackName must be specified.");
    if (this.stacks.has(name)) {
      throw new CfnError("AlreadyExistsException", `Stack [${name}] already exists`);
    }
    const parsed = this.parseTemplate(input.TemplateBody);
    const id = randomUUID();
    const arn = this.stackArn(name, id);
    const params = this.collectParameters(input, parsed);
    const now = new Date().toISOString();
    const stack = {
      StackId: arn,
      StackName: name,
      templateBody: input.TemplateBody || "{}",
      parsed,
      Parameters: params,
      Tags: this.collectTags(input),
      Capabilities: this.asList(input.Capabilities),
      StackStatus: "CREATE_COMPLETE",
      CreationTime: now,
      LastUpdatedTime: undefined,
      DisableRollback: input.DisableRollback === "true",
      resources: this.buildResources(parsed, name, arn),
      Outputs: this.buildOutputs(parsed, params),
      DeletionTime: undefined,
    };
    this.stacks.set(name, stack);
    return { result: { StackId: arn }, resultTag: "CreateStackResult" };
  }

  asList(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return Object.values(value);
    return [value];
  }

  resolveStack(nameOrArn) {
    if (!nameOrArn) return undefined;
    if (this.stacks.has(nameOrArn)) return this.stacks.get(nameOrArn);
    for (const stack of this.stacks.values()) {
      if (stack.StackId === nameOrArn) return stack;
    }
    return undefined;
  }

  describeStacks(input) {
    const name = input.StackName;
    let stacks;
    if (name) {
      const stack = this.resolveStack(name);
      if (!stack) {
        throw new CfnError("ValidationError", `Stack with id ${name} does not exist`);
      }
      stacks = [stack];
    } else {
      stacks = [...this.stacks.values()];
    }
    return {
      result: { Stacks: stacks.map((s) => this.stackSummary(s)) },
      resultTag: "DescribeStacksResult",
    };
  }

  stackSummary(stack) {
    const out = {
      StackId: stack.StackId,
      StackName: stack.StackName,
      StackStatus: stack.StackStatus,
      CreationTime: stack.CreationTime,
      DisableRollback: stack.DisableRollback,
      DriftInformation: { StackDriftStatus: "NOT_CHECKED" },
      EnableTerminationProtection: false,
      RollbackConfiguration: {},
    };
    if (stack.LastUpdatedTime) out.LastUpdatedTime = stack.LastUpdatedTime;
    if (stack.Parameters && Object.keys(stack.Parameters).length) {
      out.Parameters = Object.entries(stack.Parameters).map(([ParameterKey, ParameterValue]) => ({
        ParameterKey,
        ParameterValue,
      }));
    }
    if (stack.Outputs && stack.Outputs.length) out.Outputs = stack.Outputs;
    if (stack.Tags && stack.Tags.length) out.Tags = stack.Tags;
    if (stack.Capabilities && stack.Capabilities.length) out.Capabilities = stack.Capabilities;
    return out;
  }

  updateStack(input) {
    const name = input.StackName;
    const stack = this.resolveStack(name);
    if (!stack) {
      throw new CfnError("ValidationError", `Stack [${name}] does not exist`);
    }
    if (input.TemplateBody) {
      stack.templateBody = input.TemplateBody;
      stack.parsed = this.parseTemplate(input.TemplateBody);
    }
    const params = this.collectParameters(input, stack.parsed);
    stack.Parameters = params;
    if (input.Tags) stack.Tags = this.collectTags(input);
    stack.resources = this.buildResources(stack.parsed, stack.StackName, stack.StackId);
    stack.Outputs = this.buildOutputs(stack.parsed, params);
    stack.StackStatus = "UPDATE_COMPLETE";
    stack.LastUpdatedTime = new Date().toISOString();
    return { result: { StackId: stack.StackId }, resultTag: "UpdateStackResult" };
  }

  deleteStack(input) {
    const name = input.StackName;
    const stack = this.resolveStack(name);
    if (stack) {
      stack.StackStatus = "DELETE_COMPLETE";
      stack.DeletionTime = new Date().toISOString();
      this.stacks.delete(stack.StackName);
    }
    // DeleteStack is idempotent.
    return { result: {}, resultTag: "DeleteStackResult" };
  }

  listStacks(input) {
    const filters = this.asList(input.StackStatusFilter);
    const summaries = [...this.stacks.values()]
      .filter((s) => filters.length === 0 || filters.includes(s.StackStatus))
      .map((s) => ({
        StackId: s.StackId,
        StackName: s.StackName,
        StackStatus: s.StackStatus,
        CreationTime: s.CreationTime,
        TemplateDescription: s.parsed.raw && s.parsed.raw.Description ? s.parsed.raw.Description : undefined,
      }));
    return { result: { StackSummaries: summaries }, resultTag: "ListStacksResult" };
  }

  getTemplate(input) {
    const stack = this.resolveStack(input.StackName);
    if (!stack) {
      throw new CfnError("ValidationError", `Stack with id ${input.StackName} does not exist`);
    }
    return {
      result: { TemplateBody: stack.templateBody, StagesAvailable: ["Original", "Processed"] },
      resultTag: "GetTemplateResult",
    };
  }

  // -------------------------------------------------------------------------
  // Change sets
  // -------------------------------------------------------------------------
  createChangeSet(input) {
    const name = input.StackName;
    if (!name) throw new CfnError("ValidationError", "StackName must be specified.");
    const changeSetName = input.ChangeSetName;
    if (!changeSetName) throw new CfnError("ValidationError", "ChangeSetName must be specified.");
    const type = input.ChangeSetType || "UPDATE";
    const existing = this.resolveStack(name);
    if (type === "UPDATE" && !existing) {
      throw new CfnError("ValidationError", `Stack [${name}] does not exist`);
    }
    const parsed = this.parseTemplate(input.TemplateBody);
    const id = randomUUID();
    const arn = `arn:aws:cloudformation:${this.region}:${this.accountId}:changeSet/${changeSetName}/${id}`;
    const params = this.collectParameters(input, parsed);
    const stackId = existing ? existing.StackId : this.stackArn(name, randomUUID());

    const changes = Object.entries(parsed.Resources || {}).map(([logicalId, def]) => ({
      Type: "Resource",
      ResourceChange: {
        Action: type === "CREATE" ? "Add" : "Add",
        LogicalResourceId: logicalId,
        ResourceType: (def && def.Type) || "AWS::CloudFormation::CustomResource",
        Replacement: "False",
      },
    }));

    const cs = {
      ChangeSetId: arn,
      ChangeSetName: changeSetName,
      StackId: stackId,
      StackName: name,
      ChangeSetType: type,
      Status: "CREATE_COMPLETE",
      ExecutionStatus: "AVAILABLE",
      CreationTime: new Date().toISOString(),
      templateBody: input.TemplateBody || "{}",
      parsed,
      Parameters: params,
      Tags: this.collectTags(input),
      Changes: changes,
    };
    this.changeSets.set(arn, cs);
    return { result: { Id: arn, StackId: stackId }, resultTag: "CreateChangeSetResult" };
  }

  resolveChangeSet(input) {
    const id = input.ChangeSetName;
    if (id && this.changeSets.has(id)) return this.changeSets.get(id);
    // Look up by (StackName, ChangeSetName).
    for (const cs of this.changeSets.values()) {
      if (cs.ChangeSetId === id) return cs;
      if (cs.ChangeSetName === id) {
        if (!input.StackName || cs.StackName === input.StackName || cs.StackId === input.StackName) {
          return cs;
        }
      }
    }
    return undefined;
  }

  describeChangeSet(input) {
    const cs = this.resolveChangeSet(input);
    if (!cs) {
      throw new CfnError("ChangeSetNotFound", `ChangeSet [${input.ChangeSetName}] does not exist`, 404);
    }
    const result = {
      ChangeSetId: cs.ChangeSetId,
      ChangeSetName: cs.ChangeSetName,
      StackId: cs.StackId,
      StackName: cs.StackName,
      Status: cs.Status,
      ExecutionStatus: cs.ExecutionStatus,
      CreationTime: cs.CreationTime,
      Changes: cs.Changes,
    };
    if (cs.Parameters && Object.keys(cs.Parameters).length) {
      result.Parameters = Object.entries(cs.Parameters).map(([ParameterKey, ParameterValue]) => ({
        ParameterKey,
        ParameterValue,
      }));
    }
    return { result, resultTag: "DescribeChangeSetResult" };
  }

  executeChangeSet(input) {
    const cs = this.resolveChangeSet(input);
    if (!cs) {
      throw new CfnError("ChangeSetNotFound", `ChangeSet [${input.ChangeSetName}] does not exist`, 404);
    }
    const params = cs.Parameters;
    let stack = this.resolveStack(cs.StackName);
    const now = new Date().toISOString();
    if (cs.ChangeSetType === "CREATE" || !stack) {
      const arn = cs.StackId;
      stack = {
        StackId: arn,
        StackName: cs.StackName,
        templateBody: cs.templateBody,
        parsed: cs.parsed,
        Parameters: params,
        Tags: cs.Tags,
        Capabilities: [],
        StackStatus: "CREATE_COMPLETE",
        CreationTime: now,
        DisableRollback: false,
        resources: this.buildResources(cs.parsed, cs.StackName, arn),
        Outputs: this.buildOutputs(cs.parsed, params),
      };
      this.stacks.set(cs.StackName, stack);
    } else {
      stack.templateBody = cs.templateBody;
      stack.parsed = cs.parsed;
      stack.Parameters = params;
      stack.resources = this.buildResources(cs.parsed, stack.StackName, stack.StackId);
      stack.Outputs = this.buildOutputs(cs.parsed, params);
      stack.StackStatus = "UPDATE_COMPLETE";
      stack.LastUpdatedTime = now;
    }
    cs.ExecutionStatus = "EXECUTE_COMPLETE";
    return { result: {}, resultTag: "ExecuteChangeSetResult" };
  }

  listChangeSets(input) {
    const name = input.StackName;
    const summaries = [...this.changeSets.values()]
      .filter((cs) => !name || cs.StackName === name || cs.StackId === name)
      .map((cs) => ({
        StackId: cs.StackId,
        StackName: cs.StackName,
        ChangeSetId: cs.ChangeSetId,
        ChangeSetName: cs.ChangeSetName,
        ExecutionStatus: cs.ExecutionStatus,
        Status: cs.Status,
        CreationTime: cs.CreationTime,
      }));
    return { result: { Summaries: summaries }, resultTag: "ListChangeSetsResult" };
  }

  // -------------------------------------------------------------------------
  // Resources & exports
  // -------------------------------------------------------------------------
  describeStackResources(input) {
    const stack = this.resolveStack(input.StackName);
    if (!stack) {
      throw new CfnError("ValidationError", `Stack with id ${input.StackName} does not exist`);
    }
    let resources = stack.resources;
    if (input.LogicalResourceId) {
      resources = resources.filter((r) => r.LogicalResourceId === input.LogicalResourceId);
    }
    return {
      result: { StackResources: resources },
      resultTag: "DescribeStackResourcesResult",
    };
  }

  listStackResources(input) {
    const stack = this.resolveStack(input.StackName);
    if (!stack) {
      throw new CfnError("ValidationError", `Stack with id ${input.StackName} does not exist`);
    }
    const summaries = stack.resources.map((r) => ({
      LogicalResourceId: r.LogicalResourceId,
      PhysicalResourceId: r.PhysicalResourceId,
      ResourceType: r.ResourceType,
      ResourceStatus: r.ResourceStatus,
      LastUpdatedTimestamp: r.Timestamp,
      DriftInformation: { StackResourceDriftStatus: "NOT_CHECKED" },
    }));
    return {
      result: { StackResourceSummaries: summaries },
      resultTag: "ListStackResourcesResult",
    };
  }

  listExports() {
    const exports = [];
    for (const stack of this.stacks.values()) {
      for (const out of stack.Outputs || []) {
        if (out.ExportName) {
          exports.push({
            ExportingStackId: stack.StackId,
            Name: out.ExportName,
            Value: out.OutputValue,
          });
        }
      }
    }
    return { result: { Exports: exports }, resultTag: "ListExportsResult" };
  }

  validateTemplate(input) {
    if (!input.TemplateBody && !input.TemplateURL) {
      throw new CfnError("ValidationError", "Either TemplateBody or TemplateURL must be specified.");
    }
    const parsed = this.parseTemplate(input.TemplateBody);
    const parameters = Object.entries(parsed.Parameters || {}).map(([key, def]) => ({
      ParameterKey: key,
      DefaultValue: def && def.Default !== undefined ? String(def.Default) : undefined,
      NoEcho: def && def.NoEcho ? true : false,
      Description: def && def.Description ? def.Description : undefined,
    }));
    const result = { Parameters: parameters, Capabilities: [], CapabilitiesReason: "" };
    if (parsed.raw && parsed.raw.Description) result.Description = parsed.raw.Description;
    return { result, resultTag: "ValidateTemplateResult" };
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
    const resultBlock = resultXml.length > 0 ? `<${resultTag}>${resultXml}</${resultTag}>` : `<${resultTag}/>`;
    const xml =
      `<${responseTag} xmlns="${CFN_NAMESPACE}">` +
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
    const code = error.code || "InternalFailure";
    const status = error.status || ERROR_STATUS[code] || 400;
    const fault = status >= 500 ? "Receiver" : "Sender";
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    const xml =
      `<ErrorResponse xmlns="${CFN_NAMESPACE}">` +
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

export default CloudformationServer;
export const API_VERSION_CLOUDFORMATION = API_VERSION;
