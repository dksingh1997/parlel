// parlel/ec2 — a lightweight, dependency-free fake of AWS EC2.
//
// Speaks the AWS Query wire protocol (API version 2016-11-15) so application
// code using the real `@aws-sdk/client-ec2` client can run against it with zero
// cost and zero side effects. Pure Node.js, no external npm dependencies.
// State is in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const EC2_NAMESPACE = "http://ec2.amazonaws.com/doc/2016-11-15/";
const API_VERSION = "2016-11-15";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidParameterValue: 400,
  MissingParameter: 400,
  InvalidParameter: 400,
  InvalidInstanceID: 400,
  "InvalidInstanceID.NotFound": 400,
  "InvalidGroup.NotFound": 400,
  "InvalidVpcID.NotFound": 400,
  "InvalidSubnetID.NotFound": 400,
  "InvalidAMIID.NotFound": 400,
  "InvalidKeyPair.Duplicate": 400,
  InternalError: 500,
};

class Ec2Error extends Error {
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

function xmlNode(tag, value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    // EC2 list shape: <tag><item>..</item><item>..</item></tag>
    const items = value.map((v) => xmlNode("item", v)).join("");
    return `<${tag}>${items}</${tag}>`;
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

  // member/item-style list
  if (keys.length === 1 && (keys[0] === "member" || keys[0] === "item")) {
    const container = node[keys[0]];
    const indices = Object.keys(container)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    return indices.map((idx) => normalizeNode(container[idx]));
  }

  // Direct numeric-indexed list (EC2 uses Foo.1, Foo.2)
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

// ---------------------------------------------------------------------------
// id generation
// ---------------------------------------------------------------------------

function hexId(prefix, len = 17) {
  const bytes = randomBytes(Math.ceil(len / 2));
  return `${prefix}-${bytes.toString("hex").slice(0, len)}`;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [value];
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class Ec2Server {
  constructor(port = 4700, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.instances = new Map(); // id -> instance
    this.securityGroups = new Map(); // id -> sg
    this.vpcs = new Map(); // id -> vpc
    this.subnets = new Map(); // id -> subnet
    this.images = new Map(); // id -> ami
    this.keyPairs = new Map(); // name -> keypair
    this.tags = new Map(); // resourceId -> {key:value}
    this.seedImages();
  }

  seedImages() {
    const ami = "ami-0abcdef1234567890";
    this.images.set(ami, {
      imageId: ami,
      name: "parlel-amzn2-base",
      description: "parlel seeded AMI",
      ownerId: this.accountId,
      state: "available",
      architecture: "x86_64",
      rootDeviceType: "ebs",
      virtualizationType: "hvm",
      public: true,
      imageType: "machine",
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new Ec2Error("InternalError", error.message, 500));
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
        service: "ec2",
        instances: this.instances.size,
        vpcs: this.vpcs.size,
        securityGroups: this.securityGroups.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-ec2");

    if (method !== "POST") {
      return this.sendError(
        res,
        new Ec2Error("InvalidParameterValue", "Only POST is supported by the parlel ec2 fake.", 405),
      );
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(res, new Ec2Error("InvalidParameterValue", "Request body could not be parsed.", 400));
    }

    const operation = input.Action;
    try {
      const { result, resultTag } = this.dispatch(operation, input);
      return this.sendXml(res, 200, resultTag, result);
    } catch (error) {
      if (error instanceof Ec2Error) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      RunInstances: () => this.runInstances(input),
      DescribeInstances: () => this.describeInstances(input),
      TerminateInstances: () => this.terminateInstances(input),
      StartInstances: () => this.startInstances(input),
      StopInstances: () => this.stopInstances(input),
      CreateSecurityGroup: () => this.createSecurityGroup(input),
      DescribeSecurityGroups: () => this.describeSecurityGroups(input),
      AuthorizeSecurityGroupIngress: () => this.authorizeSecurityGroupIngress(input),
      CreateVpc: () => this.createVpc(input),
      DescribeVpcs: () => this.describeVpcs(input),
      CreateSubnet: () => this.createSubnet(input),
      DescribeSubnets: () => this.describeSubnets(input),
      DescribeImages: () => this.describeImages(input),
      CreateTags: () => this.createTags(input),
      DescribeTags: () => this.describeTags(input),
      CreateKeyPair: () => this.createKeyPair(input),
    };
    const handler = handlers[operation];
    if (!handler) {
      throw new Ec2Error("InvalidAction", `The action ${operation || "(none)"} is not valid for this endpoint.`, 400);
    }
    return handler();
  }

  // -------------------------------------------------------------------------
  // Tag helpers
  // -------------------------------------------------------------------------
  // Tag specs arrive as TagSpecification.N.ResourceType and Tag.M.{Key,Value}
  parseTagSpecifications(input) {
    const specs = asList(input.TagSpecification);
    const out = [];
    for (const spec of specs) {
      if (!spec) continue;
      const tags = asList(spec.Tag).filter((t) => t && t.Key !== undefined);
      out.push({ resourceType: spec.ResourceType, tags });
    }
    return out;
  }

  applyTags(resourceId, tags) {
    if (!tags || !tags.length) return;
    const map = this.tags.get(resourceId) || {};
    for (const t of tags) map[t.Key] = t.Value ?? "";
    this.tags.set(resourceId, map);
  }

  tagsFor(resourceId) {
    const map = this.tags.get(resourceId) || {};
    return Object.entries(map).map(([key, value]) => ({ key, value }));
  }

  // -------------------------------------------------------------------------
  // Instances
  // -------------------------------------------------------------------------
  runInstances(input) {
    const min = input.MinCount ? Number(input.MinCount) : 1;
    const max = input.MaxCount ? Number(input.MaxCount) : min;
    if (!input.ImageId) {
      throw new Ec2Error("MissingParameter", "The request must contain the parameter ImageId");
    }
    const count = Math.max(min, 1);
    const reservationId = hexId("r", 17);
    const tagSpecs = this.parseTagSpecifications(input);
    const instanceTags = tagSpecs
      .filter((s) => !s.resourceType || s.resourceType === "instance")
      .flatMap((s) => s.tags);

    const created = [];
    for (let i = 0; i < Math.min(count, max || count); i++) {
      const id = hexId("i", 17);
      const now = new Date().toISOString();
      const inst = {
        instanceId: id,
        imageId: input.ImageId,
        instanceType: input.InstanceType || "t2.micro",
        state: { code: 16, name: "running" },
        privateIpAddress: `10.0.0.${10 + this.instances.size}`,
        ipAddress: `54.0.0.${10 + this.instances.size}`,
        subnetId: input.SubnetId,
        vpcId: input.SubnetId ? this.subnets.get(input.SubnetId)?.vpcId : undefined,
        keyName: input.KeyName,
        launchTime: now,
        reservationId,
        architecture: "x86_64",
        rootDeviceType: "ebs",
        virtualizationType: "hvm",
        placement: { availabilityZone: `${this.region}a` },
        securityGroups: asList(input.SecurityGroupId).map((gid) => ({
          groupId: gid,
          groupName: this.securityGroups.get(gid)?.groupName,
        })),
      };
      this.instances.set(id, inst);
      if (instanceTags.length) this.applyTags(id, instanceTags);
      created.push(inst);
    }

    return {
      result: {
        reservationId,
        ownerId: this.accountId,
        groupSet: "",
        instancesSet: created.map((i) => this.instanceXml(i)),
      },
      resultTag: "RunInstancesResponse",
    };
  }

  instanceXml(inst) {
    return {
      instanceId: inst.instanceId,
      imageId: inst.imageId,
      instanceState: inst.state,
      privateDnsName: `ip-${inst.privateIpAddress.replace(/\./g, "-")}.ec2.internal`,
      dnsName: "",
      instanceType: inst.instanceType,
      launchTime: inst.launchTime,
      placement: inst.placement,
      privateIpAddress: inst.privateIpAddress,
      ipAddress: inst.state.name === "running" ? inst.ipAddress : undefined,
      subnetId: inst.subnetId,
      vpcId: inst.vpcId,
      keyName: inst.keyName,
      architecture: inst.architecture,
      rootDeviceType: inst.rootDeviceType,
      virtualizationType: inst.virtualizationType,
      groupSet: inst.securityGroups && inst.securityGroups.length ? inst.securityGroups : undefined,
      tagSet: this.tagsFor(inst.instanceId),
    };
  }

  collectInstanceIds(input) {
    return asList(input.InstanceId).filter(Boolean);
  }

  describeInstances(input) {
    const ids = this.collectInstanceIds(input);
    let instances = [...this.instances.values()];
    if (ids.length) {
      for (const id of ids) {
        if (!this.instances.has(id)) {
          throw new Ec2Error("InvalidInstanceID.NotFound", `The instance ID '${id}' does not exist`);
        }
      }
      instances = instances.filter((i) => ids.includes(i.instanceId));
    }
    // Group by reservation.
    const byReservation = new Map();
    for (const i of instances) {
      if (!byReservation.has(i.reservationId)) byReservation.set(i.reservationId, []);
      byReservation.get(i.reservationId).push(i);
    }
    const reservations = [...byReservation.entries()].map(([rid, list]) => ({
      reservationId: rid,
      ownerId: this.accountId,
      groupSet: "",
      instancesSet: list.map((i) => this.instanceXml(i)),
    }));
    return { result: { reservationSet: reservations }, resultTag: "DescribeInstancesResponse" };
  }

  changeStateSet(ids, fromBuilder) {
    return ids.map((id) => {
      const inst = this.instances.get(id);
      if (!inst) throw new Ec2Error("InvalidInstanceID.NotFound", `The instance ID '${id}' does not exist`);
      const { current, previous } = fromBuilder(inst);
      return {
        instanceId: id,
        currentState: current,
        previousState: previous,
      };
    });
  }

  terminateInstances(input) {
    const ids = this.collectInstanceIds(input);
    if (!ids.length) throw new Ec2Error("MissingParameter", "The request must contain the parameter InstanceId");
    const set = this.changeStateSet(ids, (inst) => {
      const previous = { ...inst.state };
      inst.state = { code: 48, name: "terminated" };
      return { current: { ...inst.state }, previous };
    });
    return { result: { instancesSet: set }, resultTag: "TerminateInstancesResponse" };
  }

  startInstances(input) {
    const ids = this.collectInstanceIds(input);
    if (!ids.length) throw new Ec2Error("MissingParameter", "The request must contain the parameter InstanceId");
    const set = this.changeStateSet(ids, (inst) => {
      const previous = { ...inst.state };
      inst.state = { code: 16, name: "running" };
      return { current: { ...inst.state }, previous };
    });
    return { result: { instancesSet: set }, resultTag: "StartInstancesResponse" };
  }

  stopInstances(input) {
    const ids = this.collectInstanceIds(input);
    if (!ids.length) throw new Ec2Error("MissingParameter", "The request must contain the parameter InstanceId");
    const set = this.changeStateSet(ids, (inst) => {
      const previous = { ...inst.state };
      inst.state = { code: 80, name: "stopped" };
      return { current: { ...inst.state }, previous };
    });
    return { result: { instancesSet: set }, resultTag: "StopInstancesResponse" };
  }

  // -------------------------------------------------------------------------
  // Security groups
  // -------------------------------------------------------------------------
  createSecurityGroup(input) {
    const name = input.GroupName;
    if (!name) throw new Ec2Error("MissingParameter", "The request must contain the parameter GroupName");
    const id = hexId("sg", 17);
    const tagSpecs = this.parseTagSpecifications(input);
    const tags = tagSpecs.flatMap((s) => s.tags);
    const sg = {
      groupId: id,
      groupName: name,
      groupDescription: input.GroupDescription || "",
      vpcId: input.VpcId,
      ownerId: this.accountId,
      ipPermissions: [],
      ipPermissionsEgress: [],
    };
    this.securityGroups.set(id, sg);
    if (tags.length) this.applyTags(id, tags);
    return { result: { groupId: id, tagSet: this.tagsFor(id) }, resultTag: "CreateSecurityGroupResponse" };
  }

  describeSecurityGroups(input) {
    const ids = asList(input.GroupId).filter(Boolean);
    let groups = [...this.securityGroups.values()];
    if (ids.length) {
      for (const id of ids) {
        if (!this.securityGroups.has(id)) {
          throw new Ec2Error("InvalidGroup.NotFound", `The security group '${id}' does not exist`);
        }
      }
      groups = groups.filter((g) => ids.includes(g.groupId));
    }
    return {
      result: {
        securityGroupInfo: groups.map((g) => ({
          ownerId: g.ownerId,
          groupId: g.groupId,
          groupName: g.groupName,
          groupDescription: g.groupDescription,
          vpcId: g.vpcId,
          ipPermissions: g.ipPermissions.length ? g.ipPermissions : undefined,
          ipPermissionsEgress: g.ipPermissionsEgress.length ? g.ipPermissionsEgress : undefined,
          tagSet: this.tagsFor(g.groupId),
        })),
      },
      resultTag: "DescribeSecurityGroupsResponse",
    };
  }

  authorizeSecurityGroupIngress(input) {
    const id = input.GroupId;
    const sg = id ? this.securityGroups.get(id) : null;
    if (!sg) throw new Ec2Error("InvalidGroup.NotFound", `The security group '${id}' does not exist`);
    // Support both single-perm and IpPermissions list forms.
    let perms = asList(input.IpPermissions);
    if (!perms.length && input.IpProtocol) {
      perms = [
        {
          IpProtocol: input.IpProtocol,
          FromPort: input.FromPort,
          ToPort: input.ToPort,
          IpRanges: input.CidrIp ? [{ CidrIp: input.CidrIp }] : [],
        },
      ];
    }
    for (const p of perms) {
      sg.ipPermissions.push({
        ipProtocol: p.IpProtocol,
        fromPort: p.FromPort,
        toPort: p.ToPort,
        ipRanges: asList(p.IpRanges).map((r) => ({ cidrIp: r.CidrIp })),
      });
    }
    return { result: { return: true }, resultTag: "AuthorizeSecurityGroupIngressResponse" };
  }

  // -------------------------------------------------------------------------
  // VPCs
  // -------------------------------------------------------------------------
  createVpc(input) {
    const cidr = input.CidrBlock;
    if (!cidr) throw new Ec2Error("MissingParameter", "The request must contain the parameter CidrBlock");
    const id = hexId("vpc", 17);
    const tagSpecs = this.parseTagSpecifications(input);
    const tags = tagSpecs.flatMap((s) => s.tags);
    const vpc = {
      vpcId: id,
      cidrBlock: cidr,
      state: "available",
      ownerId: this.accountId,
      instanceTenancy: input.InstanceTenancy || "default",
      isDefault: false,
      dhcpOptionsId: "dopt-" + randomBytes(8).toString("hex").slice(0, 17),
    };
    this.vpcs.set(id, vpc);
    if (tags.length) this.applyTags(id, tags);
    return {
      result: {
        vpc: {
          vpcId: vpc.vpcId,
          cidrBlock: vpc.cidrBlock,
          state: vpc.state,
          ownerId: vpc.ownerId,
          instanceTenancy: vpc.instanceTenancy,
          isDefault: vpc.isDefault,
          dhcpOptionsId: vpc.dhcpOptionsId,
          tagSet: this.tagsFor(vpc.vpcId),
        },
      },
      resultTag: "CreateVpcResponse",
    };
  }

  describeVpcs(input) {
    const ids = asList(input.VpcId).filter(Boolean);
    let vpcs = [...this.vpcs.values()];
    if (ids.length) {
      for (const id of ids) {
        if (!this.vpcs.has(id)) throw new Ec2Error("InvalidVpcID.NotFound", `The vpc ID '${id}' does not exist`);
      }
      vpcs = vpcs.filter((v) => ids.includes(v.vpcId));
    }
    return {
      result: {
        vpcSet: vpcs.map((v) => ({
          vpcId: v.vpcId,
          cidrBlock: v.cidrBlock,
          state: v.state,
          ownerId: v.ownerId,
          instanceTenancy: v.instanceTenancy,
          isDefault: v.isDefault,
          dhcpOptionsId: v.dhcpOptionsId,
          tagSet: this.tagsFor(v.vpcId),
        })),
      },
      resultTag: "DescribeVpcsResponse",
    };
  }

  // -------------------------------------------------------------------------
  // Subnets
  // -------------------------------------------------------------------------
  createSubnet(input) {
    const vpcId = input.VpcId;
    const cidr = input.CidrBlock;
    if (!vpcId) throw new Ec2Error("MissingParameter", "The request must contain the parameter VpcId");
    if (!this.vpcs.has(vpcId)) throw new Ec2Error("InvalidVpcID.NotFound", `The vpc ID '${vpcId}' does not exist`);
    if (!cidr) throw new Ec2Error("MissingParameter", "The request must contain the parameter CidrBlock");
    const id = hexId("subnet", 17);
    const tagSpecs = this.parseTagSpecifications(input);
    const tags = tagSpecs.flatMap((s) => s.tags);
    const subnet = {
      subnetId: id,
      vpcId,
      cidrBlock: cidr,
      state: "available",
      ownerId: this.accountId,
      availabilityZone: input.AvailabilityZone || `${this.region}a`,
      availableIpAddressCount: 251,
      mapPublicIpOnLaunch: false,
      defaultForAz: false,
    };
    this.subnets.set(id, subnet);
    if (tags.length) this.applyTags(id, tags);
    return {
      result: { subnet: this.subnetXml(subnet) },
      resultTag: "CreateSubnetResponse",
    };
  }

  subnetXml(s) {
    return {
      subnetId: s.subnetId,
      vpcId: s.vpcId,
      cidrBlock: s.cidrBlock,
      state: s.state,
      ownerId: s.ownerId,
      availabilityZone: s.availabilityZone,
      availableIpAddressCount: s.availableIpAddressCount,
      mapPublicIpOnLaunch: s.mapPublicIpOnLaunch,
      defaultForAz: s.defaultForAz,
      tagSet: this.tagsFor(s.subnetId),
    };
  }

  describeSubnets(input) {
    const ids = asList(input.SubnetId).filter(Boolean);
    let subnets = [...this.subnets.values()];
    if (ids.length) {
      for (const id of ids) {
        if (!this.subnets.has(id)) {
          throw new Ec2Error("InvalidSubnetID.NotFound", `The subnet ID '${id}' does not exist`);
        }
      }
      subnets = subnets.filter((s) => ids.includes(s.subnetId));
    }
    return {
      result: { subnetSet: subnets.map((s) => this.subnetXml(s)) },
      resultTag: "DescribeSubnetsResponse",
    };
  }

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------
  describeImages(input) {
    const ids = asList(input.ImageId).filter(Boolean);
    let images = [...this.images.values()];
    if (ids.length) {
      images = images.filter((i) => ids.includes(i.imageId));
    }
    return {
      result: {
        imagesSet: images.map((i) => ({
          imageId: i.imageId,
          imageLocation: `${i.ownerId}/${i.name}`,
          imageState: i.state,
          imageOwnerId: i.ownerId,
          isPublic: i.public,
          architecture: i.architecture,
          imageType: i.imageType,
          name: i.name,
          description: i.description,
          rootDeviceType: i.rootDeviceType,
          virtualizationType: i.virtualizationType,
          tagSet: this.tagsFor(i.imageId),
        })),
      },
      resultTag: "DescribeImagesResponse",
    };
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  createTags(input) {
    const resourceIds = asList(input.ResourceId).filter(Boolean);
    const tags = asList(input.Tag).filter((t) => t && t.Key !== undefined);
    if (!resourceIds.length) throw new Ec2Error("MissingParameter", "The request must contain the parameter ResourceId");
    for (const rid of resourceIds) {
      this.applyTags(rid, tags);
    }
    return { result: { return: true }, resultTag: "CreateTagsResponse" };
  }

  describeTags(input) {
    void input;
    const out = [];
    for (const [resourceId, map] of this.tags.entries()) {
      const resourceType = this.resourceTypeOf(resourceId);
      for (const [key, value] of Object.entries(map)) {
        out.push({ resourceId, resourceType, key, value });
      }
    }
    return { result: { tagSet: out }, resultTag: "DescribeTagsResponse" };
  }

  resourceTypeOf(id) {
    if (id.startsWith("i-")) return "instance";
    if (id.startsWith("sg-")) return "security-group";
    if (id.startsWith("vpc-")) return "vpc";
    if (id.startsWith("subnet-")) return "subnet";
    if (id.startsWith("ami-")) return "image";
    return "unknown";
  }

  // -------------------------------------------------------------------------
  // Key pairs
  // -------------------------------------------------------------------------
  createKeyPair(input) {
    const name = input.KeyName;
    if (!name) throw new Ec2Error("MissingParameter", "The request must contain the parameter KeyName");
    if (this.keyPairs.has(name)) {
      throw new Ec2Error("InvalidKeyPair.Duplicate", `The keypair '${name}' already exists.`);
    }
    const keyId = hexId("key", 17);
    const fingerprint = randomBytes(20)
      .toString("hex")
      .match(/.{2}/g)
      .join(":");
    const material = `-----BEGIN RSA PRIVATE KEY-----\n${randomBytes(64).toString("base64")}\n-----END RSA PRIVATE KEY-----`;
    const kp = { keyName: name, keyPairId: keyId, keyFingerprint: fingerprint, keyMaterial: material };
    this.keyPairs.set(name, kp);
    return {
      result: {
        keyName: name,
        keyPairId: keyId,
        keyFingerprint: fingerprint,
        keyMaterial: material,
      },
      resultTag: "CreateKeyPairResponse",
    };
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

  sendXml(res, status, responseTag, result) {
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    const resultXml = this.buildResultXml(result);
    const xml =
      `<${responseTag} xmlns="${EC2_NAMESPACE}">` +
      `<requestId>${requestId}</requestId>` +
      resultXml +
      `</${responseTag}>`;
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalError";
    const status = error.status || ERROR_STATUS[code] || 400;
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    const xml =
      `<Response>` +
      `<Errors><Error>` +
      `<Code>${xmlEscape(code)}</Code>` +
      `<Message>${xmlEscape(error.message || code)}</Message>` +
      `</Error></Errors>` +
      `<RequestID>${requestId}</RequestID>` +
      `</Response>`;
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
  }
}

export default Ec2Server;
export const API_VERSION_EC2 = API_VERSION;
