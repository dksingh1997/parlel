// parlel/route53 — a lightweight, dependency-free fake of AWS Route 53.
//
// Speaks the Route 53 REST/XML protocol (API version 2013-04-01). Requests are
// RESTful (e.g. POST /2013-04-01/hostedzone) with XML request bodies and XML
// responses. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const NAMESPACE = "https://route53.amazonaws.com/doc/2013-04-01/";
const API_VERSION = "2013-04-01";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidInput: 400,
  NoSuchHostedZone: 404,
  HostedZoneAlreadyExists: 409,
  HostedZoneNotEmpty: 400,
  InvalidChangeBatch: 400,
  InvalidDomainName: 400,
  InternalError: 500,
};

class Route53Error extends Error {
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

// Minimal XML extraction helpers (request bodies are simple and predictable).
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

export class Route53Server {
  constructor(port = 4711, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.hostedZones = new Map(); // id -> zone
    this.recordSets = new Map(); // zoneId -> Map<key, rrset>
    this.changeCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new Route53Error("InternalError", error.message, 500));
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

  zoneIdFromPath(part) {
    // Accept "/hostedzone/Z123" or just "Z123".
    return part.replace(/^\/?hostedzone\//, "").replace(/^\//, "");
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "route53",
        hostedZones: this.hostedZones.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-route53");

    const body = (await this.readBody(req)).toString("utf8");

    try {
      return this.route(method, path, url, body, res);
    } catch (error) {
      if (error instanceof Route53Error) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, url, body, res) {
    const base = `/${API_VERSION}`;
    if (!path.startsWith(base)) {
      throw new Route53Error("InvalidInput", `Unknown path ${path}`, 404);
    }
    const sub = path.slice(base.length); // e.g. /hostedzone or /hostedzone/Z1

    // /hostedzone
    if (sub === "/hostedzone") {
      if (method === "POST") return this.createHostedZone(body, res);
      if (method === "GET") return this.listHostedZones(url, res);
    }

    // /hostedzone/{id} and /hostedzone/{id}/rrset
    const hzMatch = sub.match(/^\/hostedzone\/([^/]+)(\/rrset)?$/);
    if (hzMatch) {
      const zoneId = hzMatch[1];
      const isRrset = !!hzMatch[2];
      if (isRrset) {
        if (method === "POST") return this.changeResourceRecordSets(zoneId, body, res);
        if (method === "GET") return this.listResourceRecordSets(zoneId, url, res);
      } else {
        if (method === "GET") return this.getHostedZone(zoneId, res);
        if (method === "DELETE") return this.deleteHostedZone(zoneId, res);
      }
    }

    throw new Route53Error("InvalidInput", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  createHostedZone(body, res) {
    const name = tagText(body, "Name");
    if (!name) throw new Route53Error("InvalidDomainName", "Name is required");
    const callerRef = tagText(body, "CallerReference");
    const comment = tagText(tagText(body, "HostedZoneConfig") || "", "Comment");
    const privateZone =
      (tagText(tagText(body, "HostedZoneConfig") || "", "PrivateZone") || "false") === "true";
    const normalizedName = name.endsWith(".") ? name : `${name}.`;

    const id = `Z${randomBytes(10).toString("hex").toUpperCase().slice(0, 18)}`;
    const fqId = `/hostedzone/${id}`;
    const zone = {
      id,
      fqId,
      name: normalizedName,
      callerReference: callerRef || randomUUID(),
      comment,
      privateZone,
      resourceRecordSetCount: 2,
    };
    this.hostedZones.set(id, zone);
    // Seed NS + SOA records like real Route 53.
    const rrset = new Map();
    rrset.set(`${normalizedName}|NS`, {
      Name: normalizedName,
      Type: "NS",
      TTL: 172800,
      ResourceRecords: [
        { Value: "ns-1.parlel.test." },
        { Value: "ns-2.parlel.test." },
      ],
    });
    rrset.set(`${normalizedName}|SOA`, {
      Name: normalizedName,
      Type: "SOA",
      TTL: 900,
      ResourceRecords: [
        { Value: "ns-1.parlel.test. hostmaster.parlel.test. 1 7200 900 1209600 86400" },
      ],
    });
    this.recordSets.set(id, rrset);

    const changeId = this.nextChangeId();
    const xml =
      `<CreateHostedZoneResponse xmlns="${NAMESPACE}">` +
      this.zoneXml(zone) +
      `<ChangeInfo><Id>/change/${changeId}</Id><Status>PENDING</Status>` +
      `<SubmittedAt>${new Date().toISOString()}</SubmittedAt></ChangeInfo>` +
      `<DelegationSet><NameServers>` +
      `<NameServer>ns-1.parlel.test</NameServer><NameServer>ns-2.parlel.test</NameServer>` +
      `</NameServers></DelegationSet>` +
      `</CreateHostedZoneResponse>`;
    return this.sendXml(res, 201, xml);
  }

  zoneXml(zone) {
    return (
      `<HostedZone>` +
      `<Id>${zone.fqId}</Id>` +
      `<Name>${xmlEscape(zone.name)}</Name>` +
      `<CallerReference>${xmlEscape(zone.callerReference)}</CallerReference>` +
      `<Config>` +
      (zone.comment ? `<Comment>${xmlEscape(zone.comment)}</Comment>` : "") +
      `<PrivateZone>${zone.privateZone}</PrivateZone>` +
      `</Config>` +
      `<ResourceRecordSetCount>${this.zoneRecordCount(zone.id)}</ResourceRecordSetCount>` +
      `</HostedZone>`
    );
  }

  zoneRecordCount(id) {
    const rrset = this.recordSets.get(id);
    return rrset ? rrset.size : 0;
  }

  listHostedZones(url, res) {
    const zones = [...this.hostedZones.values()];
    const items = zones.map((z) => this.zoneXml(z)).join("");
    const xml =
      `<ListHostedZonesResponse xmlns="${NAMESPACE}">` +
      `<HostedZones>${items}</HostedZones>` +
      `<IsTruncated>false</IsTruncated>` +
      `<MaxItems>100</MaxItems>` +
      `</ListHostedZonesResponse>`;
    return this.sendXml(res, 200, xml);
  }

  requireZone(zoneId) {
    const id = this.zoneIdFromPath(zoneId);
    const zone = this.hostedZones.get(id);
    if (!zone) {
      throw new Route53Error("NoSuchHostedZone", `No hosted zone found with ID: ${id}`, 404);
    }
    return zone;
  }

  getHostedZone(zoneId, res) {
    const zone = this.requireZone(zoneId);
    const xml =
      `<GetHostedZoneResponse xmlns="${NAMESPACE}">` +
      this.zoneXml(zone) +
      `<DelegationSet><NameServers>` +
      `<NameServer>ns-1.parlel.test</NameServer><NameServer>ns-2.parlel.test</NameServer>` +
      `</NameServers></DelegationSet>` +
      `</GetHostedZoneResponse>`;
    return this.sendXml(res, 200, xml);
  }

  deleteHostedZone(zoneId, res) {
    const zone = this.requireZone(zoneId);
    const rrset = this.recordSets.get(zone.id);
    // Real Route 53 refuses delete if non-NS/SOA records exist.
    if (rrset) {
      for (const r of rrset.values()) {
        if (r.Type !== "NS" && r.Type !== "SOA") {
          throw new Route53Error(
            "HostedZoneNotEmpty",
            "The hosted zone contains resource records that are not SOA or NS records.",
          );
        }
      }
    }
    this.hostedZones.delete(zone.id);
    this.recordSets.delete(zone.id);
    const changeId = this.nextChangeId();
    const xml =
      `<DeleteHostedZoneResponse xmlns="${NAMESPACE}">` +
      `<ChangeInfo><Id>/change/${changeId}</Id><Status>PENDING</Status>` +
      `<SubmittedAt>${new Date().toISOString()}</SubmittedAt></ChangeInfo>` +
      `</DeleteHostedZoneResponse>`;
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  changeResourceRecordSets(zoneId, body, res) {
    const zone = this.requireZone(zoneId);
    const rrset = this.recordSets.get(zone.id);
    const changeBlocks = tagBlocks(body, "Change");
    if (changeBlocks.length === 0) {
      throw new Route53Error("InvalidChangeBatch", "No changes specified");
    }
    for (const change of changeBlocks) {
      const action = tagText(change, "Action");
      const rrsBlock = tagText(change, "ResourceRecordSet");
      if (!rrsBlock) throw new Route53Error("InvalidChangeBatch", "Missing ResourceRecordSet");
      const name = tagText(rrsBlock, "Name");
      const type = tagText(rrsBlock, "Type");
      if (!name || !type) {
        throw new Route53Error("InvalidChangeBatch", "Name and Type are required");
      }
      const normalizedName = name.endsWith(".") ? name : `${name}.`;
      const ttl = tagText(rrsBlock, "TTL");
      const records = tagBlocks(rrsBlock, "ResourceRecord")
        .map((r) => ({ Value: tagText(r, "Value") }))
        .filter((r) => r.Value !== undefined);
      const key = `${normalizedName}|${type}`;

      if (action === "DELETE") {
        rrset.delete(key);
      } else {
        // CREATE or UPSERT
        rrset.set(key, {
          Name: normalizedName,
          Type: type,
          TTL: ttl ? Number(ttl) : undefined,
          ResourceRecords: records,
        });
      }
    }
    const changeId = this.nextChangeId();
    const xml =
      `<ChangeResourceRecordSetsResponse xmlns="${NAMESPACE}">` +
      `<ChangeInfo><Id>/change/${changeId}</Id><Status>PENDING</Status>` +
      `<SubmittedAt>${new Date().toISOString()}</SubmittedAt></ChangeInfo>` +
      `</ChangeResourceRecordSetsResponse>`;
    return this.sendXml(res, 200, xml);
  }

  rrsetXml(r) {
    const recs = (r.ResourceRecords || [])
      .map((rec) => `<ResourceRecord><Value>${xmlEscape(rec.Value)}</Value></ResourceRecord>`)
      .join("");
    return (
      `<ResourceRecordSet>` +
      `<Name>${xmlEscape(r.Name)}</Name>` +
      `<Type>${xmlEscape(r.Type)}</Type>` +
      (r.TTL !== undefined ? `<TTL>${r.TTL}</TTL>` : "") +
      `<ResourceRecords>${recs}</ResourceRecords>` +
      `</ResourceRecordSet>`
    );
  }

  listResourceRecordSets(zoneId, url, res) {
    const zone = this.requireZone(zoneId);
    const rrset = this.recordSets.get(zone.id);
    const items = [...rrset.values()].map((r) => this.rrsetXml(r)).join("");
    const xml =
      `<ListResourceRecordSetsResponse xmlns="${NAMESPACE}">` +
      `<ResourceRecordSets>${items}</ResourceRecordSets>` +
      `<IsTruncated>false</IsTruncated>` +
      `<MaxItems>300</MaxItems>` +
      `</ListResourceRecordSetsResponse>`;
    return this.sendXml(res, 200, xml);
  }

  nextChangeId() {
    this.changeCounter += 1;
    return `C${this.changeCounter.toString().padStart(13, "0")}`;
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

export default Route53Server;
export const API_VERSION_ROUTE53 = API_VERSION;
