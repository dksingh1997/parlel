// parlel/organizations — a lightweight, dependency-free fake of AWS Organizations.
//
// Speaks AWS JSON 1.1 (X-Amz-Target: AWSOrganizationsV20161128.<Op>). Pure Node.js.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  AWSOrganizationsNotInUseException: 400,
  AccountNotFoundException: 400,
  OrganizationalUnitNotFoundException: 400,
  ParentNotFoundException: 400,
  PolicyNotFoundException: 400,
  DuplicateOrganizationalUnitException: 400,
  AlreadyInOrganizationException: 400,
  ConstraintViolationException: 400,
  InvalidInputException: 400,
  ValidationException: 400,
  ServiceException: 500,
};

class OrgError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function epochSeconds(ms = Date.now()) {
  return Math.floor(ms / 1000);
}

function rid(len) {
  return randomBytes(len).toString("hex").slice(0, len);
}

export class OrganizationsServer {
  constructor(port = 4733, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.organization = null;
    this.accounts = new Map(); // accountId -> account
    this.ous = new Map(); // ouId -> ou
    this.policies = new Map(); // policyId -> policy
    this.attachments = new Map(); // targetId -> Set<policyId>
    this.createAccountStatuses = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new OrgError("ServiceException", error.message, 500));
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "organizations", accounts: this.accounts.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-organizations");

    if (method !== "POST") {
      return this.sendError(res, new OrgError("ValidationException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new OrgError("ValidationException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof OrgError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateOrganization": return this.createOrganization(input);
      case "DescribeOrganization": return this.describeOrganization(input);
      case "DeleteOrganization": return this.deleteOrganization(input);
      case "ListAccounts": return this.listAccounts(input);
      case "CreateAccount": return this.createAccount(input);
      case "DescribeCreateAccountStatus": return this.describeCreateAccountStatus(input);
      case "DescribeAccount": return this.describeAccount(input);
      case "ListRoots": return this.listRoots(input);
      case "CreateOrganizationalUnit": return this.createOrganizationalUnit(input);
      case "DescribeOrganizationalUnit": return this.describeOrganizationalUnit(input);
      case "ListOrganizationalUnitsForParent": return this.listOrganizationalUnitsForParent(input);
      case "DeleteOrganizationalUnit": return this.deleteOrganizationalUnit(input);
      case "CreatePolicy": return this.createPolicy(input);
      case "DescribePolicy": return this.describePolicy(input);
      case "ListPolicies": return this.listPolicies(input);
      case "DeletePolicy": return this.deletePolicy(input);
      case "AttachPolicy": return this.attachPolicy(input);
      case "DetachPolicy": return this.detachPolicy(input);
      case "ListPoliciesForTarget": return this.listPoliciesForTarget(input);
      default:
        throw new OrgError("ValidationException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  rootId() {
    return this.organization ? this.organization.rootId : null;
  }

  requireOrg() {
    if (!this.organization) {
      throw new OrgError("AWSOrganizationsNotInUseException", "Your account is not a member of an organization.");
    }
    return this.organization;
  }

  createOrganization(input = {}) {
    if (this.organization) {
      throw new OrgError("AlreadyInOrganizationException", "The AWS account is already a member of an organization.");
    }
    const orgId = `o-${rid(10)}`;
    const rootId = `r-${rid(4)}`;
    this.organization = {
      Id: orgId,
      Arn: `arn:aws:organizations::${this.accountId}:organization/${orgId}`,
      FeatureSet: input.FeatureSet || "ALL",
      MasterAccountId: this.accountId,
      MasterAccountArn: `arn:aws:organizations::${this.accountId}:account/${orgId}/${this.accountId}`,
      MasterAccountEmail: "master@parlel.local",
      rootId,
      rootArn: `arn:aws:organizations::${this.accountId}:root/${orgId}/${rootId}`,
    };
    // The management account is itself an account in the org.
    this.accounts.set(this.accountId, {
      Id: this.accountId,
      Arn: this.organization.MasterAccountArn,
      Name: "management-account",
      Email: "master@parlel.local",
      Status: "ACTIVE",
      JoinedMethod: "INVITED",
      JoinedTimestamp: Date.now(),
      parent: rootId,
    });
    return { Organization: this.orgView() };
  }

  orgView() {
    const o = this.organization;
    return {
      Id: o.Id,
      Arn: o.Arn,
      FeatureSet: o.FeatureSet,
      MasterAccountArn: o.MasterAccountArn,
      MasterAccountId: o.MasterAccountId,
      MasterAccountEmail: o.MasterAccountEmail,
      AvailablePolicyTypes: [{ Type: "SERVICE_CONTROL_POLICY", Status: "ENABLED" }],
    };
  }

  describeOrganization() {
    this.requireOrg();
    return { Organization: this.orgView() };
  }

  deleteOrganization() {
    this.requireOrg();
    this.reset();
    return {};
  }

  listRoots() {
    this.requireOrg();
    return {
      Roots: [
        {
          Id: this.organization.rootId,
          Arn: this.organization.rootArn,
          Name: "Root",
          PolicyTypes: [{ Type: "SERVICE_CONTROL_POLICY", Status: "ENABLED" }],
        },
      ],
    };
  }

  listAccounts() {
    this.requireOrg();
    return { Accounts: [...this.accounts.values()].map((a) => this.accountView(a)) };
  }

  accountView(a) {
    return {
      Id: a.Id,
      Arn: a.Arn,
      Name: a.Name,
      Email: a.Email,
      Status: a.Status,
      JoinedMethod: a.JoinedMethod,
      JoinedTimestamp: epochSeconds(a.JoinedTimestamp),
    };
  }

  createAccount(input) {
    this.requireOrg();
    if (!input.AccountName) throw new OrgError("InvalidInputException", "AccountName is required.");
    if (!input.Email) throw new OrgError("InvalidInputException", "Email is required.");
    const accountId = String(100000000000 + Math.floor(Math.random() * 899999999999));
    const orgId = this.organization.Id;
    const account = {
      Id: accountId,
      Arn: `arn:aws:organizations::${this.accountId}:account/${orgId}/${accountId}`,
      Name: input.AccountName,
      Email: input.Email,
      Status: "ACTIVE",
      JoinedMethod: "CREATED",
      JoinedTimestamp: Date.now(),
      parent: this.organization.rootId,
    };
    this.accounts.set(accountId, account);
    const requestId = `car-${rid(8)}`;
    const status = {
      Id: requestId,
      AccountName: input.AccountName,
      State: "SUCCEEDED",
      AccountId: accountId,
      RequestedTimestamp: Date.now(),
      CompletedTimestamp: Date.now(),
    };
    this.createAccountStatuses.set(requestId, status);
    return { CreateAccountStatus: this.createAccountStatusView(status) };
  }

  createAccountStatusView(s) {
    return {
      Id: s.Id,
      AccountName: s.AccountName,
      State: s.State,
      AccountId: s.AccountId,
      RequestedTimestamp: epochSeconds(s.RequestedTimestamp),
      CompletedTimestamp: epochSeconds(s.CompletedTimestamp),
    };
  }

  describeCreateAccountStatus(input) {
    const s = this.createAccountStatuses.get(input.CreateAccountRequestId);
    if (!s) throw new OrgError("ValidationException", "CreateAccountRequestId not found.");
    return { CreateAccountStatus: this.createAccountStatusView(s) };
  }

  describeAccount(input) {
    this.requireOrg();
    const a = this.accounts.get(input.AccountId);
    if (!a) throw new OrgError("AccountNotFoundException", `Account ${input.AccountId} not found.`);
    return { Account: this.accountView(a) };
  }

  createOrganizationalUnit(input) {
    this.requireOrg();
    const parentId = input.ParentId;
    if (!parentId) throw new OrgError("InvalidInputException", "ParentId is required.");
    if (parentId !== this.organization.rootId && !this.ous.has(parentId)) {
      throw new OrgError("ParentNotFoundException", `Parent ${parentId} not found.`);
    }
    const ouId = `ou-${rid(4)}-${rid(8)}`;
    const orgId = this.organization.Id;
    const ou = {
      Id: ouId,
      Arn: `arn:aws:organizations::${this.accountId}:ou/${orgId}/${ouId}`,
      Name: input.Name,
      parent: parentId,
    };
    this.ous.set(ouId, ou);
    return { OrganizationalUnit: this.ouView(ou) };
  }

  ouView(ou) {
    return { Id: ou.Id, Arn: ou.Arn, Name: ou.Name };
  }

  describeOrganizationalUnit(input) {
    const ou = this.ous.get(input.OrganizationalUnitId);
    if (!ou) throw new OrgError("OrganizationalUnitNotFoundException", "OU not found.");
    return { OrganizationalUnit: this.ouView(ou) };
  }

  listOrganizationalUnitsForParent(input) {
    this.requireOrg();
    const parentId = input.ParentId;
    const ous = [...this.ous.values()].filter((o) => o.parent === parentId);
    return { OrganizationalUnits: ous.map((o) => this.ouView(o)) };
  }

  deleteOrganizationalUnit(input) {
    const ou = this.ous.get(input.OrganizationalUnitId);
    if (!ou) throw new OrgError("OrganizationalUnitNotFoundException", "OU not found.");
    this.ous.delete(input.OrganizationalUnitId);
    return {};
  }

  createPolicy(input) {
    this.requireOrg();
    if (!input.Name) throw new OrgError("InvalidInputException", "Name is required.");
    if (!input.Content) throw new OrgError("InvalidInputException", "Content is required.");
    const policyId = `p-${rid(8)}`;
    const orgId = this.organization.Id;
    const policy = {
      Id: policyId,
      Arn: `arn:aws:organizations::${this.accountId}:policy/${orgId}/${input.Type || "service_control_policy"}/${policyId}`,
      Name: input.Name,
      Description: input.Description || "",
      Type: input.Type || "SERVICE_CONTROL_POLICY",
      AwsManaged: false,
      Content: input.Content,
    };
    this.policies.set(policyId, policy);
    return { Policy: this.policyView(policy, true) };
  }

  policyView(policy, includeContent) {
    const summary = {
      Id: policy.Id,
      Arn: policy.Arn,
      Name: policy.Name,
      Description: policy.Description,
      Type: policy.Type,
      AwsManaged: policy.AwsManaged,
    };
    if (includeContent) return { PolicySummary: summary, Content: policy.Content };
    return summary;
  }

  describePolicy(input) {
    const policy = this.policies.get(input.PolicyId);
    if (!policy) throw new OrgError("PolicyNotFoundException", "Policy not found.");
    return { Policy: this.policyView(policy, true) };
  }

  listPolicies(input) {
    this.requireOrg();
    let all = [...this.policies.values()];
    if (input.Filter) all = all.filter((p) => p.Type === input.Filter);
    return { Policies: all.map((p) => this.policyView(p, false)) };
  }

  deletePolicy(input) {
    const policy = this.policies.get(input.PolicyId);
    if (!policy) throw new OrgError("PolicyNotFoundException", "Policy not found.");
    this.policies.delete(input.PolicyId);
    return {};
  }

  attachPolicy(input) {
    this.requireOrg();
    const policy = this.policies.get(input.PolicyId);
    if (!policy) throw new OrgError("PolicyNotFoundException", "Policy not found.");
    const targetId = input.TargetId;
    if (!targetId) throw new OrgError("InvalidInputException", "TargetId is required.");
    if (!this.attachments.has(targetId)) this.attachments.set(targetId, new Set());
    this.attachments.get(targetId).add(input.PolicyId);
    return {};
  }

  detachPolicy(input) {
    const set = this.attachments.get(input.TargetId);
    if (set) set.delete(input.PolicyId);
    return {};
  }

  listPoliciesForTarget(input) {
    this.requireOrg();
    const set = this.attachments.get(input.TargetId) || new Set();
    const list = [...set].map((pid) => this.policies.get(pid)).filter(Boolean).map((p) => this.policyView(p, false));
    return { Policies: list };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "ServiceException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default OrganizationsServer;
