// parlel/ses — a lightweight, dependency-free fake of AWS SES (Simple Email
// Service, the classic v1 API, version 2010-12-01).
//
// Speaks the AWS Query wire protocol so that application code using the real
// `@aws-sdk/client-ses` client can run against it with zero cost and zero side
// effects. Pure Node.js, no external npm dependencies. State is in-memory and
// ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-ses v3):
//   * Requests are POST / with Content-Type application/x-www-form-urlencoded.
//     The body carries `Action=<Operation>&Version=2010-12-01&...params`.
//   * Lists are flattened as `<Name>.member.<n>`; maps as
//     `<Name>.entry.<n>.{key,value}`.
//   * Success: 200, XML `<XxxResponse xmlns="...">`
//       `<XxxResult>...</XxxResult>`
//       `<ResponseMetadata><RequestId>...</RequestId></ResponseMetadata>`
//     `</XxxResponse>`.
//   * Error: non-2xx, XML `<ErrorResponse xmlns="...">`
//       `<Error><Type>Sender|Receiver</Type><Code>..</Code><Message>..</Message></Error>`
//       `<RequestId>...</RequestId></ErrorResponse>`.

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

const SES_NAMESPACE = "http://ses.amazonaws.com/doc/2010-12-01/";
const API_VERSION = "2010-12-01";
const DEFAULT_ACCOUNT_ID = "000000000000";

// SES error codes -> HTTP status. (Sender == client fault, Receiver == server.)
const ERROR_STATUS = {
  MessageRejected: 400,
  MailFromDomainNotVerifiedException: 400,
  ConfigurationSetDoesNotExistException: 400,
  ConfigurationSetDoesNotExist: 400,
  ConfigurationSetAlreadyExistsException: 400,
  ConfigurationSetSendingPausedException: 400,
  AccountSendingPausedException: 400,
  TemplateDoesNotExistException: 400,
  TemplateDoesNotExist: 400,
  AlreadyExistsException: 400,
  AlreadyExists: 400,
  CannotDeleteException: 400,
  CannotDelete: 400,
  RuleSetDoesNotExistException: 400,
  RuleSetDoesNotExist: 400,
  RuleDoesNotExistException: 400,
  RuleDoesNotExist: 400,
  InvalidConfigurationSetException: 400,
  InvalidParameterValue: 400,
  InvalidParameterValueException: 400,
  InvalidLambdaFunctionException: 400,
  InvalidS3ConfigurationException: 400,
  InvalidSnsTopicException: 400,
  InvalidFirehoseDestinationException: 400,
  InvalidCloudWatchDestinationException: 400,
  InvalidDeliveryOptionsException: 400,
  InvalidPolicyException: 400,
  InvalidPolicy: 400,
  InvalidRenderingParameterException: 400,
  InvalidTemplateException: 400,
  InvalidTrackingOptionsException: 400,
  CustomVerificationEmailTemplateAlreadyExistsException: 400,
  CustomVerificationEmailTemplateDoesNotExistException: 400,
  CustomVerificationEmailInvalidContentException: 400,
  FromEmailAddressNotVerifiedException: 400,
  EventDestinationAlreadyExistsException: 400,
  EventDestinationDoesNotExistException: 400,
  TrackingOptionsAlreadyExistsException: 400,
  TrackingOptionsDoesNotExistException: 400,
  LimitExceededException: 400,
  LimitExceeded: 400,
  ProductionAccessNotGrantedException: 400,
  MissingRenderingAttributeException: 400,
  ValidationError: 400,
  InternalError: 500,
  InternalFailure: 500,
};

class SesError extends Error {
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

// A small marker class so we can explicitly serialize a JS object as an AWS
// query map (<entry><key/><value/></entry>) where the value may itself be a
// nested object/structure.
class XmlMap {
  constructor(obj) {
    this.obj = obj || {};
  }
}

// Serialize a JS value into XML nodes given a tag name.
//   * null/undefined -> omitted
//   * arrays -> repeated <tag><member>...</member></tag>
//   * XmlMap -> <tag><entry><key/><value/></entry>...</tag>
//   * other objects -> nested elements
//   * booleans -> "true"/"false"
function xmlNode(tag, value) {
  if (value === undefined || value === null) return "";
  if (value instanceof XmlMap) {
    return xmlMapNode(tag, value.obj);
  }
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

// Serialize a map as <tag><entry><key>..</key><value>..</value></entry>..</tag>.
// Values may be scalars or nested objects.
function xmlMapNode(tag, map) {
  const keys = Object.keys(map || {});
  if (keys.length === 0) return `<${tag}/>`;
  const entries = keys
    .map((k) => {
      const v = map[k];
      let valueXml;
      if (v !== null && typeof v === "object") {
        valueXml = Object.entries(v)
          .map(([ik, iv]) => xmlNode(ik, iv))
          .join("");
      } else if (typeof v === "boolean") {
        valueXml = v ? "true" : "false";
      } else {
        valueXml = xmlEscape(v === undefined || v === null ? "" : v);
      }
      return `<entry><key>${xmlEscape(k)}</key><value>${valueXml}</value></entry>`;
    })
    .join("");
  return `<${tag}>${entries}</${tag}>`;
}

// ---------------------------------------------------------------------------
// AWS query form-encoded request parser
// ---------------------------------------------------------------------------

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

// Recursively convert objects whose keys are member/entry/numeric into the
// shapes SES uses (arrays + key/value maps).
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
  for (const k of keys) out[k] = normalizeNode(node[k]);
  return out;
}

function entriesToMap(list) {
  const map = {};
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const k = item.key !== undefined ? item.key : item.Key !== undefined ? item.Key : item.Name;
    const v =
      item.value !== undefined ? item.value : item.Value !== undefined ? item.Value : undefined;
    if (k === undefined) return null;
    map[k] = v === undefined ? "" : v;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class SesServer {
  constructor(port = 4570, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // identities: Map<identity, { type:"EmailAddress"|"Domain", verificationStatus,
    //   verificationToken, dkimEnabled, dkimTokens[], dkimVerificationStatus,
    //   mailFromDomain, mailFromBehaviorOnMxFailure, mailFromStatus,
    //   forwardingEnabled, notificationTopics:{Bounce,Complaint,Delivery},
    //   headersInNotifications:{Bounce,Complaint,Delivery}, policies:Map }>
    this.identities = new Map();
    // configuration sets: Map<name, { name, eventDestinations:Map, trackingOptions,
    //   deliveryOptions, reputationMetricsEnabled, sendingEnabled }>
    this.configurationSets = new Map();
    // templates: Map<name, { TemplateName, SubjectPart, TextPart, HtmlPart }>
    this.templates = new Map();
    // custom verification email templates: Map<name, {...}>
    this.customVerificationTemplates = new Map();
    // receipt rule sets: Map<name, { name, rules:[] }>
    this.receiptRuleSets = new Map();
    this.activeReceiptRuleSet = null;
    // receipt filters: Map<name, { Name, IpFilter:{Policy, Cidr} }>
    this.receiptFilters = new Map();
    // account-level
    this.accountSendingEnabled = true;
    // sent messages (for assertions)
    this.sentEmails = [];
    // send statistics datapoints
    this.sendDataPoints = [];
    this.sentLast24Hours = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new SesError("InternalError", error.message, 500));
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
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "ses",
        identities: this.identities.size,
        templates: this.templates.size,
        configurationSets: this.configurationSets.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/_parlel/sent") {
      return this.sendJson(res, 200, { sent: this.sentEmails });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-ses");

    if (method !== "POST") {
      return this.sendError(
        res,
        new SesError("InvalidParameterValue", "Only POST is supported by the parlel ses fake.", 405),
      );
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(
        res,
        new SesError("InvalidParameterValue", "Request body could not be parsed.", 400),
      );
    }

    const operation = input.Action;
    try {
      const { result, resultTag } = this.dispatch(operation, input);
      return this.sendXml(res, 200, operation, resultTag, result);
    } catch (error) {
      if (error instanceof SesError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      // Identities / verification
      VerifyEmailAddress: () => this.verifyEmailAddress(input),
      VerifyEmailIdentity: () => this.verifyEmailIdentity(input),
      VerifyDomainIdentity: () => this.verifyDomainIdentity(input),
      VerifyDomainDkim: () => this.verifyDomainDkim(input),
      DeleteIdentity: () => this.deleteIdentity(input),
      DeleteVerifiedEmailAddress: () => this.deleteVerifiedEmailAddress(input),
      ListIdentities: () => this.listIdentities(input),
      ListVerifiedEmailAddresses: () => this.listVerifiedEmailAddresses(input),
      GetIdentityVerificationAttributes: () => this.getIdentityVerificationAttributes(input),
      GetIdentityDkimAttributes: () => this.getIdentityDkimAttributes(input),
      SetIdentityDkimEnabled: () => this.setIdentityDkimEnabled(input),
      GetIdentityMailFromDomainAttributes: () => this.getIdentityMailFromDomainAttributes(input),
      SetIdentityMailFromDomain: () => this.setIdentityMailFromDomain(input),
      GetIdentityNotificationAttributes: () => this.getIdentityNotificationAttributes(input),
      SetIdentityNotificationTopic: () => this.setIdentityNotificationTopic(input),
      SetIdentityFeedbackForwardingEnabled: () => this.setIdentityFeedbackForwardingEnabled(input),
      SetIdentityHeadersInNotificationsEnabled: () =>
        this.setIdentityHeadersInNotificationsEnabled(input),
      // Identity policies
      PutIdentityPolicy: () => this.putIdentityPolicy(input),
      GetIdentityPolicies: () => this.getIdentityPolicies(input),
      ListIdentityPolicies: () => this.listIdentityPolicies(input),
      DeleteIdentityPolicy: () => this.deleteIdentityPolicy(input),
      // Sending
      SendEmail: () => this.sendEmail(input),
      SendRawEmail: () => this.sendRawEmail(input),
      SendTemplatedEmail: () => this.sendTemplatedEmail(input),
      SendBulkTemplatedEmail: () => this.sendBulkTemplatedEmail(input),
      SendCustomVerificationEmail: () => this.sendCustomVerificationEmail(input),
      SendBounce: () => this.sendBounce(input),
      // Account / stats
      GetSendQuota: () => this.getSendQuota(input),
      GetSendStatistics: () => this.getSendStatistics(input),
      GetAccountSendingEnabled: () => this.getAccountSendingEnabled(input),
      UpdateAccountSendingEnabled: () => this.updateAccountSendingEnabled(input),
      // Templates
      CreateTemplate: () => this.createTemplate(input),
      GetTemplate: () => this.getTemplate(input),
      UpdateTemplate: () => this.updateTemplate(input),
      DeleteTemplate: () => this.deleteTemplate(input),
      ListTemplates: () => this.listTemplates(input),
      TestRenderTemplate: () => this.testRenderTemplate(input),
      // Custom verification email templates
      CreateCustomVerificationEmailTemplate: () =>
        this.createCustomVerificationEmailTemplate(input),
      GetCustomVerificationEmailTemplate: () => this.getCustomVerificationEmailTemplate(input),
      UpdateCustomVerificationEmailTemplate: () =>
        this.updateCustomVerificationEmailTemplate(input),
      DeleteCustomVerificationEmailTemplate: () =>
        this.deleteCustomVerificationEmailTemplate(input),
      ListCustomVerificationEmailTemplates: () =>
        this.listCustomVerificationEmailTemplates(input),
      // Configuration sets
      CreateConfigurationSet: () => this.createConfigurationSet(input),
      DescribeConfigurationSet: () => this.describeConfigurationSet(input),
      DeleteConfigurationSet: () => this.deleteConfigurationSet(input),
      ListConfigurationSets: () => this.listConfigurationSets(input),
      PutConfigurationSetDeliveryOptions: () => this.putConfigurationSetDeliveryOptions(input),
      UpdateConfigurationSetReputationMetricsEnabled: () =>
        this.updateConfigurationSetReputationMetricsEnabled(input),
      UpdateConfigurationSetSendingEnabled: () =>
        this.updateConfigurationSetSendingEnabled(input),
      // Configuration set event destinations
      CreateConfigurationSetEventDestination: () =>
        this.createConfigurationSetEventDestination(input),
      UpdateConfigurationSetEventDestination: () =>
        this.updateConfigurationSetEventDestination(input),
      DeleteConfigurationSetEventDestination: () =>
        this.deleteConfigurationSetEventDestination(input),
      // Configuration set tracking options
      CreateConfigurationSetTrackingOptions: () =>
        this.createConfigurationSetTrackingOptions(input),
      UpdateConfigurationSetTrackingOptions: () =>
        this.updateConfigurationSetTrackingOptions(input),
      DeleteConfigurationSetTrackingOptions: () =>
        this.deleteConfigurationSetTrackingOptions(input),
      // Receipt rule sets
      CreateReceiptRuleSet: () => this.createReceiptRuleSet(input),
      DeleteReceiptRuleSet: () => this.deleteReceiptRuleSet(input),
      DescribeReceiptRuleSet: () => this.describeReceiptRuleSet(input),
      ListReceiptRuleSets: () => this.listReceiptRuleSets(input),
      CloneReceiptRuleSet: () => this.cloneReceiptRuleSet(input),
      DescribeActiveReceiptRuleSet: () => this.describeActiveReceiptRuleSet(input),
      SetActiveReceiptRuleSet: () => this.setActiveReceiptRuleSet(input),
      ReorderReceiptRuleSet: () => this.reorderReceiptRuleSet(input),
      // Receipt rules
      CreateReceiptRule: () => this.createReceiptRule(input),
      UpdateReceiptRule: () => this.updateReceiptRule(input),
      DeleteReceiptRule: () => this.deleteReceiptRule(input),
      DescribeReceiptRule: () => this.describeReceiptRule(input),
      SetReceiptRulePosition: () => this.setReceiptRulePosition(input),
      // Receipt filters
      CreateReceiptFilter: () => this.createReceiptFilter(input),
      DeleteReceiptFilter: () => this.deleteReceiptFilter(input),
      ListReceiptFilters: () => this.listReceiptFilters(input),
    };
    const handler = handlers[operation];
    if (!handler) {
      throw new SesError(
        "InvalidAction",
        `The action ${operation || "(none)"} is not valid for this endpoint.`,
        400,
      );
    }
    return handler();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  isEmail(s) {
    return typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
  }

  identityFromAddress(address) {
    // For "Name <user@example.com>" or "user@example.com" extract the address.
    const m = String(address).match(/<([^>]+)>/);
    return m ? m[1] : String(address).trim();
  }

  dkimTokensFor(domain) {
    // Deterministic fake DKIM tokens derived from the domain.
    const base = createHash("sha256").update(domain).digest("hex");
    return [0, 1, 2].map((i) => base.slice(i * 8, i * 8 + 32).padEnd(32, "0"));
  }

  verificationTokenFor(identity) {
    return createHash("sha1").update(`token:${identity}`).digest("base64").replace(/=/g, "");
  }

  ensureIdentity(identity, type) {
    let rec = this.identities.get(identity);
    if (!rec) {
      rec = {
        identity,
        type,
        verificationStatus: "Pending",
        verificationToken: this.verificationTokenFor(identity),
        dkimEnabled: type === "Domain",
        dkimTokens: type === "Domain" ? this.dkimTokensFor(identity) : [],
        dkimVerificationStatus: type === "Domain" ? "Pending" : "NotStarted",
        mailFromDomain: undefined,
        mailFromBehaviorOnMxFailure: "UseDefaultValue",
        mailFromStatus: undefined,
        forwardingEnabled: true,
        notificationTopics: {},
        headersInNotifications: {},
        policies: new Map(),
      };
      this.identities.set(identity, rec);
    }
    return rec;
  }

  requireIdentity(identity) {
    const rec = this.identities.get(identity);
    if (!rec) {
      throw new SesError(
        "InvalidParameterValue",
        `Identity ${identity} does not exist.`,
        400,
      );
    }
    return rec;
  }

  // -------------------------------------------------------------------------
  // Identities / verification
  // -------------------------------------------------------------------------
  verifyEmailAddress(input) {
    const addr = input.EmailAddress;
    if (!this.isEmail(addr)) {
      throw new SesError("InvalidParameterValue", `Invalid email address<${addr}>.`);
    }
    const rec = this.ensureIdentity(addr, "EmailAddress");
    rec.verificationStatus = "Success"; // auto-verify in the fake
    return { result: {}, resultTag: "VerifyEmailAddressResult" };
  }

  verifyEmailIdentity(input) {
    const addr = input.EmailAddress;
    if (!this.isEmail(addr)) {
      throw new SesError("InvalidParameterValue", `Invalid email address<${addr}>.`);
    }
    const rec = this.ensureIdentity(addr, "EmailAddress");
    rec.verificationStatus = "Success";
    return { result: {}, resultTag: "VerifyEmailIdentityResult" };
  }

  verifyDomainIdentity(input) {
    const domain = input.Domain;
    if (!domain) {
      throw new SesError("InvalidParameterValue", "Domain is required.");
    }
    const rec = this.ensureIdentity(domain, "Domain");
    rec.verificationStatus = "Success";
    return {
      result: { VerificationToken: rec.verificationToken },
      resultTag: "VerifyDomainIdentityResult",
    };
  }

  verifyDomainDkim(input) {
    const domain = input.Domain;
    if (!domain) {
      throw new SesError("InvalidParameterValue", "Domain is required.");
    }
    const rec = this.ensureIdentity(domain, "Domain");
    rec.dkimEnabled = true;
    rec.dkimTokens = this.dkimTokensFor(domain);
    rec.dkimVerificationStatus = "Success";
    return {
      result: { DkimTokens: rec.dkimTokens },
      resultTag: "VerifyDomainDkimResult",
    };
  }

  deleteIdentity(input) {
    const identity = input.Identity;
    if (!identity) {
      throw new SesError("InvalidParameterValue", "Identity is required.");
    }
    this.identities.delete(identity);
    return { result: {}, resultTag: "DeleteIdentityResult" };
  }

  deleteVerifiedEmailAddress(input) {
    const addr = input.EmailAddress;
    this.identities.delete(addr);
    return { result: {}, resultTag: "DeleteVerifiedEmailAddressResult" };
  }

  listIdentities(input) {
    const type = input.IdentityType;
    let all = [...this.identities.values()];
    if (type === "EmailAddress") all = all.filter((r) => r.type === "EmailAddress");
    else if (type === "Domain") all = all.filter((r) => r.type === "Domain");
    all = all.map((r) => r.identity).sort();
    const maxItems = input.MaxItems ? parseInt(input.MaxItems, 10) : 100;
    const { page, nextToken } = this.paginate(all, input.NextToken, maxItems);
    const result = { Identities: page };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListIdentitiesResult" };
  }

  listVerifiedEmailAddresses() {
    const addrs = [...this.identities.values()]
      .filter((r) => r.type === "EmailAddress" && r.verificationStatus === "Success")
      .map((r) => r.identity)
      .sort();
    return {
      result: { VerifiedEmailAddresses: addrs },
      resultTag: "ListVerifiedEmailAddressesResult",
    };
  }

  getIdentityVerificationAttributes(input) {
    const identities = this.asList(input.Identities);
    const map = {};
    for (const id of identities) {
      const rec = this.identities.get(id);
      if (rec) {
        map[id] = {
          VerificationStatus: rec.verificationStatus,
        };
        if (rec.type === "Domain") {
          map[id].VerificationToken = rec.verificationToken;
        }
      }
    }
    return {
      result: { VerificationAttributes: new XmlMap(map) },
      resultTag: "GetIdentityVerificationAttributesResult",
    };
  }

  getIdentityDkimAttributes(input) {
    const identities = this.asList(input.Identities);
    const map = {};
    for (const id of identities) {
      const rec = this.identities.get(id);
      if (rec) {
        map[id] = {
          DkimEnabled: rec.dkimEnabled,
          DkimVerificationStatus: rec.dkimVerificationStatus,
        };
        if (rec.dkimTokens && rec.dkimTokens.length) {
          map[id].DkimTokens = rec.dkimTokens;
        }
      }
    }
    return {
      result: { DkimAttributes: new XmlMap(map) },
      resultTag: "GetIdentityDkimAttributesResult",
    };
  }

  setIdentityDkimEnabled(input) {
    const rec = this.requireIdentity(input.Identity);
    rec.dkimEnabled = input.DkimEnabled === "true" || input.DkimEnabled === true;
    return { result: {}, resultTag: "SetIdentityDkimEnabledResult" };
  }

  getIdentityMailFromDomainAttributes(input) {
    const identities = this.asList(input.Identities);
    const map = {};
    for (const id of identities) {
      const rec = this.identities.get(id);
      if (rec) {
        const attrs = {
          BehaviorOnMXFailure: rec.mailFromBehaviorOnMxFailure || "UseDefaultValue",
        };
        if (rec.mailFromDomain) {
          attrs.MailFromDomain = rec.mailFromDomain;
          attrs.MailFromDomainStatus = rec.mailFromStatus || "Success";
        }
        map[id] = attrs;
      }
    }
    return {
      result: { MailFromDomainAttributes: new XmlMap(map) },
      resultTag: "GetIdentityMailFromDomainAttributesResult",
    };
  }

  setIdentityMailFromDomain(input) {
    const rec = this.requireIdentity(input.Identity);
    rec.mailFromDomain = input.MailFromDomain || undefined;
    rec.mailFromBehaviorOnMxFailure = input.BehaviorOnMXFailure || "UseDefaultValue";
    rec.mailFromStatus = rec.mailFromDomain ? "Success" : undefined;
    return { result: {}, resultTag: "SetIdentityMailFromDomainResult" };
  }

  getIdentityNotificationAttributes(input) {
    const identities = this.asList(input.Identities);
    const map = {};
    for (const id of identities) {
      const rec = this.identities.get(id);
      if (rec) {
        map[id] = {
          BounceTopic: rec.notificationTopics.Bounce || "",
          ComplaintTopic: rec.notificationTopics.Complaint || "",
          DeliveryTopic: rec.notificationTopics.Delivery || "",
          ForwardingEnabled: rec.forwardingEnabled,
          HeadersInBounceNotificationsEnabled: !!rec.headersInNotifications.Bounce,
          HeadersInComplaintNotificationsEnabled: !!rec.headersInNotifications.Complaint,
          HeadersInDeliveryNotificationsEnabled: !!rec.headersInNotifications.Delivery,
        };
      }
    }
    return {
      result: { NotificationAttributes: new XmlMap(map) },
      resultTag: "GetIdentityNotificationAttributesResult",
    };
  }

  setIdentityNotificationTopic(input) {
    const rec = this.requireIdentity(input.Identity);
    const type = input.NotificationType;
    if (!["Bounce", "Complaint", "Delivery"].includes(type)) {
      throw new SesError("InvalidParameterValue", `Invalid notification type: ${type}`);
    }
    if (input.SnsTopic) rec.notificationTopics[type] = input.SnsTopic;
    else delete rec.notificationTopics[type];
    return { result: {}, resultTag: "SetIdentityNotificationTopicResult" };
  }

  setIdentityFeedbackForwardingEnabled(input) {
    const rec = this.requireIdentity(input.Identity);
    rec.forwardingEnabled =
      input.ForwardingEnabled === "true" || input.ForwardingEnabled === true;
    return { result: {}, resultTag: "SetIdentityFeedbackForwardingEnabledResult" };
  }

  setIdentityHeadersInNotificationsEnabled(input) {
    const rec = this.requireIdentity(input.Identity);
    const type = input.NotificationType;
    if (!["Bounce", "Complaint", "Delivery"].includes(type)) {
      throw new SesError("InvalidParameterValue", `Invalid notification type: ${type}`);
    }
    rec.headersInNotifications[type] = input.Enabled === "true" || input.Enabled === true;
    return { result: {}, resultTag: "SetIdentityHeadersInNotificationsEnabledResult" };
  }

  // -------------------------------------------------------------------------
  // Identity policies
  // -------------------------------------------------------------------------
  putIdentityPolicy(input) {
    const rec = this.requireIdentity(input.Identity);
    if (!input.PolicyName) {
      throw new SesError("InvalidParameterValue", "PolicyName is required.");
    }
    if (!input.Policy) {
      throw new SesError("InvalidParameterValue", "Policy is required.");
    }
    rec.policies.set(input.PolicyName, input.Policy);
    return { result: {}, resultTag: "PutIdentityPolicyResult" };
  }

  getIdentityPolicies(input) {
    const rec = this.requireIdentity(input.Identity);
    const names = this.asList(input.PolicyNames);
    const map = {};
    for (const name of names) {
      if (rec.policies.has(name)) map[name] = rec.policies.get(name);
    }
    return {
      result: { Policies: new XmlMap(map) },
      resultTag: "GetIdentityPoliciesResult",
    };
  }

  listIdentityPolicies(input) {
    const rec = this.requireIdentity(input.Identity);
    return {
      result: { PolicyNames: [...rec.policies.keys()].sort() },
      resultTag: "ListIdentityPoliciesResult",
    };
  }

  deleteIdentityPolicy(input) {
    const rec = this.requireIdentity(input.Identity);
    rec.policies.delete(input.PolicyName);
    return { result: {}, resultTag: "DeleteIdentityPolicyResult" };
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------
  requireSendingEnabled() {
    if (!this.accountSendingEnabled) {
      throw new SesError(
        "AccountSendingPausedException",
        "Email sending is disabled for your entire account.",
      );
    }
  }

  verifiedSource(source) {
    const identity = this.identityFromAddress(source);
    const domain = identity.includes("@") ? identity.split("@")[1] : identity;
    const emailRec = this.identities.get(identity);
    const domainRec = this.identities.get(domain);
    const emailOk = emailRec && emailRec.verificationStatus === "Success";
    const domainOk = domainRec && domainRec.verificationStatus === "Success";
    return emailOk || domainOk;
  }

  recordSend(record) {
    this.sentEmails.push({ ...record, timestamp: Date.now() });
    this.sentLast24Hours += 1;
  }

  collectAddresses(dest) {
    if (!dest) return [];
    const out = [];
    for (const field of ["ToAddresses", "CcAddresses", "BccAddresses"]) {
      const list = this.asList(dest[field]);
      for (const a of list) out.push(a);
    }
    return out;
  }

  sendEmail(input) {
    this.requireSendingEnabled();
    const source = input.Source;
    if (!source) {
      throw new SesError("InvalidParameterValue", "Source is required.");
    }
    if (!this.verifiedSource(source)) {
      throw new SesError(
        "MessageRejected",
        `Email address is not verified. The following identities failed the check in region ${this.region.toUpperCase()}: ${this.identityFromAddress(source)}`,
      );
    }
    const dest = input.Destination || {};
    const recipients = this.collectAddresses(dest);
    if (recipients.length === 0) {
      throw new SesError("InvalidParameterValue", "Destination must contain at least one recipient.");
    }
    const message = input.Message;
    if (!message || !message.Subject || !message.Body) {
      throw new SesError("InvalidParameterValue", "Message Subject and Body are required.");
    }
    const messageId = this.makeMessageId();
    this.recordSend({
      type: "SendEmail",
      messageId,
      source,
      destination: recipients,
      subject: message.Subject?.Data,
      body: message.Body,
      configurationSet: input.ConfigurationSetName,
    });
    return { result: { MessageId: messageId }, resultTag: "SendEmailResult" };
  }

  sendRawEmail(input) {
    this.requireSendingEnabled();
    const raw = input.RawMessage;
    if (!raw || !raw.Data) {
      throw new SesError("InvalidParameterValue", "RawMessage.Data is required.");
    }
    let source = input.Source;
    let decoded = "";
    try {
      decoded = Buffer.from(String(raw.Data), "base64").toString("utf8");
    } catch {
      decoded = String(raw.Data);
    }
    if (!source) {
      const m = decoded.match(/^From:\s*(.+)$/im);
      if (m) source = m[1].trim();
    }
    if (source && !this.verifiedSource(source)) {
      throw new SesError(
        "MessageRejected",
        `Email address is not verified. The following identities failed the check in region ${this.region.toUpperCase()}: ${this.identityFromAddress(source)}`,
      );
    }
    const messageId = this.makeMessageId();
    this.recordSend({
      type: "SendRawEmail",
      messageId,
      source,
      destination: this.asList(input.Destinations),
      raw: decoded,
      configurationSet: input.ConfigurationSetName,
    });
    return { result: { MessageId: messageId }, resultTag: "SendRawEmailResult" };
  }

  sendTemplatedEmail(input) {
    this.requireSendingEnabled();
    const source = input.Source;
    if (!source) {
      throw new SesError("InvalidParameterValue", "Source is required.");
    }
    if (!this.verifiedSource(source)) {
      throw new SesError(
        "MessageRejected",
        `Email address is not verified. The following identities failed the check in region ${this.region.toUpperCase()}: ${this.identityFromAddress(source)}`,
      );
    }
    const templateName = input.Template;
    if (!templateName) {
      throw new SesError("InvalidParameterValue", "Template is required.");
    }
    if (!this.templates.has(templateName)) {
      throw new SesError(
        "TemplateDoesNotExistException",
        `Template (${templateName}) does not exist`,
      );
    }
    let templateData = input.TemplateData;
    if (templateData !== undefined) {
      try {
        JSON.parse(templateData);
      } catch {
        throw new SesError(
          "InvalidParameterValue",
          "TemplateData must be valid JSON.",
        );
      }
    }
    const recipients = this.collectAddresses(input.Destination || {});
    if (recipients.length === 0) {
      throw new SesError("InvalidParameterValue", "Destination must contain at least one recipient.");
    }
    const messageId = this.makeMessageId();
    this.recordSend({
      type: "SendTemplatedEmail",
      messageId,
      source,
      destination: recipients,
      template: templateName,
      templateData,
      configurationSet: input.ConfigurationSetName,
    });
    return { result: { MessageId: messageId }, resultTag: "SendTemplatedEmailResult" };
  }

  sendBulkTemplatedEmail(input) {
    this.requireSendingEnabled();
    const source = input.Source;
    if (!source) {
      throw new SesError("InvalidParameterValue", "Source is required.");
    }
    if (!this.verifiedSource(source)) {
      throw new SesError(
        "MessageRejected",
        `Email address is not verified. The following identities failed the check in region ${this.region.toUpperCase()}: ${this.identityFromAddress(source)}`,
      );
    }
    const templateName = input.Template;
    if (!templateName) {
      throw new SesError("InvalidParameterValue", "Template is required.");
    }
    if (!this.templates.has(templateName)) {
      throw new SesError(
        "TemplateDoesNotExistException",
        `Template (${templateName}) does not exist`,
      );
    }
    let destinations = this.asList(input.Destinations);
    const status = destinations.map((d) => {
      const messageId = this.makeMessageId();
      this.recordSend({
        type: "SendBulkTemplatedEmail",
        messageId,
        source,
        destination: this.collectAddresses(d.Destination || {}),
        template: templateName,
        replacementTemplateData: d.ReplacementTemplateData,
        configurationSet: input.ConfigurationSetName,
      });
      return { Status: "Success", MessageId: messageId };
    });
    if (status.length === 0) {
      // Still valid; SES returns an empty Status list.
    }
    return {
      result: { Status: status },
      resultTag: "SendBulkTemplatedEmailResult",
    };
  }

  sendCustomVerificationEmail(input) {
    this.requireSendingEnabled();
    const addr = input.EmailAddress;
    if (!this.isEmail(addr)) {
      throw new SesError("InvalidParameterValue", `Invalid email address<${addr}>.`);
    }
    const templateName = input.TemplateName;
    if (!this.customVerificationTemplates.has(templateName)) {
      throw new SesError(
        "CustomVerificationEmailTemplateDoesNotExistException",
        `Custom verification email template (${templateName}) does not exist`,
      );
    }
    // Create the identity in a Pending state, awaiting click-through verification.
    this.ensureIdentity(addr, "EmailAddress");
    const messageId = this.makeMessageId();
    this.recordSend({
      type: "SendCustomVerificationEmail",
      messageId,
      destination: [addr],
      template: templateName,
      configurationSet: input.ConfigurationSetName,
    });
    return {
      result: { MessageId: messageId },
      resultTag: "SendCustomVerificationEmailResult",
    };
  }

  sendBounce(input) {
    if (!input.OriginalMessageId) {
      throw new SesError("InvalidParameterValue", "OriginalMessageId is required.");
    }
    if (!input.BounceSender) {
      throw new SesError("InvalidParameterValue", "BounceSender is required.");
    }
    const messageId = this.makeMessageId();
    return { result: { MessageId: messageId }, resultTag: "SendBounceResult" };
  }

  makeMessageId() {
    const hex = randomUUID().replace(/-/g, "");
    return `0100${hex.slice(0, 12)}-${hex.slice(12, 20)}-0000-${hex.slice(20, 24)}-000000000000`;
  }

  // -------------------------------------------------------------------------
  // Account / stats
  // -------------------------------------------------------------------------
  getSendQuota() {
    return {
      result: {
        Max24HourSend: 200,
        MaxSendRate: 1,
        SentLast24Hours: this.sentLast24Hours,
      },
      resultTag: "GetSendQuotaResult",
    };
  }

  getSendStatistics() {
    const datapoints =
      this.sendDataPoints.length > 0
        ? this.sendDataPoints
        : [
            {
              Timestamp: new Date().toISOString(),
              DeliveryAttempts: this.sentEmails.length,
              Bounces: 0,
              Complaints: 0,
              Rejects: 0,
            },
          ];
    return {
      result: { SendDataPoints: datapoints },
      resultTag: "GetSendStatisticsResult",
    };
  }

  getAccountSendingEnabled() {
    return {
      result: { Enabled: this.accountSendingEnabled },
      resultTag: "GetAccountSendingEnabledResult",
    };
  }

  updateAccountSendingEnabled(input) {
    this.accountSendingEnabled = input.Enabled === "true" || input.Enabled === true;
    return { result: {}, resultTag: "UpdateAccountSendingEnabledResult" };
  }

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------
  validateTemplate(tpl) {
    if (!tpl || !tpl.TemplateName) {
      throw new SesError("InvalidParameterValue", "TemplateName is required.");
    }
    if (
      tpl.SubjectPart === undefined &&
      tpl.TextPart === undefined &&
      tpl.HtmlPart === undefined
    ) {
      throw new SesError(
        "InvalidParameterValue",
        "The template must contain a subject, a text part, or an HTML part.",
      );
    }
  }

  createTemplate(input) {
    const tpl = input.Template;
    this.validateTemplate(tpl);
    if (this.templates.has(tpl.TemplateName)) {
      throw new SesError(
        "AlreadyExistsException",
        `Template ${tpl.TemplateName} already exists.`,
      );
    }
    this.templates.set(tpl.TemplateName, {
      TemplateName: tpl.TemplateName,
      SubjectPart: tpl.SubjectPart,
      TextPart: tpl.TextPart,
      HtmlPart: tpl.HtmlPart,
    });
    return { result: {}, resultTag: "CreateTemplateResult" };
  }

  getTemplate(input) {
    const name = input.TemplateName;
    const tpl = this.templates.get(name);
    if (!tpl) {
      throw new SesError(
        "TemplateDoesNotExistException",
        `Template (${name}) does not exist`,
      );
    }
    const Template = { TemplateName: tpl.TemplateName };
    if (tpl.SubjectPart !== undefined) Template.SubjectPart = tpl.SubjectPart;
    if (tpl.TextPart !== undefined) Template.TextPart = tpl.TextPart;
    if (tpl.HtmlPart !== undefined) Template.HtmlPart = tpl.HtmlPart;
    return { result: { Template }, resultTag: "GetTemplateResult" };
  }

  updateTemplate(input) {
    const tpl = input.Template;
    this.validateTemplate(tpl);
    if (!this.templates.has(tpl.TemplateName)) {
      throw new SesError(
        "TemplateDoesNotExistException",
        `Template (${tpl.TemplateName}) does not exist`,
      );
    }
    this.templates.set(tpl.TemplateName, {
      TemplateName: tpl.TemplateName,
      SubjectPart: tpl.SubjectPart,
      TextPart: tpl.TextPart,
      HtmlPart: tpl.HtmlPart,
    });
    return { result: {}, resultTag: "UpdateTemplateResult" };
  }

  deleteTemplate(input) {
    // Idempotent.
    this.templates.delete(input.TemplateName);
    return { result: {}, resultTag: "DeleteTemplateResult" };
  }

  listTemplates(input) {
    const all = [...this.templates.values()]
      .map((t) => ({
        Name: t.TemplateName,
        CreatedTimestamp: new Date().toISOString(),
      }))
      .sort((a, b) => a.Name.localeCompare(b.Name));
    const maxItems = input.MaxItems ? parseInt(input.MaxItems, 10) : 10;
    const { page, nextToken } = this.paginate(all, input.NextToken, maxItems);
    const result = { TemplatesMetadata: page };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListTemplatesResult" };
  }

  renderTemplate(content, data) {
    if (content === undefined || content === null) return content;
    return String(content).replace(/\{\{(\w+)\}\}/g, (_, key) =>
      data[key] !== undefined ? String(data[key]) : "",
    );
  }

  testRenderTemplate(input) {
    const name = input.TemplateName;
    const tpl = this.templates.get(name);
    if (!tpl) {
      throw new SesError(
        "TemplateDoesNotExistException",
        `Template (${name}) does not exist`,
      );
    }
    let data = {};
    if (input.TemplateData) {
      try {
        data = JSON.parse(input.TemplateData);
      } catch {
        throw new SesError("InvalidParameterValue", "TemplateData must be valid JSON.");
      }
    }
    // Find placeholders missing from data.
    const placeholders = new Set();
    for (const part of [tpl.SubjectPart, tpl.TextPart, tpl.HtmlPart]) {
      if (!part) continue;
      let m;
      const re = /\{\{(\w+)\}\}/g;
      while ((m = re.exec(part))) placeholders.add(m[1]);
    }
    for (const p of placeholders) {
      if (data[p] === undefined) {
        throw new SesError(
          "MissingRenderingAttributeException",
          `Attribute '${p}' is not present in the rendering data.`,
        );
      }
    }
    const subject = this.renderTemplate(tpl.SubjectPart || "", data);
    const text = this.renderTemplate(tpl.TextPart, data);
    const html = this.renderTemplate(tpl.HtmlPart, data);
    const rendered =
      `Subject: ${subject}\r\n` +
      (html !== undefined ? `${html}` : text !== undefined ? `${text}` : "");
    return {
      result: { RenderedTemplate: rendered },
      resultTag: "TestRenderTemplateResult",
    };
  }

  // -------------------------------------------------------------------------
  // Custom verification email templates
  // -------------------------------------------------------------------------
  createCustomVerificationEmailTemplate(input) {
    const name = input.TemplateName;
    if (!name) {
      throw new SesError("InvalidParameterValue", "TemplateName is required.");
    }
    if (this.customVerificationTemplates.has(name)) {
      throw new SesError(
        "CustomVerificationEmailTemplateAlreadyExistsException",
        `Custom verification email template (${name}) already exists.`,
      );
    }
    for (const field of [
      "FromEmailAddress",
      "TemplateSubject",
      "TemplateContent",
      "SuccessRedirectionURL",
      "FailureRedirectionURL",
    ]) {
      if (!input[field]) {
        throw new SesError("InvalidParameterValue", `${field} is required.`);
      }
    }
    this.customVerificationTemplates.set(name, {
      TemplateName: name,
      FromEmailAddress: input.FromEmailAddress,
      TemplateSubject: input.TemplateSubject,
      TemplateContent: input.TemplateContent,
      SuccessRedirectionURL: input.SuccessRedirectionURL,
      FailureRedirectionURL: input.FailureRedirectionURL,
    });
    return {
      result: {},
      resultTag: "CreateCustomVerificationEmailTemplateResult",
    };
  }

  getCustomVerificationEmailTemplate(input) {
    const name = input.TemplateName;
    const tpl = this.customVerificationTemplates.get(name);
    if (!tpl) {
      throw new SesError(
        "CustomVerificationEmailTemplateDoesNotExistException",
        `Custom verification email template (${name}) does not exist`,
      );
    }
    return { result: { ...tpl }, resultTag: "GetCustomVerificationEmailTemplateResult" };
  }

  updateCustomVerificationEmailTemplate(input) {
    const name = input.TemplateName;
    const tpl = this.customVerificationTemplates.get(name);
    if (!tpl) {
      throw new SesError(
        "CustomVerificationEmailTemplateDoesNotExistException",
        `Custom verification email template (${name}) does not exist`,
      );
    }
    for (const field of [
      "FromEmailAddress",
      "TemplateSubject",
      "TemplateContent",
      "SuccessRedirectionURL",
      "FailureRedirectionURL",
    ]) {
      if (input[field] !== undefined) tpl[field] = input[field];
    }
    return {
      result: {},
      resultTag: "UpdateCustomVerificationEmailTemplateResult",
    };
  }

  deleteCustomVerificationEmailTemplate(input) {
    this.customVerificationTemplates.delete(input.TemplateName);
    return {
      result: {},
      resultTag: "DeleteCustomVerificationEmailTemplateResult",
    };
  }

  listCustomVerificationEmailTemplates(input) {
    const all = [...this.customVerificationTemplates.values()]
      .map((t) => ({
        TemplateName: t.TemplateName,
        FromEmailAddress: t.FromEmailAddress,
        TemplateSubject: t.TemplateSubject,
        SuccessRedirectionURL: t.SuccessRedirectionURL,
        FailureRedirectionURL: t.FailureRedirectionURL,
      }))
      .sort((a, b) => a.TemplateName.localeCompare(b.TemplateName));
    const maxResults = input.MaxResults ? parseInt(input.MaxResults, 10) : 50;
    const { page, nextToken } = this.paginate(all, input.NextToken, maxResults);
    const result = { CustomVerificationEmailTemplates: page };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListCustomVerificationEmailTemplatesResult" };
  }

  // -------------------------------------------------------------------------
  // Configuration sets
  // -------------------------------------------------------------------------
  requireConfigSet(name) {
    const cs = this.configurationSets.get(name);
    if (!cs) {
      throw new SesError(
        "ConfigurationSetDoesNotExistException",
        `Configuration set <${name}> does not exist.`,
      );
    }
    return cs;
  }

  createConfigurationSet(input) {
    const cs = input.ConfigurationSet;
    if (!cs || !cs.Name) {
      throw new SesError("InvalidParameterValue", "ConfigurationSet.Name is required.");
    }
    if (this.configurationSets.has(cs.Name)) {
      throw new SesError(
        "ConfigurationSetAlreadyExistsException",
        `Configuration set <${cs.Name}> already exists.`,
      );
    }
    this.configurationSets.set(cs.Name, {
      name: cs.Name,
      eventDestinations: new Map(),
      trackingOptions: null,
      deliveryOptions: null,
      reputationMetricsEnabled: false,
      sendingEnabled: true,
    });
    return { result: {}, resultTag: "CreateConfigurationSetResult" };
  }

  describeConfigurationSet(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    const result = {
      ConfigurationSet: { Name: cs.name },
    };
    const attrs = this.asList(input.ConfigurationSetAttributeNames);
    if (attrs.includes("eventDestinations") && cs.eventDestinations.size > 0) {
      result.EventDestinations = [...cs.eventDestinations.values()].map((e) =>
        this.eventDestinationView(e),
      );
    }
    if (attrs.includes("trackingOptions") && cs.trackingOptions) {
      result.TrackingOptions = cs.trackingOptions;
    }
    if (attrs.includes("deliveryOptions") && cs.deliveryOptions) {
      result.DeliveryOptions = cs.deliveryOptions;
    }
    if (attrs.includes("reputationOptions")) {
      result.ReputationOptions = {
        SendingEnabled: cs.sendingEnabled,
        ReputationMetricsEnabled: cs.reputationMetricsEnabled,
      };
    }
    return { result, resultTag: "DescribeConfigurationSetResult" };
  }

  deleteConfigurationSet(input) {
    this.requireConfigSet(input.ConfigurationSetName);
    this.configurationSets.delete(input.ConfigurationSetName);
    return { result: {}, resultTag: "DeleteConfigurationSetResult" };
  }

  listConfigurationSets(input) {
    const all = [...this.configurationSets.values()]
      .map((cs) => ({ Name: cs.name }))
      .sort((a, b) => a.Name.localeCompare(b.Name));
    const maxItems = input.MaxItems ? parseInt(input.MaxItems, 10) : 100;
    const { page, nextToken } = this.paginate(all, input.NextToken, maxItems);
    const result = { ConfigurationSets: page };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListConfigurationSetsResult" };
  }

  putConfigurationSetDeliveryOptions(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    cs.deliveryOptions = input.DeliveryOptions || {};
    return { result: {}, resultTag: "PutConfigurationSetDeliveryOptionsResult" };
  }

  updateConfigurationSetReputationMetricsEnabled(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    cs.reputationMetricsEnabled = input.Enabled === "true" || input.Enabled === true;
    return {
      result: {},
      resultTag: "UpdateConfigurationSetReputationMetricsEnabledResult",
    };
  }

  updateConfigurationSetSendingEnabled(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    cs.sendingEnabled = input.Enabled === "true" || input.Enabled === true;
    return {
      result: {},
      resultTag: "UpdateConfigurationSetSendingEnabledResult",
    };
  }

  eventDestinationView(e) {
    const view = {
      Name: e.Name,
      Enabled: e.Enabled,
      MatchingEventTypes: e.MatchingEventTypes || [],
    };
    if (e.KinesisFirehoseDestination) view.KinesisFirehoseDestination = e.KinesisFirehoseDestination;
    if (e.CloudWatchDestination) view.CloudWatchDestination = e.CloudWatchDestination;
    if (e.SNSDestination) view.SNSDestination = e.SNSDestination;
    return view;
  }

  // -------------------------------------------------------------------------
  // Configuration set event destinations
  // -------------------------------------------------------------------------
  createConfigurationSetEventDestination(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    const dest = input.EventDestination;
    if (!dest || !dest.Name) {
      throw new SesError("InvalidParameterValue", "EventDestination.Name is required.");
    }
    if (cs.eventDestinations.has(dest.Name)) {
      throw new SesError(
        "EventDestinationAlreadyExistsException",
        `Event destination <${dest.Name}> already exists.`,
      );
    }
    cs.eventDestinations.set(dest.Name, {
      Name: dest.Name,
      Enabled: dest.Enabled === "true" || dest.Enabled === true,
      MatchingEventTypes: this.asList(dest.MatchingEventTypes),
      KinesisFirehoseDestination: dest.KinesisFirehoseDestination,
      CloudWatchDestination: dest.CloudWatchDestination,
      SNSDestination: dest.SNSDestination,
    });
    return {
      result: {},
      resultTag: "CreateConfigurationSetEventDestinationResult",
    };
  }

  updateConfigurationSetEventDestination(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    const dest = input.EventDestination;
    if (!dest || !dest.Name || !cs.eventDestinations.has(dest.Name)) {
      throw new SesError(
        "EventDestinationDoesNotExistException",
        `Event destination does not exist.`,
      );
    }
    cs.eventDestinations.set(dest.Name, {
      Name: dest.Name,
      Enabled: dest.Enabled === "true" || dest.Enabled === true,
      MatchingEventTypes: this.asList(dest.MatchingEventTypes),
      KinesisFirehoseDestination: dest.KinesisFirehoseDestination,
      CloudWatchDestination: dest.CloudWatchDestination,
      SNSDestination: dest.SNSDestination,
    });
    return {
      result: {},
      resultTag: "UpdateConfigurationSetEventDestinationResult",
    };
  }

  deleteConfigurationSetEventDestination(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    cs.eventDestinations.delete(input.EventDestinationName);
    return {
      result: {},
      resultTag: "DeleteConfigurationSetEventDestinationResult",
    };
  }

  // -------------------------------------------------------------------------
  // Configuration set tracking options
  // -------------------------------------------------------------------------
  createConfigurationSetTrackingOptions(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    if (cs.trackingOptions) {
      throw new SesError(
        "TrackingOptionsAlreadyExistsException",
        "Tracking options already exist for this configuration set.",
      );
    }
    cs.trackingOptions = input.TrackingOptions || {};
    return {
      result: {},
      resultTag: "CreateConfigurationSetTrackingOptionsResult",
    };
  }

  updateConfigurationSetTrackingOptions(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    if (!cs.trackingOptions) {
      throw new SesError(
        "TrackingOptionsDoesNotExistException",
        "Tracking options do not exist for this configuration set.",
      );
    }
    cs.trackingOptions = input.TrackingOptions || {};
    return {
      result: {},
      resultTag: "UpdateConfigurationSetTrackingOptionsResult",
    };
  }

  deleteConfigurationSetTrackingOptions(input) {
    const cs = this.requireConfigSet(input.ConfigurationSetName);
    cs.trackingOptions = null;
    return {
      result: {},
      resultTag: "DeleteConfigurationSetTrackingOptionsResult",
    };
  }

  // -------------------------------------------------------------------------
  // Receipt rule sets
  // -------------------------------------------------------------------------
  createReceiptRuleSet(input) {
    const name = input.RuleSetName;
    if (!name) {
      throw new SesError("InvalidParameterValue", "RuleSetName is required.");
    }
    if (this.receiptRuleSets.has(name)) {
      throw new SesError(
        "AlreadyExistsException",
        `Rule set <${name}> already exists.`,
      );
    }
    this.receiptRuleSets.set(name, { name, rules: [] });
    return { result: {}, resultTag: "CreateReceiptRuleSetResult" };
  }

  deleteReceiptRuleSet(input) {
    const name = input.RuleSetName;
    if (this.activeReceiptRuleSet === name) {
      throw new SesError(
        "CannotDeleteException",
        "Cannot delete an active receipt rule set.",
      );
    }
    this.receiptRuleSets.delete(name);
    return { result: {}, resultTag: "DeleteReceiptRuleSetResult" };
  }

  requireRuleSet(name) {
    const rs = this.receiptRuleSets.get(name);
    if (!rs) {
      throw new SesError(
        "RuleSetDoesNotExistException",
        `Rule set <${name}> does not exist.`,
      );
    }
    return rs;
  }

  describeReceiptRuleSet(input) {
    const rs = this.requireRuleSet(input.RuleSetName);
    return {
      result: {
        Metadata: { Name: rs.name, CreatedTimestamp: new Date().toISOString() },
        Rules: rs.rules,
      },
      resultTag: "DescribeReceiptRuleSetResult",
    };
  }

  listReceiptRuleSets(input) {
    const all = [...this.receiptRuleSets.values()]
      .map((rs) => ({ Name: rs.name, CreatedTimestamp: new Date().toISOString() }))
      .sort((a, b) => a.Name.localeCompare(b.Name));
    const { page, nextToken } = this.paginate(all, input.NextToken, 100);
    const result = { RuleSets: page };
    if (nextToken) result.NextToken = nextToken;
    return { result, resultTag: "ListReceiptRuleSetsResult" };
  }

  cloneReceiptRuleSet(input) {
    const original = this.requireRuleSet(input.OriginalRuleSetName);
    const name = input.RuleSetName;
    if (!name) {
      throw new SesError("InvalidParameterValue", "RuleSetName is required.");
    }
    if (this.receiptRuleSets.has(name)) {
      throw new SesError(
        "AlreadyExistsException",
        `Rule set <${name}> already exists.`,
      );
    }
    this.receiptRuleSets.set(name, {
      name,
      rules: JSON.parse(JSON.stringify(original.rules)),
    });
    return { result: {}, resultTag: "CloneReceiptRuleSetResult" };
  }

  describeActiveReceiptRuleSet() {
    if (!this.activeReceiptRuleSet) {
      return { result: {}, resultTag: "DescribeActiveReceiptRuleSetResult" };
    }
    const rs = this.receiptRuleSets.get(this.activeReceiptRuleSet);
    return {
      result: {
        Metadata: { Name: rs.name, CreatedTimestamp: new Date().toISOString() },
        Rules: rs.rules,
      },
      resultTag: "DescribeActiveReceiptRuleSetResult",
    };
  }

  setActiveReceiptRuleSet(input) {
    const name = input.RuleSetName;
    if (name === undefined || name === "") {
      this.activeReceiptRuleSet = null;
    } else {
      this.requireRuleSet(name);
      this.activeReceiptRuleSet = name;
    }
    return { result: {}, resultTag: "SetActiveReceiptRuleSetResult" };
  }

  reorderReceiptRuleSet(input) {
    const rs = this.requireRuleSet(input.RuleSetName);
    const order = this.asList(input.RuleNames);
    const byName = new Map(rs.rules.map((r) => [r.Name, r]));
    for (const n of order) {
      if (!byName.has(n)) {
        throw new SesError(
          "RuleDoesNotExistException",
          `Rule <${n}> does not exist.`,
        );
      }
    }
    if (order.length !== rs.rules.length) {
      throw new SesError(
        "InvalidParameterValue",
        "RuleNames must contain exactly the rules in the rule set.",
      );
    }
    rs.rules = order.map((n) => byName.get(n));
    return { result: {}, resultTag: "ReorderReceiptRuleSetResult" };
  }

  // -------------------------------------------------------------------------
  // Receipt rules
  // -------------------------------------------------------------------------
  createReceiptRule(input) {
    const rs = this.requireRuleSet(input.RuleSetName);
    const rule = input.Rule;
    if (!rule || !rule.Name) {
      throw new SesError("InvalidParameterValue", "Rule.Name is required.");
    }
    if (rs.rules.some((r) => r.Name === rule.Name)) {
      throw new SesError(
        "AlreadyExistsException",
        `Rule <${rule.Name}> already exists.`,
      );
    }
    const normalized = this.normalizeRule(rule);
    if (input.After) {
      const idx = rs.rules.findIndex((r) => r.Name === input.After);
      if (idx === -1) {
        throw new SesError(
          "RuleDoesNotExistException",
          `Rule <${input.After}> does not exist.`,
        );
      }
      rs.rules.splice(idx + 1, 0, normalized);
    } else {
      rs.rules.unshift(normalized);
    }
    return { result: {}, resultTag: "CreateReceiptRuleResult" };
  }

  normalizeRule(rule) {
    return {
      Name: rule.Name,
      Enabled: rule.Enabled === "true" || rule.Enabled === true,
      TlsPolicy: rule.TlsPolicy || "Optional",
      Recipients: this.asList(rule.Recipients),
      Actions: this.asList(rule.Actions),
      ScanEnabled: rule.ScanEnabled === "true" || rule.ScanEnabled === true,
    };
  }

  updateReceiptRule(input) {
    const rs = this.requireRuleSet(input.RuleSetName);
    const rule = input.Rule;
    if (!rule || !rule.Name) {
      throw new SesError("InvalidParameterValue", "Rule.Name is required.");
    }
    const idx = rs.rules.findIndex((r) => r.Name === rule.Name);
    if (idx === -1) {
      throw new SesError(
        "RuleDoesNotExistException",
        `Rule <${rule.Name}> does not exist.`,
      );
    }
    rs.rules[idx] = this.normalizeRule(rule);
    return { result: {}, resultTag: "UpdateReceiptRuleResult" };
  }

  deleteReceiptRule(input) {
    const rs = this.requireRuleSet(input.RuleSetName);
    rs.rules = rs.rules.filter((r) => r.Name !== input.RuleName);
    return { result: {}, resultTag: "DeleteReceiptRuleResult" };
  }

  describeReceiptRule(input) {
    const rs = this.requireRuleSet(input.RuleSetName);
    const rule = rs.rules.find((r) => r.Name === input.RuleName);
    if (!rule) {
      throw new SesError(
        "RuleDoesNotExistException",
        `Rule <${input.RuleName}> does not exist.`,
      );
    }
    return { result: { Rule: rule }, resultTag: "DescribeReceiptRuleResult" };
  }

  setReceiptRulePosition(input) {
    const rs = this.requireRuleSet(input.RuleSetName);
    const name = input.RuleName;
    const idx = rs.rules.findIndex((r) => r.Name === name);
    if (idx === -1) {
      throw new SesError(
        "RuleDoesNotExistException",
        `Rule <${name}> does not exist.`,
      );
    }
    const [rule] = rs.rules.splice(idx, 1);
    if (input.After) {
      const afterIdx = rs.rules.findIndex((r) => r.Name === input.After);
      if (afterIdx === -1) {
        rs.rules.splice(idx, 0, rule);
        throw new SesError(
          "RuleDoesNotExistException",
          `Rule <${input.After}> does not exist.`,
        );
      }
      rs.rules.splice(afterIdx + 1, 0, rule);
    } else {
      rs.rules.unshift(rule);
    }
    return { result: {}, resultTag: "SetReceiptRulePositionResult" };
  }

  // -------------------------------------------------------------------------
  // Receipt filters
  // -------------------------------------------------------------------------
  createReceiptFilter(input) {
    const filter = input.Filter;
    if (!filter || !filter.Name) {
      throw new SesError("InvalidParameterValue", "Filter.Name is required.");
    }
    if (this.receiptFilters.has(filter.Name)) {
      throw new SesError(
        "AlreadyExistsException",
        `Filter <${filter.Name}> already exists.`,
      );
    }
    this.receiptFilters.set(filter.Name, {
      Name: filter.Name,
      IpFilter: filter.IpFilter || {},
    });
    return { result: {}, resultTag: "CreateReceiptFilterResult" };
  }

  deleteReceiptFilter(input) {
    this.receiptFilters.delete(input.FilterName);
    return { result: {}, resultTag: "DeleteReceiptFilterResult" };
  }

  listReceiptFilters() {
    const filters = [...this.receiptFilters.values()].sort((a, b) =>
      a.Name.localeCompare(b.Name),
    );
    return { result: { Filters: filters }, resultTag: "ListReceiptFiltersResult" };
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------
  asList(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return Object.values(value);
    return [value];
  }

  paginate(items, nextToken, pageSize) {
    let start = 0;
    if (nextToken) {
      const decoded = parseInt(
        Buffer.from(String(nextToken), "base64").toString("utf8"),
        10,
      );
      if (!Number.isNaN(decoded)) start = decoded;
    }
    const size = pageSize > 0 ? pageSize : items.length || 1;
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
      `<${responseTag} xmlns="${SES_NAMESPACE}">` +
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
      `<ErrorResponse xmlns="${SES_NAMESPACE}">` +
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

export default SesServer;
export const API_VERSION_SES = API_VERSION;
