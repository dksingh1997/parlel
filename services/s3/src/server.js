// parlel/s3 — a lightweight, dependency-free fake of AWS S3.
//
// Speaks the AWS S3 REST API (XML wire protocol) so application code using the
// real `@aws-sdk/client-s3` client can run against it with zero cost and zero
// side effects. Pure Node.js, no external npm dependencies. State is in-memory
// and ephemeral (resettable via reset() or POST /_parlel/reset).

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const S3_NS = "http://s3.amazonaws.com/doc/2006-03-01/";
const OWNER_ID = "parlelownerid000000000000000000000000000000000000000000000000000";
const OWNER_NAME = "parlel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function md5Hex(buf) {
  return createHash("md5").update(buf).digest("hex");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tag(name, value) {
  if (value === undefined || value === null) return "";
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

// S3 bucket name rules (relaxed but realistic).
function isValidBucketName(name) {
  if (typeof name !== "string") return false;
  if (name.length < 3 || name.length > 63) return false;
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return false;
  if (name.includes("..")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return false; // not an IP
  return true;
}

function ownerXml() {
  return `<Owner><ID>${OWNER_ID}</ID><DisplayName>${OWNER_NAME}</DisplayName></Owner>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class S3Server {
  constructor(port = 4566, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.server = null;
    this.reset();
  }

  reset() {
    // buckets: Map<bucketName, Bucket>
    // Bucket = {
    //   name, creationDate,
    //   objects: Map<key, ObjectVersion[]>,  // newest version last
    //   uploads: Map<uploadId, { key, parts: Map<partNumber, {etag, body, size}>, initiated, metadata, contentType }>,
    //   versioning: "Enabled" | "Suspended" | null,
    //   tagging: Map<string,string>,
    //   cors: array | null,
    //   policy: string | null,
    //   acl: object,
    //   lifecycle: array | null,
    //   encryption: object | null,
    //   website: object | null,
    // }
    this.buckets = new Map();
    this.versionCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, 500, "InternalError", error.message, req);
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

  // -------------------------------------------------------------------------
  // Body reading (raw buffer; many S3 ops carry binary payloads)
  // -------------------------------------------------------------------------
  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // -------------------------------------------------------------------------
  // Addressing: resolve { bucket, key } from host + path.
  // Supports path-style (/bucket/key) and virtual-hosted-style
  // (bucket.s3.amazonaws.com/key, bucket.localhost/key).
  // -------------------------------------------------------------------------
  resolveAddress(req, url) {
    const hostHeader = (req.headers.host || "").split(":")[0];
    const pathname = decodeURIComponent(url.pathname);

    // Detect virtual-host style: host has a label before a known s3-ish suffix
    // or before "localhost" / the server host. Be conservative: only treat as
    // virtual-host when the leading label is a plausible bucket and the rest
    // looks like an s3 endpoint host.
    const vhostSuffixes = [
      `.s3.${this.region}.amazonaws.com`,
      ".s3.amazonaws.com",
      `.s3-${this.region}.amazonaws.com`,
      ".s3.localhost.localstack.cloud",
      ".localhost",
    ];
    for (const suffix of vhostSuffixes) {
      if (hostHeader.endsWith(suffix) && hostHeader.length > suffix.length) {
        const bucket = hostHeader.slice(0, hostHeader.length - suffix.length);
        const key = pathname.replace(/^\//, "");
        return { bucket, key, style: "vhost" };
      }
    }

    // Path style: /bucket/key...
    const trimmed = pathname.replace(/^\//, "");
    if (trimmed === "") return { bucket: null, key: "", style: "path" };
    const slash = trimmed.indexOf("/");
    if (slash === -1) return { bucket: trimmed, key: "", style: "path" };
    return { bucket: trimmed.slice(0, slash), key: trimmed.slice(slash + 1), style: "path" };
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const params = url.searchParams;

    // Internal/health endpoints (not part of S3).
    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "s3", buckets: this.buckets.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    const { bucket, key } = this.resolveAddress(req, url);
    const body = await this.readBody(req);

    res.setHeader("x-amz-request-id", this.requestId());
    res.setHeader("x-amz-id-2", this.requestId());
    res.setHeader("Server", "parlel-s3");

    // Service-level (no bucket): GET / => ListBuckets
    if (!bucket) {
      if (method === "GET") return this.listBuckets(res);
      return this.sendError(res, 405, "MethodNotAllowed", "The specified method is not allowed", req);
    }

    // Bucket-level (no key)
    if (!key) {
      return this.handleBucket(req, res, method, bucket, params, body);
    }

    // Object-level
    return this.handleObject(req, res, method, bucket, key, params, body);
  }

  requestId() {
    return md5Hex(String(Math.random()) + Date.now()).slice(0, 16).toUpperCase();
  }

  // -------------------------------------------------------------------------
  // Bucket-level operations
  // -------------------------------------------------------------------------
  handleBucket(req, res, method, bucketName, params, body) {
    const has = (name) => params.has(name);

    // PUT bucket (CreateBucket)
    if (method === "PUT" && !this.bucketSubresource(params)) {
      return this.createBucket(res, bucketName, body, req);
    }

    // DELETE bucket
    if (method === "DELETE" && !this.bucketSubresource(params)) {
      return this.deleteBucket(res, bucketName, req);
    }

    // HEAD bucket
    if (method === "HEAD" && !this.bucketSubresource(params)) {
      return this.headBucket(res, bucketName, req);
    }

    // Sub-resource routing (query params)
    if (method === "GET" && has("location")) return this.getBucketLocation(res, bucketName, req);
    if (method === "GET" && has("versioning")) return this.getBucketVersioning(res, bucketName, req);
    if (method === "PUT" && has("versioning")) return this.putBucketVersioning(res, bucketName, body, req);
    if (method === "GET" && has("tagging")) return this.getBucketTagging(res, bucketName, req);
    if (method === "PUT" && has("tagging")) return this.putBucketTagging(res, bucketName, body, req);
    if (method === "DELETE" && has("tagging")) return this.deleteBucketTagging(res, bucketName, req);
    if (method === "GET" && has("cors")) return this.getBucketCors(res, bucketName, req);
    if (method === "PUT" && has("cors")) return this.putBucketCors(res, bucketName, body, req);
    if (method === "DELETE" && has("cors")) return this.deleteBucketCors(res, bucketName, req);
    if (method === "GET" && has("policy")) return this.getBucketPolicy(res, bucketName, req);
    if (method === "PUT" && has("policy")) return this.putBucketPolicy(res, bucketName, body, req);
    if (method === "DELETE" && has("policy")) return this.deleteBucketPolicy(res, bucketName, req);
    if (method === "GET" && has("acl")) return this.getBucketAcl(res, bucketName, req);
    if (method === "PUT" && has("acl")) return this.putBucketAcl(res, bucketName, req);
    if (method === "GET" && has("lifecycle")) return this.getBucketLifecycle(res, bucketName, req);
    if (method === "PUT" && has("lifecycle")) return this.putBucketLifecycle(res, bucketName, body, req);
    if (method === "DELETE" && has("lifecycle")) return this.deleteBucketLifecycle(res, bucketName, req);
    if (method === "GET" && has("encryption")) return this.getBucketEncryption(res, bucketName, req);
    if (method === "PUT" && has("encryption")) return this.putBucketEncryption(res, bucketName, body, req);
    if (method === "DELETE" && has("encryption")) return this.deleteBucketEncryption(res, bucketName, req);
    if (method === "GET" && has("website")) return this.getBucketWebsite(res, bucketName, req);
    if (method === "PUT" && has("website")) return this.putBucketWebsite(res, bucketName, body, req);
    if (method === "DELETE" && has("website")) return this.deleteBucketWebsite(res, bucketName, req);
    if (method === "GET" && has("uploads")) return this.listMultipartUploads(res, bucketName, params, req);
    if (method === "POST" && has("delete")) return this.deleteObjects(res, bucketName, body, req);

    // Recognized-but-unsupported bucket sub-resources => honest NotImplemented,
    // rather than silently returning an object listing.
    const unsupported = [
      "accelerate", "logging", "notification", "requestPayment", "replication",
      "object-lock", "publicAccessBlock", "ownershipControls", "analytics",
      "inventory", "metrics", "intelligent-tiering", "requestProgress", "select",
    ];
    for (const name of unsupported) {
      if (has(name)) {
        return this.sendError(res, 501, "NotImplemented", `The ${name} sub-resource is not implemented by the parlel s3 fake.`, req);
      }
    }

    // GET bucket => ListObjects (v1) or v2 (list-type=2)
    if (method === "GET" && has("versions")) return this.listObjectVersions(res, bucketName, params, req);
    if (method === "GET") {
      if (params.get("list-type") === "2") return this.listObjectsV2(res, bucketName, params, req);
      return this.listObjectsV1(res, bucketName, params, req);
    }

    return this.sendError(res, 405, "MethodNotAllowed", "The specified method is not allowed", req);
  }

  bucketSubresource(params) {
    for (const name of [
      "location", "versioning", "tagging", "cors", "policy", "acl",
      "lifecycle", "encryption", "website", "uploads", "delete", "versions",
    ]) {
      if (params.has(name)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Object-level operations
  // -------------------------------------------------------------------------
  handleObject(req, res, method, bucketName, key, params, body) {
    const has = (name) => params.has(name);

    // Multipart sub-resources
    if (method === "POST" && has("uploads")) return this.createMultipartUpload(res, bucketName, key, req);
    if (method === "PUT" && has("uploadId") && has("partNumber")) return this.uploadPart(res, bucketName, key, params, body, req);
    if (method === "POST" && has("uploadId")) return this.completeMultipartUpload(res, bucketName, key, params, body, req);
    if (method === "DELETE" && has("uploadId")) return this.abortMultipartUpload(res, bucketName, key, params, req);
    if (method === "GET" && has("uploadId")) return this.listParts(res, bucketName, key, params, req);

    // Object tagging
    if (method === "GET" && has("tagging")) return this.getObjectTagging(res, bucketName, key, params, req);
    if (method === "PUT" && has("tagging")) return this.putObjectTagging(res, bucketName, key, params, body, req);
    if (method === "DELETE" && has("tagging")) return this.deleteObjectTagging(res, bucketName, key, params, req);

    // Object ACL
    if (method === "GET" && has("acl")) return this.getObjectAcl(res, bucketName, key, req);
    if (method === "PUT" && has("acl")) return this.putObjectAcl(res, bucketName, key, req);

    // Object attributes
    if (method === "GET" && has("attributes")) return this.getObjectAttributes(res, bucketName, key, params, req);

    // Core object verbs
    if (method === "PUT") {
      if (req.headers["x-amz-copy-source"]) return this.copyObject(res, bucketName, key, req);
      return this.putObject(res, bucketName, key, body, req);
    }
    if (method === "GET") return this.getObject(res, bucketName, key, params, req);
    if (method === "HEAD") return this.headObject(res, bucketName, key, params, req);
    if (method === "DELETE") return this.deleteObject(res, bucketName, key, params, req);
    if (method === "POST") return this.postObject(res, bucketName, key, body, req);

    return this.sendError(res, 405, "MethodNotAllowed", "The specified method is not allowed", req);
  }

  // -------------------------------------------------------------------------
  // Bucket store helpers
  // -------------------------------------------------------------------------
  getBucket(name) {
    return this.buckets.get(name) || null;
  }

  requireBucket(res, name, req) {
    const bucket = this.getBucket(name);
    if (!bucket) {
      this.sendError(res, 404, "NoSuchBucket", "The specified bucket does not exist", req, { BucketName: name });
      return null;
    }
    return bucket;
  }

  nextVersionId() {
    this.versionCounter += 1;
    return md5Hex(`v${this.versionCounter}-${Date.now()}-${Math.random()}`).slice(0, 32);
  }

  // -------------------------------------------------------------------------
  // ListBuckets
  // -------------------------------------------------------------------------
  listBuckets(res) {
    const items = [...this.buckets.values()]
      .map((b) => `<Bucket><Name>${escapeXml(b.name)}</Name><CreationDate>${b.creationDate}</CreationDate></Bucket>`)
      .join("");
    const xml = `${XML_HEADER}<ListAllMyBucketsResult xmlns="${S3_NS}">${ownerXml()}<Buckets>${items}</Buckets></ListAllMyBucketsResult>`;
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // CreateBucket / DeleteBucket / HeadBucket
  // -------------------------------------------------------------------------
  createBucket(res, name, body, req) {
    if (!isValidBucketName(name)) {
      return this.sendError(res, 400, "InvalidBucketName", "The specified bucket is not valid.", req, { BucketName: name });
    }
    const existing = this.buckets.get(name);
    if (existing) {
      // Real S3: re-creating a bucket you already own returns 200 OK in
      // us-east-1 (legacy compatibility, resets ACLs) but 409
      // BucketAlreadyOwnedByYou in every other region.
      // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html
      if (this.region === "us-east-1") {
        res.setHeader("Location", `/${name}`);
        return this.sendXml(res, 200, "");
      }
      return this.sendError(res, 409, "BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.", req, { BucketName: name });
    }
    this.buckets.set(name, {
      name,
      creationDate: now(),
      objects: new Map(),
      uploads: new Map(),
      versioning: null,
      tagging: new Map(),
      cors: null,
      policy: null,
      lifecycle: null,
      encryption: null,
      website: null,
    });
    res.setHeader("Location", `/${name}`);
    return this.sendXml(res, 200, "");
  }

  deleteBucket(res, name, req) {
    const bucket = this.requireBucket(res, name, req);
    if (!bucket) return;
    const hasLive = [...bucket.objects.values()].some((vers) => vers.some((v) => !v.deleteMarker));
    if (hasLive) {
      return this.sendError(res, 409, "BucketNotEmpty", "The bucket you tried to delete is not empty", req, { BucketName: name });
    }
    this.buckets.delete(name);
    return this.sendXml(res, 204, "");
  }

  headBucket(res, name, req) {
    const bucket = this.getBucket(name);
    if (!bucket) {
      res.setHeader("x-amz-bucket-region", this.region);
      return this.sendError(res, 404, "NoSuchBucket", "The specified bucket does not exist", req, { BucketName: name });
    }
    res.setHeader("x-amz-bucket-region", this.region);
    return this.sendXml(res, 200, "");
  }

  // -------------------------------------------------------------------------
  // Object: PUT (PutObject)
  // -------------------------------------------------------------------------
  putObject(res, bucketName, key, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;

    const contentMd5 = req.headers["content-md5"];
    if (contentMd5) {
      const expected = Buffer.from(contentMd5, "base64").toString("hex");
      if (expected !== md5Hex(body)) {
        return this.sendError(res, 400, "BadDigest", "The Content-MD5 you specified did not match what we received.", req);
      }
    }

    const etag = `"${md5Hex(body)}"`;
    const version = this.storeObject(bucket, key, {
      body,
      etag,
      contentType: req.headers["content-type"] || "application/octet-stream",
      metadata: this.extractUserMetadata(req),
      tagging: this.parseTaggingHeader(req.headers["x-amz-tagging"]),
      cacheControl: req.headers["cache-control"],
      contentDisposition: req.headers["content-disposition"],
      contentEncoding: req.headers["content-encoding"],
      contentLanguage: req.headers["content-language"],
      storageClass: req.headers["x-amz-storage-class"] || "STANDARD",
    });

    res.setHeader("ETag", etag);
    if (version.versionId) res.setHeader("x-amz-version-id", version.versionId);
    return this.sendXml(res, 200, "");
  }

  storeObject(bucket, key, props) {
    const versioned = bucket.versioning === "Enabled";
    const versionId = versioned ? this.nextVersionId() : null;
    const record = {
      key,
      versionId,
      deleteMarker: false,
      lastModified: now(),
      size: props.body ? props.body.length : 0,
      ...props,
    };
    let chain = bucket.objects.get(key);
    if (!chain) {
      chain = [];
      bucket.objects.set(key, chain);
    }
    if (!versioned) {
      // Replace the single null-version entry.
      const filtered = chain.filter((v) => v.versionId !== null);
      filtered.push(record);
      bucket.objects.set(key, filtered);
    } else {
      chain.push(record);
    }
    return record;
  }

  latestVersion(bucket, key) {
    const chain = bucket.objects.get(key);
    if (!chain || chain.length === 0) return null;
    return chain[chain.length - 1];
  }

  extractUserMetadata(req) {
    const meta = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith("x-amz-meta-")) meta[name.slice("x-amz-meta-".length)] = value;
    }
    return meta;
  }

  parseTaggingHeader(value) {
    const map = new Map();
    if (!value) return map;
    for (const pair of value.split("&")) {
      const [k, v = ""] = pair.split("=");
      if (k) map.set(decodeURIComponent(k), decodeURIComponent(v));
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Object: GET (GetObject) with range + conditional support
  // -------------------------------------------------------------------------
  getObject(res, bucketName, key, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const version = this.resolveObjectVersion(bucket, key, params.get("versionId"));
    if (!version || version.deleteMarker) {
      return this.sendError(res, 404, "NoSuchKey", "The specified key does not exist.", req, { Key: key });
    }

    const cond = this.checkConditional(req, version);
    if (cond) return this.sendError(res, cond.status, cond.code, cond.message, req);

    let body = version.body || Buffer.alloc(0);
    let status = 200;
    const total = body.length;

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        let start = match[1] === "" ? null : parseInt(match[1], 10);
        let end = match[2] === "" ? null : parseInt(match[2], 10);
        if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1; }
        else { if (start === null) start = 0; if (end === null || end >= total) end = total - 1; }
        if (start > end || start >= total) {
          res.setHeader("Content-Range", `bytes */${total}`);
          return this.sendError(res, 416, "InvalidRange", "The requested range is not satisfiable", req);
        }
        body = body.subarray(start, end + 1);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        status = 206;
        res.setHeader("Accept-Ranges", "bytes");
      }
    }

    this.applyObjectHeaders(res, version, params);
    res.setHeader("Content-Length", String(body.length));
    res.statusCode = status;
    res.end(body);
  }

  resolveObjectVersion(bucket, key, versionId) {
    const chain = bucket.objects.get(key);
    if (!chain || chain.length === 0) return null;
    if (versionId) return chain.find((v) => v.versionId === versionId) || null;
    return chain[chain.length - 1];
  }

  applyObjectHeaders(res, version, params) {
    res.setHeader("ETag", version.etag);
    res.setHeader("Last-Modified", new Date(version.lastModified).toUTCString());
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", version.contentType || "application/octet-stream");
    if (version.versionId) res.setHeader("x-amz-version-id", version.versionId);
    if (version.cacheControl) res.setHeader("Cache-Control", version.cacheControl);
    if (version.contentDisposition) res.setHeader("Content-Disposition", version.contentDisposition);
    if (version.contentEncoding) res.setHeader("Content-Encoding", version.contentEncoding);
    if (version.contentLanguage) res.setHeader("Content-Language", version.contentLanguage);
    if (version.storageClass && version.storageClass !== "STANDARD") {
      res.setHeader("x-amz-storage-class", version.storageClass);
    }
    if (version.tagging && version.tagging.size) {
      res.setHeader("x-amz-tagging-count", String(version.tagging.size));
    }
    for (const [name, value] of Object.entries(version.metadata || {})) {
      res.setHeader(`x-amz-meta-${name}`, value);
    }
    // response-* override params
    if (params) {
      const overrides = {
        "response-content-type": "Content-Type",
        "response-content-disposition": "Content-Disposition",
        "response-content-encoding": "Content-Encoding",
        "response-content-language": "Content-Language",
        "response-cache-control": "Cache-Control",
      };
      for (const [param, header] of Object.entries(overrides)) {
        const v = params.get(param);
        if (v) res.setHeader(header, v);
      }
    }
  }

  checkConditional(req, version) {
    const etag = version.etag;
    const lastMod = new Date(version.lastModified).getTime();
    const ifMatch = req.headers["if-match"];
    const ifNoneMatch = req.headers["if-none-match"];
    const ifModSince = req.headers["if-modified-since"];
    const ifUnmodSince = req.headers["if-unmodified-since"];

    if (ifMatch && !this.etagMatches(ifMatch, etag)) {
      return { status: 412, code: "PreconditionFailed", message: "At least one of the preconditions you specified did not hold." };
    }
    if (ifNoneMatch && this.etagMatches(ifNoneMatch, etag)) {
      return { status: 304, code: "NotModified", message: "Not Modified" };
    }
    if (ifUnmodSince && lastMod > Date.parse(ifUnmodSince)) {
      return { status: 412, code: "PreconditionFailed", message: "At least one of the preconditions you specified did not hold." };
    }
    if (ifModSince && lastMod <= Date.parse(ifModSince)) {
      return { status: 304, code: "NotModified", message: "Not Modified" };
    }
    return null;
  }

  etagMatches(header, etag) {
    if (header.trim() === "*") return true;
    return header.split(",").map((t) => t.trim()).includes(etag);
  }

  // -------------------------------------------------------------------------
  // Object: HEAD (HeadObject)
  // -------------------------------------------------------------------------
  headObject(res, bucketName, key, params, req) {
    const bucket = this.getBucket(bucketName);
    if (!bucket) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const version = this.resolveObjectVersion(bucket, key, params.get("versionId"));
    if (!version || version.deleteMarker) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const cond = this.checkConditional(req, version);
    if (cond) {
      res.statusCode = cond.status;
      res.end();
      return;
    }
    this.applyObjectHeaders(res, version, params);
    res.setHeader("Content-Length", String(version.size));
    res.statusCode = 200;
    res.end();
  }

  // -------------------------------------------------------------------------
  // Object: DELETE (DeleteObject)
  // -------------------------------------------------------------------------
  deleteObject(res, bucketName, key, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const versionId = params.get("versionId");
    const chain = bucket.objects.get(key);

    if (versionId) {
      if (chain) {
        const idx = chain.findIndex((v) => v.versionId === versionId);
        if (idx !== -1) {
          const removed = chain.splice(idx, 1)[0];
          if (chain.length === 0) bucket.objects.delete(key);
          res.setHeader("x-amz-version-id", versionId);
          if (removed.deleteMarker) res.setHeader("x-amz-delete-marker", "true");
        }
      }
      return this.sendXml(res, 204, "");
    }

    if (bucket.versioning === "Enabled") {
      // Insert a delete marker.
      const markerId = this.nextVersionId();
      const marker = { key, versionId: markerId, deleteMarker: true, lastModified: now(), size: 0 };
      if (chain) chain.push(marker);
      else bucket.objects.set(key, [marker]);
      res.setHeader("x-amz-version-id", markerId);
      res.setHeader("x-amz-delete-marker", "true");
      return this.sendXml(res, 204, "");
    }

    // Unversioned: remove entirely (idempotent — 204 even if absent).
    bucket.objects.delete(key);
    return this.sendXml(res, 204, "");
  }

  // -------------------------------------------------------------------------
  // DeleteObjects (batch)
  // -------------------------------------------------------------------------
  deleteObjects(res, bucketName, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const xml = body.toString("utf8");
    const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(xml);
    const objects = [];
    const objectRe = /<Object>([\s\S]*?)<\/Object>/g;
    let m;
    while ((m = objectRe.exec(xml)) !== null) {
      const inner = m[1];
      const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(inner);
      const verMatch = /<VersionId>([\s\S]*?)<\/VersionId>/.exec(inner);
      if (keyMatch) objects.push({ key: this.unescapeXml(keyMatch[1]), versionId: verMatch ? verMatch[1] : null });
    }

    // Real S3 requires at least one <Object> in a well-formed <Delete> body;
    // an empty or malformed request returns 400 MalformedXML.
    // https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
    if (objects.length === 0) {
      return this.sendError(res, 400, "MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", req);
    }

    const deleted = [];
    const errors = [];
    for (const obj of objects) {
      const chain = bucket.objects.get(obj.key);
      if (obj.versionId) {
        if (chain) {
          const idx = chain.findIndex((v) => v.versionId === obj.versionId);
          if (idx !== -1) {
            chain.splice(idx, 1);
            if (chain.length === 0) bucket.objects.delete(obj.key);
          }
        }
        deleted.push({ key: obj.key, versionId: obj.versionId });
      } else if (bucket.versioning === "Enabled") {
        const markerId = this.nextVersionId();
        const marker = { key: obj.key, versionId: markerId, deleteMarker: true, lastModified: now(), size: 0 };
        if (chain) chain.push(marker);
        else bucket.objects.set(obj.key, [marker]);
        deleted.push({ key: obj.key, deleteMarker: true, deleteMarkerVersionId: markerId });
      } else {
        bucket.objects.delete(obj.key);
        deleted.push({ key: obj.key });
      }
    }

    let out = `${XML_HEADER}<DeleteResult xmlns="${S3_NS}">`;
    if (!quiet) {
      for (const d of deleted) {
        out += "<Deleted>";
        out += tag("Key", d.key);
        if (d.versionId) out += tag("VersionId", d.versionId);
        if (d.deleteMarker) out += "<DeleteMarker>true</DeleteMarker>";
        if (d.deleteMarkerVersionId) out += tag("DeleteMarkerVersionId", d.deleteMarkerVersionId);
        out += "</Deleted>";
      }
    }
    for (const e of errors) {
      out += `<Error>${tag("Key", e.key)}${tag("Code", e.code)}${tag("Message", e.message)}</Error>`;
    }
    out += "</DeleteResult>";
    return this.sendXml(res, 200, out);
  }

  unescapeXml(value) {
    return String(value)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  // -------------------------------------------------------------------------
  // CopyObject
  // -------------------------------------------------------------------------
  copyObject(res, destBucketName, destKey, req) {
    const destBucket = this.requireBucket(res, destBucketName, req);
    if (!destBucket) return;

    let source = decodeURIComponent(req.headers["x-amz-copy-source"]).replace(/^\//, "");
    let srcVersionId = null;
    const qIdx = source.indexOf("?");
    if (qIdx !== -1) {
      const qs = new URLSearchParams(source.slice(qIdx + 1));
      srcVersionId = qs.get("versionId");
      source = source.slice(0, qIdx);
    }
    const slash = source.indexOf("/");
    const srcBucketName = source.slice(0, slash);
    const srcKey = source.slice(slash + 1);

    const srcBucket = this.getBucket(srcBucketName);
    if (!srcBucket) {
      return this.sendError(res, 404, "NoSuchBucket", "The specified bucket does not exist", req, { BucketName: srcBucketName });
    }
    const srcVersion = this.resolveObjectVersion(srcBucket, srcKey, srcVersionId);
    if (!srcVersion || srcVersion.deleteMarker) {
      return this.sendError(res, 404, "NoSuchKey", "The specified key does not exist.", req, { Key: srcKey });
    }

    const directive = (req.headers["x-amz-metadata-directive"] || "COPY").toUpperCase();
    const tagDirective = (req.headers["x-amz-tagging-directive"] || "COPY").toUpperCase();
    const newVersion = this.storeObject(destBucket, destKey, {
      body: Buffer.from(srcVersion.body || Buffer.alloc(0)),
      etag: srcVersion.etag,
      contentType: directive === "REPLACE" ? (req.headers["content-type"] || "application/octet-stream") : srcVersion.contentType,
      metadata: directive === "REPLACE" ? this.extractUserMetadata(req) : { ...srcVersion.metadata },
      tagging: tagDirective === "REPLACE" ? this.parseTaggingHeader(req.headers["x-amz-tagging"]) : new Map(srcVersion.tagging),
      cacheControl: directive === "REPLACE" ? req.headers["cache-control"] : srcVersion.cacheControl,
      storageClass: req.headers["x-amz-storage-class"] || srcVersion.storageClass || "STANDARD",
    });

    if (newVersion.versionId) res.setHeader("x-amz-version-id", newVersion.versionId);
    if (srcVersion.versionId) res.setHeader("x-amz-copy-source-version-id", srcVersion.versionId);
    const xml = `${XML_HEADER}<CopyObjectResult xmlns="${S3_NS}">${tag("LastModified", newVersion.lastModified)}${tag("ETag", newVersion.etag)}</CopyObjectResult>`;
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // POST object (browser-style form upload) — minimal support
  // -------------------------------------------------------------------------
  postObject(res, bucketName, key, body, req) {
    return this.sendError(res, 501, "NotImplemented", "POST form uploads are not implemented in the parlel fake.", req);
  }

  // -------------------------------------------------------------------------
  // ListObjects v1
  // -------------------------------------------------------------------------
  listObjectsV1(res, bucketName, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const prefix = params.get("prefix") || "";
    const delimiter = params.get("delimiter") || "";
    const marker = params.get("marker") || "";
    const maxKeys = Math.min(parseInt(params.get("max-keys") || "1000", 10), 1000);
    const encodingType = params.get("encoding-type");

    const { contents, prefixes, isTruncated, nextMarker } = this.collectKeys(bucket, { prefix, delimiter, after: marker, maxKeys });

    let xml = `${XML_HEADER}<ListBucketResult xmlns="${S3_NS}">`;
    xml += tag("Name", bucketName);
    xml += tag("Prefix", prefix);
    xml += tag("Marker", marker);
    if (isTruncated && nextMarker) xml += tag("NextMarker", nextMarker);
    xml += tag("MaxKeys", maxKeys);
    if (delimiter) xml += tag("Delimiter", delimiter);
    if (encodingType) xml += tag("EncodingType", encodingType);
    xml += `<IsTruncated>${isTruncated}</IsTruncated>`;
    for (const c of contents) xml += this.contentsXml(c);
    for (const p of prefixes) xml += `<CommonPrefixes>${tag("Prefix", p)}</CommonPrefixes>`;
    xml += "</ListBucketResult>";
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // ListObjectsV2
  // -------------------------------------------------------------------------
  listObjectsV2(res, bucketName, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const prefix = params.get("prefix") || "";
    const delimiter = params.get("delimiter") || "";
    const maxKeys = Math.min(parseInt(params.get("max-keys") || "1000", 10), 1000);
    const continuationToken = params.get("continuation-token");
    const startAfter = params.get("start-after") || "";
    const fetchOwner = params.get("fetch-owner") === "true";
    const encodingType = params.get("encoding-type");

    const after = continuationToken ? Buffer.from(continuationToken, "base64").toString("utf8") : startAfter;
    const { contents, prefixes, isTruncated, nextMarker } = this.collectKeys(bucket, { prefix, delimiter, after, maxKeys });

    let xml = `${XML_HEADER}<ListBucketResult xmlns="${S3_NS}">`;
    xml += tag("Name", bucketName);
    xml += tag("Prefix", prefix);
    xml += tag("MaxKeys", maxKeys);
    xml += tag("KeyCount", contents.length + prefixes.length);
    if (delimiter) xml += tag("Delimiter", delimiter);
    if (encodingType) xml += tag("EncodingType", encodingType);
    if (continuationToken) xml += tag("ContinuationToken", continuationToken);
    if (startAfter) xml += tag("StartAfter", startAfter);
    xml += `<IsTruncated>${isTruncated}</IsTruncated>`;
    if (isTruncated && nextMarker) {
      xml += tag("NextContinuationToken", Buffer.from(nextMarker, "utf8").toString("base64"));
    }
    for (const c of contents) xml += this.contentsXml(c, fetchOwner);
    for (const p of prefixes) xml += `<CommonPrefixes>${tag("Prefix", p)}</CommonPrefixes>`;
    xml += "</ListBucketResult>";
    return this.sendXml(res, 200, xml);
  }

  collectKeys(bucket, { prefix, delimiter, after, maxKeys }) {
    // Gather live (non-deleteMarker) latest versions.
    const live = [];
    for (const [key, chain] of bucket.objects) {
      const latest = chain[chain.length - 1];
      if (!latest || latest.deleteMarker) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      live.push({ key, version: latest });
    }
    live.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const contents = [];
    const commonPrefixes = new Set();
    let isTruncated = false;
    let nextMarker = null;
    let count = 0;

    for (const entry of live) {
      if (after && entry.key <= after) continue;
      if (delimiter) {
        const rest = entry.key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx !== -1) {
          const cp = prefix + rest.slice(0, idx + delimiter.length);
          if (!commonPrefixes.has(cp)) {
            if (count >= maxKeys) { isTruncated = true; nextMarker = entry.key; break; }
            commonPrefixes.add(cp);
            count += 1;
            nextMarker = entry.key;
          }
          continue;
        }
      }
      if (count >= maxKeys) { isTruncated = true; nextMarker = contents.length ? contents[contents.length - 1].key : entry.key; break; }
      contents.push({ key: entry.key, version: entry.version });
      count += 1;
      nextMarker = entry.key;
    }

    return {
      contents,
      prefixes: [...commonPrefixes].sort(),
      isTruncated,
      nextMarker,
    };
  }

  contentsXml(entry, fetchOwner = true) {
    const v = entry.version;
    let xml = "<Contents>";
    xml += tag("Key", entry.key);
    xml += tag("LastModified", v.lastModified);
    xml += tag("ETag", v.etag);
    xml += tag("Size", v.size);
    xml += tag("StorageClass", v.storageClass || "STANDARD");
    if (fetchOwner) xml += ownerXml();
    xml += "</Contents>";
    return xml;
  }

  // -------------------------------------------------------------------------
  // ListObjectVersions
  // -------------------------------------------------------------------------
  listObjectVersions(res, bucketName, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const prefix = params.get("prefix") || "";
    const maxKeys = Math.min(parseInt(params.get("max-keys") || "1000", 10), 1000);

    const entries = [];
    for (const [key, chain] of bucket.objects) {
      if (prefix && !key.startsWith(prefix)) continue;
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const v = chain[i];
        entries.push({ key, v, isLatest: i === chain.length - 1 });
      }
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    let xml = `${XML_HEADER}<ListVersionsResult xmlns="${S3_NS}">`;
    xml += tag("Name", bucketName);
    xml += tag("Prefix", prefix);
    xml += tag("MaxKeys", maxKeys);
    xml += "<IsTruncated>false</IsTruncated>";
    for (const e of entries.slice(0, maxKeys)) {
      if (e.v.deleteMarker) {
        xml += "<DeleteMarker>";
        xml += tag("Key", e.key);
        xml += tag("VersionId", e.v.versionId || "null");
        xml += `<IsLatest>${e.isLatest}</IsLatest>`;
        xml += tag("LastModified", e.v.lastModified);
        xml += ownerXml();
        xml += "</DeleteMarker>";
      } else {
        xml += "<Version>";
        xml += tag("Key", e.key);
        xml += tag("VersionId", e.v.versionId || "null");
        xml += `<IsLatest>${e.isLatest}</IsLatest>`;
        xml += tag("LastModified", e.v.lastModified);
        xml += tag("ETag", e.v.etag);
        xml += tag("Size", e.v.size);
        xml += tag("StorageClass", e.v.storageClass || "STANDARD");
        xml += ownerXml();
        xml += "</Version>";
      }
    }
    xml += "</ListVersionsResult>";
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // Multipart uploads
  // -------------------------------------------------------------------------
  createMultipartUpload(res, bucketName, key, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const uploadId = md5Hex(`${key}-${Date.now()}-${Math.random()}`);
    bucket.uploads.set(uploadId, {
      key,
      parts: new Map(),
      initiated: now(),
      contentType: req.headers["content-type"] || "application/octet-stream",
      metadata: this.extractUserMetadata(req),
      tagging: this.parseTaggingHeader(req.headers["x-amz-tagging"]),
      storageClass: req.headers["x-amz-storage-class"] || "STANDARD",
    });
    const xml = `${XML_HEADER}<InitiateMultipartUploadResult xmlns="${S3_NS}">${tag("Bucket", bucketName)}${tag("Key", key)}${tag("UploadId", uploadId)}</InitiateMultipartUploadResult>`;
    return this.sendXml(res, 200, xml);
  }

  uploadPart(res, bucketName, key, params, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const uploadId = params.get("uploadId");
    const partNumber = parseInt(params.get("partNumber"), 10);
    const upload = bucket.uploads.get(uploadId);
    if (!upload) {
      return this.sendError(res, 404, "NoSuchUpload", "The specified multipart upload does not exist.", req, { UploadId: uploadId });
    }
    if (!(partNumber >= 1 && partNumber <= 10000)) {
      return this.sendError(res, 400, "InvalidArgument", "Part number must be an integer between 1 and 10000, inclusive", req);
    }
    const etag = `"${md5Hex(body)}"`;
    upload.parts.set(partNumber, { etag, body: Buffer.from(body), size: body.length });
    res.setHeader("ETag", etag);
    return this.sendXml(res, 200, "");
  }

  completeMultipartUpload(res, bucketName, key, params, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const uploadId = params.get("uploadId");
    const upload = bucket.uploads.get(uploadId);
    if (!upload) {
      return this.sendError(res, 404, "NoSuchUpload", "The specified multipart upload does not exist.", req, { UploadId: uploadId });
    }

    const xml = body.toString("utf8");
    const partRe = /<Part>([\s\S]*?)<\/Part>/g;
    const requested = [];
    let m;
    while ((m = partRe.exec(xml)) !== null) {
      const inner = m[1];
      const num = parseInt((/<PartNumber>(\d+)<\/PartNumber>/.exec(inner) || [])[1], 10);
      const etagRaw = (/<ETag>([\s\S]*?)<\/ETag>/.exec(inner) || [])[1];
      const etag = etagRaw !== undefined ? this.unescapeXml(etagRaw) : etagRaw;
      requested.push({ num, etag });
    }

    if (requested.length === 0) {
      return this.sendError(res, 400, "InvalidRequest", "You must specify at least one part", req);
    }

    // Validate order and existence.
    let lastNum = 0;
    const buffers = [];
    const etagSources = [];
    for (const part of requested) {
      if (part.num <= lastNum) {
        return this.sendError(res, 400, "InvalidPartOrder", "The list of parts was not in ascending order. Parts must be ordered by part number.", req);
      }
      lastNum = part.num;
      const stored = upload.parts.get(part.num);
      if (!stored) {
        return this.sendError(res, 400, "InvalidPart", "One or more of the specified parts could not be found.", req, { PartNumber: part.num });
      }
      const normalize = (e) => String(e || "").replace(/"/g, "");
      if (part.etag && normalize(part.etag) !== normalize(stored.etag)) {
        return this.sendError(res, 400, "InvalidPart", "One or more of the specified parts could not be found.", req, { PartNumber: part.num });
      }
      buffers.push(stored.body);
      etagSources.push(normalize(stored.etag));
    }

    const finalBody = Buffer.concat(buffers);
    // Multipart ETag = md5(concat of part md5 binaries) + "-" + partCount
    const partHashes = Buffer.concat(etagSources.map((e) => Buffer.from(e, "hex")));
    const multipartEtag = `"${md5Hex(partHashes)}-${requested.length}"`;

    const version = this.storeObject(bucket, key, {
      body: finalBody,
      etag: multipartEtag,
      contentType: upload.contentType,
      metadata: upload.metadata,
      tagging: upload.tagging,
      storageClass: upload.storageClass,
    });
    bucket.uploads.delete(uploadId);

    if (version.versionId) res.setHeader("x-amz-version-id", version.versionId);
    const location = `http://${req.headers.host}/${bucketName}/${key}`;
    const out = `${XML_HEADER}<CompleteMultipartUploadResult xmlns="${S3_NS}">${tag("Location", location)}${tag("Bucket", bucketName)}${tag("Key", key)}${tag("ETag", multipartEtag)}</CompleteMultipartUploadResult>`;
    return this.sendXml(res, 200, out);
  }

  abortMultipartUpload(res, bucketName, key, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const uploadId = params.get("uploadId");
    if (!bucket.uploads.has(uploadId)) {
      return this.sendError(res, 404, "NoSuchUpload", "The specified multipart upload does not exist.", req, { UploadId: uploadId });
    }
    bucket.uploads.delete(uploadId);
    return this.sendXml(res, 204, "");
  }

  listParts(res, bucketName, key, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const uploadId = params.get("uploadId");
    const upload = bucket.uploads.get(uploadId);
    if (!upload) {
      return this.sendError(res, 404, "NoSuchUpload", "The specified multipart upload does not exist.", req, { UploadId: uploadId });
    }
    let xml = `${XML_HEADER}<ListPartsResult xmlns="${S3_NS}">`;
    xml += tag("Bucket", bucketName);
    xml += tag("Key", key);
    xml += tag("UploadId", uploadId);
    xml += tag("StorageClass", upload.storageClass || "STANDARD");
    xml += "<IsTruncated>false</IsTruncated>";
    const nums = [...upload.parts.keys()].sort((a, b) => a - b);
    for (const num of nums) {
      const part = upload.parts.get(num);
      xml += `<Part>${tag("PartNumber", num)}${tag("LastModified", upload.initiated)}${tag("ETag", part.etag)}${tag("Size", part.size)}</Part>`;
    }
    xml += "</ListPartsResult>";
    return this.sendXml(res, 200, xml);
  }

  listMultipartUploads(res, bucketName, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    let xml = `${XML_HEADER}<ListMultipartUploadsResult xmlns="${S3_NS}">`;
    xml += tag("Bucket", bucketName);
    xml += "<IsTruncated>false</IsTruncated>";
    for (const [uploadId, upload] of bucket.uploads) {
      xml += "<Upload>";
      xml += tag("Key", upload.key);
      xml += tag("UploadId", uploadId);
      xml += tag("Initiated", upload.initiated);
      xml += tag("StorageClass", upload.storageClass || "STANDARD");
      xml += "</Upload>";
    }
    xml += "</ListMultipartUploadsResult>";
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // GetObjectAttributes
  // -------------------------------------------------------------------------
  getObjectAttributes(res, bucketName, key, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const version = this.resolveObjectVersion(bucket, key, params.get("versionId"));
    if (!version || version.deleteMarker) {
      return this.sendError(res, 404, "NoSuchKey", "The specified key does not exist.", req, { Key: key });
    }
    res.setHeader("Last-Modified", new Date(version.lastModified).toUTCString());
    if (version.versionId) res.setHeader("x-amz-version-id", version.versionId);
    let xml = `${XML_HEADER}<GetObjectAttributesResponse xmlns="${S3_NS}">`;
    xml += tag("ETag", version.etag.replace(/"/g, ""));
    xml += tag("ObjectSize", version.size);
    xml += tag("StorageClass", version.storageClass || "STANDARD");
    xml += "</GetObjectAttributesResponse>";
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // Object tagging
  // -------------------------------------------------------------------------
  getObjectTagging(res, bucketName, key, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const version = this.resolveObjectVersion(bucket, key, params.get("versionId"));
    if (!version || version.deleteMarker) {
      return this.sendError(res, 404, "NoSuchKey", "The specified key does not exist.", req, { Key: key });
    }
    return this.sendXml(res, 200, this.taggingXml(version.tagging));
  }

  putObjectTagging(res, bucketName, key, params, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const version = this.resolveObjectVersion(bucket, key, params.get("versionId"));
    if (!version || version.deleteMarker) {
      return this.sendError(res, 404, "NoSuchKey", "The specified key does not exist.", req, { Key: key });
    }
    version.tagging = this.parseTaggingXml(body.toString("utf8"));
    return this.sendXml(res, 200, "");
  }

  deleteObjectTagging(res, bucketName, key, params, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const version = this.resolveObjectVersion(bucket, key, params.get("versionId"));
    if (!version || version.deleteMarker) {
      return this.sendError(res, 404, "NoSuchKey", "The specified key does not exist.", req, { Key: key });
    }
    version.tagging = new Map();
    return this.sendXml(res, 204, "");
  }

  taggingXml(map) {
    let xml = `${XML_HEADER}<Tagging xmlns="${S3_NS}"><TagSet>`;
    for (const [k, v] of (map || new Map())) {
      xml += `<Tag>${tag("Key", k)}${tag("Value", v)}</Tag>`;
    }
    xml += "</TagSet></Tagging>";
    return xml;
  }

  parseTaggingXml(xml) {
    const map = new Map();
    const tagRe = /<Tag>([\s\S]*?)<\/Tag>/g;
    let m;
    while ((m = tagRe.exec(xml)) !== null) {
      const k = (/<Key>([\s\S]*?)<\/Key>/.exec(m[1]) || [])[1];
      const v = (/<Value>([\s\S]*?)<\/Value>/.exec(m[1]) || [])[1];
      if (k !== undefined) map.set(this.unescapeXml(k), this.unescapeXml(v || ""));
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // ACL (objects + buckets) — canned/static representation
  // -------------------------------------------------------------------------
  aclXml() {
    return `${XML_HEADER}<AccessControlPolicy xmlns="${S3_NS}">${ownerXml()}<AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>${OWNER_ID}</ID><DisplayName>${OWNER_NAME}</DisplayName></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`;
  }

  getObjectAcl(res, bucketName, key, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const version = this.latestVersion(bucket, key);
    if (!version || version.deleteMarker) {
      return this.sendError(res, 404, "NoSuchKey", "The specified key does not exist.", req, { Key: key });
    }
    return this.sendXml(res, 200, this.aclXml());
  }

  putObjectAcl(res, bucketName, key, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const version = this.latestVersion(bucket, key);
    if (!version || version.deleteMarker) {
      return this.sendError(res, 404, "NoSuchKey", "The specified key does not exist.", req, { Key: key });
    }
    return this.sendXml(res, 200, "");
  }

  getBucketAcl(res, bucketName, req) {
    if (!this.requireBucket(res, bucketName, req)) return;
    return this.sendXml(res, 200, this.aclXml());
  }

  putBucketAcl(res, bucketName, req) {
    if (!this.requireBucket(res, bucketName, req)) return;
    return this.sendXml(res, 200, "");
  }

  // -------------------------------------------------------------------------
  // Bucket location / versioning
  // -------------------------------------------------------------------------
  getBucketLocation(res, bucketName, req) {
    if (!this.requireBucket(res, bucketName, req)) return;
    const constraint = this.region === "us-east-1" ? "" : this.region;
    const xml = `${XML_HEADER}<LocationConstraint xmlns="${S3_NS}">${escapeXml(constraint)}</LocationConstraint>`;
    return this.sendXml(res, 200, xml);
  }

  getBucketVersioning(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    let xml = `${XML_HEADER}<VersioningConfiguration xmlns="${S3_NS}">`;
    if (bucket.versioning) xml += tag("Status", bucket.versioning);
    xml += "</VersioningConfiguration>";
    return this.sendXml(res, 200, xml);
  }

  putBucketVersioning(res, bucketName, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    const status = (/<Status>([\s\S]*?)<\/Status>/.exec(body.toString("utf8")) || [])[1];
    if (status === "Enabled" || status === "Suspended") bucket.versioning = status;
    return this.sendXml(res, 200, "");
  }

  // -------------------------------------------------------------------------
  // Bucket tagging
  // -------------------------------------------------------------------------
  getBucketTagging(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    if (!bucket.tagging || bucket.tagging.size === 0) {
      return this.sendError(res, 404, "NoSuchTagSet", "The TagSet does not exist", req);
    }
    return this.sendXml(res, 200, this.taggingXml(bucket.tagging));
  }

  putBucketTagging(res, bucketName, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.tagging = this.parseTaggingXml(body.toString("utf8"));
    return this.sendXml(res, 204, "");
  }

  deleteBucketTagging(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.tagging = new Map();
    return this.sendXml(res, 204, "");
  }

  // -------------------------------------------------------------------------
  // Bucket CORS
  // -------------------------------------------------------------------------
  getBucketCors(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    if (!bucket.cors) {
      return this.sendError(res, 404, "NoSuchCORSConfiguration", "The CORS configuration does not exist", req);
    }
    return this.sendXml(res, 200, bucket.cors);
  }

  putBucketCors(res, bucketName, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.cors = `${XML_HEADER}${body.toString("utf8").replace(/^<\?xml[^>]*\?>/, "")}`;
    return this.sendXml(res, 200, "");
  }

  deleteBucketCors(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.cors = null;
    return this.sendXml(res, 204, "");
  }

  // -------------------------------------------------------------------------
  // Bucket policy
  // -------------------------------------------------------------------------
  getBucketPolicy(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    if (!bucket.policy) {
      return this.sendError(res, 404, "NoSuchBucketPolicy", "The bucket policy does not exist", req);
    }
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(bucket.policy);
  }

  putBucketPolicy(res, bucketName, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.policy = body.toString("utf8");
    return this.sendXml(res, 204, "");
  }

  deleteBucketPolicy(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.policy = null;
    return this.sendXml(res, 204, "");
  }

  // -------------------------------------------------------------------------
  // Bucket lifecycle
  // -------------------------------------------------------------------------
  getBucketLifecycle(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    if (!bucket.lifecycle) {
      return this.sendError(res, 404, "NoSuchLifecycleConfiguration", "The lifecycle configuration does not exist", req);
    }
    return this.sendXml(res, 200, bucket.lifecycle);
  }

  putBucketLifecycle(res, bucketName, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.lifecycle = `${XML_HEADER}${body.toString("utf8").replace(/^<\?xml[^>]*\?>/, "")}`;
    return this.sendXml(res, 200, "");
  }

  deleteBucketLifecycle(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.lifecycle = null;
    return this.sendXml(res, 204, "");
  }

  // -------------------------------------------------------------------------
  // Bucket encryption
  // -------------------------------------------------------------------------
  getBucketEncryption(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    if (!bucket.encryption) {
      return this.sendError(res, 404, "ServerSideEncryptionConfigurationNotFoundError", "The server side encryption configuration was not found", req);
    }
    return this.sendXml(res, 200, bucket.encryption);
  }

  putBucketEncryption(res, bucketName, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.encryption = `${XML_HEADER}${body.toString("utf8").replace(/^<\?xml[^>]*\?>/, "")}`;
    return this.sendXml(res, 200, "");
  }

  deleteBucketEncryption(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.encryption = null;
    return this.sendXml(res, 204, "");
  }

  // -------------------------------------------------------------------------
  // Bucket website
  // -------------------------------------------------------------------------
  getBucketWebsite(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    if (!bucket.website) {
      return this.sendError(res, 404, "NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration", req);
    }
    return this.sendXml(res, 200, bucket.website);
  }

  putBucketWebsite(res, bucketName, body, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.website = `${XML_HEADER}${body.toString("utf8").replace(/^<\?xml[^>]*\?>/, "")}`;
    return this.sendXml(res, 200, "");
  }

  deleteBucketWebsite(res, bucketName, req) {
    const bucket = this.requireBucket(res, bucketName, req);
    if (!bucket) return;
    bucket.website = null;
    return this.sendXml(res, 204, "");
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendXml(res, status, xml) {
    res.statusCode = status;
    if (status === 204 || xml === "") {
      if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/xml");
      res.end(status === 204 ? undefined : xml || "");
      return;
    }
    res.setHeader("Content-Type", "application/xml");
    res.end(xml);
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, status, code, message, req, extra = {}) {
    const resource = req ? (req.url || "").split("?")[0] : "/";
    // Real S3 error bodies carry RequestId/HostId that match the
    // x-amz-request-id / x-amz-id-2 response headers. Reuse the headers set
    // in handle() so the body and headers agree; fall back to fresh ids.
    let requestId = res.getHeader("x-amz-request-id");
    let hostId = res.getHeader("x-amz-id-2");
    if (!requestId) {
      requestId = this.requestId();
      res.setHeader("x-amz-request-id", requestId);
    }
    if (!hostId) {
      hostId = this.requestId();
      res.setHeader("x-amz-id-2", hostId);
    }
    let xml = `${XML_HEADER}<Error>`;
    xml += tag("Code", code);
    xml += tag("Message", message);
    for (const [k, v] of Object.entries(extra)) xml += tag(k, v);
    xml += tag("Resource", resource);
    xml += tag("RequestId", requestId);
    xml += tag("HostId", hostId);
    xml += "</Error>";
    res.statusCode = status;
    res.setHeader("Content-Type", "application/xml");
    res.end(xml);
  }
}

export default S3Server;
