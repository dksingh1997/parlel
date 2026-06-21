// parlel/waf-v2 — a lightweight, dependency-free fake of AWS WAFv2.
//
// Speaks the AWS JSON 1.1 wire protocol (target prefix AWSWAF_20190729).
// Requests are POST / with header `X-Amz-Target: AWSWAF_20190729.<Operation>`
// and JSON bodies. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const TARGET_PREFIX = "AWSWAF_20190729";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  WAFInvalidParameterException: 400,
  WAFNonexistentItemException: 400,
  WAFDuplicateItemException: 400,
  WAFOptimisticLockException: 400,
  WAFLimitsExceededException: 400,
  WAFInternalErrorException: 500,
};

class WafError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

export class WafV2Server {
  constructor(port = 4716, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.webACLs = new Map(); // id -> webacl
    this.ipSets = new Map(); // id -> ipset
    this.ruleGroups = new Map(); // id -> rulegroup
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new WafError("WAFInternalErrorException", error.message, 500));
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
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  newId() {
    return randomUUID();
  }

  lockToken() {
    return randomUUID();
  }

  arn(type, name, id) {
    const scopeRegion = this.region;
    return `arn:aws:wafv2:${scopeRegion}:${this.accountId}:regional/${type}/${name}/${id}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "waf-v2",
        webACLs: this.webACLs.size,
        ipSets: this.ipSets.size,
        ruleGroups: this.ruleGroups.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-waf-v2");

    if (method !== "POST") {
      return this.sendError(res, new WafError("WAFInvalidParameterException", "Only POST supported", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new WafError("WAFInvalidParameterException", "Invalid JSON", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof WafError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateWebACL":
        return this.createWebACL(input);
      case "ListWebACLs":
        return this.listWebACLs(input);
      case "GetWebACL":
        return this.getWebACL(input);
      case "DeleteWebACL":
        return this.deleteWebACL(input);
      case "CreateIPSet":
        return this.createIPSet(input);
      case "ListIPSets":
        return this.listIPSets(input);
      case "GetIPSet":
        return this.getIPSet(input);
      case "DeleteIPSet":
        return this.deleteIPSet(input);
      case "CreateRuleGroup":
        return this.createRuleGroup(input);
      case "ListRuleGroups":
        return this.listRuleGroups(input);
      case "GetRuleGroup":
        return this.getRuleGroup(input);
      default:
        throw new WafError(
          "WAFInvalidParameterException",
          `The action ${operation || "(none)"} is not valid.`,
          400,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Web ACLs
  // -------------------------------------------------------------------------
  createWebACL(input) {
    const name = input.Name;
    const scope = input.Scope;
    if (!name) throw new WafError("WAFInvalidParameterException", "Name is required");
    if (!scope) throw new WafError("WAFInvalidParameterException", "Scope is required");
    for (const acl of this.webACLs.values()) {
      if (acl.Name === name && acl.Scope === scope) {
        throw new WafError("WAFDuplicateItemException", `WebACL ${name} already exists`);
      }
    }
    const id = this.newId();
    const arn = this.arn("webacl", name, id);
    const lockToken = this.lockToken();
    const acl = {
      Id: id,
      Name: name,
      ARN: arn,
      Scope: scope,
      DefaultAction: input.DefaultAction || { Allow: {} },
      Description: input.Description,
      Rules: input.Rules || [],
      VisibilityConfig: input.VisibilityConfig,
      Capacity: 10,
      LockToken: lockToken,
    };
    this.webACLs.set(id, acl);
    return {
      Summary: { Name: name, Id: id, Description: acl.Description, LockToken: lockToken, ARN: arn },
    };
  }

  listWebACLs(input) {
    const scope = input.Scope;
    const acls = [...this.webACLs.values()].filter((a) => !scope || a.Scope === scope);
    return {
      WebACLs: acls.map((a) => ({
        Name: a.Name,
        Id: a.Id,
        Description: a.Description,
        LockToken: a.LockToken,
        ARN: a.ARN,
      })),
    };
  }

  requireWebACL(input) {
    const id = input.Id;
    const acl = this.webACLs.get(id);
    if (!acl) {
      throw new WafError("WAFNonexistentItemException", `WebACL ${id} does not exist`);
    }
    return acl;
  }

  getWebACL(input) {
    const acl = this.requireWebACL(input);
    return {
      WebACL: {
        Name: acl.Name,
        Id: acl.Id,
        ARN: acl.ARN,
        DefaultAction: acl.DefaultAction,
        Description: acl.Description,
        Rules: acl.Rules,
        VisibilityConfig: acl.VisibilityConfig,
        Capacity: acl.Capacity,
      },
      LockToken: acl.LockToken,
    };
  }

  deleteWebACL(input) {
    this.requireWebACL(input);
    this.webACLs.delete(input.Id);
    return {};
  }

  // -------------------------------------------------------------------------
  // IP Sets
  // -------------------------------------------------------------------------
  createIPSet(input) {
    const name = input.Name;
    const scope = input.Scope;
    if (!name) throw new WafError("WAFInvalidParameterException", "Name is required");
    if (!input.IPAddressVersion) {
      throw new WafError("WAFInvalidParameterException", "IPAddressVersion is required");
    }
    for (const s of this.ipSets.values()) {
      if (s.Name === name && s.Scope === scope) {
        throw new WafError("WAFDuplicateItemException", `IPSet ${name} already exists`);
      }
    }
    const id = this.newId();
    const arn = this.arn("ipset", name, id);
    const lockToken = this.lockToken();
    const ipSet = {
      Id: id,
      Name: name,
      ARN: arn,
      Scope: scope,
      IPAddressVersion: input.IPAddressVersion,
      Addresses: input.Addresses || [],
      Description: input.Description,
      LockToken: lockToken,
    };
    this.ipSets.set(id, ipSet);
    return {
      Summary: { Name: name, Id: id, Description: ipSet.Description, LockToken: lockToken, ARN: arn },
    };
  }

  listIPSets(input) {
    const scope = input.Scope;
    const sets = [...this.ipSets.values()].filter((s) => !scope || s.Scope === scope);
    return {
      IPSets: sets.map((s) => ({
        Name: s.Name,
        Id: s.Id,
        Description: s.Description,
        LockToken: s.LockToken,
        ARN: s.ARN,
      })),
    };
  }

  getIPSet(input) {
    const id = input.Id;
    const s = this.ipSets.get(id);
    if (!s) throw new WafError("WAFNonexistentItemException", `IPSet ${id} does not exist`);
    return {
      IPSet: {
        Name: s.Name,
        Id: s.Id,
        ARN: s.ARN,
        IPAddressVersion: s.IPAddressVersion,
        Addresses: s.Addresses,
        Description: s.Description,
      },
      LockToken: s.LockToken,
    };
  }

  deleteIPSet(input) {
    const id = input.Id;
    if (!this.ipSets.has(id)) {
      throw new WafError("WAFNonexistentItemException", `IPSet ${id} does not exist`);
    }
    this.ipSets.delete(id);
    return {};
  }

  // -------------------------------------------------------------------------
  // Rule Groups
  // -------------------------------------------------------------------------
  createRuleGroup(input) {
    const name = input.Name;
    const scope = input.Scope;
    if (!name) throw new WafError("WAFInvalidParameterException", "Name is required");
    if (input.Capacity === undefined) {
      throw new WafError("WAFInvalidParameterException", "Capacity is required");
    }
    for (const g of this.ruleGroups.values()) {
      if (g.Name === name && g.Scope === scope) {
        throw new WafError("WAFDuplicateItemException", `RuleGroup ${name} already exists`);
      }
    }
    const id = this.newId();
    const arn = this.arn("rulegroup", name, id);
    const lockToken = this.lockToken();
    const group = {
      Id: id,
      Name: name,
      ARN: arn,
      Scope: scope,
      Capacity: input.Capacity,
      Rules: input.Rules || [],
      Description: input.Description,
      VisibilityConfig: input.VisibilityConfig,
      LockToken: lockToken,
    };
    this.ruleGroups.set(id, group);
    return {
      Summary: { Name: name, Id: id, Description: group.Description, LockToken: lockToken, ARN: arn },
    };
  }

  listRuleGroups(input) {
    const scope = input.Scope;
    const groups = [...this.ruleGroups.values()].filter((g) => !scope || g.Scope === scope);
    return {
      RuleGroups: groups.map((g) => ({
        Name: g.Name,
        Id: g.Id,
        Description: g.Description,
        LockToken: g.LockToken,
        ARN: g.ARN,
      })),
    };
  }

  getRuleGroup(input) {
    const id = input.Id;
    const g = this.ruleGroups.get(id);
    if (!g) throw new WafError("WAFNonexistentItemException", `RuleGroup ${id} does not exist`);
    return {
      RuleGroup: {
        Name: g.Name,
        Id: g.Id,
        ARN: g.ARN,
        Capacity: g.Capacity,
        Rules: g.Rules,
        Description: g.Description,
        VisibilityConfig: g.VisibilityConfig,
      },
      LockToken: g.LockToken,
    };
  }

  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "WAFInternalErrorException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default WafV2Server;
export const WAF_TARGET_PREFIX = TARGET_PREFIX;
