// parlel/autoscaling — a lightweight, dependency-free fake of AWS Auto Scaling.
// Speaks the AWS Query (XML) wire protocol (API version 2011-01-01, member-style
// lists) so the real `@aws-sdk/client-auto-scaling` client works against it.
// Also includes a minimal CreateLaunchTemplate (technically EC2 API). Pure
// Node.js, no external dependencies, in-memory state.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const ASG_NAMESPACE = "https://autoscaling.amazonaws.com/doc/2011-01-01/";
const API_VERSION = "2011-01-01";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ValidationError: 400,
  AlreadyExists: 400,
  InvalidParameterValue: 400,
  InvalidParameterCombination: 400,
  MissingParameter: 400,
  ResourceInUse: 400,
  InternalFailure: 500,
};

class AsgError extends Error {
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

// member-style serialization (AutoScaling): arrays -> <tag><member>..</member></tag>
function xmlNode(tag, value) {
  if (value === undefined || value === null) return `<${tag}/>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<${tag}/>`;
    const members = value.map((v) => xmlNode("member", v)).join("");
    return `<${tag}>${members}</${tag}>`;
  }
  if (typeof value === "object") {
    const inner = Object.entries(value).map(([k, v]) => xmlNode(k, v)).join("");
    return `<${tag}>${inner}</${tag}>`;
  }
  if (typeof value === "boolean") return `<${tag}>${value ? "true" : "false"}</${tag}>`;
  if (value === "") return `<${tag}/>`;
  return `<${tag}>${xmlEscape(value)}</${tag}>`;
}

function parseForm(body) {
  const flat = {};
  for (const [key, value] of new URLSearchParams(body).entries()) flat[key] = value;
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
      if (i === parts.length - 1) cursor[part] = value;
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
  if (keys.length === 1 && (keys[0] === "member" || keys[0] === "item")) {
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

function asList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [value];
}

export class AutoscalingServer {
  constructor(port = 4706, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.groups = new Map(); // name -> asg
    this.launchConfigs = new Map(); // name -> lc
    this.launchTemplates = new Map(); // name -> lt
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new AsgError("InternalFailure", error.message, 500));
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
      return this.sendJson(res, 200, {
        status: "ok",
        service: "autoscaling",
        groups: this.groups.size,
        launchConfigurations: this.launchConfigs.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-autoscaling");

    if (method !== "POST") {
      return this.sendError(res, new AsgError("ValidationError", "Only POST is supported.", 405));
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(res, new AsgError("ValidationError", "Body could not be parsed.", 400));
    }

    try {
      const { result, resultTag } = this.dispatch(input.Action, input);
      return this.sendXml(res, 200, input.Action, resultTag, result);
    } catch (error) {
      if (error instanceof AsgError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      CreateAutoScalingGroup: () => this.createAutoScalingGroup(input),
      DescribeAutoScalingGroups: () => this.describeAutoScalingGroups(input),
      UpdateAutoScalingGroup: () => this.updateAutoScalingGroup(input),
      DeleteAutoScalingGroup: () => this.deleteAutoScalingGroup(input),
      CreateLaunchConfiguration: () => this.createLaunchConfiguration(input),
      DescribeLaunchConfigurations: () => this.describeLaunchConfigurations(input),
      SetDesiredCapacity: () => this.setDesiredCapacity(input),
      CreateLaunchTemplate: () => this.createLaunchTemplate(input),
    };
    const handler = handlers[operation];
    if (!handler) throw new AsgError("ValidationError", `The action ${operation || "(none)"} is not valid.`, 400);
    return handler();
  }

  asgArn(name) {
    return `arn:aws:autoscaling:${this.region}:${this.accountId}:autoScalingGroup:${randomUUID()}:autoScalingGroupName/${name}`;
  }

  // -------------------------------------------------------------------------
  // Auto Scaling Groups
  // -------------------------------------------------------------------------
  createAutoScalingGroup(input) {
    const name = input.AutoScalingGroupName;
    if (!name) throw new AsgError("ValidationError", "AutoScalingGroupName is required.");
    if (this.groups.has(name)) {
      throw new AsgError("AlreadyExists", `AutoScalingGroup by this name already exists - A group with the name ${name} already exists`);
    }
    const min = Number(input.MinSize ?? 0);
    const max = Number(input.MaxSize ?? 0);
    const desired = input.DesiredCapacity !== undefined ? Number(input.DesiredCapacity) : min;
    const azs = asList(input.AvailabilityZones).filter(Boolean);
    const now = new Date().toISOString();

    const instances = [];
    for (let i = 0; i < desired; i++) {
      instances.push({
        instanceId: `i-${randomBytes(8).toString("hex").slice(0, 17)}`,
        availabilityZone: azs[i % Math.max(azs.length, 1)] || `${this.region}a`,
        lifecycleState: "InService",
        healthStatus: "Healthy",
        launchConfigurationName: input.LaunchConfigurationName,
        instanceType: "",
        protectedFromScaleIn: false,
      });
    }

    const asg = {
      name,
      arn: this.asgArn(name),
      minSize: min,
      maxSize: max,
      desiredCapacity: desired,
      defaultCooldown: input.DefaultCooldown ? Number(input.DefaultCooldown) : 300,
      availabilityZones: azs,
      launchConfigurationName: input.LaunchConfigurationName,
      launchTemplate: input.LaunchTemplate,
      vpcZoneIdentifier: input.VPCZoneIdentifier || "",
      healthCheckType: input.HealthCheckType || "EC2",
      healthCheckGracePeriod: input.HealthCheckGracePeriod ? Number(input.HealthCheckGracePeriod) : 0,
      createdTime: now,
      instances,
      newInstancesProtectedFromScaleIn: input.NewInstancesProtectedFromScaleIn === "true" || input.NewInstancesProtectedFromScaleIn === true,
      tags: asList(input.Tags).filter((t) => t && t.Key !== undefined),
    };
    this.groups.set(name, asg);
    return { result: {}, resultTag: "CreateAutoScalingGroupResult" };
  }

  asgXml(asg) {
    return {
      AutoScalingGroupName: asg.name,
      AutoScalingGroupARN: asg.arn,
      LaunchConfigurationName: asg.launchConfigurationName || "",
      LaunchTemplate: asg.launchTemplate || "",
      MixedInstancesPolicy: "",
      MinSize: asg.minSize,
      MaxSize: asg.maxSize,
      DesiredCapacity: asg.desiredCapacity,
      DefaultCooldown: asg.defaultCooldown,
      AvailabilityZones: asg.availabilityZones,
      LoadBalancerNames: [],
      TargetGroupARNs: [],
      HealthCheckType: asg.healthCheckType,
      HealthCheckGracePeriod: asg.healthCheckGracePeriod,
      Instances: asg.instances.map((i) => ({
        InstanceId: i.instanceId,
        AvailabilityZone: i.availabilityZone,
        LifecycleState: i.lifecycleState,
        HealthStatus: i.healthStatus,
        LaunchConfigurationName: i.launchConfigurationName || "",
        LaunchTemplate: "",
        InstanceType: i.instanceType || "",
        ProtectedFromScaleIn: i.protectedFromScaleIn,
        WeightedCapacity: "",
      })),
      CreatedTime: asg.createdTime,
      SuspendedProcesses: [],
      PlacementGroup: "",
      VPCZoneIdentifier: asg.vpcZoneIdentifier,
      EnabledMetrics: [],
      Status: "",
      Tags: asg.tags.map((t) => ({
        ResourceId: asg.name,
        ResourceType: "auto-scaling-group",
        Key: t.Key,
        Value: t.Value ?? "",
        PropagateAtLaunch: t.PropagateAtLaunch === "true" || t.PropagateAtLaunch === true,
      })),
      TerminationPolicies: ["Default"],
      NewInstancesProtectedFromScaleIn: asg.newInstancesProtectedFromScaleIn,
      ServiceLinkedRoleARN: "",
      MaxInstanceLifetime: "",
      CapacityRebalance: "",
      WarmPoolConfiguration: "",
      WarmPoolSize: "",
      DesiredCapacityType: "",
      DefaultInstanceWarmup: "",
      TrafficSources: [],
    };
  }

  reconcileInstances(asg) {
    const target = asg.desiredCapacity;
    while (asg.instances.length < target) {
      asg.instances.push({
        instanceId: `i-${randomBytes(8).toString("hex").slice(0, 17)}`,
        availabilityZone: asg.availabilityZones[0] || `${this.region}a`,
        lifecycleState: "InService",
        healthStatus: "Healthy",
        launchConfigurationName: asg.launchConfigurationName,
        instanceType: "",
        protectedFromScaleIn: false,
      });
    }
    while (asg.instances.length > target) asg.instances.pop();
  }

  describeAutoScalingGroups(input) {
    const names = asList(input.AutoScalingGroupNames).filter(Boolean);
    let groups = [...this.groups.values()];
    if (names.length) groups = groups.filter((g) => names.includes(g.name));
    return {
      result: { AutoScalingGroups: groups.map((g) => this.asgXml(g)) },
      resultTag: "DescribeAutoScalingGroupsResult",
    };
  }

  requireGroup(name) {
    if (!name) throw new AsgError("ValidationError", "AutoScalingGroupName is required.");
    const g = this.groups.get(name);
    if (!g) throw new AsgError("ValidationError", `AutoScalingGroup name not found - AutoScalingGroup ${name} not found`);
    return g;
  }

  updateAutoScalingGroup(input) {
    const asg = this.requireGroup(input.AutoScalingGroupName);
    if (input.MinSize !== undefined) asg.minSize = Number(input.MinSize);
    if (input.MaxSize !== undefined) asg.maxSize = Number(input.MaxSize);
    if (input.DesiredCapacity !== undefined) {
      asg.desiredCapacity = Number(input.DesiredCapacity);
      this.reconcileInstances(asg);
    }
    if (input.DefaultCooldown !== undefined) asg.defaultCooldown = Number(input.DefaultCooldown);
    if (input.HealthCheckType !== undefined) asg.healthCheckType = input.HealthCheckType;
    if (input.HealthCheckGracePeriod !== undefined) asg.healthCheckGracePeriod = Number(input.HealthCheckGracePeriod);
    if (input.LaunchConfigurationName !== undefined) asg.launchConfigurationName = input.LaunchConfigurationName;
    if (input.VPCZoneIdentifier !== undefined) asg.vpcZoneIdentifier = input.VPCZoneIdentifier;
    const azs = asList(input.AvailabilityZones).filter(Boolean);
    if (azs.length) asg.availabilityZones = azs;
    return { result: {}, resultTag: "UpdateAutoScalingGroupResult" };
  }

  deleteAutoScalingGroup(input) {
    const name = input.AutoScalingGroupName;
    const asg = this.requireGroup(name);
    if (asg.instances.length > 0 && input.ForceDelete !== "true") {
      throw new AsgError("ResourceInUse", `You cannot delete an AutoScalingGroup while there are instances or pending Spot instance request(s) still in the group.`);
    }
    this.groups.delete(name);
    return { result: {}, resultTag: "DeleteAutoScalingGroupResult" };
  }

  setDesiredCapacity(input) {
    const asg = this.requireGroup(input.AutoScalingGroupName);
    if (input.DesiredCapacity === undefined) throw new AsgError("ValidationError", "DesiredCapacity is required.");
    asg.desiredCapacity = Number(input.DesiredCapacity);
    this.reconcileInstances(asg);
    return { result: {}, resultTag: "SetDesiredCapacityResult" };
  }

  // -------------------------------------------------------------------------
  // Launch configurations
  // -------------------------------------------------------------------------
  createLaunchConfiguration(input) {
    const name = input.LaunchConfigurationName;
    if (!name) throw new AsgError("ValidationError", "LaunchConfigurationName is required.");
    if (this.launchConfigs.has(name)) {
      throw new AsgError("AlreadyExists", `Launch Configuration by this name already exists - A launch configuration already exists with the name ${name}`);
    }
    const lc = {
      name,
      arn: `arn:aws:autoscaling:${this.region}:${this.accountId}:launchConfiguration:${randomUUID()}:launchConfigurationName/${name}`,
      imageId: input.ImageId || "",
      instanceType: input.InstanceType || "t2.micro",
      keyName: input.KeyName || "",
      securityGroups: asList(input.SecurityGroups).filter(Boolean),
      userData: input.UserData || "",
      createdTime: new Date().toISOString(),
      ebsOptimized: input.EbsOptimized === "true",
      instanceMonitoring: { Enabled: input.InstanceMonitoring ? input.InstanceMonitoring.Enabled === "true" : true },
      kernelId: input.KernelId || "",
      ramdiskId: input.RamdiskId || "",
      blockDeviceMappings: asList(input.BlockDeviceMappings).filter(Boolean),
      classicLinkVPCId: input.ClassicLinkVPCId || "",
      classicLinkVPCSecurityGroups: asList(input.ClassicLinkVPCSecurityGroups).filter(Boolean),
      iamInstanceProfile: input.IamInstanceProfile || "",
      spotPrice: input.SpotPrice || "",
      associatePublicIpAddress: input.AssociatePublicIpAddress === "true",
      placementTenancy: input.PlacementTenancy || "",
    };
    this.launchConfigs.set(name, lc);
    return { result: {}, resultTag: "CreateLaunchConfigurationResult" };
  }

  describeLaunchConfigurations(input) {
    const names = asList(input.LaunchConfigurationNames).filter(Boolean);
    let configs = [...this.launchConfigs.values()];
    if (names.length) configs = configs.filter((c) => names.includes(c.name));
    return {
      result: {
        LaunchConfigurations: configs.map((c) => ({
          LaunchConfigurationName: c.name,
          LaunchConfigurationARN: c.arn,
          ImageId: c.imageId,
          InstanceType: c.instanceType,
          KeyName: c.keyName,
          SecurityGroups: c.securityGroups,
          UserData: c.userData,
          CreatedTime: c.createdTime,
          EbsOptimized: c.ebsOptimized,
          InstanceMonitoring: c.instanceMonitoring,
          KernelId: c.kernelId,
          RamdiskId: c.ramdiskId,
          BlockDeviceMappings: c.blockDeviceMappings,
          ClassicLinkVPCId: c.classicLinkVPCId,
          ClassicLinkVPCSecurityGroups: c.classicLinkVPCSecurityGroups,
          IamInstanceProfile: c.iamInstanceProfile,
          SpotPrice: c.spotPrice,
          AssociatePublicIpAddress: c.associatePublicIpAddress,
          PlacementTenancy: c.placementTenancy,
          MetadataOptions: "",
        })),
      },
      resultTag: "DescribeLaunchConfigurationsResult",
    };
  }

  // -------------------------------------------------------------------------
  // Launch templates (EC2 API, minimal)
  // -------------------------------------------------------------------------
  createLaunchTemplate(input) {
    const name = input.LaunchTemplateName;
    if (!name) throw new AsgError("ValidationError", "LaunchTemplateName is required.");
    if (this.launchTemplates.has(name)) {
      throw new AsgError("AlreadyExists", `Launch template name already in use - ${name}`);
    }
    const id = `lt-${randomBytes(8).toString("hex").slice(0, 17)}`;
    const data = input.LaunchTemplateData || {};
    const lt = {
      id,
      name,
      createTime: new Date().toISOString(),
      createdBy: `arn:aws:iam::${this.accountId}:root`,
      defaultVersionNumber: 1,
      latestVersionNumber: 1,
      data,
    };
    this.launchTemplates.set(name, lt);
    return {
      result: {
        launchTemplate: {
          LaunchTemplateId: lt.id,
          LaunchTemplateName: lt.name,
          CreateTime: lt.createTime,
          CreatedBy: lt.createdBy,
          DefaultVersionNumber: lt.defaultVersionNumber,
          LatestVersionNumber: lt.latestVersionNumber,
        },
      },
      resultTag: "CreateLaunchTemplateResult",
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
    const resultBlock = resultXml.length > 0 ? `<${resultTag}>${resultXml}</${resultTag}>` : `<${resultTag}/>`;
    const xml =
      `<${responseTag} xmlns="${ASG_NAMESPACE}">` +
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
      `<ErrorResponse xmlns="${ASG_NAMESPACE}">` +
      `<Error><Type>${fault}</Type><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(error.message || code)}</Message></Error>` +
      `<RequestId>${requestId}</RequestId></ErrorResponse>`;
    res.end(`<?xml version="1.0"?>\n${xml}`);
  }
}

export default AutoscalingServer;
export const API_VERSION_AUTOSCALING = API_VERSION;
