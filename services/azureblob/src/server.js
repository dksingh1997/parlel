// parlel/azureblob — a lightweight, dependency-free fake of Azure Blob Storage.
//
// Speaks the Azure Blob Storage REST API (XML wire protocol + x-ms-* headers) so
// application code using the real `@azure/storage-blob` client can run against it
// with zero cost and zero side effects. Pure Node.js, no external npm
// dependencies. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).
//
// URL shape (path-style, like Azurite):
//   http://127.0.0.1:4590/<account>/<container>/<blob>?<comp>...
//
// Implements: BlobServiceClient, ContainerClient, BlobClient, BlockBlobClient,
// AppendBlobClient, PageBlobClient, BlobLeaseClient, and BlobBatchClient surfaces.

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';
const API_VERSION = "2025-05-05";
const DEFAULT_ACCOUNT = "devstoreaccount1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function md5Base64(buf) {
  return createHash("md5").update(buf).digest("base64");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(name, value) {
  if (value === undefined || value === null) return "";
  return `<${name}>${escapeXml(value)}</${name}>`;
}

// Azure timestamps use RFC1123 (HTTP date) for Last-Modified headers and
// ISO-8601-with-7-fractional-digits for XML bodies.
function httpDate(d = new Date()) {
  return d.toUTCString();
}

function azureXmlDate(d = new Date()) {
  // 2020-01-01T00:00:00.0000000Z
  const iso = d.toISOString(); // ...Z with 3 fractional digits
  return iso.replace(/\.\d+Z$/, "") + ".0000000Z";
}

function makeEtag() {
  // Azure ETags look like "0x8D...". Quote-wrapped on the wire.
  const hex = createHash("md5")
    .update(String(Math.random()) + Date.now())
    .digest("hex")
    .slice(0, 14)
    .toUpperCase();
  return `"0x8D${hex}"`;
}

function requestId() {
  return randomUUID();
}

// Container names: 3-63 chars, lowercase letters/numbers/hyphens, no leading/
// trailing hyphen, no consecutive hyphens. "$root" and "$logs" are special.
function isValidContainerName(name) {
  if (name === "$root" || name === "$logs" || name === "$web") return true;
  if (typeof name !== "string") return false;
  if (name.length < 3 || name.length > 63) return false;
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.endsWith("-")) return false;
  if (name.includes("--")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class AzureblobServer {
  constructor(port = 4590, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.account = options.account || DEFAULT_ACCOUNT;
    this.server = null;
    this.reset();
  }

  reset() {
    // containers: Map<containerName, Container>
    // Container = {
    //   name, etag, lastModified, metadata: {}, publicAccess: null|"blob"|"container",
    //   lease: { id, state, duration } | null,
    //   signedIdentifiers: [],
    //   blobs: Map<blobName, Blob>,
    // }
    // Blob = {
    //   name, blobType: "BlockBlob"|"AppendBlob"|"PageBlob",
    //   content: Buffer, etag, lastModified, contentType, contentEncoding,
    //   contentLanguage, contentDisposition, cacheControl, contentMd5,
    //   metadata: {}, tags: {}, snapshots: [{ snapshot, blob }],
    //   committedBlocks: Map<id, Buffer>, uncommittedBlocks: Map<id, Buffer>,
    //   blockOrder: [ids],
    //   sequenceNumber, committedBlockCount, pageRanges,
    //   lease: { id, state, duration } | null,
    //   deleted: bool, accessTier,
    //   copyId, copyStatus, copySource,
    // }
    this.containers = new Map();
    this.deletedContainers = new Map();
    this.serviceProperties = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, 500, "InternalError", error.message);
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
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // -------------------------------------------------------------------------
  // Addressing: /<account>/<container>/<blob...>
  // -------------------------------------------------------------------------
  resolveAddress(url) {
    const pathname = decodeURIComponent(url.pathname);
    const trimmed = pathname.replace(/^\//, "");
    if (trimmed === "") return { account: null, container: null, blob: null };
    const firstSlash = trimmed.indexOf("/");
    if (firstSlash === -1) return { account: trimmed, container: null, blob: null };
    const account = trimmed.slice(0, firstSlash);
    const rest = trimmed.slice(firstSlash + 1);
    if (rest === "") return { account, container: null, blob: null };
    const secondSlash = rest.indexOf("/");
    if (secondSlash === -1) return { account, container: rest, blob: null };
    return {
      account,
      container: rest.slice(0, secondSlash),
      blob: rest.slice(secondSlash + 1),
    };
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const params = url.searchParams;

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "azureblob", containers: this.containers.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    const { account, container, blob } = this.resolveAddress(url);
    const body = await this.readBody(req);

    res.setHeader("x-ms-request-id", requestId());
    res.setHeader("x-ms-version", API_VERSION);
    res.setHeader("Server", "parlel-azureblob");
    res.setHeader("Date", httpDate());

    if (!account) {
      return this.sendError(res, 400, "InvalidUri", "The requested URI does not represent any resource on the server.");
    }

    const comp = params.get("comp");
    const restype = params.get("restype");

    // Service-level: /<account>/?...  (no container)
    if (!container) {
      return this.handleService(req, res, method, comp, restype, params, body);
    }

    // Container-level: /<account>/<container>?restype=container...
    if (!blob) {
      return this.handleContainer(req, res, method, container, comp, restype, params, body);
    }

    // Blob-level
    return this.handleBlob(req, res, method, container, blob, comp, params, body);
  }

  // -------------------------------------------------------------------------
  // Service-level operations
  // -------------------------------------------------------------------------
  handleService(req, res, method, comp, restype, params, body) {
    if (comp === "properties" && restype === "service" && method === "GET") {
      return this.getServiceProperties(res);
    }
    if (comp === "properties" && restype === "service" && method === "PUT") {
      return this.setServiceProperties(res, body);
    }
    if (comp === "properties" && restype === "account" && method === "GET") {
      return this.getAccountInfo(res);
    }
    if (comp === "list" && method === "GET") {
      return this.listContainers(res, params);
    }
    if (comp === "stats" && method === "GET") {
      return this.getServiceStats(res);
    }
    if (comp === "blobs" && method === "GET") {
      return this.findBlobsByTags(res, params);
    }
    if (comp === "batch" && method === "POST") {
      return this.submitBatch(req, res, params, body, null);
    }
    return this.sendError(res, 400, "InvalidQueryParameterValue", "Unsupported service operation.");
  }

  getServiceProperties(res) {
    const xml =
      `${XML_HEADER}<StorageServiceProperties>` +
      `<Logging><Version>1.0</Version><Delete>false</Delete><Read>false</Read><Write>false</Write><RetentionPolicy><Enabled>false</Enabled></RetentionPolicy></Logging>` +
      `<HourMetrics><Version>1.0</Version><Enabled>false</Enabled><RetentionPolicy><Enabled>false</Enabled></RetentionPolicy></HourMetrics>` +
      `<MinuteMetrics><Version>1.0</Version><Enabled>false</Enabled><RetentionPolicy><Enabled>false</Enabled></RetentionPolicy></MinuteMetrics>` +
      `<DefaultServiceVersion>${API_VERSION}</DefaultServiceVersion>` +
      `</StorageServiceProperties>`;
    return this.sendXml(res, 200, xml);
  }

  setServiceProperties(res, body) {
    this.serviceProperties = body.toString("utf8");
    res.statusCode = 202;
    res.end();
  }

  getServiceStats(res) {
    const xml = `${XML_HEADER}<StorageServiceStats><GeoReplication><Status>live</Status><LastSyncTime>${httpDate()}</LastSyncTime></GeoReplication></StorageServiceStats>`;
    return this.sendXml(res, 200, xml);
  }

  getAccountInfo(res) {
    res.setHeader("x-ms-sku-name", "Standard_LRS");
    res.setHeader("x-ms-account-kind", "StorageV2");
    res.setHeader("x-ms-is-hns-enabled", "false");
    res.statusCode = 200;
    res.end();
  }

  listContainers(res, params) {
    const prefix = params.get("prefix") || "";
    const includeMetadata = (params.get("include") || "").includes("metadata");
    const maxResults = parseInt(params.get("maxresults") || "5000", 10);

    const names = [...this.containers.keys()]
      .filter((n) => n.startsWith(prefix))
      .sort();

    const page = names.slice(0, maxResults);
    let xml = `${XML_HEADER}<EnumerationResults ServiceEndpoint="http://${this.host}:${this.port}/${this.account}/">`;
    if (prefix) xml += tag("Prefix", prefix);
    xml += `<MaxResults>${maxResults}</MaxResults>`;
    xml += "<Containers>";
    for (const name of page) {
      const c = this.containers.get(name);
      xml += "<Container>";
      xml += tag("Name", name);
      xml += "<Properties>";
      xml += tag("Last-Modified", httpDate(new Date(c.lastModified)));
      xml += tag("Etag", c.etag);
      xml += tag("LeaseStatus", c.lease ? "locked" : "unlocked");
      xml += tag("LeaseState", c.lease ? c.lease.state : "available");
      if (c.publicAccess) xml += tag("PublicAccess", c.publicAccess);
      xml += tag("HasImmutabilityPolicy", "false");
      xml += tag("HasLegalHold", "false");
      xml += "</Properties>";
      if (includeMetadata && Object.keys(c.metadata).length) {
        xml += "<Metadata>";
        for (const [k, v] of Object.entries(c.metadata)) xml += tag(k, v);
        xml += "</Metadata>";
      }
      xml += "</Container>";
    }
    xml += "</Containers>";
    xml += "<NextMarker/>";
    xml += "</EnumerationResults>";
    return this.sendXml(res, 200, xml);
  }

  findBlobsByTags(res, params) {
    const where = params.get("where") || "";
    // Parse simple "key='value'" expressions joined by AND.
    const conds = [];
    const re = /"?([@\w-]+)"?\s*=\s*'([^']*)'/g;
    let m;
    while ((m = re.exec(where)) !== null) conds.push([m[1], m[2]]);

    let xml = `${XML_HEADER}<EnumerationResults ServiceEndpoint="http://${this.host}:${this.port}/${this.account}/">`;
    xml += "<Blobs>";
    for (const [cname, container] of this.containers) {
      for (const [bname, b] of container.blobs) {
        if (b.deleted) continue;
        const matches = conds.every(([k, v]) => String(b.tags[k]) === v);
        if (conds.length && matches) {
          xml += "<Blob>";
          xml += tag("Name", bname);
          xml += tag("ContainerName", cname);
          xml += "<Tags><TagSet>";
          for (const [tk, tv] of Object.entries(b.tags)) {
            xml += `<Tag>${tag("Key", tk)}${tag("Value", tv)}</Tag>`;
          }
          xml += "</TagSet></Tags>";
          xml += "</Blob>";
        }
      }
    }
    xml += "</Blobs><NextMarker/></EnumerationResults>";
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // Container-level operations
  // -------------------------------------------------------------------------
  handleContainer(req, res, method, name, comp, restype, params, body) {
    if (restype === "container" && !comp) {
      if (method === "PUT") return this.createContainer(req, res, name);
      if (method === "GET" || method === "HEAD") return this.getContainerProperties(req, res, name);
      if (method === "DELETE") return this.deleteContainer(req, res, name);
    }
    if (restype === "container" && comp === "metadata") {
      if (method === "PUT") return this.setContainerMetadata(req, res, name);
      if (method === "GET" || method === "HEAD") return this.getContainerProperties(req, res, name);
    }
    if (restype === "container" && comp === "acl") {
      if (method === "GET") return this.getContainerAcl(req, res, name);
      if (method === "PUT") return this.setContainerAcl(req, res, name, body);
    }
    if (restype === "container" && comp === "lease" && method === "PUT") {
      return this.containerLease(req, res, name);
    }
    if (restype === "container" && comp === "undelete" && method === "PUT") {
      return this.undeleteContainer(req, res, name);
    }
    if (comp === "list" && restype === "container" && method === "GET") {
      return this.listBlobs(req, res, name, params);
    }
    if (comp === "batch" && method === "POST") {
      return this.submitBatch(req, res, params, body, name);
    }
    return this.sendError(res, 400, "InvalidQueryParameterValue", "Unsupported container operation.");
  }

  getContainer(name) {
    return this.containers.get(name) || null;
  }

  requireContainer(res, name) {
    const c = this.getContainer(name);
    if (!c) {
      this.sendError(res, 404, "ContainerNotFound", "The specified container does not exist.");
      return null;
    }
    return c;
  }

  createContainer(req, res, name) {
    if (!isValidContainerName(name)) {
      return this.sendError(res, 400, "InvalidResourceName", "The specified resource name contains invalid characters.");
    }
    if (this.containers.has(name)) {
      return this.sendError(res, 409, "ContainerAlreadyExists", "The specified container already exists.");
    }
    const publicAccess = req.headers["x-ms-blob-public-access"] || null;
    const etag = makeEtag();
    const lastModified = Date.now();
    this.containers.set(name, {
      name,
      etag,
      lastModified,
      metadata: this.extractMetadata(req),
      publicAccess,
      lease: null,
      signedIdentifiers: [],
      blobs: new Map(),
    });
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", httpDate(new Date(lastModified)));
    res.statusCode = 201;
    res.end();
  }

  getContainerProperties(req, res, name) {
    const c = this.getContainer(name);
    if (!c) {
      // HEAD/GET on missing container: status 404, no body for HEAD.
      res.statusCode = 404;
      res.setHeader("x-ms-error-code", "ContainerNotFound");
      if (req.method === "HEAD") return res.end();
      return this.sendError(res, 404, "ContainerNotFound", "The specified container does not exist.");
    }
    res.setHeader("ETag", c.etag);
    res.setHeader("Last-Modified", httpDate(new Date(c.lastModified)));
    res.setHeader("x-ms-lease-status", c.lease ? "locked" : "unlocked");
    res.setHeader("x-ms-lease-state", c.lease ? c.lease.state : "available");
    if (c.lease && c.lease.duration) res.setHeader("x-ms-lease-duration", c.lease.duration);
    if (c.publicAccess) res.setHeader("x-ms-blob-public-access", c.publicAccess);
    res.setHeader("x-ms-has-immutability-policy", "false");
    res.setHeader("x-ms-has-legal-hold", "false");
    res.setHeader("x-ms-default-encryption-scope", "$account-encryption-key");
    res.setHeader("x-ms-deny-encryption-scope-override", "false");
    for (const [k, v] of Object.entries(c.metadata)) res.setHeader(`x-ms-meta-${k}`, v);
    res.statusCode = 200;
    res.end();
  }

  setContainerMetadata(req, res, name) {
    const c = this.requireContainer(res, name);
    if (!c) return;
    c.metadata = this.extractMetadata(req);
    c.etag = makeEtag();
    c.lastModified = Date.now();
    res.setHeader("ETag", c.etag);
    res.setHeader("Last-Modified", httpDate(new Date(c.lastModified)));
    res.statusCode = 200;
    res.end();
  }

  deleteContainer(req, res, name) {
    const c = this.requireContainer(res, name);
    if (!c) return;
    this.containers.delete(name);
    this.deletedContainers.set(name, c);
    res.statusCode = 202;
    res.end();
  }

  undeleteContainer(req, res, name) {
    const deleted = this.deletedContainers.get(name);
    if (!deleted) {
      // Nothing to restore; treat as a no-op success (Azure returns 201).
      res.statusCode = 201;
      return res.end();
    }
    this.deletedContainers.delete(name);
    if (!this.containers.has(name)) this.containers.set(name, deleted);
    res.statusCode = 201;
    res.end();
  }

  getContainerAcl(req, res, name) {
    const c = this.requireContainer(res, name);
    if (!c) return;
    if (c.publicAccess) res.setHeader("x-ms-blob-public-access", c.publicAccess);
    res.setHeader("ETag", c.etag);
    res.setHeader("Last-Modified", httpDate(new Date(c.lastModified)));
    let xml = `${XML_HEADER}<SignedIdentifiers>`;
    for (const si of c.signedIdentifiers) {
      xml += "<SignedIdentifier>";
      xml += tag("Id", si.id);
      xml += "<AccessPolicy>";
      if (si.start) xml += tag("Start", si.start);
      if (si.expiry) xml += tag("Expiry", si.expiry);
      if (si.permission) xml += tag("Permission", si.permission);
      xml += "</AccessPolicy>";
      xml += "</SignedIdentifier>";
    }
    xml += "</SignedIdentifiers>";
    return this.sendXml(res, 200, xml);
  }

  setContainerAcl(req, res, name, body) {
    const c = this.requireContainer(res, name);
    if (!c) return;
    const publicAccess = req.headers["x-ms-blob-public-access"];
    c.publicAccess = publicAccess || null;
    const xml = body.toString("utf8");
    const ids = [];
    const re = /<SignedIdentifier>([\s\S]*?)<\/SignedIdentifier>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const inner = m[1];
      const id = (/<Id>([\s\S]*?)<\/Id>/.exec(inner) || [])[1];
      const start = (/<Start>([\s\S]*?)<\/Start>/.exec(inner) || [])[1];
      const expiry = (/<Expiry>([\s\S]*?)<\/Expiry>/.exec(inner) || [])[1];
      const permission = (/<Permission>([\s\S]*?)<\/Permission>/.exec(inner) || [])[1];
      ids.push({ id, start, expiry, permission });
    }
    c.signedIdentifiers = ids;
    c.etag = makeEtag();
    c.lastModified = Date.now();
    res.setHeader("ETag", c.etag);
    res.setHeader("Last-Modified", httpDate(new Date(c.lastModified)));
    res.statusCode = 200;
    res.end();
  }

  containerLease(req, res, name) {
    const c = this.requireContainer(res, name);
    if (!c) return;
    return this.handleLease(req, res, c, "container");
  }

  // -------------------------------------------------------------------------
  // List Blobs (flat + hierarchy)
  // -------------------------------------------------------------------------
  listBlobs(req, res, name, params) {
    const c = this.requireContainer(res, name);
    if (!c) return;
    const prefix = params.get("prefix") || "";
    const delimiter = params.get("delimiter");
    const maxResults = parseInt(params.get("maxresults") || "5000", 10);
    const include = (params.get("include") || "").split(",").filter(Boolean);
    const includeMetadata = include.includes("metadata");
    const includeTags = include.includes("tags");
    const includeSnapshots = include.includes("snapshots");
    const includeUncommitted = include.includes("uncommittedblobs");
    const includeDeleted = include.includes("deleted");

    const live = [];
    for (const [bname, b] of c.blobs) {
      if (b.deleted && !includeDeleted) continue;
      if (b.uncommitted && !includeUncommitted) continue;
      if (!bname.startsWith(prefix)) continue;
      live.push([bname, b]);
    }
    live.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const blobPrefixes = new Set();
    const blobs = [];
    for (const [bname, b] of live) {
      if (delimiter) {
        const rest = bname.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx !== -1) {
          blobPrefixes.add(prefix + rest.slice(0, idx + delimiter.length));
          continue;
        }
      }
      blobs.push([bname, b]);
    }

    let xml = `${XML_HEADER}<EnumerationResults ServiceEndpoint="http://${this.host}:${this.port}/${this.account}/" ContainerName="${escapeXml(name)}">`;
    if (prefix) xml += tag("Prefix", prefix);
    if (delimiter) xml += tag("Delimiter", delimiter);
    xml += `<MaxResults>${maxResults}</MaxResults>`;
    xml += "<Blobs>";
    for (const [bname, b] of blobs.slice(0, maxResults)) {
      const emitOne = (blob, snapshot) => {
        let s = "<Blob>";
        s += tag("Name", bname);
        if (snapshot) s += tag("Snapshot", snapshot);
        s += "<Properties>";
        s += tag("Last-Modified", httpDate(new Date(blob.lastModified)));
        s += tag("Etag", blob.etag);
        s += tag("Content-Length", blob.content.length);
        s += tag("Content-Type", blob.contentType || "application/octet-stream");
        if (blob.contentEncoding) s += tag("Content-Encoding", blob.contentEncoding);
        if (blob.contentLanguage) s += tag("Content-Language", blob.contentLanguage);
        s += tag("Content-MD5", blob.contentMd5 || "");
        if (blob.cacheControl) s += tag("Cache-Control", blob.cacheControl);
        if (blob.contentDisposition) s += tag("Content-Disposition", blob.contentDisposition);
        if (blob.blobType === "PageBlob") s += tag("x-ms-blob-sequence-number", blob.sequenceNumber || 0);
        s += tag("BlobType", blob.blobType);
        s += tag("AccessTier", blob.accessTier || "Hot");
        s += tag("AccessTierInferred", "true");
        s += tag("LeaseStatus", blob.lease ? "locked" : "unlocked");
        s += tag("LeaseState", blob.lease ? blob.lease.state : "available");
        s += tag("ServerEncrypted", "true");
        s += "</Properties>";
        if (includeMetadata && Object.keys(blob.metadata).length) {
          s += "<Metadata>";
          for (const [k, v] of Object.entries(blob.metadata)) s += tag(k, v);
          s += "</Metadata>";
        }
        if (includeTags && Object.keys(blob.tags).length) {
          s += "<Tags><TagSet>";
          for (const [tk, tv] of Object.entries(blob.tags)) s += `<Tag>${tag("Key", tk)}${tag("Value", tv)}</Tag>`;
          s += "</TagSet></Tags>";
        }
        s += "</Blob>";
        return s;
      };
      if (includeSnapshots) {
        for (const snap of b.snapshots) xml += emitOne(snap.blob, snap.snapshot);
      }
      xml += emitOne(b, null);
    }
    for (const p of [...blobPrefixes].sort()) {
      xml += `<BlobPrefix>${tag("Name", p)}</BlobPrefix>`;
    }
    xml += "</Blobs>";
    xml += "<NextMarker/>";
    xml += "</EnumerationResults>";
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // Blob-level routing
  // -------------------------------------------------------------------------
  handleBlob(req, res, method, containerName, blobName, comp, params, body) {
    const has = (c) => comp === c;

    // PUT verbs distinguished by comp + headers
    if (method === "PUT") {
      if (has("block")) return this.stageBlock(req, res, containerName, blobName, params, body);
      if (has("blocklist")) return this.commitBlockList(req, res, containerName, blobName, body);
      if (has("appendblock")) return this.appendBlock(req, res, containerName, blobName, body);
      if (has("page")) return this.uploadPages(req, res, containerName, blobName, body);
      if (has("metadata")) return this.setBlobMetadata(req, res, containerName, blobName);
      if (has("properties")) return this.setBlobProperties(req, res, containerName, blobName);
      if (has("tags")) return this.setBlobTags(req, res, containerName, blobName, body);
      if (has("tier")) return this.setAccessTier(req, res, containerName, blobName);
      if (has("lease")) return this.blobLease(req, res, containerName, blobName);
      if (has("snapshot")) return this.createSnapshot(req, res, containerName, blobName);
      if (has("seal")) return this.sealAppendBlob(req, res, containerName, blobName);
      if (has("undelete")) return this.undeleteBlob(req, res, containerName, blobName);
      if (has("expiry")) return this.setBlobExpiry(req, res, containerName, blobName);
      if (has("copy")) return this.abortCopy(req, res, containerName, blobName, params);
      // PutBlob (BlockBlob / AppendBlob / PageBlob create) or copy-from-url
      if (req.headers["x-ms-copy-source"]) return this.copyFromUrl(req, res, containerName, blobName, body);
      return this.putBlob(req, res, containerName, blobName, body);
    }

    if (method === "GET") {
      if (has("blocklist")) return this.getBlockList(req, res, containerName, blobName, params);
      if (has("pagelist")) return this.getPageRanges(req, res, containerName, blobName, params);
      if (has("tags")) return this.getBlobTags(req, res, containerName, blobName, params);
      return this.downloadBlob(req, res, containerName, blobName, params);
    }

    if (method === "HEAD") {
      return this.getBlobProperties(req, res, containerName, blobName, params);
    }

    if (method === "DELETE") {
      return this.deleteBlob(req, res, containerName, blobName, params);
    }

    return this.sendError(res, 405, "UnsupportedHttpVerb", "The resource doesn't support the specified HTTP verb.");
  }

  getBlob(container, name) {
    return container.blobs.get(name) || null;
  }

  requireBlob(res, container, name) {
    const b = this.getBlob(container, name);
    if (!b || b.deleted || b.uncommitted) {
      this.sendError(res, 404, "BlobNotFound", "The specified blob does not exist.");
      return null;
    }
    return b;
  }

  newBlob(name, blobType) {
    return {
      name,
      blobType,
      content: Buffer.alloc(0),
      etag: makeEtag(),
      lastModified: Date.now(),
      contentType: "application/octet-stream",
      contentEncoding: undefined,
      contentLanguage: undefined,
      contentDisposition: undefined,
      cacheControl: undefined,
      contentMd5: undefined,
      metadata: {},
      tags: {},
      snapshots: [],
      committedBlocks: new Map(),
      uncommittedBlocks: new Map(),
      blockOrder: [],
      sequenceNumber: 0,
      lease: null,
      deleted: false,
      uncommitted: false,
      accessTier: undefined,
      copyId: undefined,
      copyStatus: undefined,
      copySource: undefined,
    };
  }

  // -------------------------------------------------------------------------
  // PutBlob (upload) — BlockBlob full upload, AppendBlob/PageBlob create
  // -------------------------------------------------------------------------
  putBlob(req, res, containerName, blobName, body) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const blobType = req.headers["x-ms-blob-type"] || "BlockBlob";

    const contentMd5Header = req.headers["content-md5"];
    if (contentMd5Header && blobType === "BlockBlob") {
      if (contentMd5Header !== md5Base64(body)) {
        return this.sendError(res, 400, "Md5Mismatch", "The MD5 value specified in the request did not match with the MD5 value calculated by the server.");
      }
    }

    let b = c.blobs.get(blobName);
    if (!b || b.deleted) {
      b = this.newBlob(blobName, blobType);
      c.blobs.set(blobName, b);
    } else {
      // Overwriting an existing blob preserves its snapshots (Azure semantics).
      b.blobType = blobType;
      b.committedBlocks = new Map();
      b.uncommittedBlocks = new Map();
      b.blockOrder = [];
    }

    if (blobType === "PageBlob") {
      const len = parseInt(req.headers["x-ms-blob-content-length"] || "0", 10);
      b.content = Buffer.alloc(len);
      b.sequenceNumber = parseInt(req.headers["x-ms-blob-sequence-number"] || "0", 10);
    } else if (blobType === "AppendBlob") {
      b.content = Buffer.alloc(0);
      b.committedBlockCount = 0;
    } else {
      // BlockBlob
      b.content = Buffer.from(body);
    }

    this.applyBlobHttpHeaders(req, b);
    b.metadata = this.extractMetadata(req);
    b.tags = this.parseTagsHeader(req.headers["x-ms-tags"]);
    b.contentMd5 = req.headers["x-ms-blob-content-md5"] || (blobType === "BlockBlob" ? md5Base64(b.content) : undefined);
    b.etag = makeEtag();
    b.lastModified = Date.now();
    b.uncommitted = false;
    b.deleted = false;

    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    if (b.contentMd5) res.setHeader("Content-MD5", b.contentMd5);
    res.setHeader("x-ms-request-server-encrypted", "true");
    res.statusCode = 201;
    res.end();
  }

  applyBlobHttpHeaders(req, b) {
    if (req.headers["x-ms-blob-content-type"] !== undefined) b.contentType = req.headers["x-ms-blob-content-type"];
    else if (req.headers["content-type"] && b.contentType === "application/octet-stream") {
      // For block blob upload, content-type header maps to blob content type only
      // if x-ms-blob-content-type not set. SDK sets application/octet-stream by default.
    }
    if (req.headers["x-ms-blob-content-encoding"] !== undefined) b.contentEncoding = req.headers["x-ms-blob-content-encoding"];
    if (req.headers["x-ms-blob-content-language"] !== undefined) b.contentLanguage = req.headers["x-ms-blob-content-language"];
    if (req.headers["x-ms-blob-content-disposition"] !== undefined) b.contentDisposition = req.headers["x-ms-blob-content-disposition"];
    if (req.headers["x-ms-blob-cache-control"] !== undefined) b.cacheControl = req.headers["x-ms-blob-cache-control"];
    if (req.headers["x-ms-blob-content-md5"] !== undefined) b.contentMd5 = req.headers["x-ms-blob-content-md5"];
  }

  // -------------------------------------------------------------------------
  // Download (GetBlob) — with range + conditional
  // -------------------------------------------------------------------------
  downloadBlob(req, res, containerName, blobName, params) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const snapshot = params.get("snapshot");
    let b = this.getBlob(c, blobName);
    if (snapshot && b) {
      const snap = b.snapshots.find((s) => s.snapshot === snapshot);
      b = snap ? snap.blob : null;
    }
    if (!b || b.deleted || b.uncommitted) {
      return this.sendError(res, 404, "BlobNotFound", "The specified blob does not exist.");
    }

    const cond = this.checkConditional(req, b);
    if (cond) return this.sendError(res, cond.status, cond.code, cond.message);

    let content = b.content;
    let status = 200;
    const total = content.length;

    const rangeHeader = req.headers["x-ms-range"] || req.headers.range;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (match) {
        let start = match[1] === "" ? 0 : parseInt(match[1], 10);
        let end = match[2] === "" ? total - 1 : parseInt(match[2], 10);
        if (end >= total) end = total - 1;
        if (start > end || start >= total) {
          res.setHeader("Content-Range", `bytes */${total}`);
          return this.sendError(res, 416, "InvalidRange", "The range specified is invalid for the current size of the resource.");
        }
        content = content.subarray(start, end + 1);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        status = 206;
      }
    }

    this.applyBlobResponseHeaders(res, b);
    res.setHeader("Content-Length", String(content.length));
    res.setHeader("Accept-Ranges", "bytes");
    res.statusCode = status;
    res.end(content);
  }

  applyBlobResponseHeaders(res, b) {
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.setHeader("Content-Type", b.contentType || "application/octet-stream");
    res.setHeader("x-ms-blob-type", b.blobType);
    res.setHeader("x-ms-creation-time", httpDate(new Date(b.lastModified)));
    res.setHeader("x-ms-lease-status", b.lease ? "locked" : "unlocked");
    res.setHeader("x-ms-lease-state", b.lease ? b.lease.state : "available");
    res.setHeader("x-ms-server-encrypted", "true");
    res.setHeader("Accept-Ranges", "bytes");
    if (b.contentEncoding) res.setHeader("Content-Encoding", b.contentEncoding);
    if (b.contentLanguage) res.setHeader("Content-Language", b.contentLanguage);
    if (b.contentDisposition) res.setHeader("Content-Disposition", b.contentDisposition);
    if (b.cacheControl) res.setHeader("Cache-Control", b.cacheControl);
    if (b.contentMd5) res.setHeader("Content-MD5", b.contentMd5);
    if (b.accessTier) {
      res.setHeader("x-ms-access-tier", b.accessTier);
    } else {
      res.setHeader("x-ms-access-tier", b.blobType === "BlockBlob" ? "Hot" : "");
      res.setHeader("x-ms-access-tier-inferred", "true");
    }
    if (b.blobType === "PageBlob") res.setHeader("x-ms-blob-sequence-number", String(b.sequenceNumber || 0));
    if (b.blobType === "AppendBlob") res.setHeader("x-ms-blob-committed-block-count", String(b.committedBlockCount || 0));
    const tagCount = Object.keys(b.tags).length;
    if (tagCount) res.setHeader("x-ms-tag-count", String(tagCount));
    for (const [k, v] of Object.entries(b.metadata)) res.setHeader(`x-ms-meta-${k}`, v);
    if (b.copyId) {
      res.setHeader("x-ms-copy-id", b.copyId);
      res.setHeader("x-ms-copy-status", b.copyStatus);
      res.setHeader("x-ms-copy-source", b.copySource);
    }
  }

  checkConditional(req, b) {
    const etag = b.etag;
    const lastMod = b.lastModified;
    const ifMatch = req.headers["if-match"];
    const ifNoneMatch = req.headers["if-none-match"];
    const ifModSince = req.headers["if-modified-since"];
    const ifUnmodSince = req.headers["if-unmodified-since"];
    const norm = (e) => String(e).trim();

    if (ifMatch && ifMatch !== "*" && !ifMatch.split(",").map(norm).includes(etag)) {
      return { status: 412, code: "ConditionNotMet", message: "The condition specified using HTTP conditional header(s) is not met." };
    }
    if (ifNoneMatch && (ifNoneMatch === "*" || ifNoneMatch.split(",").map(norm).includes(etag))) {
      return { status: 304, code: "ConditionNotMet", message: "The condition specified using HTTP conditional header(s) is not met." };
    }
    if (ifUnmodSince && lastMod > Date.parse(ifUnmodSince) + 999) {
      return { status: 412, code: "ConditionNotMet", message: "The condition specified using HTTP conditional header(s) is not met." };
    }
    if (ifModSince && lastMod <= Date.parse(ifModSince)) {
      return { status: 304, code: "ConditionNotMet", message: "The condition specified using HTTP conditional header(s) is not met." };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // GetBlobProperties (HEAD)
  // -------------------------------------------------------------------------
  getBlobProperties(req, res, containerName, blobName, params) {
    const c = this.getContainer(containerName);
    if (!c) {
      res.statusCode = 404;
      res.setHeader("x-ms-error-code", "ContainerNotFound");
      return res.end();
    }
    const snapshot = params.get("snapshot");
    let b = this.getBlob(c, blobName);
    if (snapshot && b) {
      const snap = b.snapshots.find((s) => s.snapshot === snapshot);
      b = snap ? snap.blob : null;
    }
    if (!b || b.deleted || b.uncommitted) {
      res.statusCode = 404;
      res.setHeader("x-ms-error-code", "BlobNotFound");
      return res.end();
    }
    const cond = this.checkConditional(req, b);
    if (cond) {
      res.statusCode = cond.status;
      res.setHeader("x-ms-error-code", cond.code);
      return res.end();
    }
    this.applyBlobResponseHeaders(res, b);
    res.setHeader("Content-Length", String(b.content.length));
    res.statusCode = 200;
    res.end();
  }

  // -------------------------------------------------------------------------
  // SetBlobMetadata / SetBlobProperties / Tags / Tier / Expiry
  // -------------------------------------------------------------------------
  setBlobMetadata(req, res, containerName, blobName) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    b.metadata = this.extractMetadata(req);
    b.etag = makeEtag();
    b.lastModified = Date.now();
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.statusCode = 200;
    res.end();
  }

  setBlobProperties(req, res, containerName, blobName) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    // PageBlob resize via x-ms-blob-content-length
    const newLen = req.headers["x-ms-blob-content-length"];
    if (newLen !== undefined && b.blobType === "PageBlob") {
      const len = parseInt(newLen, 10);
      if (len > b.content.length) {
        b.content = Buffer.concat([b.content, Buffer.alloc(len - b.content.length)]);
      } else {
        b.content = b.content.subarray(0, len);
      }
      res.setHeader("x-ms-blob-sequence-number", String(b.sequenceNumber || 0));
    }
    this.applyBlobHttpHeaders(req, b);
    b.etag = makeEtag();
    b.lastModified = Date.now();
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.statusCode = 200;
    res.end();
  }

  setBlobTags(req, res, containerName, blobName, body) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    b.tags = this.parseTagsXml(body.toString("utf8"));
    res.statusCode = 204;
    res.end();
  }

  getBlobTags(req, res, containerName, blobName, params) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    let xml = `${XML_HEADER}<Tags><TagSet>`;
    for (const [k, v] of Object.entries(b.tags)) {
      xml += `<Tag>${tag("Key", k)}${tag("Value", v)}</Tag>`;
    }
    xml += "</TagSet></Tags>";
    return this.sendXml(res, 200, xml);
  }

  setAccessTier(req, res, containerName, blobName) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    b.accessTier = req.headers["x-ms-access-tier"];
    res.statusCode = 200;
    res.end();
  }

  setBlobExpiry(req, res, containerName, blobName) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.statusCode = 200;
    res.end();
  }

  // -------------------------------------------------------------------------
  // Snapshot / Undelete / Delete
  // -------------------------------------------------------------------------
  createSnapshot(req, res, containerName, blobName) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    const snapshotTime = azureXmlDate();
    const copy = {
      ...b,
      content: Buffer.from(b.content),
      metadata: { ...b.metadata },
      tags: { ...b.tags },
      snapshots: [],
    };
    b.snapshots.push({ snapshot: snapshotTime, blob: copy });
    res.setHeader("x-ms-snapshot", snapshotTime);
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.statusCode = 201;
    res.end();
  }

  undeleteBlob(req, res, containerName, blobName) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.getBlob(c, blobName);
    if (!b) {
      return this.sendError(res, 404, "BlobNotFound", "The specified blob does not exist.");
    }
    b.deleted = false;
    res.statusCode = 200;
    res.end();
  }

  sealAppendBlob(req, res, containerName, blobName) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    if (b.blobType !== "AppendBlob") {
      return this.sendError(res, 409, "InvalidBlobType", "The blob type is invalid for this operation.");
    }
    b.sealed = true;
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.setHeader("x-ms-blob-sealed", "true");
    res.statusCode = 200;
    res.end();
  }

  deleteBlob(req, res, containerName, blobName, params) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const snapshot = params.get("snapshot");
    const b = this.getBlob(c, blobName);
    if (!b || b.deleted) {
      return this.sendError(res, 404, "BlobNotFound", "The specified blob does not exist.");
    }
    if (snapshot) {
      b.snapshots = b.snapshots.filter((s) => s.snapshot !== snapshot);
      res.statusCode = 202;
      return res.end();
    }
    const deleteSnapshots = req.headers["x-ms-delete-snapshots"];
    if (b.snapshots.length && !deleteSnapshots) {
      return this.sendError(res, 409, "SnapshotsPresent", "This operation is not permitted because the blob has snapshots.");
    }
    if (deleteSnapshots === "only") {
      b.snapshots = [];
      res.statusCode = 202;
      return res.end();
    }
    // "include": delete blob + all snapshots. Also handles no-snapshots case.
    b.snapshots = [];
    b.deleted = true;
    res.statusCode = 202;
    res.end();
  }

  // -------------------------------------------------------------------------
  // Block blob: StageBlock / CommitBlockList / GetBlockList
  // -------------------------------------------------------------------------
  stageBlock(req, res, containerName, blobName, params, body) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    let b = c.blobs.get(blobName);
    if (!b || b.deleted) {
      b = this.newBlob(blobName, "BlockBlob");
      b.uncommitted = true;
      c.blobs.set(blobName, b);
    }
    const blockId = params.get("blockid");
    if (!blockId) {
      return this.sendError(res, 400, "InvalidQueryParameterValue", "blockid is required.");
    }
    // StageBlockFromURL: pull bytes from the source blob instead of the body.
    const copySource = req.headers["x-ms-copy-source"];
    let blockData = body;
    if (copySource) {
      const sourced = this.readSourceRange(copySource, req.headers["x-ms-source-range"]);
      if (sourced === null) {
        return this.sendError(res, 404, "CannotVerifyCopySource", "The specified source blob could not be found or read.");
      }
      blockData = sourced;
    }
    const contentMd5Header = req.headers["content-md5"];
    if (contentMd5Header && contentMd5Header !== md5Base64(blockData)) {
      return this.sendError(res, 400, "Md5Mismatch", "The MD5 value specified in the request did not match with the MD5 value calculated by the server.");
    }
    b.uncommittedBlocks.set(blockId, Buffer.from(blockData));
    res.setHeader("Content-MD5", md5Base64(blockData));
    res.setHeader("x-ms-request-server-encrypted", "true");
    res.statusCode = 201;
    res.end();
  }

  commitBlockList(req, res, containerName, blobName, body) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = c.blobs.get(blobName);
    if (!b) {
      return this.sendError(res, 400, "InvalidBlockList", "The specified block list is invalid.");
    }
    const xml = body.toString("utf8");
    const order = [];
    // Latest / Committed / Uncommitted blocks
    const re = /<(Latest|Committed|Uncommitted)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      order.push({ type: m[1], id: unescapeXml(m[2]) });
    }

    const buffers = [];
    const committed = new Map();
    const newOrder = [];
    for (const item of order) {
      let buf;
      if (item.type === "Committed") buf = b.committedBlocks.get(item.id);
      else if (item.type === "Uncommitted") buf = b.uncommittedBlocks.get(item.id);
      else buf = b.uncommittedBlocks.get(item.id) || b.committedBlocks.get(item.id);
      if (buf === undefined) {
        return this.sendError(res, 400, "InvalidBlockList", "The specified block list is invalid.");
      }
      buffers.push(buf);
      committed.set(item.id, buf);
      newOrder.push(item.id);
    }

    b.content = Buffer.concat(buffers);
    b.committedBlocks = committed;
    b.blockOrder = newOrder;
    b.uncommittedBlocks = new Map();
    b.blobType = "BlockBlob";
    b.uncommitted = false;
    b.deleted = false;
    this.applyBlobHttpHeaders(req, b);
    const meta = this.extractMetadata(req);
    if (Object.keys(meta).length) b.metadata = meta;
    const tagsHeader = this.parseTagsHeader(req.headers["x-ms-tags"]);
    if (Object.keys(tagsHeader).length) b.tags = tagsHeader;
    b.contentMd5 = req.headers["x-ms-blob-content-md5"] || md5Base64(b.content);
    b.etag = makeEtag();
    b.lastModified = Date.now();

    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.setHeader("x-ms-request-server-encrypted", "true");
    res.statusCode = 201;
    res.end();
  }

  getBlockList(req, res, containerName, blobName, params) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = c.blobs.get(blobName);
    if (!b || b.deleted) {
      return this.sendError(res, 404, "BlobNotFound", "The specified blob does not exist.");
    }
    const listType = params.get("blocklisttype") || "committed";
    let xml = `${XML_HEADER}<BlockList>`;
    if (listType === "committed" || listType === "all") {
      xml += "<CommittedBlocks>";
      for (const id of b.blockOrder) {
        const buf = b.committedBlocks.get(id);
        xml += `<Block>${tag("Name", id)}${tag("Size", buf ? buf.length : 0)}</Block>`;
      }
      xml += "</CommittedBlocks>";
    }
    if (listType === "uncommitted" || listType === "all") {
      xml += "<UncommittedBlocks>";
      for (const [id, buf] of b.uncommittedBlocks) {
        xml += `<Block>${tag("Name", id)}${tag("Size", buf.length)}</Block>`;
      }
      xml += "</UncommittedBlocks>";
    }
    xml += "</BlockList>";
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.setHeader("x-ms-blob-content-length", String(b.content.length));
    res.setHeader("Content-Type", "application/xml");
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // Append blob: AppendBlock
  // -------------------------------------------------------------------------
  appendBlock(req, res, containerName, blobName, body) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = c.blobs.get(blobName);
    if (!b || b.deleted) {
      return this.sendError(res, 404, "BlobNotFound", "The specified blob does not exist.");
    }
    if (b.blobType !== "AppendBlob") {
      return this.sendError(res, 409, "InvalidBlobType", "The blob type is invalid for this operation.");
    }
    const appendPos = req.headers["x-ms-blob-condition-appendpos"];
    if (appendPos !== undefined && parseInt(appendPos, 10) !== b.content.length) {
      return this.sendError(res, 412, "AppendPositionConditionNotMet", "The append position condition specified was not met.");
    }
    // AppendBlockFromURL: pull bytes from the source blob instead of the body.
    let appendData = body;
    const copySource = req.headers["x-ms-copy-source"];
    if (copySource) {
      const sourced = this.readSourceRange(copySource, req.headers["x-ms-source-range"]);
      if (sourced === null) {
        return this.sendError(res, 404, "CannotVerifyCopySource", "The specified source blob could not be found or read.");
      }
      appendData = sourced;
    }
    const offset = b.content.length;
    b.content = Buffer.concat([b.content, Buffer.from(appendData)]);
    b.committedBlockCount = (b.committedBlockCount || 0) + 1;
    b.etag = makeEtag();
    b.lastModified = Date.now();
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.setHeader("x-ms-blob-append-offset", String(offset));
    res.setHeader("x-ms-blob-committed-block-count", String(b.committedBlockCount));
    res.setHeader("Content-MD5", md5Base64(appendData));
    res.statusCode = 201;
    res.end();
  }

  // -------------------------------------------------------------------------
  // Page blob: UploadPages / ClearPages / GetPageRanges
  // -------------------------------------------------------------------------
  uploadPages(req, res, containerName, blobName, body) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = c.blobs.get(blobName);
    if (!b || b.deleted) {
      return this.sendError(res, 404, "BlobNotFound", "The specified blob does not exist.");
    }
    if (b.blobType !== "PageBlob") {
      return this.sendError(res, 409, "InvalidBlobType", "The blob type is invalid for this operation.");
    }
    const range = req.headers["x-ms-range"] || req.headers.range;
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || "");
    if (!match) {
      return this.sendError(res, 400, "InvalidHeaderValue", "The value for one of the HTTP headers is not in the correct format.");
    }
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const pageWrite = req.headers["x-ms-page-write"] || "update";

    if (end >= b.content.length) {
      b.content = Buffer.concat([b.content, Buffer.alloc(end + 1 - b.content.length)]);
    }
    if (pageWrite === "clear") {
      b.content.fill(0, start, end + 1);
    } else {
      // UploadPagesFromURL: pull bytes from the source blob instead of the body.
      let pageData = body;
      const copySource = req.headers["x-ms-copy-source"];
      if (copySource) {
        const sourced = this.readSourceRange(copySource, req.headers["x-ms-source-range"]);
        if (sourced === null) {
          return this.sendError(res, 404, "CannotVerifyCopySource", "The specified source blob could not be found or read.");
        }
        pageData = sourced;
      }
      Buffer.from(pageData).copy(b.content, start, 0, end - start + 1);
    }
    b.sequenceNumber = (b.sequenceNumber || 0);
    b.etag = makeEtag();
    b.lastModified = Date.now();
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.setHeader("x-ms-blob-sequence-number", String(b.sequenceNumber));
    res.statusCode = 201;
    res.end();
  }

  getPageRanges(req, res, containerName, blobName, params) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = c.blobs.get(blobName);
    if (!b || b.deleted) {
      return this.sendError(res, 404, "BlobNotFound", "The specified blob does not exist.");
    }
    if (b.blobType !== "PageBlob") {
      return this.sendError(res, 409, "InvalidBlobType", "The blob type is invalid for this operation.");
    }
    // Compute contiguous non-zero 512-byte page ranges.
    const ranges = [];
    const pageSize = 512;
    let rangeStart = null;
    const total = b.content.length;
    for (let off = 0; off < total; off += pageSize) {
      const slice = b.content.subarray(off, Math.min(off + pageSize, total));
      const nonZero = slice.some((x) => x !== 0);
      if (nonZero && rangeStart === null) rangeStart = off;
      if (!nonZero && rangeStart !== null) {
        ranges.push([rangeStart, off - 1]);
        rangeStart = null;
      }
    }
    if (rangeStart !== null) ranges.push([rangeStart, total - 1]);

    let xml = `${XML_HEADER}<PageList>`;
    for (const [s, e] of ranges) {
      xml += `<PageRange>${tag("Start", s)}${tag("End", e)}</PageRange>`;
    }
    xml += "</PageList>";
    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.setHeader("x-ms-blob-content-length", String(total));
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // Copy
  // -------------------------------------------------------------------------
  copyFromUrl(req, res, containerName, blobName, body) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const source = req.headers["x-ms-copy-source"];
    const requiresSync = req.headers["x-ms-requires-sync"] === "true";

    const sourceData = this.resolveSourceBlob(source);
    if (!sourceData) {
      return this.sendError(res, 404, "CannotVerifyCopySource", "The specified source blob could not be found or read.");
    }

    let b = c.blobs.get(blobName);
    if (!b || b.deleted) {
      b = this.newBlob(blobName, sourceData.blobType || "BlockBlob");
      c.blobs.set(blobName, b);
    }
    b.content = Buffer.from(sourceData.content);
    b.blobType = sourceData.blobType || "BlockBlob";
    b.contentType = sourceData.contentType || "application/octet-stream";
    b.contentMd5 = sourceData.contentMd5;
    const meta = this.extractMetadata(req);
    b.metadata = Object.keys(meta).length ? meta : { ...sourceData.metadata };
    b.tags = this.parseTagsHeader(req.headers["x-ms-tags"]) || {};
    b.etag = makeEtag();
    b.lastModified = Date.now();
    b.uncommitted = false;
    b.deleted = false;
    const copyId = randomUUID();
    b.copyId = copyId;
    b.copyStatus = "success";
    b.copySource = source;

    res.setHeader("ETag", b.etag);
    res.setHeader("Last-Modified", httpDate(new Date(b.lastModified)));
    res.setHeader("x-ms-copy-id", copyId);
    res.setHeader("x-ms-copy-status", "success");
    res.statusCode = 202;
    res.end();
  }

  resolveSourceBlob(sourceUrl) {
    try {
      const u = new URL(sourceUrl);
      const { container, blob } = this.resolveAddress(u);
      const c = this.getContainer(container);
      if (!c) return null;
      const b = this.getBlob(c, blob);
      if (!b || b.deleted) return null;
      return b;
    } catch {
      return null;
    }
  }

  // Read a byte range from a source blob referenced by URL. Used by the
  // *FromURL family (stageBlockFromURL, appendBlockFromURL, uploadPagesFromURL).
  // rangeHeader is the Azure "bytes=start-end" source-range form.
  readSourceRange(sourceUrl, rangeHeader) {
    const src = this.resolveSourceBlob(sourceUrl);
    if (!src) return null;
    let content = src.content;
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || "");
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] === "" ? content.length - 1 : parseInt(match[2], 10);
      content = content.subarray(start, end + 1);
    }
    return content;
  }

  abortCopy(req, res, containerName, blobName, params) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    res.setHeader("x-ms-copy-action", "abort");
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  // Lease (blob + container share the same action machinery)
  // -------------------------------------------------------------------------
  blobLease(req, res, containerName, blobName) {
    const c = this.requireContainer(res, containerName);
    if (!c) return;
    const b = this.requireBlob(res, c, blobName);
    if (!b) return;
    return this.handleLease(req, res, b, "blob");
  }

  handleLease(req, res, target, kind) {
    const action = (req.headers["x-ms-lease-action"] || "").toLowerCase();
    const proposedId = req.headers["x-ms-proposed-lease-id"];
    const leaseId = req.headers["x-ms-lease-id"];
    const duration = req.headers["x-ms-lease-duration"];

    switch (action) {
      case "acquire": {
        if (target.lease && target.lease.state === "leased" && target.lease.id !== leaseId) {
          return this.sendError(res, 409, "LeaseAlreadyPresent", "There is already a lease present.");
        }
        const id = proposedId || randomUUID();
        target.lease = { id, state: "leased", duration: duration || "-1" };
        res.setHeader("x-ms-lease-id", id);
        res.setHeader("ETag", target.etag);
        res.setHeader("Last-Modified", httpDate(new Date(target.lastModified)));
        res.statusCode = 201;
        return res.end();
      }
      case "renew": {
        if (!target.lease || target.lease.id !== leaseId) {
          return this.sendError(res, 409, "LeaseIdMismatchWithLeaseOperation", "The lease ID specified did not match the lease ID for the resource.");
        }
        target.lease.state = "leased";
        res.setHeader("x-ms-lease-id", target.lease.id);
        res.statusCode = 200;
        return res.end();
      }
      case "release": {
        if (!target.lease || target.lease.id !== leaseId) {
          return this.sendError(res, 409, "LeaseIdMismatchWithLeaseOperation", "The lease ID specified did not match the lease ID for the resource.");
        }
        target.lease = null;
        res.statusCode = 200;
        return res.end();
      }
      case "change": {
        if (!target.lease || target.lease.id !== leaseId) {
          return this.sendError(res, 409, "LeaseIdMismatchWithLeaseOperation", "The lease ID specified did not match the lease ID for the resource.");
        }
        target.lease.id = proposedId;
        res.setHeader("x-ms-lease-id", target.lease.id);
        res.statusCode = 200;
        return res.end();
      }
      case "break": {
        if (!target.lease) {
          return this.sendError(res, 409, "LeaseNotPresentWithLeaseOperation", "There is currently no lease on the resource.");
        }
        target.lease.state = "broken";
        const wasLeased = target.lease;
        target.lease = null;
        res.setHeader("x-ms-lease-time", "0");
        res.statusCode = 202;
        void wasLeased;
        return res.end();
      }
      default:
        return this.sendError(res, 400, "InvalidHeaderValue", "Invalid x-ms-lease-action.");
    }
  }

  // -------------------------------------------------------------------------
  // Batch (BlobBatchClient) — multipart/mixed sub-requests
  // -------------------------------------------------------------------------
  submitBatch(req, res, params, body, containerName) {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = /boundary=(.+)$/.exec(contentType);
    if (!boundaryMatch) {
      return this.sendError(res, 400, "InvalidInput", "Missing multipart boundary.");
    }
    const reqBoundary = boundaryMatch[1].trim();
    const text = body.toString("utf8");
    const parts = text.split(`--${reqBoundary}`).filter((p) => p.trim() && !p.trim().startsWith("--"));

    const respBoundary = `batchresponse_${randomUUID()}`;
    let respBody = "";
    let idx = 0;
    for (const part of parts) {
      // Each part has headers, then an HTTP sub-request.
      const reqLineMatch = /(DELETE|PUT|GET|HEAD|POST)\s+([^\s]+)\s+HTTP/.exec(part);
      const clMatch = /Content-ID:\s*<?(\d+)>?/i.exec(part);
      const contentId = clMatch ? clMatch[1] : String(idx);
      let subStatus = 202;
      let subCode = "Accepted";
      let extraHeaders = "";

      if (reqLineMatch) {
        const subMethod = reqLineMatch[1];
        let subPath = reqLineMatch[2];
        try {
          const subUrl = new URL(subPath, `http://${this.host}:${this.port}`);
          const addr = this.resolveAddress(subUrl);
          const tierHeader = /x-ms-access-tier:\s*([^\r\n]+)/i.exec(part);
          if (subMethod === "DELETE") {
            const c = this.getContainer(addr.container);
            const b = c ? this.getBlob(c, addr.blob) : null;
            if (!c || !b || b.deleted) {
              subStatus = 404; subCode = "Not Found";
              extraHeaders = "x-ms-error-code: BlobNotFound\r\n";
            } else {
              b.deleted = true;
              subStatus = 202; subCode = "Accepted";
            }
          } else if (subMethod === "PUT" && tierHeader) {
            const c = this.getContainer(addr.container);
            const b = c ? this.getBlob(c, addr.blob) : null;
            if (!c || !b || b.deleted) {
              subStatus = 404; subCode = "Not Found";
              extraHeaders = "x-ms-error-code: BlobNotFound\r\n";
            } else {
              b.accessTier = tierHeader[1].trim();
              subStatus = 200; subCode = "OK";
            }
          }
        } catch {
          subStatus = 400; subCode = "Bad Request";
        }
      }

      respBody += `--${respBoundary}\r\n`;
      respBody += "Content-Type: application/http\r\n";
      respBody += "Content-Transfer-Encoding: binary\r\n";
      respBody += `Content-ID: ${contentId}\r\n\r\n`;
      respBody += `HTTP/1.1 ${subStatus} ${subCode}\r\n`;
      respBody += `x-ms-request-id: ${requestId()}\r\n`;
      respBody += `x-ms-version: ${API_VERSION}\r\n`;
      respBody += extraHeaders;
      respBody += "\r\n";
      idx += 1;
    }
    respBody += `--${respBoundary}--\r\n`;

    res.statusCode = 202;
    res.setHeader("Content-Type", `multipart/mixed; boundary=${respBoundary}`);
    res.setHeader("x-ms-request-id", requestId());
    res.end(respBody);
  }

  // -------------------------------------------------------------------------
  // Metadata / tag helpers
  // -------------------------------------------------------------------------
  extractMetadata(req) {
    const meta = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith("x-ms-meta-")) meta[name.slice("x-ms-meta-".length)] = value;
    }
    return meta;
  }

  parseTagsHeader(value) {
    const tags = {};
    if (!value) return tags;
    for (const pair of value.split("&")) {
      const [k, v = ""] = pair.split("=");
      if (k) tags[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    return tags;
  }

  parseTagsXml(xml) {
    const tags = {};
    const re = /<Tag>([\s\S]*?)<\/Tag>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const k = (/<Key>([\s\S]*?)<\/Key>/.exec(m[1]) || [])[1];
      const v = (/<Value>([\s\S]*?)<\/Value>/.exec(m[1]) || [])[1];
      if (k !== undefined) tags[unescapeXml(k)] = unescapeXml(v || "");
    }
    return tags;
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendXml(res, status, xml) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/xml");
    res.end(xml);
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, status, code, message) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("x-ms-error-code", code);
    const xml = `${XML_HEADER}<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message></Error>`;
    res.end(xml);
  }
}

export default AzureblobServer;
