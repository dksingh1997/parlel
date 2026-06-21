// parlel/sts — a lightweight, dependency-free fake of AWS STS.
//
// Speaks the AWS Query wire protocol (API version 2011-06-15). Pure Node.js,
// no external npm dependencies. State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const STS_NAMESPACE = "https://sts.amazonaws.com/doc/2011-06-15/";
const API_VERSION = "2011-06-15";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidParameterValue: 400,
  ValidationError: 400,
  MalformedPolicyDocument: 400,
  PackedPolicyTooLarge: 400,
  AccessDenied: 403,
  ExpiredTokenException: 400,
  IDPRejectedClaim: 403,
  InvalidIdentityToken: 400,
  InternalError: 500,
};

class StsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

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
    const inner = Object.entries(value).map(([k, v]) => xmlNode(k, v)).join("");
    return `<${tag}>${inner}</${tag}>`;
  }
  if (typeof value === "boolean") return `<${tag}>${value ? "true" : "false"}</${tag}>`;
  return `<${tag}>${xmlEscape(value)}</${tag}>`;
}

function parseForm(body) {
  const flat = {};
  const params = new URLSearchParams(body);
  for (const [key, value] of params.entries()) flat[key] = value;
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
      if (last) cursor[part] = value;
      else {
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
    const indices = Object.keys(container).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    return indices.map((idx) => normalizeNode(container[idx]));
  }
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return keys.sort((a, b) => Number(a) - Number(b)).map((idx) => normalizeNode(node[idx]));
  }
  const out = {};
  for (const k of keys) out[k] = normalizeNode(node[k]);
  return out;
}

function fakeAccessKeyId() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "ASIA";
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function fakeSecret() {
  return randomBytes(30).toString("base64").replace(/[+/=]/g, "").slice(0, 40);
}

function fakeSessionToken() {
  return randomBytes(120).toString("base64");
}

function isoDate(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class StsServer {
  constructor(port = 4729, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.sessions = new Map(); // accessKeyId -> session info
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new StsError("InternalError", error.message, 500));
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
      return this.sendJson(res, 200, { status: "ok", service: "sts", sessions: this.sessions.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-sts");

    if (method !== "POST") {
      return this.sendError(res, new StsError("ValidationError", "Only POST is supported.", 405));
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(res, new StsError("ValidationError", "Request body could not be parsed.", 400));
    }

    const operation = input.Action;
    try {
      const { result, resultTag } = this.dispatch(operation, input);
      return this.sendXml(res, 200, operation, resultTag, result);
    } catch (error) {
      if (error instanceof StsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      GetCallerIdentity: () => this.getCallerIdentity(input),
      AssumeRole: () => this.assumeRole(input),
      GetSessionToken: () => this.getSessionToken(input),
      AssumeRoleWithWebIdentity: () => this.assumeRoleWithWebIdentity(input),
      GetFederationToken: () => this.getFederationToken(input),
      DecodeAuthorizationMessage: () => this.decodeAuthorizationMessage(input),
    };
    const handler = handlers[operation];
    if (!handler) {
      throw new StsError("ValidationError", `The action ${operation || "(none)"} is not valid.`, 400);
    }
    return handler();
  }

  credentials(durationSeconds = 3600) {
    const accessKeyId = fakeAccessKeyId();
    const expiration = Date.now() + Number(durationSeconds) * 1000;
    const creds = {
      AccessKeyId: accessKeyId,
      SecretAccessKey: fakeSecret(),
      SessionToken: fakeSessionToken(),
      Expiration: isoDate(expiration),
    };
    this.sessions.set(accessKeyId, { ...creds, expirationMs: expiration });
    return creds;
  }

  getCallerIdentity() {
    return {
      result: {
        UserId: "AROAPARLELEXAMPLEID:parlel-session",
        Account: this.accountId,
        Arn: `arn:aws:sts::${this.accountId}:assumed-role/parlel/parlel-session`,
      },
      resultTag: "GetCallerIdentityResult",
    };
  }

  assumeRole(input) {
    const roleArn = input.RoleArn;
    const sessionName = input.RoleSessionName;
    if (!roleArn) throw new StsError("ValidationError", "RoleArn is required.");
    if (!sessionName) throw new StsError("ValidationError", "RoleSessionName is required.");
    const duration = input.DurationSeconds || 3600;
    const creds = this.credentials(duration);
    const roleName = roleArn.split("/").pop() || "role";
    const roleId = "AROA" + randomBytes(8).toString("hex").toUpperCase().slice(0, 17);
    return {
      result: {
        Credentials: creds,
        AssumedRoleUser: {
          AssumedRoleId: `${roleId}:${sessionName}`,
          Arn: `arn:aws:sts::${this.accountId}:assumed-role/${roleName}/${sessionName}`,
        },
        PackedPolicySize: 6,
      },
      resultTag: "AssumeRoleResult",
    };
  }

  getSessionToken(input) {
    const duration = input.DurationSeconds || 43200;
    const creds = this.credentials(duration);
    return { result: { Credentials: creds }, resultTag: "GetSessionTokenResult" };
  }

  assumeRoleWithWebIdentity(input) {
    const roleArn = input.RoleArn;
    const sessionName = input.RoleSessionName;
    if (!roleArn) throw new StsError("ValidationError", "RoleArn is required.");
    if (!sessionName) throw new StsError("ValidationError", "RoleSessionName is required.");
    if (!input.WebIdentityToken) throw new StsError("InvalidIdentityToken", "WebIdentityToken is required.");
    const duration = input.DurationSeconds || 3600;
    const creds = this.credentials(duration);
    const roleName = roleArn.split("/").pop() || "role";
    const roleId = "AROA" + randomBytes(8).toString("hex").toUpperCase().slice(0, 17);
    return {
      result: {
        Credentials: creds,
        SubjectFromWebIdentityToken: "parlel-subject",
        AssumedRoleUser: {
          AssumedRoleId: `${roleId}:${sessionName}`,
          Arn: `arn:aws:sts::${this.accountId}:assumed-role/${roleName}/${sessionName}`,
        },
        Audience: input.ProviderId || "parlel.local",
        Provider: input.ProviderId || "parlel.local",
        PackedPolicySize: 6,
      },
      resultTag: "AssumeRoleWithWebIdentityResult",
    };
  }

  getFederationToken(input) {
    const name = input.Name;
    if (!name) throw new StsError("ValidationError", "Name is required.");
    const duration = input.DurationSeconds || 43200;
    const creds = this.credentials(duration);
    return {
      result: {
        Credentials: creds,
        FederatedUser: {
          FederatedUserId: `${this.accountId}:${name}`,
          Arn: `arn:aws:sts::${this.accountId}:federated-user/${name}`,
        },
        PackedPolicySize: 6,
      },
      resultTag: "GetFederationTokenResult",
    };
  }

  decodeAuthorizationMessage(input) {
    const message = input.EncodedMessage;
    if (!message) throw new StsError("ValidationError", "EncodedMessage is required.");
    const decoded = {
      allowed: false,
      explicitDeny: true,
      matchedStatements: {},
      failures: {},
      context: { principal: { id: "parlel", arn: `arn:aws:iam::${this.accountId}:user/parlel` }, action: "unknown", resource: "unknown" },
    };
    return {
      result: { DecodedMessage: JSON.stringify(decoded) },
      resultTag: "DecodeAuthorizationMessageResult",
    };
  }

  buildResultXml(result) {
    let xml = "";
    for (const [key, value] of Object.entries(result)) xml += xmlNode(key, value);
    return xml;
  }

  sendXml(res, status, operation, resultTag, result) {
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    const responseTag = `${operation}Response`;
    const resultXml = this.buildResultXml(result);
    const resultBlock = resultXml.length > 0 ? `<${resultTag}>${resultXml}</${resultTag}>` : `<${resultTag}/>`;
    const xml =
      `<${responseTag} xmlns="${STS_NAMESPACE}">` +
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
      `<ErrorResponse xmlns="${STS_NAMESPACE}">` +
      `<Error><Type>${fault}</Type><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(error.message || code)}</Message></Error>` +
      `<RequestId>${requestId}</RequestId></ErrorResponse>`;
    res.end(`<?xml version="1.0"?>\n${xml}`);
  }
}

export default StsServer;
export const API_VERSION_STS = API_VERSION;
