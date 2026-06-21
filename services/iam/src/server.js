// parlel/iam — a lightweight, dependency-free fake of AWS IAM.
//
// Speaks the AWS Query wire protocol (API version 2010-05-08) so that
// application code using the real `@aws-sdk/client-iam` client can run against
// it with zero cost and zero side effects. Pure Node.js, no external npm
// dependencies. State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const IAM_NAMESPACE = "https://iam.amazonaws.com/doc/2010-05-08/";
const API_VERSION = "2010-05-08";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  NoSuchEntity: 404,
  EntityAlreadyExists: 409,
  InvalidInput: 400,
  ValidationError: 400,
  LimitExceeded: 409,
  MalformedPolicyDocument: 400,
  DeleteConflict: 409,
  InternalError: 500,
  AccessDenied: 403,
};

class IamError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// XML helpers (copied from sns)
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

// ---------------------------------------------------------------------------
// AWS query form-encoded request parser (copied from sns)
// ---------------------------------------------------------------------------
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
    const k = item.key !== undefined ? item.key : item.Key !== undefined ? item.Key : item.Name;
    const v = item.value !== undefined ? item.value : item.Value !== undefined ? item.Value : item.AttributeValue;
    if (k === undefined) return null;
    map[k] = v === undefined ? "" : v;
  }
  return map;
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------
function uniqueId(prefix) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  const bytes = randomBytes(16);
  for (let i = 0; i < 17; i += 1) out += alphabet[bytes[i % bytes.length] % alphabet.length];
  return prefix + out;
}

function isoDate(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function coerceList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [value];
}

function coerceTags(input) {
  const tags = [];
  if (!input) return tags;
  const list = Array.isArray(input) ? input : typeof input === "object" ? Object.values(input) : [];
  for (const t of list) {
    if (t && t.Key !== undefined) tags.push({ Key: t.Key, Value: t.Value ?? "" });
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export class IamServer {
  constructor(port = 4575, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map(); // name -> user
    this.roles = new Map(); // name -> role
    this.policies = new Map(); // arn -> policy
    this.groups = new Map(); // name -> group
    this.instanceProfiles = new Map(); // name -> profile
    this.accessKeys = new Map(); // accessKeyId -> { userName, status, secret, createDate }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new IamError("InternalError", error.message, 500));
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

  arn(type, path, name) {
    const p = path && path !== "/" ? path : "/";
    return `arn:aws:iam::${this.accountId}:${type}${p}${name}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "iam",
        users: this.users.size,
        roles: this.roles.size,
        policies: this.policies.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-iam");

    if (method !== "POST") {
      return this.sendError(res, new IamError("InvalidInput", "Only POST is supported.", 405));
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(res, new IamError("InvalidInput", "Request body could not be parsed.", 400));
    }

    const operation = input.Action;
    try {
      const { result, resultTag } = this.dispatch(operation, input);
      return this.sendXml(res, 200, operation, resultTag, result);
    } catch (error) {
      if (error instanceof IamError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      // Users
      CreateUser: () => this.createUser(input),
      GetUser: () => this.getUser(input),
      ListUsers: () => this.listUsers(input),
      DeleteUser: () => this.deleteUser(input),
      UpdateUser: () => this.updateUser(input),
      // Roles
      CreateRole: () => this.createRole(input),
      GetRole: () => this.getRole(input),
      ListRoles: () => this.listRoles(input),
      DeleteRole: () => this.deleteRole(input),
      // Policies
      CreatePolicy: () => this.createPolicy(input),
      GetPolicy: () => this.getPolicy(input),
      ListPolicies: () => this.listPolicies(input),
      DeletePolicy: () => this.deletePolicy(input),
      CreatePolicyVersion: () => this.createPolicyVersion(input),
      // Attach / detach
      AttachUserPolicy: () => this.attachUserPolicy(input),
      AttachRolePolicy: () => this.attachRolePolicy(input),
      DetachUserPolicy: () => this.detachUserPolicy(input),
      DetachRolePolicy: () => this.detachRolePolicy(input),
      ListAttachedUserPolicies: () => this.listAttachedUserPolicies(input),
      ListAttachedRolePolicies: () => this.listAttachedRolePolicies(input),
      // Inline policies
      PutUserPolicy: () => this.putUserPolicy(input),
      GetUserPolicy: () => this.getUserPolicy(input),
      PutRolePolicy: () => this.putRolePolicy(input),
      GetRolePolicy: () => this.getRolePolicy(input),
      ListUserPolicies: () => this.listUserPolicies(input),
      ListRolePolicies: () => this.listRolePolicies(input),
      // Access keys
      CreateAccessKey: () => this.createAccessKey(input),
      ListAccessKeys: () => this.listAccessKeys(input),
      DeleteAccessKey: () => this.deleteAccessKey(input),
      UpdateAccessKey: () => this.updateAccessKey(input),
      // Instance profiles
      CreateInstanceProfile: () => this.createInstanceProfile(input),
      GetInstanceProfile: () => this.getInstanceProfile(input),
      ListInstanceProfiles: () => this.listInstanceProfiles(input),
      AddRoleToInstanceProfile: () => this.addRoleToInstanceProfile(input),
      // Groups
      CreateGroup: () => this.createGroup(input),
      GetGroup: () => this.getGroup(input),
      ListGroups: () => this.listGroups(input),
      DeleteGroup: () => this.deleteGroup(input),
      AddUserToGroup: () => this.addUserToGroup(input),
      RemoveUserFromGroup: () => this.removeUserFromGroup(input),
      // Tags
      TagRole: () => this.tagRole(input),
      TagUser: () => this.tagUser(input),
      ListRoleTags: () => this.listRoleTags(input),
      ListUserTags: () => this.listUserTags(input),
      UntagRole: () => this.untagRole(input),
      UntagUser: () => this.untagUser(input),
    };
    const handler = handlers[operation];
    if (!handler) {
      throw new IamError("InvalidInput", `The action ${operation || "(none)"} is not valid for this endpoint.`, 400);
    }
    return handler();
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  createUser(input) {
    const name = input.UserName;
    if (!name) throw new IamError("ValidationError", "UserName is required.");
    if (this.users.has(name)) {
      throw new IamError("EntityAlreadyExists", `User with name ${name} already exists.`);
    }
    const path = input.Path || "/";
    const now = Date.now();
    const user = {
      UserName: name,
      UserId: uniqueId("AIDA"),
      Path: path,
      Arn: this.arn("user", path, name),
      CreateDate: now,
      tags: coerceTags(input.Tags),
      attachedPolicies: new Map(),
      inlinePolicies: new Map(),
      groups: new Set(),
    };
    this.users.set(name, user);
    return { result: { User: this.userView(user) }, resultTag: "CreateUserResult" };
  }

  userView(user) {
    const v = {
      Path: user.Path,
      UserName: user.UserName,
      UserId: user.UserId,
      Arn: user.Arn,
      CreateDate: isoDate(user.CreateDate),
    };
    if (user.tags && user.tags.length) v.Tags = user.tags;
    return v;
  }

  requireUser(name) {
    if (!name) throw new IamError("ValidationError", "UserName is required.");
    const user = this.users.get(name);
    if (!user) throw new IamError("NoSuchEntity", `The user with name ${name} cannot be found.`);
    return user;
  }

  getUser(input) {
    let name = input.UserName;
    let user;
    if (!name) {
      // Return a synthetic root-ish user representing the caller.
      user = {
        UserName: "parlel",
        UserId: "AIDAPARLELROOTUSER00",
        Path: "/",
        Arn: this.arn("user", "/", "parlel"),
        CreateDate: 0,
        tags: [],
      };
    } else {
      user = this.requireUser(name);
    }
    return { result: { User: this.userView(user) }, resultTag: "GetUserResult" };
  }

  listUsers(input) {
    const pathPrefix = input.PathPrefix || "/";
    const all = [...this.users.values()].filter((u) => u.Path.startsWith(pathPrefix));
    return {
      result: { Users: all.map((u) => this.userView(u)), IsTruncated: false },
      resultTag: "ListUsersResult",
    };
  }

  deleteUser(input) {
    const user = this.requireUser(input.UserName);
    this.users.delete(user.UserName);
    // Clean up access keys.
    for (const [id, ak] of this.accessKeys) {
      if (ak.userName === user.UserName) this.accessKeys.delete(id);
    }
    return { result: {}, resultTag: "DeleteUserResult" };
  }

  updateUser(input) {
    const user = this.requireUser(input.UserName);
    if (input.NewUserName && input.NewUserName !== user.UserName) {
      if (this.users.has(input.NewUserName)) {
        throw new IamError("EntityAlreadyExists", `User ${input.NewUserName} already exists.`);
      }
      this.users.delete(user.UserName);
      user.UserName = input.NewUserName;
      user.Arn = this.arn("user", user.Path, user.UserName);
      this.users.set(user.UserName, user);
    }
    if (input.NewPath) {
      user.Path = input.NewPath;
      user.Arn = this.arn("user", user.Path, user.UserName);
    }
    return { result: {}, resultTag: "UpdateUserResult" };
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------
  createRole(input) {
    const name = input.RoleName;
    if (!name) throw new IamError("ValidationError", "RoleName is required.");
    if (this.roles.has(name)) {
      throw new IamError("EntityAlreadyExists", `Role with name ${name} already exists.`);
    }
    const doc = input.AssumeRolePolicyDocument;
    if (!doc) throw new IamError("ValidationError", "AssumeRolePolicyDocument is required.");
    const path = input.Path || "/";
    const now = Date.now();
    const role = {
      RoleName: name,
      RoleId: uniqueId("AROA"),
      Path: path,
      Arn: this.arn("role", path, name),
      CreateDate: now,
      AssumeRolePolicyDocument: doc,
      Description: input.Description,
      MaxSessionDuration: input.MaxSessionDuration ? Number(input.MaxSessionDuration) : 3600,
      tags: coerceTags(input.Tags),
      attachedPolicies: new Map(),
      inlinePolicies: new Map(),
    };
    this.roles.set(name, role);
    return { result: { Role: this.roleView(role) }, resultTag: "CreateRoleResult" };
  }

  roleView(role, { includeDoc = true } = {}) {
    const v = {
      Path: role.Path,
      RoleName: role.RoleName,
      RoleId: role.RoleId,
      Arn: role.Arn,
      CreateDate: isoDate(role.CreateDate),
      MaxSessionDuration: role.MaxSessionDuration,
    };
    if (includeDoc && role.AssumeRolePolicyDocument !== undefined) {
      v.AssumeRolePolicyDocument = encodeURIComponent(role.AssumeRolePolicyDocument);
    }
    if (role.Description !== undefined) v.Description = role.Description;
    if (role.tags && role.tags.length) v.Tags = role.tags;
    return v;
  }

  requireRole(name) {
    if (!name) throw new IamError("ValidationError", "RoleName is required.");
    const role = this.roles.get(name);
    if (!role) throw new IamError("NoSuchEntity", `The role with name ${name} cannot be found.`);
    return role;
  }

  getRole(input) {
    const role = this.requireRole(input.RoleName);
    return { result: { Role: this.roleView(role) }, resultTag: "GetRoleResult" };
  }

  listRoles(input) {
    const pathPrefix = input.PathPrefix || "/";
    const all = [...this.roles.values()].filter((r) => r.Path.startsWith(pathPrefix));
    return {
      result: { Roles: all.map((r) => this.roleView(r)), IsTruncated: false },
      resultTag: "ListRolesResult",
    };
  }

  deleteRole(input) {
    const role = this.requireRole(input.RoleName);
    this.roles.delete(role.RoleName);
    return { result: {}, resultTag: "DeleteRoleResult" };
  }

  // -------------------------------------------------------------------------
  // Managed policies
  // -------------------------------------------------------------------------
  createPolicy(input) {
    const name = input.PolicyName;
    if (!name) throw new IamError("ValidationError", "PolicyName is required.");
    const doc = input.PolicyDocument;
    if (!doc) throw new IamError("ValidationError", "PolicyDocument is required.");
    const path = input.Path || "/";
    const arn = this.arn("policy", path, name);
    if (this.policies.has(arn)) {
      throw new IamError("EntityAlreadyExists", `A policy called ${name} already exists.`);
    }
    const now = Date.now();
    const versionId = "v1";
    const policy = {
      PolicyName: name,
      PolicyId: uniqueId("ANPA"),
      Arn: arn,
      Path: path,
      DefaultVersionId: versionId,
      AttachmentCount: 0,
      IsAttachable: true,
      Description: input.Description,
      CreateDate: now,
      UpdateDate: now,
      versions: new Map([[versionId, { document: doc, isDefault: true, createDate: now }]]),
      tags: coerceTags(input.Tags),
    };
    this.policies.set(arn, policy);
    return { result: { Policy: this.policyView(policy) }, resultTag: "CreatePolicyResult" };
  }

  policyView(policy) {
    const v = {
      PolicyName: policy.PolicyName,
      PolicyId: policy.PolicyId,
      Arn: policy.Arn,
      Path: policy.Path,
      DefaultVersionId: policy.DefaultVersionId,
      AttachmentCount: policy.AttachmentCount,
      PermissionsBoundaryUsageCount: 0,
      IsAttachable: policy.IsAttachable,
      CreateDate: isoDate(policy.CreateDate),
      UpdateDate: isoDate(policy.UpdateDate),
    };
    if (policy.Description !== undefined) v.Description = policy.Description;
    if (policy.tags && policy.tags.length) v.Tags = policy.tags;
    return v;
  }

  requirePolicy(arn) {
    if (!arn) throw new IamError("ValidationError", "PolicyArn is required.");
    const policy = this.policies.get(arn);
    if (!policy) throw new IamError("NoSuchEntity", `Policy ${arn} does not exist.`);
    return policy;
  }

  getPolicy(input) {
    const policy = this.requirePolicy(input.PolicyArn);
    return { result: { Policy: this.policyView(policy) }, resultTag: "GetPolicyResult" };
  }

  listPolicies(input) {
    let all = [...this.policies.values()];
    if (input.Scope === "AWS") all = [];
    return {
      result: { Policies: all.map((p) => this.policyView(p)), IsTruncated: false },
      resultTag: "ListPoliciesResult",
    };
  }

  deletePolicy(input) {
    const policy = this.requirePolicy(input.PolicyArn);
    this.policies.delete(policy.Arn);
    return { result: {}, resultTag: "DeletePolicyResult" };
  }

  createPolicyVersion(input) {
    const policy = this.requirePolicy(input.PolicyArn);
    const doc = input.PolicyDocument;
    if (!doc) throw new IamError("ValidationError", "PolicyDocument is required.");
    const num = policy.versions.size + 1;
    const versionId = `v${num}`;
    const now = Date.now();
    const setDefault = input.SetAsDefault === "true" || input.SetAsDefault === true;
    if (setDefault) {
      for (const v of policy.versions.values()) v.isDefault = false;
      policy.DefaultVersionId = versionId;
    }
    policy.versions.set(versionId, { document: doc, isDefault: setDefault, createDate: now });
    policy.UpdateDate = now;
    return {
      result: {
        PolicyVersion: {
          VersionId: versionId,
          IsDefaultVersion: setDefault,
          CreateDate: isoDate(now),
        },
      },
      resultTag: "CreatePolicyVersionResult",
    };
  }

  // -------------------------------------------------------------------------
  // Attach / detach managed policies
  // -------------------------------------------------------------------------
  attachUserPolicy(input) {
    const user = this.requireUser(input.UserName);
    const policy = this.requirePolicy(input.PolicyArn);
    if (!user.attachedPolicies.has(policy.Arn)) {
      user.attachedPolicies.set(policy.Arn, policy.PolicyName);
      policy.AttachmentCount += 1;
    }
    return { result: {}, resultTag: "AttachUserPolicyResult" };
  }

  attachRolePolicy(input) {
    const role = this.requireRole(input.RoleName);
    const policy = this.requirePolicy(input.PolicyArn);
    if (!role.attachedPolicies.has(policy.Arn)) {
      role.attachedPolicies.set(policy.Arn, policy.PolicyName);
      policy.AttachmentCount += 1;
    }
    return { result: {}, resultTag: "AttachRolePolicyResult" };
  }

  detachUserPolicy(input) {
    const user = this.requireUser(input.UserName);
    if (user.attachedPolicies.delete(input.PolicyArn)) {
      const policy = this.policies.get(input.PolicyArn);
      if (policy && policy.AttachmentCount > 0) policy.AttachmentCount -= 1;
    }
    return { result: {}, resultTag: "DetachUserPolicyResult" };
  }

  detachRolePolicy(input) {
    const role = this.requireRole(input.RoleName);
    if (role.attachedPolicies.delete(input.PolicyArn)) {
      const policy = this.policies.get(input.PolicyArn);
      if (policy && policy.AttachmentCount > 0) policy.AttachmentCount -= 1;
    }
    return { result: {}, resultTag: "DetachRolePolicyResult" };
  }

  listAttachedUserPolicies(input) {
    const user = this.requireUser(input.UserName);
    const list = [...user.attachedPolicies.entries()].map(([PolicyArn, PolicyName]) => ({ PolicyName, PolicyArn }));
    return {
      result: { AttachedPolicies: list, IsTruncated: false },
      resultTag: "ListAttachedUserPoliciesResult",
    };
  }

  listAttachedRolePolicies(input) {
    const role = this.requireRole(input.RoleName);
    const list = [...role.attachedPolicies.entries()].map(([PolicyArn, PolicyName]) => ({ PolicyName, PolicyArn }));
    return {
      result: { AttachedPolicies: list, IsTruncated: false },
      resultTag: "ListAttachedRolePoliciesResult",
    };
  }

  // -------------------------------------------------------------------------
  // Inline policies
  // -------------------------------------------------------------------------
  putUserPolicy(input) {
    const user = this.requireUser(input.UserName);
    if (!input.PolicyName) throw new IamError("ValidationError", "PolicyName is required.");
    user.inlinePolicies.set(input.PolicyName, input.PolicyDocument ?? "");
    return { result: {}, resultTag: "PutUserPolicyResult" };
  }

  getUserPolicy(input) {
    const user = this.requireUser(input.UserName);
    const doc = user.inlinePolicies.get(input.PolicyName);
    if (doc === undefined) throw new IamError("NoSuchEntity", `Policy ${input.PolicyName} not found for user.`);
    return {
      result: {
        UserName: user.UserName,
        PolicyName: input.PolicyName,
        PolicyDocument: encodeURIComponent(doc),
      },
      resultTag: "GetUserPolicyResult",
    };
  }

  putRolePolicy(input) {
    const role = this.requireRole(input.RoleName);
    if (!input.PolicyName) throw new IamError("ValidationError", "PolicyName is required.");
    role.inlinePolicies.set(input.PolicyName, input.PolicyDocument ?? "");
    return { result: {}, resultTag: "PutRolePolicyResult" };
  }

  getRolePolicy(input) {
    const role = this.requireRole(input.RoleName);
    const doc = role.inlinePolicies.get(input.PolicyName);
    if (doc === undefined) throw new IamError("NoSuchEntity", `Policy ${input.PolicyName} not found for role.`);
    return {
      result: {
        RoleName: role.RoleName,
        PolicyName: input.PolicyName,
        PolicyDocument: encodeURIComponent(doc),
      },
      resultTag: "GetRolePolicyResult",
    };
  }

  listUserPolicies(input) {
    const user = this.requireUser(input.UserName);
    return {
      result: { PolicyNames: [...user.inlinePolicies.keys()], IsTruncated: false },
      resultTag: "ListUserPoliciesResult",
    };
  }

  listRolePolicies(input) {
    const role = this.requireRole(input.RoleName);
    return {
      result: { PolicyNames: [...role.inlinePolicies.keys()], IsTruncated: false },
      resultTag: "ListRolePoliciesResult",
    };
  }

  // -------------------------------------------------------------------------
  // Access keys
  // -------------------------------------------------------------------------
  createAccessKey(input) {
    const userName = input.UserName;
    if (userName) this.requireUser(userName);
    const accessKeyId = uniqueId("AKIA");
    const secret = randomBytes(30).toString("base64").replace(/[+/=]/g, "").slice(0, 40);
    const now = Date.now();
    this.accessKeys.set(accessKeyId, {
      userName: userName || "parlel",
      status: "Active",
      secret,
      createDate: now,
    });
    return {
      result: {
        AccessKey: {
          UserName: userName || "parlel",
          AccessKeyId: accessKeyId,
          Status: "Active",
          SecretAccessKey: secret,
          CreateDate: isoDate(now),
        },
      },
      resultTag: "CreateAccessKeyResult",
    };
  }

  listAccessKeys(input) {
    const userName = input.UserName;
    const list = [...this.accessKeys.entries()]
      .filter(([, ak]) => !userName || ak.userName === userName)
      .map(([AccessKeyId, ak]) => ({
        UserName: ak.userName,
        AccessKeyId,
        Status: ak.status,
        CreateDate: isoDate(ak.createDate),
      }));
    return {
      result: { AccessKeyMetadata: list, IsTruncated: false },
      resultTag: "ListAccessKeysResult",
    };
  }

  deleteAccessKey(input) {
    if (!this.accessKeys.has(input.AccessKeyId)) {
      throw new IamError("NoSuchEntity", `Access key ${input.AccessKeyId} does not exist.`);
    }
    this.accessKeys.delete(input.AccessKeyId);
    return { result: {}, resultTag: "DeleteAccessKeyResult" };
  }

  updateAccessKey(input) {
    const ak = this.accessKeys.get(input.AccessKeyId);
    if (!ak) throw new IamError("NoSuchEntity", `Access key ${input.AccessKeyId} does not exist.`);
    if (input.Status) ak.status = input.Status;
    return { result: {}, resultTag: "UpdateAccessKeyResult" };
  }

  // -------------------------------------------------------------------------
  // Instance profiles
  // -------------------------------------------------------------------------
  createInstanceProfile(input) {
    const name = input.InstanceProfileName;
    if (!name) throw new IamError("ValidationError", "InstanceProfileName is required.");
    if (this.instanceProfiles.has(name)) {
      throw new IamError("EntityAlreadyExists", `Instance Profile ${name} already exists.`);
    }
    const path = input.Path || "/";
    const now = Date.now();
    const profile = {
      InstanceProfileName: name,
      InstanceProfileId: uniqueId("AIPA"),
      Path: path,
      Arn: this.arn("instance-profile", path, name),
      CreateDate: now,
      roles: [],
      tags: coerceTags(input.Tags),
    };
    this.instanceProfiles.set(name, profile);
    return {
      result: { InstanceProfile: this.instanceProfileView(profile) },
      resultTag: "CreateInstanceProfileResult",
    };
  }

  instanceProfileView(profile) {
    return {
      InstanceProfileName: profile.InstanceProfileName,
      InstanceProfileId: profile.InstanceProfileId,
      Path: profile.Path,
      Arn: profile.Arn,
      CreateDate: isoDate(profile.CreateDate),
      Roles: profile.roles.map((r) => this.roleView(r)),
    };
  }

  getInstanceProfile(input) {
    const profile = this.instanceProfiles.get(input.InstanceProfileName);
    if (!profile) throw new IamError("NoSuchEntity", `Instance Profile ${input.InstanceProfileName} not found.`);
    return {
      result: { InstanceProfile: this.instanceProfileView(profile) },
      resultTag: "GetInstanceProfileResult",
    };
  }

  listInstanceProfiles(input) {
    const pathPrefix = input.PathPrefix || "/";
    const all = [...this.instanceProfiles.values()].filter((p) => p.Path.startsWith(pathPrefix));
    return {
      result: { InstanceProfiles: all.map((p) => this.instanceProfileView(p)), IsTruncated: false },
      resultTag: "ListInstanceProfilesResult",
    };
  }

  addRoleToInstanceProfile(input) {
    const profile = this.instanceProfiles.get(input.InstanceProfileName);
    if (!profile) throw new IamError("NoSuchEntity", `Instance Profile ${input.InstanceProfileName} not found.`);
    const role = this.requireRole(input.RoleName);
    if (!profile.roles.find((r) => r.RoleName === role.RoleName)) profile.roles.push(role);
    return { result: {}, resultTag: "AddRoleToInstanceProfileResult" };
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------
  createGroup(input) {
    const name = input.GroupName;
    if (!name) throw new IamError("ValidationError", "GroupName is required.");
    if (this.groups.has(name)) {
      throw new IamError("EntityAlreadyExists", `Group ${name} already exists.`);
    }
    const path = input.Path || "/";
    const now = Date.now();
    const group = {
      GroupName: name,
      GroupId: uniqueId("AGPA"),
      Path: path,
      Arn: this.arn("group", path, name),
      CreateDate: now,
      members: new Set(),
    };
    this.groups.set(name, group);
    return { result: { Group: this.groupView(group) }, resultTag: "CreateGroupResult" };
  }

  groupView(group) {
    return {
      Path: group.Path,
      GroupName: group.GroupName,
      GroupId: group.GroupId,
      Arn: group.Arn,
      CreateDate: isoDate(group.CreateDate),
    };
  }

  requireGroup(name) {
    if (!name) throw new IamError("ValidationError", "GroupName is required.");
    const group = this.groups.get(name);
    if (!group) throw new IamError("NoSuchEntity", `Group ${name} not found.`);
    return group;
  }

  getGroup(input) {
    const group = this.requireGroup(input.GroupName);
    const members = [...group.members].map((un) => this.users.get(un)).filter(Boolean).map((u) => this.userView(u));
    return {
      result: { Group: this.groupView(group), Users: members, IsTruncated: false },
      resultTag: "GetGroupResult",
    };
  }

  listGroups(input) {
    const pathPrefix = input.PathPrefix || "/";
    const all = [...this.groups.values()].filter((g) => g.Path.startsWith(pathPrefix));
    return {
      result: { Groups: all.map((g) => this.groupView(g)), IsTruncated: false },
      resultTag: "ListGroupsResult",
    };
  }

  deleteGroup(input) {
    const group = this.requireGroup(input.GroupName);
    this.groups.delete(group.GroupName);
    return { result: {}, resultTag: "DeleteGroupResult" };
  }

  addUserToGroup(input) {
    const group = this.requireGroup(input.GroupName);
    const user = this.requireUser(input.UserName);
    group.members.add(user.UserName);
    user.groups.add(group.GroupName);
    return { result: {}, resultTag: "AddUserToGroupResult" };
  }

  removeUserFromGroup(input) {
    const group = this.requireGroup(input.GroupName);
    const user = this.requireUser(input.UserName);
    group.members.delete(user.UserName);
    user.groups.delete(group.GroupName);
    return { result: {}, resultTag: "RemoveUserFromGroupResult" };
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  mergeTags(existing, incoming) {
    const map = new Map(existing.map((t) => [t.Key, t.Value]));
    for (const t of incoming) map.set(t.Key, t.Value);
    return [...map.entries()].map(([Key, Value]) => ({ Key, Value }));
  }

  tagRole(input) {
    const role = this.requireRole(input.RoleName);
    role.tags = this.mergeTags(role.tags, coerceTags(input.Tags));
    return { result: {}, resultTag: "TagRoleResult" };
  }

  tagUser(input) {
    const user = this.requireUser(input.UserName);
    user.tags = this.mergeTags(user.tags, coerceTags(input.Tags));
    return { result: {}, resultTag: "TagUserResult" };
  }

  listRoleTags(input) {
    const role = this.requireRole(input.RoleName);
    return { result: { Tags: role.tags, IsTruncated: false }, resultTag: "ListRoleTagsResult" };
  }

  listUserTags(input) {
    const user = this.requireUser(input.UserName);
    return { result: { Tags: user.tags, IsTruncated: false }, resultTag: "ListUserTagsResult" };
  }

  untagRole(input) {
    const role = this.requireRole(input.RoleName);
    const keys = new Set(coerceList(input.TagKeys));
    role.tags = role.tags.filter((t) => !keys.has(t.Key));
    return { result: {}, resultTag: "UntagRoleResult" };
  }

  untagUser(input) {
    const user = this.requireUser(input.UserName);
    const keys = new Set(coerceList(input.TagKeys));
    user.tags = user.tags.filter((t) => !keys.has(t.Key));
    return { result: {}, resultTag: "UntagUserResult" };
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
    const resultBlock = hasResultBody ? `<${resultTag}>${resultXml}</${resultTag}>` : `<${resultTag}/>`;
    const xml =
      `<${responseTag} xmlns="${IAM_NAMESPACE}">` +
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
      `<ErrorResponse xmlns="${IAM_NAMESPACE}">` +
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

export default IamServer;
export const API_VERSION_IAM = API_VERSION;
