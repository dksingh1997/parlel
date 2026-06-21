// parlel/imds — a lightweight, dependency-free fake of the EC2 Instance
// Metadata Service (IMDS).
//
// Supports IMDSv1 (plain GETs) and IMDSv2 (PUT /latest/api/token then GETs
// with X-aws-ec2-metadata-token). Metadata responses are plain text; the IAM
// security-credentials document is JSON. State is in-memory and ephemeral
// (resettable via reset() or POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

export class ImdsServer {
  constructor(port = 4719, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.options = options;
    this.reset();
  }

  reset() {
    const o = this.options || {};
    this.instanceId = o.instanceId || "i-1234567890abcdef0";
    this.localIpv4 = o.localIpv4 || "172.16.0.10";
    this.publicIpv4 = o.publicIpv4 || "54.0.0.10";
    this.availabilityZone = o.availabilityZone || `${this.region}a`;
    this.instanceType = o.instanceType || "t3.micro";
    this.amiId = o.amiId || "ami-0abcdef1234567890";
    this.hostname = o.hostname || "ip-172-16-0-10.ec2.internal";
    this.macAddress = o.macAddress || "0a:1b:2c:3d:4e:5f";
    // role name -> credentials
    this.roles = new Map();
    this.roles.set("parlel-role", this.makeCredentials("parlel-role"));
    // active IMDSv2 tokens: Map<token, expiry-ms>
    this.tokens = new Map();
  }

  makeCredentials(roleName) {
    return {
      Code: "Success",
      LastUpdated: new Date().toISOString(),
      Type: "AWS-HMAC",
      AccessKeyId: "ASIA" + randomBytes(8).toString("hex").toUpperCase().slice(0, 16),
      SecretAccessKey: randomBytes(20).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40),
      Token: randomBytes(48).toString("base64"),
      Expiration: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
      RoleName: roleName,
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          res.statusCode = 500;
          res.end(String(error && error.message ? error.message : error));
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
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "imds",
        instanceId: this.instanceId,
        roles: this.roles.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("Server", "EC2ws");

    // IMDSv2 token issuance.
    if (path === "/latest/api/token" && method === "PUT") {
      return this.issueToken(req, res);
    }

    if (method !== "GET") {
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }

    // IMDSv2: if a token header is present, validate it. (IMDSv1 needs none.)
    const token = req.headers["x-aws-ec2-metadata-token"];
    if (token !== undefined) {
      const expiry = this.tokens.get(String(token));
      if (!expiry || expiry < Date.now()) {
        res.statusCode = 401;
        return res.end("Unauthorized");
      }
    }

    return this.metadata(path, res);
  }

  issueToken(req, res) {
    const ttlHeader = req.headers["x-aws-ec2-metadata-token-ttl-seconds"];
    if (ttlHeader === undefined) {
      res.statusCode = 400;
      return res.end("Missing X-aws-ec2-metadata-token-ttl-seconds header");
    }
    const ttl = Number(ttlHeader);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 21600) {
      res.statusCode = 400;
      return res.end("Invalid TTL");
    }
    const token = randomBytes(40).toString("base64");
    this.tokens.set(token, Date.now() + ttl * 1000);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("X-aws-ec2-metadata-token-ttl-seconds", String(ttl));
    res.end(token);
  }

  text(res, body, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain");
    res.end(body);
  }

  notFound(res) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("Not Found");
  }

  metadata(path, res) {
    // Top-level meta-data listing.
    if (path === "/latest/meta-data" || path === "/latest/meta-data/") {
      return this.text(
        res,
        [
          "ami-id",
          "hostname",
          "instance-id",
          "instance-type",
          "local-ipv4",
          "mac",
          "placement/",
          "public-ipv4",
          "iam/",
        ].join("\n"),
      );
    }

    switch (path) {
      case "/latest/meta-data/instance-id":
        return this.text(res, this.instanceId);
      case "/latest/meta-data/instance-type":
        return this.text(res, this.instanceType);
      case "/latest/meta-data/ami-id":
        return this.text(res, this.amiId);
      case "/latest/meta-data/local-ipv4":
        return this.text(res, this.localIpv4);
      case "/latest/meta-data/public-ipv4":
        return this.text(res, this.publicIpv4);
      case "/latest/meta-data/hostname":
        return this.text(res, this.hostname);
      case "/latest/meta-data/mac":
        return this.text(res, this.macAddress);
      case "/latest/meta-data/placement/":
        return this.text(res, ["availability-zone", "region"].join("\n"));
      case "/latest/meta-data/placement/availability-zone":
        return this.text(res, this.availabilityZone);
      case "/latest/meta-data/placement/region":
        return this.text(res, this.region);
      case "/latest/dynamic/instance-identity/document":
        return this.sendJson(res, 200, {
          accountId: this.accountId,
          region: this.region,
          availabilityZone: this.availabilityZone,
          instanceId: this.instanceId,
          instanceType: this.instanceType,
          imageId: this.amiId,
          privateIp: this.localIpv4,
          architecture: "x86_64",
          pendingTime: new Date().toISOString(),
          version: "2017-09-30",
        });
      default:
        break;
    }

    // IAM security credentials listing.
    if (
      path === "/latest/meta-data/iam/security-credentials" ||
      path === "/latest/meta-data/iam/security-credentials/"
    ) {
      return this.text(res, [...this.roles.keys()].join("\n"));
    }
    if (path === "/latest/meta-data/iam/" || path === "/latest/meta-data/iam") {
      return this.text(res, "security-credentials/");
    }

    // IAM security credentials for a specific role -> JSON document.
    const roleMatch = path.match(/^\/latest\/meta-data\/iam\/security-credentials\/([^/]+)$/);
    if (roleMatch) {
      const roleName = decodeURIComponent(roleMatch[1]);
      let creds = this.roles.get(roleName);
      if (!creds) {
        // Real IMDS returns 404 for unknown roles.
        return this.notFound(res);
      }
      return this.sendJson(res, 200, creds);
    }

    return this.notFound(res);
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }
}

export default ImdsServer;
