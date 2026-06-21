// parlel/ebs — a lightweight, dependency-free fake of AWS EBS (the volume &
// snapshot subset of the EC2 API). Speaks the AWS Query (XML) wire protocol
// (API version 2016-11-15) so the real `@aws-sdk/client-ec2` client works
// against it. Pure Node.js, no external dependencies, in-memory state.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const EC2_NAMESPACE = "http://ec2.amazonaws.com/doc/2016-11-15/";
const API_VERSION = "2016-11-15";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidParameterValue: 400,
  MissingParameter: 400,
  "InvalidVolume.NotFound": 400,
  "InvalidSnapshot.NotFound": 400,
  "VolumeInUse": 400,
  "IncorrectState": 400,
  InternalError: 500,
};

class EbsError extends Error {
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
    const items = value.map((v) => xmlNode("item", v)).join("");
    return `<${tag}>${items}</${tag}>`;
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

function hexId(prefix, len = 17) {
  return `${prefix}-${randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len)}`;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [value];
}

export class EbsServer {
  constructor(port = 4701, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.volumes = new Map();
    this.snapshots = new Map();
    this.tags = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new EbsError("InternalError", error.message, 500));
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
        service: "ebs",
        volumes: this.volumes.size,
        snapshots: this.snapshots.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-ebs");

    if (method !== "POST") {
      return this.sendError(res, new EbsError("InvalidParameterValue", "Only POST is supported.", 405));
    }

    const body = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = parseForm(body);
    } catch {
      return this.sendError(res, new EbsError("InvalidParameterValue", "Body could not be parsed.", 400));
    }

    try {
      const { result, resultTag } = this.dispatch(input.Action, input);
      return this.sendXml(res, 200, resultTag, result);
    } catch (error) {
      if (error instanceof EbsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      CreateVolume: () => this.createVolume(input),
      DescribeVolumes: () => this.describeVolumes(input),
      DeleteVolume: () => this.deleteVolume(input),
      AttachVolume: () => this.attachVolume(input),
      DetachVolume: () => this.detachVolume(input),
      CreateSnapshot: () => this.createSnapshot(input),
      DescribeSnapshots: () => this.describeSnapshots(input),
      DeleteSnapshot: () => this.deleteSnapshot(input),
    };
    const handler = handlers[operation];
    if (!handler) throw new EbsError("InvalidAction", `The action ${operation || "(none)"} is not valid.`, 400);
    return handler();
  }

  tagsFor(id) {
    const map = this.tags.get(id) || {};
    return Object.entries(map).map(([key, value]) => ({ key, value }));
  }

  applyTagSpecs(id, input) {
    const specs = asList(input.TagSpecification);
    const map = this.tags.get(id) || {};
    for (const spec of specs) {
      for (const t of asList(spec.Tag)) {
        if (t && t.Key !== undefined) map[t.Key] = t.Value ?? "";
      }
    }
    if (Object.keys(map).length) this.tags.set(id, map);
  }

  // -------------------------------------------------------------------------
  // Volumes
  // -------------------------------------------------------------------------
  createVolume(input) {
    const az = input.AvailabilityZone;
    if (!az) throw new EbsError("MissingParameter", "The request must contain the parameter AvailabilityZone");
    const size = input.Size ? Number(input.Size) : input.SnapshotId ? 8 : 8;
    const id = hexId("vol", 17);
    const now = new Date().toISOString();
    const vol = {
      volumeId: id,
      size,
      availabilityZone: az,
      state: "available",
      volumeType: input.VolumeType || "gp3",
      iops: input.Iops ? Number(input.Iops) : 3000,
      encrypted: input.Encrypted === "true",
      snapshotId: input.SnapshotId || "",
      createTime: now,
      multiAttachEnabled: false,
      attachments: [],
    };
    this.volumes.set(id, vol);
    this.applyTagSpecs(id, input);
    return { result: this.volumeXml(vol), resultTag: "CreateVolumeResponse" };
  }

  volumeXml(v) {
    return {
      volumeId: v.volumeId,
      size: v.size,
      snapshotId: v.snapshotId,
      availabilityZone: v.availabilityZone,
      status: v.state,
      createTime: v.createTime,
      volumeType: v.volumeType,
      iops: v.iops,
      encrypted: v.encrypted,
      multiAttachEnabled: v.multiAttachEnabled,
      attachmentSet: v.attachments.length ? v.attachments : undefined,
      tagSet: this.tagsFor(v.volumeId),
    };
  }

  describeVolumes(input) {
    const ids = asList(input.VolumeId).filter(Boolean);
    let vols = [...this.volumes.values()];
    if (ids.length) {
      for (const id of ids) {
        if (!this.volumes.has(id)) throw new EbsError("InvalidVolume.NotFound", `The volume '${id}' does not exist.`);
      }
      vols = vols.filter((v) => ids.includes(v.volumeId));
    }
    return { result: { volumeSet: vols.map((v) => this.volumeXml(v)) }, resultTag: "DescribeVolumesResponse" };
  }

  requireVolume(id) {
    if (!id) throw new EbsError("MissingParameter", "The request must contain the parameter VolumeId");
    const v = this.volumes.get(id);
    if (!v) throw new EbsError("InvalidVolume.NotFound", `The volume '${id}' does not exist.`);
    return v;
  }

  deleteVolume(input) {
    const v = this.requireVolume(input.VolumeId);
    if (v.state === "in-use") throw new EbsError("VolumeInUse", `Volume ${v.volumeId} is currently attached.`);
    this.volumes.delete(v.volumeId);
    this.tags.delete(v.volumeId);
    return { result: { return: true }, resultTag: "DeleteVolumeResponse" };
  }

  attachVolume(input) {
    const v = this.requireVolume(input.VolumeId);
    const instanceId = input.InstanceId;
    const device = input.Device;
    if (!instanceId) throw new EbsError("MissingParameter", "The request must contain the parameter InstanceId");
    if (!device) throw new EbsError("MissingParameter", "The request must contain the parameter Device");
    const now = new Date().toISOString();
    const attachment = {
      volumeId: v.volumeId,
      instanceId,
      device,
      status: "attached",
      attachTime: now,
      deleteOnTermination: false,
    };
    v.attachments = [attachment];
    v.state = "in-use";
    return { result: attachment, resultTag: "AttachVolumeResponse" };
  }

  detachVolume(input) {
    const v = this.requireVolume(input.VolumeId);
    const attachment = v.attachments[0] || { volumeId: v.volumeId, instanceId: input.InstanceId || "", device: input.Device || "" };
    v.attachments = [];
    v.state = "available";
    return {
      result: {
        volumeId: v.volumeId,
        instanceId: attachment.instanceId,
        device: attachment.device,
        status: "detaching",
        attachTime: new Date().toISOString(),
      },
      resultTag: "DetachVolumeResponse",
    };
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------
  createSnapshot(input) {
    const v = this.requireVolume(input.VolumeId);
    const id = hexId("snap", 17);
    const now = new Date().toISOString();
    const snap = {
      snapshotId: id,
      volumeId: v.volumeId,
      volumeSize: v.size,
      state: "completed",
      progress: "100%",
      startTime: now,
      ownerId: this.accountId,
      description: input.Description || "",
      encrypted: v.encrypted,
    };
    this.snapshots.set(id, snap);
    this.applyTagSpecs(id, input);
    return { result: this.snapshotXml(snap), resultTag: "CreateSnapshotResponse" };
  }

  snapshotXml(s) {
    return {
      snapshotId: s.snapshotId,
      volumeId: s.volumeId,
      status: s.state,
      startTime: s.startTime,
      progress: s.progress,
      ownerId: s.ownerId,
      volumeSize: s.volumeSize,
      description: s.description,
      encrypted: s.encrypted,
      tagSet: this.tagsFor(s.snapshotId),
    };
  }

  describeSnapshots(input) {
    const ids = asList(input.SnapshotId).filter(Boolean);
    let snaps = [...this.snapshots.values()];
    if (ids.length) {
      for (const id of ids) {
        if (!this.snapshots.has(id)) throw new EbsError("InvalidSnapshot.NotFound", `The snapshot '${id}' does not exist.`);
      }
      snaps = snaps.filter((s) => ids.includes(s.snapshotId));
    }
    return { result: { snapshotSet: snaps.map((s) => this.snapshotXml(s)) }, resultTag: "DescribeSnapshotsResponse" };
  }

  deleteSnapshot(input) {
    const id = input.SnapshotId;
    if (!id) throw new EbsError("MissingParameter", "The request must contain the parameter SnapshotId");
    if (!this.snapshots.has(id)) throw new EbsError("InvalidSnapshot.NotFound", `The snapshot '${id}' does not exist.`);
    this.snapshots.delete(id);
    this.tags.delete(id);
    return { result: { return: true }, resultTag: "DeleteSnapshotResponse" };
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  buildResultXml(result) {
    let xml = "";
    for (const [key, value] of Object.entries(result)) xml += xmlNode(key, value);
    return xml;
  }

  sendXml(res, status, responseTag, result) {
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    const xml =
      `<${responseTag} xmlns="${EC2_NAMESPACE}">` +
      `<requestId>${requestId}</requestId>` +
      this.buildResultXml(result) +
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
      `<Response><Errors><Error>` +
      `<Code>${xmlEscape(code)}</Code><Message>${xmlEscape(error.message || code)}</Message>` +
      `</Error></Errors><RequestID>${requestId}</RequestID></Response>`;
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
  }
}

export default EbsServer;
export const API_VERSION_EBS = API_VERSION;
