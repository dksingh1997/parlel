// parlel/cloudfront — a lightweight, dependency-free fake of AWS CloudFront.
//
// Speaks the CloudFront REST/XML protocol (API version 2020-05-31). Requests
// are RESTful (e.g. POST /2020-05-31/distribution) with XML request bodies and
// XML responses. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const NAMESPACE = "http://cloudfront.amazonaws.com/doc/2020-05-31/";
const API_VERSION = "2020-05-31";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidArgument: 400,
  NoSuchDistribution: 404,
  NoSuchInvalidation: 404,
  NoSuchOriginAccessControl: 404,
  DistributionNotDisabled: 409,
  PreconditionFailed: 412,
  InternalError: 500,
};

class CloudFrontError extends Error {
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

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

function tagBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function distId() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "E";
  const bytes = randomBytes(13);
  for (let i = 0; i < 13; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export class CloudfrontServer {
  constructor(port = 4712, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.distributions = new Map(); // id -> dist
    this.invalidations = new Map(); // distId -> Map<invId, invalidation>
    this.originAccessControls = new Map(); // id -> oac
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new CloudFrontError("InternalError", error.message, 500));
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
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "cloudfront",
        distributions: this.distributions.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-cloudfront");

    const body = (await this.readBody(req)).toString("utf8");
    try {
      return this.route(method, path, req, body, res);
    } catch (error) {
      if (error instanceof CloudFrontError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, req, body, res) {
    const base = `/${API_VERSION}`;
    if (!path.startsWith(base)) {
      throw new CloudFrontError("InvalidArgument", `Unknown path ${path}`, 404);
    }
    const sub = path.slice(base.length);

    if (sub === "/distribution") {
      if (method === "POST") return this.createDistribution(body, res);
      if (method === "GET") return this.listDistributions(res);
    }

    // /distribution/{id}/invalidation
    const invListMatch = sub.match(/^\/distribution\/([^/]+)\/invalidation$/);
    if (invListMatch) {
      const id = invListMatch[1];
      if (method === "POST") return this.createInvalidation(id, body, res);
      if (method === "GET") return this.listInvalidations(id, res);
    }

    // /distribution/{id}/invalidation/{invId}
    const invGetMatch = sub.match(/^\/distribution\/([^/]+)\/invalidation\/([^/]+)$/);
    if (invGetMatch && method === "GET") {
      return this.getInvalidation(invGetMatch[1], invGetMatch[2], res);
    }

    // /distribution/{id}
    const distMatch = sub.match(/^\/distribution\/([^/]+)$/);
    if (distMatch) {
      const id = distMatch[1];
      if (method === "GET") return this.getDistribution(id, res);
      if (method === "DELETE") return this.deleteDistribution(id, req, res);
    }

    if (sub === "/origin-access-control") {
      if (method === "POST") return this.createOriginAccessControl(body, res);
      if (method === "GET") return this.listOriginAccessControls(res);
    }

    throw new CloudFrontError("InvalidArgument", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  createDistribution(body, res) {
    const callerRef = tagText(body, "CallerReference") || randomUUID();
    const comment = tagText(body, "Comment") || "";
    const enabled = (tagText(body, "Enabled") || "true") === "true";
    const origins = tagBlocks(body, "Origin").map((o) => ({
      Id: tagText(o, "Id"),
      DomainName: tagText(o, "DomainName"),
    }));
    const defaultRootObject = tagText(body, "DefaultRootObject") || "";
    const priceClass = tagText(body, "PriceClass") || "PriceClass_All";

    const id = distId();
    const etag = randomBytes(7).toString("hex").toUpperCase();
    const domainName = `${id.toLowerCase()}.cloudfront.net`;
    const arn = `arn:aws:cloudfront::${this.accountId}:distribution/${id}`;
    const dist = {
      id,
      arn,
      etag,
      domainName,
      callerReference: callerRef,
      comment,
      enabled,
      status: "Deployed",
      origins,
      defaultRootObject,
      priceClass,
      lastModifiedTime: new Date().toISOString(),
    };
    this.distributions.set(id, dist);
    this.invalidations.set(id, new Map());

    res.setHeader("ETag", etag);
    res.setHeader(
      "Location",
      `https://cloudfront.amazonaws.com/${API_VERSION}/distribution/${id}`,
    );
    const xml =
      `<Distribution xmlns="${NAMESPACE}">` +
      this.distInner(dist) +
      `</Distribution>`;
    return this.sendXml(res, 201, xml);
  }

  distInner(dist) {
    const originItems = dist.origins
      .map(
        (o) =>
          `<Origin><Id>${xmlEscape(o.Id || "")}</Id>` +
          `<DomainName>${xmlEscape(o.DomainName || "")}</DomainName></Origin>`,
      )
      .join("");
    return (
      `<Id>${dist.id}</Id>` +
      `<ARN>${dist.arn}</ARN>` +
      `<Status>${dist.status}</Status>` +
      `<LastModifiedTime>${dist.lastModifiedTime}</LastModifiedTime>` +
      `<DomainName>${dist.domainName}</DomainName>` +
      `<DistributionConfig>` +
      `<CallerReference>${xmlEscape(dist.callerReference)}</CallerReference>` +
      `<Comment>${xmlEscape(dist.comment)}</Comment>` +
      `<DefaultRootObject>${xmlEscape(dist.defaultRootObject)}</DefaultRootObject>` +
      `<PriceClass>${dist.priceClass}</PriceClass>` +
      `<Enabled>${dist.enabled}</Enabled>` +
      `<Origins><Quantity>${dist.origins.length}</Quantity><Items>${originItems}</Items></Origins>` +
      `</DistributionConfig>`
    );
  }

  distSummary(dist) {
    return (
      `<DistributionSummary>` +
      `<Id>${dist.id}</Id>` +
      `<ARN>${dist.arn}</ARN>` +
      `<Status>${dist.status}</Status>` +
      `<LastModifiedTime>${dist.lastModifiedTime}</LastModifiedTime>` +
      `<DomainName>${dist.domainName}</DomainName>` +
      `<Comment>${xmlEscape(dist.comment)}</Comment>` +
      `<PriceClass>${dist.priceClass}</PriceClass>` +
      `<Enabled>${dist.enabled}</Enabled>` +
      `</DistributionSummary>`
    );
  }

  listDistributions(res) {
    const items = [...this.distributions.values()].map((d) => this.distSummary(d)).join("");
    const xml =
      `<DistributionList xmlns="${NAMESPACE}">` +
      `<Marker></Marker><MaxItems>100</MaxItems><IsTruncated>false</IsTruncated>` +
      `<Quantity>${this.distributions.size}</Quantity>` +
      `<Items>${items}</Items>` +
      `</DistributionList>`;
    return this.sendXml(res, 200, xml);
  }

  requireDistribution(id) {
    const dist = this.distributions.get(id);
    if (!dist) {
      throw new CloudFrontError("NoSuchDistribution", `The specified distribution does not exist: ${id}`, 404);
    }
    return dist;
  }

  getDistribution(id, res) {
    const dist = this.requireDistribution(id);
    res.setHeader("ETag", dist.etag);
    const xml = `<Distribution xmlns="${NAMESPACE}">${this.distInner(dist)}</Distribution>`;
    return this.sendXml(res, 200, xml);
  }

  deleteDistribution(id, req, res) {
    const dist = this.requireDistribution(id);
    if (dist.enabled) {
      throw new CloudFrontError(
        "DistributionNotDisabled",
        "The distribution you are trying to delete has not been disabled.",
        409,
      );
    }
    this.distributions.delete(id);
    this.invalidations.delete(id);
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  createInvalidation(distId, body, res) {
    this.requireDistribution(distId);
    const callerRef = tagText(body, "CallerReference") || randomUUID();
    const paths = tagBlocks(tagText(body, "Paths") || body, "Path").map((p) => p.trim());
    const invId = `I${randomBytes(10).toString("hex").toUpperCase().slice(0, 13)}`;
    const inv = {
      id: invId,
      status: "Completed",
      createTime: new Date().toISOString(),
      callerReference: callerRef,
      paths,
    };
    this.invalidations.get(distId).set(invId, inv);
    res.setHeader(
      "Location",
      `https://cloudfront.amazonaws.com/${API_VERSION}/distribution/${distId}/invalidation/${invId}`,
    );
    const xml = `<Invalidation xmlns="${NAMESPACE}">${this.invInner(inv)}</Invalidation>`;
    return this.sendXml(res, 201, xml);
  }

  invInner(inv) {
    const pathItems = inv.paths.map((p) => `<Path>${xmlEscape(p)}</Path>`).join("");
    return (
      `<Id>${inv.id}</Id>` +
      `<Status>${inv.status}</Status>` +
      `<CreateTime>${inv.createTime}</CreateTime>` +
      `<InvalidationBatch>` +
      `<Paths><Quantity>${inv.paths.length}</Quantity><Items>${pathItems}</Items></Paths>` +
      `<CallerReference>${xmlEscape(inv.callerReference)}</CallerReference>` +
      `</InvalidationBatch>`
    );
  }

  listInvalidations(distId, res) {
    this.requireDistribution(distId);
    const invs = [...this.invalidations.get(distId).values()];
    const items = invs
      .map(
        (i) =>
          `<InvalidationSummary><Id>${i.id}</Id>` +
          `<CreateTime>${i.createTime}</CreateTime><Status>${i.status}</Status></InvalidationSummary>`,
      )
      .join("");
    const xml =
      `<InvalidationList xmlns="${NAMESPACE}">` +
      `<Marker></Marker><MaxItems>100</MaxItems><IsTruncated>false</IsTruncated>` +
      `<Quantity>${invs.length}</Quantity><Items>${items}</Items>` +
      `</InvalidationList>`;
    return this.sendXml(res, 200, xml);
  }

  getInvalidation(distId, invId, res) {
    this.requireDistribution(distId);
    const inv = this.invalidations.get(distId).get(invId);
    if (!inv) {
      throw new CloudFrontError("NoSuchInvalidation", `The specified invalidation does not exist: ${invId}`, 404);
    }
    const xml = `<Invalidation xmlns="${NAMESPACE}">${this.invInner(inv)}</Invalidation>`;
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  createOriginAccessControl(body, res) {
    const name = tagText(body, "Name");
    if (!name) throw new CloudFrontError("InvalidArgument", "Name is required");
    const id = `E${randomBytes(13).toString("hex").toUpperCase().slice(0, 13)}`;
    const etag = randomBytes(7).toString("hex").toUpperCase();
    const oac = {
      id,
      etag,
      name,
      description: tagText(body, "Description") || "",
      signingProtocol: tagText(body, "SigningProtocol") || "sigv4",
      signingBehavior: tagText(body, "SigningBehavior") || "always",
      originAccessControlOriginType: tagText(body, "OriginAccessControlOriginType") || "s3",
    };
    this.originAccessControls.set(id, oac);
    res.setHeader("ETag", etag);
    res.setHeader(
      "Location",
      `https://cloudfront.amazonaws.com/${API_VERSION}/origin-access-control/${id}`,
    );
    const xml =
      `<OriginAccessControl xmlns="${NAMESPACE}">${this.oacInner(oac)}</OriginAccessControl>`;
    return this.sendXml(res, 201, xml);
  }

  oacInner(oac) {
    return (
      `<Id>${oac.id}</Id>` +
      `<OriginAccessControlConfig>` +
      `<Name>${xmlEscape(oac.name)}</Name>` +
      `<Description>${xmlEscape(oac.description)}</Description>` +
      `<SigningProtocol>${oac.signingProtocol}</SigningProtocol>` +
      `<SigningBehavior>${oac.signingBehavior}</SigningBehavior>` +
      `<OriginAccessControlOriginType>${oac.originAccessControlOriginType}</OriginAccessControlOriginType>` +
      `</OriginAccessControlConfig>`
    );
  }

  listOriginAccessControls(res) {
    const items = [...this.originAccessControls.values()]
      .map(
        (o) =>
          `<OriginAccessControlSummary><Id>${o.id}</Id>` +
          `<Name>${xmlEscape(o.name)}</Name>` +
          `<Description>${xmlEscape(o.description)}</Description>` +
          `<SigningProtocol>${o.signingProtocol}</SigningProtocol>` +
          `<SigningBehavior>${o.signingBehavior}</SigningBehavior>` +
          `<OriginAccessControlOriginType>${o.originAccessControlOriginType}</OriginAccessControlOriginType>` +
          `</OriginAccessControlSummary>`,
      )
      .join("");
    const xml =
      `<OriginAccessControlList xmlns="${NAMESPACE}">` +
      `<Marker></Marker><MaxItems>100</MaxItems><IsTruncated>false</IsTruncated>` +
      `<Quantity>${this.originAccessControls.size}</Quantity><Items>${items}</Items>` +
      `</OriginAccessControlList>`;
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  sendXml(res, status, xml) {
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
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<ErrorResponse xmlns="${NAMESPACE}">` +
      `<Error><Type>Sender</Type><Code>${xmlEscape(code)}</Code>` +
      `<Message>${xmlEscape(error.message || code)}</Message></Error>` +
      `<RequestId>${requestId}</RequestId></ErrorResponse>`;
    res.end(xml);
  }
}

export default CloudfrontServer;
export const API_VERSION_CLOUDFRONT = API_VERSION;
