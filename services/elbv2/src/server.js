// parlel/elbv2 — a lightweight, dependency-free fake of AWS Elastic Load
// Balancing v2 (Application/Network/Gateway load balancers).
//
// Speaks the AWS Query wire protocol (API version 2015-12-01). Requests are
// POST / with `application/x-www-form-urlencoded` bodies carrying
// `Action=<Operation>&Version=2015-12-01&...flattened params`. Responses are
// XML. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const NAMESPACE = "http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/";
const API_VERSION = "2015-12-01";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ValidationError: 400,
  LoadBalancerNotFound: 400,
  TargetGroupNotFound: 400,
  ListenerNotFound: 400,
  RuleNotFound: 400,
  DuplicateLoadBalancerName: 400,
  DuplicateTargetGroupName: 400,
  InvalidConfigurationRequest: 400,
  ResourceInUse: 400,
  InternalError: 500,
};

class ElbError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// XML helpers (copied/adapted from services/sns)
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
    const indices = Object.keys(container)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    return indices.map((idx) => normalizeNode(container[idx]));
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

function hexId(bytes = 8) {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export class Elbv2Server {
  constructor(port = 4710, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.loadBalancers = new Map(); // arn -> lb
    this.targetGroups = new Map(); // arn -> tg
    this.listeners = new Map(); // arn -> listener
    this.rules = new Map(); // arn -> rule
    this.targetHealth = new Map(); // tgArn -> Map<targetKey, target>
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new ElbError("InternalError", error.message, 500));
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "elbv2",
        loadBalancers: this.loadBalancers.size,
        targetGroups: this.targetGroups.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-elbv2");

    if (method !== "POST") {
      return this.sendError(
        res,
        new ElbError("ValidationError", "Only POST is supported.", 405),
      );
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(res, new ElbError("ValidationError", "Bad request body.", 400));
    }

    const operation = input.Action;
    try {
      const { result, resultTag } = this.dispatch(operation, input);
      return this.sendXml(res, 200, operation, resultTag, result);
    } catch (error) {
      if (error instanceof ElbError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      CreateLoadBalancer: () => this.createLoadBalancer(input),
      DescribeLoadBalancers: () => this.describeLoadBalancers(input),
      DeleteLoadBalancer: () => this.deleteLoadBalancer(input),
      CreateTargetGroup: () => this.createTargetGroup(input),
      DescribeTargetGroups: () => this.describeTargetGroups(input),
      DeleteTargetGroup: () => this.deleteTargetGroup(input),
      RegisterTargets: () => this.registerTargets(input),
      DeregisterTargets: () => this.deregisterTargets(input),
      DescribeTargetHealth: () => this.describeTargetHealth(input),
      CreateListener: () => this.createListener(input),
      DescribeListeners: () => this.describeListeners(input),
      DeleteListener: () => this.deleteListener(input),
      CreateRule: () => this.createRule(input),
      DescribeRules: () => this.describeRules(input),
    };
    const handler = handlers[operation];
    if (!handler) {
      throw new ElbError(
        "ValidationError",
        `The action ${operation || "(none)"} is not valid.`,
        400,
      );
    }
    return handler();
  }

  asList(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    return [value];
  }

  // -------------------------------------------------------------------------
  // Load Balancers
  // -------------------------------------------------------------------------
  createLoadBalancer(input) {
    const name = input.Name;
    if (!name) throw new ElbError("ValidationError", "Name is required");
    for (const lb of this.loadBalancers.values()) {
      if (lb.name === name) {
        throw new ElbError(
          "DuplicateLoadBalancerName",
          `A load balancer with the name '${name}' already exists`,
        );
      }
    }
    const id = hexId(8);
    const type = input.Type || "application";
    const scheme = input.Scheme || "internet-facing";
    const arn = `arn:aws:elasticloadbalancing:${this.region}:${this.accountId}:loadbalancer/${
      type === "network" ? "net" : type === "gateway" ? "gwy" : "app"
    }/${name}/${id}`;
    const dnsName = `${name}-${hexId(4)}.${this.region}.elb.amazonaws.com`;
    const subnets = this.asList(input.Subnets || (input.SubnetMappings
      ? this.asList(input.SubnetMappings).map((m) => m.SubnetId)
      : []));
    const securityGroups = this.asList(input.SecurityGroups);
    const lb = {
      arn,
      name,
      type,
      scheme,
      dnsName,
      state: "active",
      vpcId: input.VpcId || `vpc-${hexId(4)}`,
      ipAddressType: input.IpAddressType || "ipv4",
      createdTime: new Date().toISOString(),
      canonicalHostedZoneId: "Z" + hexId(7).toUpperCase().slice(0, 13),
      availabilityZones: subnets.map((s) => ({
        SubnetId: s,
        ZoneName: `${this.region}a`,
      })),
      securityGroups,
      tags: this.parseTags(input.Tags),
    };
    this.loadBalancers.set(arn, lb);
    return {
      result: { LoadBalancers: [this.lbView(lb)] },
      resultTag: "CreateLoadBalancerResult",
    };
  }

  parseTags(tags) {
    const out = {};
    for (const t of this.asList(tags)) {
      if (t && t.Key !== undefined) out[t.Key] = t.Value ?? "";
    }
    return out;
  }

  lbView(lb) {
    return {
      LoadBalancerArn: lb.arn,
      LoadBalancerName: lb.name,
      Type: lb.type,
      Scheme: lb.scheme,
      DNSName: lb.dnsName,
      VpcId: lb.vpcId,
      IpAddressType: lb.ipAddressType,
      CanonicalHostedZoneId: lb.canonicalHostedZoneId,
      CreatedTime: lb.createdTime,
      State: { Code: lb.state },
      AvailabilityZones: lb.availabilityZones,
      SecurityGroups: lb.securityGroups,
    };
  }

  describeLoadBalancers(input) {
    let lbs = [...this.loadBalancers.values()];
    const arns = this.asList(input.LoadBalancerArns);
    const names = this.asList(input.Names);
    if (arns.length) {
      lbs = arns.map((a) => {
        const lb = this.loadBalancers.get(a);
        if (!lb) throw new ElbError("LoadBalancerNotFound", `Load balancer '${a}' not found`);
        return lb;
      });
    } else if (names.length) {
      lbs = names.map((n) => {
        const lb = [...this.loadBalancers.values()].find((x) => x.name === n);
        if (!lb) throw new ElbError("LoadBalancerNotFound", `Load balancer '${n}' not found`);
        return lb;
      });
    }
    return {
      result: { LoadBalancers: lbs.map((l) => this.lbView(l)) },
      resultTag: "DescribeLoadBalancersResult",
    };
  }

  deleteLoadBalancer(input) {
    const arn = input.LoadBalancerArn;
    if (!arn) throw new ElbError("ValidationError", "LoadBalancerArn is required");
    if (!this.loadBalancers.has(arn)) {
      throw new ElbError("LoadBalancerNotFound", `Load balancer '${arn}' not found`);
    }
    this.loadBalancers.delete(arn);
    for (const [lArn, l] of this.listeners) {
      if (l.loadBalancerArn === arn) this.listeners.delete(lArn);
    }
    return { result: {}, resultTag: "DeleteLoadBalancerResult" };
  }

  // -------------------------------------------------------------------------
  // Target Groups
  // -------------------------------------------------------------------------
  createTargetGroup(input) {
    const name = input.Name;
    if (!name) throw new ElbError("ValidationError", "Name is required");
    for (const tg of this.targetGroups.values()) {
      if (tg.name === name) {
        throw new ElbError(
          "DuplicateTargetGroupName",
          `A target group with the name '${name}' already exists`,
        );
      }
    }
    const id = hexId(8);
    const arn = `arn:aws:elasticloadbalancing:${this.region}:${this.accountId}:targetgroup/${name}/${id}`;
    const tg = {
      arn,
      name,
      protocol: input.Protocol,
      port: input.Port ? Number(input.Port) : undefined,
      vpcId: input.VpcId,
      targetType: input.TargetType || "instance",
      healthCheckProtocol: input.HealthCheckProtocol || input.Protocol || "HTTP",
      healthCheckPort: input.HealthCheckPort || "traffic-port",
      healthCheckPath: input.HealthCheckPath || "/",
      healthCheckIntervalSeconds: Number(input.HealthCheckIntervalSeconds || 30),
      healthCheckTimeoutSeconds: Number(input.HealthCheckTimeoutSeconds || 5),
      healthyThresholdCount: Number(input.HealthyThresholdCount || 5),
      unhealthyThresholdCount: Number(input.UnhealthyThresholdCount || 2),
      ipAddressType: input.IpAddressType || "ipv4",
      protocolVersion: input.ProtocolVersion || "HTTP1",
    };
    this.targetGroups.set(arn, tg);
    this.targetHealth.set(arn, new Map());
    return {
      result: { TargetGroups: [this.tgView(tg)] },
      resultTag: "CreateTargetGroupResult",
    };
  }

  tgView(tg) {
    return {
      TargetGroupArn: tg.arn,
      TargetGroupName: tg.name,
      Protocol: tg.protocol,
      Port: tg.port,
      VpcId: tg.vpcId,
      TargetType: tg.targetType,
      HealthCheckProtocol: tg.healthCheckProtocol,
      HealthCheckPort: tg.healthCheckPort,
      HealthCheckPath: tg.healthCheckPath,
      HealthCheckEnabled: true,
      HealthCheckIntervalSeconds: tg.healthCheckIntervalSeconds,
      HealthCheckTimeoutSeconds: tg.healthCheckTimeoutSeconds,
      HealthyThresholdCount: tg.healthyThresholdCount,
      UnhealthyThresholdCount: tg.unhealthyThresholdCount,
      IpAddressType: tg.ipAddressType,
      ProtocolVersion: tg.protocolVersion,
    };
  }

  requireTargetGroup(arn) {
    const tg = this.targetGroups.get(arn);
    if (!tg) throw new ElbError("TargetGroupNotFound", `Target group '${arn}' not found`);
    return tg;
  }

  describeTargetGroups(input) {
    let tgs = [...this.targetGroups.values()];
    const arns = this.asList(input.TargetGroupArns);
    const names = this.asList(input.Names);
    if (arns.length) {
      tgs = arns.map((a) => this.requireTargetGroup(a));
    } else if (names.length) {
      tgs = names.map((n) => {
        const tg = [...this.targetGroups.values()].find((x) => x.name === n);
        if (!tg) throw new ElbError("TargetGroupNotFound", `Target group '${n}' not found`);
        return tg;
      });
    } else if (input.LoadBalancerArn) {
      // Return all (we don't deeply track association here).
    }
    return {
      result: { TargetGroups: tgs.map((t) => this.tgView(t)) },
      resultTag: "DescribeTargetGroupsResult",
    };
  }

  deleteTargetGroup(input) {
    const arn = input.TargetGroupArn;
    this.requireTargetGroup(arn);
    this.targetGroups.delete(arn);
    this.targetHealth.delete(arn);
    return { result: {}, resultTag: "DeleteTargetGroupResult" };
  }

  // -------------------------------------------------------------------------
  // Targets
  // -------------------------------------------------------------------------
  targetKey(t) {
    return `${t.Id}:${t.Port || ""}`;
  }

  registerTargets(input) {
    const arn = input.TargetGroupArn;
    this.requireTargetGroup(arn);
    const targets = this.asList(input.Targets);
    if (targets.length === 0) {
      throw new ElbError("ValidationError", "Targets is required");
    }
    const health = this.targetHealth.get(arn);
    for (const t of targets) {
      health.set(this.targetKey(t), {
        Id: t.Id,
        Port: t.Port ? Number(t.Port) : undefined,
        AvailabilityZone: t.AvailabilityZone,
        state: "healthy",
      });
    }
    return { result: {}, resultTag: "RegisterTargetsResult" };
  }

  deregisterTargets(input) {
    const arn = input.TargetGroupArn;
    this.requireTargetGroup(arn);
    const targets = this.asList(input.Targets);
    const health = this.targetHealth.get(arn);
    for (const t of targets) health.delete(this.targetKey(t));
    return { result: {}, resultTag: "DeregisterTargetsResult" };
  }

  describeTargetHealth(input) {
    const arn = input.TargetGroupArn;
    this.requireTargetGroup(arn);
    const health = this.targetHealth.get(arn);
    let entries = [...health.values()];
    const filter = this.asList(input.Targets);
    if (filter.length) {
      const keys = new Set(filter.map((t) => this.targetKey(t)));
      entries = entries.filter((e) =>
        keys.has(`${e.Id}:${e.Port || ""}`),
      );
    }
    return {
      result: {
        TargetHealthDescriptions: entries.map((e) => ({
          Target: {
            Id: e.Id,
            Port: e.Port,
            AvailabilityZone: e.AvailabilityZone,
          },
          TargetHealth: { State: e.state },
        })),
      },
      resultTag: "DescribeTargetHealthResult",
    };
  }

  // -------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------
  createListener(input) {
    const lbArn = input.LoadBalancerArn;
    if (!this.loadBalancers.has(lbArn)) {
      throw new ElbError("LoadBalancerNotFound", `Load balancer '${lbArn}' not found`);
    }
    const id = hexId(8);
    const arn = `${lbArn.replace(":loadbalancer/", ":listener/")}/${id}`;
    const defaultActions = this.asList(input.DefaultActions).map((a) => ({
      Type: a.Type,
      TargetGroupArn: a.TargetGroupArn,
      Order: a.Order ? Number(a.Order) : undefined,
    }));
    const listener = {
      arn,
      loadBalancerArn: lbArn,
      protocol: input.Protocol,
      port: input.Port ? Number(input.Port) : undefined,
      defaultActions,
      sslPolicy: input.SslPolicy,
      certificates: this.asList(input.Certificates),
    };
    this.listeners.set(arn, listener);
    return {
      result: { Listeners: [this.listenerView(listener)] },
      resultTag: "CreateListenerResult",
    };
  }

  listenerView(l) {
    return {
      ListenerArn: l.arn,
      LoadBalancerArn: l.loadBalancerArn,
      Protocol: l.protocol,
      Port: l.port,
      DefaultActions: l.defaultActions,
      SslPolicy: l.sslPolicy,
    };
  }

  describeListeners(input) {
    let listeners = [...this.listeners.values()];
    const arns = this.asList(input.ListenerArns);
    if (arns.length) {
      listeners = arns.map((a) => {
        const l = this.listeners.get(a);
        if (!l) throw new ElbError("ListenerNotFound", `Listener '${a}' not found`);
        return l;
      });
    } else if (input.LoadBalancerArn) {
      listeners = listeners.filter((l) => l.loadBalancerArn === input.LoadBalancerArn);
    }
    return {
      result: { Listeners: listeners.map((l) => this.listenerView(l)) },
      resultTag: "DescribeListenersResult",
    };
  }

  deleteListener(input) {
    const arn = input.ListenerArn;
    if (!this.listeners.has(arn)) {
      throw new ElbError("ListenerNotFound", `Listener '${arn}' not found`);
    }
    this.listeners.delete(arn);
    for (const [rArn, r] of this.rules) {
      if (r.listenerArn === arn) this.rules.delete(rArn);
    }
    return { result: {}, resultTag: "DeleteListenerResult" };
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------
  createRule(input) {
    const listenerArn = input.ListenerArn;
    if (!this.listeners.has(listenerArn)) {
      throw new ElbError("ListenerNotFound", `Listener '${listenerArn}' not found`);
    }
    const id = hexId(8);
    const arn = `${listenerArn.replace(":listener/", ":listener-rule/")}/${id}`;
    const rule = {
      arn,
      listenerArn,
      priority: input.Priority,
      conditions: this.asList(input.Conditions),
      actions: this.asList(input.Actions),
    };
    this.rules.set(arn, rule);
    return {
      result: { Rules: [this.ruleView(rule)] },
      resultTag: "CreateRuleResult",
    };
  }

  ruleView(r) {
    return {
      RuleArn: r.arn,
      Priority: String(r.priority),
      Conditions: r.conditions,
      Actions: r.actions,
      IsDefault: false,
    };
  }

  describeRules(input) {
    let rules = [...this.rules.values()];
    const arns = this.asList(input.RuleArns);
    if (arns.length) {
      rules = arns.map((a) => {
        const r = this.rules.get(a);
        if (!r) throw new ElbError("RuleNotFound", `Rule '${a}' not found`);
        return r;
      });
    } else if (input.ListenerArn) {
      if (!this.listeners.has(input.ListenerArn)) {
        throw new ElbError("ListenerNotFound", `Listener '${input.ListenerArn}' not found`);
      }
      rules = rules.filter((r) => r.listenerArn === input.ListenerArn);
    }
    return {
      result: { Rules: rules.map((r) => this.ruleView(r)) },
      resultTag: "DescribeRulesResult",
    };
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  buildResultXml(result) {
    let xml = "";
    for (const [key, value] of Object.entries(result)) xml += xmlNode(key, value);
    return xml;
  }

  sendXml(res, status, operation, resultTag, result) {
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    const responseTag = `${operation}Response`;
    const resultXml = this.buildResultXml(result);
    const resultBlock = resultXml.length
      ? `<${resultTag}>${resultXml}</${resultTag}>`
      : `<${resultTag}/>`;
    const xml =
      `<${responseTag} xmlns="${NAMESPACE}">` +
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
      `<ErrorResponse xmlns="${NAMESPACE}">` +
      `<Error><Type>${fault}</Type><Code>${xmlEscape(code)}</Code>` +
      `<Message>${xmlEscape(error.message || code)}</Message></Error>` +
      `<RequestId>${requestId}</RequestId></ErrorResponse>`;
    res.end(`<?xml version="1.0"?>\n${xml}`);
  }
}

export default Elbv2Server;
export const API_VERSION_ELBV2 = API_VERSION;
