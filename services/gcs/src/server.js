// parlel/gcs — a lightweight, dependency-free fake of Google Cloud Storage.
//
// Speaks the GCS JSON API (https://storage.googleapis.com/storage/v1) so that
// application code using the real `@google-cloud/storage` client can run
// against it with zero cost and zero side effects. Pure Node.js, no external
// npm dependencies. State is in-memory and ephemeral (resettable via reset()
// or POST /_parlel/reset).
//
// Point the client at this server by setting either:
//   - STORAGE_EMULATOR_HOST=http://127.0.0.1:4580, or
//   - new Storage({ apiEndpoint: "http://127.0.0.1:4580", projectId: "parlel" })

import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// CRC32C (Castagnoli) — GCS reports object hashes as base64 crc32c + md5.
// The real @google-cloud/storage client validates downloads against the
// x-goog-hash header, so we must compute a correct crc32c.
// ---------------------------------------------------------------------------

const CRC32C_TABLE = (() => {
  const poly = 0x82f63b78;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? poly ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32c(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32C_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const out = Buffer.alloc(4);
  out.writeUInt32BE(crc, 0);
  return out.toString("base64");
}

function md5Base64(buf) {
  return createHash("md5").update(buf).digest("base64");
}

function md5Hex(buf) {
  return createHash("md5").update(buf).digest("hex");
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, (m) => m);
}

// ---------------------------------------------------------------------------
// GCS bucket-name validation (relaxed but realistic).
// ---------------------------------------------------------------------------
function isValidBucketName(name) {
  if (typeof name !== "string") return false;
  if (name.length < 3 || name.length > 222) return false;
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(name)) return false;
  if (name.includes("..")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return false; // not an IP
  return true;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export class GcsServer {
  constructor(port = 4580, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.projectId = options.projectId || "parlel";
    this.server = null;
    this.reset();
  }

  reset() {
    // buckets: Map<name, Bucket>
    // Bucket = {
    //   name, id, timeCreated, updated, metageneration,
    //   location, storageClass, versioning(bool), labels, metadata(custom),
    //   objects: Map<name, ObjectGeneration[]>  // ascending generation
    // }
    // ObjectGeneration = {
    //   name, bucket, generation, metageneration, body(Buffer),
    //   contentType, size, md5Hash, crc32c, etag, timeCreated, updated,
    //   metadata(custom), cacheControl, contentDisposition, contentEncoding,
    //   contentLanguage, storageClass, deleted(bool for soft state)
    // }
    this.buckets = new Map();
    this.resumableUploads = new Map(); // uploadId -> { bucket, name, metadata, chunks, contentType }
    this.hmacKeys = new Map(); // accessId -> key
    this.generationCounter = Date.now();
  }

  nextGeneration() {
    this.generationCounter += 1;
    return String(this.generationCounter);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, 500, "internalError", error.message || "internal error");
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

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = url.pathname;
    const q = url.searchParams;

    res.setHeader("x-guploader-uploadid", md5Hex(String(Math.random())).slice(0, 24));

    // Internal endpoints (not part of GCS).
    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "gcs", buckets: this.buckets.size });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    const body = await this.readBody(req);

    // ---- Resumable / media upload endpoints ----
    // POST   /upload/storage/v1/b/{bucket}/o    (start or multipart/media)
    // PUT    /upload/storage/v1/b/{bucket}/o    (resumable chunk, upload_id in qs)
    if (pathname.startsWith("/upload/storage/v1/b/")) {
      return this.handleUpload(req, res, method, pathname, q, body);
    }

    // ---- Batch endpoint ----
    if (pathname === "/batch/storage/v1" && method === "POST") {
      return this.handleBatch(req, res, q, body);
    }

    // ---- Standard JSON API ----
    if (pathname.startsWith("/storage/v1/")) {
      return this.handleJsonApi(req, res, method, pathname, q, body);
    }

    // Some clients hit /storage/v1 (no trailing). Normalize.
    if (pathname === "/storage/v1" || pathname === "/storage/v1/") {
      return this.sendJson(res, 200, { kind: "storage#serviceAccount", email_address: `parlel@${this.projectId}.iam.gserviceaccount.com` });
    }

    // ---- Public / XML-style direct object access: /{bucket}/{object} ----
    // Used by File#isPublic() and File#publicUrl() (GET/HEAD only). The parlel
    // fake serves the bytes when the object exists; it does not enforce ACLs.
    if ((method === "GET" || method === "HEAD") && pathname !== "/") {
      const segs = splitPath(pathname);
      if (segs.length >= 2) {
        const bucketName = decodeURIComponent(segs[0]);
        const objectName = decodeURIComponent(segs.slice(1).join("/"));
        const b = this.buckets.get(bucketName);
        if (b) {
          const o = this.liveGeneration(b, objectName);
          if (o) {
            if (method === "HEAD") {
              res.setHeader("Content-Type", o.contentType || "application/octet-stream");
              res.setHeader("Content-Length", String(o.size));
              res.setHeader("ETag", o.etag);
              res.statusCode = 200;
              return res.end();
            }
            return this.downloadObject(req, res, bucketName, objectName, q);
          }
        }
        return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`);
      }
    }

    return this.sendError(res, 404, "notFound", "Not Found");
  }

  // -------------------------------------------------------------------------
  // JSON API dispatch
  // -------------------------------------------------------------------------
  handleJsonApi(req, res, method, pathname, q, body) {
    const rest = pathname.slice("/storage/v1/".length);
    const parts = splitPath(rest);

    // /b  -> buckets collection
    if (parts[0] === "b") {
      // /b                         GET list, POST insert
      if (parts.length === 1) {
        if (method === "GET") return this.listBuckets(res, q);
        if (method === "POST") return this.insertBucket(res, q, body);
        return this.sendError(res, 405, "methodNotAllowed", "Method Not Allowed");
      }

      const bucketName = decodeURIComponent(parts[1]);

      // /b/{bucket}
      if (parts.length === 2) {
        if (method === "GET") return this.getBucket(res, bucketName);
        if (method === "DELETE") return this.deleteBucket(res, bucketName, q);
        if (method === "PATCH") return this.patchBucket(res, bucketName, body);
        if (method === "PUT") return this.updateBucket(res, bucketName, body);
        return this.sendError(res, 405, "methodNotAllowed", "Method Not Allowed");
      }

      // /b/{bucket}/o
      if (parts[2] === "o") {
        if (parts.length === 3) {
          if (method === "GET") return this.listObjects(res, bucketName, q);
          return this.sendError(res, 405, "methodNotAllowed", "Method Not Allowed");
        }
        // /b/{bucket}/o/{object}
        if (parts.length === 4) {
          const objectName = decodeURIComponent(parts[3]);
          if (method === "GET") {
            if (q.get("alt") === "media") return this.downloadObject(req, res, bucketName, objectName, q);
            return this.getObject(res, bucketName, objectName, q);
          }
          if (method === "DELETE") return this.deleteObject(res, bucketName, objectName, q);
          if (method === "PATCH") return this.patchObject(res, bucketName, objectName, q, body);
          if (method === "PUT") return this.updateObject(res, bucketName, objectName, q, body);
          return this.sendError(res, 405, "methodNotAllowed", "Method Not Allowed");
        }
        // /b/{bucket}/o/{object}/acl  and  /b/{bucket}/o/{object}/acl/{entity}
        if (parts.length >= 5 && parts[4] === "acl") {
          const objectName = decodeURIComponent(parts[3]);
          const entity = parts.length >= 6 ? decodeURIComponent(parts[5]) : null;
          return this.handleAcl(res, method, bucketName, objectName, entity, q, body);
        }
        // /b/{bucket}/o/{object}/rewriteTo/b/{destBucket}/o/{destObject}
        if (parts[4] === "rewriteTo" && parts[5] === "b" && parts[7] === "o") {
          const srcObject = decodeURIComponent(parts[3]);
          const destBucket = decodeURIComponent(parts[6]);
          const destObject = decodeURIComponent(parts[8]);
          if (method === "POST") return this.rewriteObject(res, bucketName, srcObject, destBucket, destObject, q, body);
        }
      }

      // /b/{bucket}/o/{object}/copyTo/b/{destBucket}/o/{destObject}
      if (parts[2] === "o" && parts[4] === "copyTo" && parts[5] === "b" && parts[7] === "o") {
        const srcObject = decodeURIComponent(parts[3]);
        const destBucket = decodeURIComponent(parts[6]);
        const destObject = decodeURIComponent(parts[8]);
        if (method === "POST") return this.copyObject(res, bucketName, srcObject, destBucket, destObject, q, body);
      }

      // /b/{bucket}/acl  and  /b/{bucket}/acl/{entity}
      if (parts[2] === "acl") {
        const entity = parts.length >= 4 ? decodeURIComponent(parts[3]) : null;
        return this.handleAcl(res, method, bucketName, null, entity, q, body);
      }

      // /b/{bucket}/defaultObjectAcl  and  /b/{bucket}/defaultObjectAcl/{entity}
      if (parts[2] === "defaultObjectAcl") {
        const entity = parts.length >= 4 ? decodeURIComponent(parts[3]) : null;
        return this.handleAcl(res, method, bucketName, null, entity, q, body, true);
      }

      // /b/{bucket}/notificationConfigs  (Pub/Sub notifications — canned)
      if (parts[2] === "notificationConfigs") {
        if (!this.requireBucket(res, bucketName)) return;
        if (parts.length === 3 && method === "GET") {
          return this.sendJson(res, 200, { kind: "storage#notifications", items: [] });
        }
        if (parts.length === 3 && method === "POST") {
          let payload = {};
          try {
            payload = body.length ? JSON.parse(body.toString("utf8")) : {};
          } catch {
            payload = {};
          }
          const id = md5Hex(String(Math.random())).slice(0, 12);
          return this.sendJson(res, 200, {
            kind: "storage#notification",
            id,
            topic: payload.topic || "",
            payload_format: payload.payload_format || "JSON_API_V1",
            etag: `etag-${id}`,
            selfLink: `http://${this.host}:${this.port}/storage/v1/b/${bucketName}/notificationConfigs/${id}`,
          });
        }
        if (parts.length === 4) {
          if (method === "GET") {
            return this.sendJson(res, 200, { kind: "storage#notification", id: decodeURIComponent(parts[3]) });
          }
          if (method === "DELETE") {
            res.statusCode = 204;
            return res.end();
          }
        }
      }

      // /b/{bucket}/iam   and   /b/{bucket}/iam/testPermissions
      if (parts[2] === "iam") {
        if (parts.length === 3 && method === "GET") return this.getBucketIam(res, bucketName);
        if (parts.length === 3 && method === "PUT") return this.setBucketIam(res, bucketName, body);
        if (parts[3] === "testPermissions" && method === "GET") return this.testBucketIam(res, bucketName, q);
      }
    }

    // /b/{bucket}/o compose handled above via objects; compose is POST /o/{name}/compose
    if (parts[0] === "b" && parts[2] === "o" && parts[4] === "compose") {
      const bucketName = decodeURIComponent(parts[1]);
      const objectName = decodeURIComponent(parts[3]);
      if (method === "POST") return this.composeObject(res, bucketName, objectName, q, body);
    }

    // /projects/{project}/serviceAccount  and  /projects/{project}/hmacKeys
    if (parts[0] === "projects") {
      if (parts[2] === "serviceAccount" && method === "GET") {
        return this.sendJson(res, 200, {
          kind: "storage#serviceAccount",
          email_address: `parlel@${this.projectId}.iam.gserviceaccount.com`,
        });
      }
      if (parts[2] === "hmacKeys") {
        if (parts.length === 3 && method === "GET") return this.listHmacKeys(res, q);
        if (parts.length === 3 && method === "POST") return this.createHmacKey(res, q);
        if (parts.length === 4) {
          const accessId = decodeURIComponent(parts[3]);
          if (method === "GET") return this.getHmacKey(res, accessId);
          if (method === "DELETE") return this.deleteHmacKey(res, accessId);
          if (method === "PUT") return this.updateHmacKey(res, accessId, body);
        }
      }
    }

    return this.sendError(res, 404, "notFound", "Not Found");
  }

  // -------------------------------------------------------------------------
  // Bucket store helpers
  // -------------------------------------------------------------------------
  bucketResource(b) {
    return {
      kind: "storage#bucket",
      id: b.name,
      selfLink: `http://${this.host}:${this.port}/storage/v1/b/${b.name}`,
      name: b.name,
      projectNumber: "1",
      metageneration: String(b.metageneration),
      location: b.location,
      storageClass: b.storageClass,
      etag: `etag-${b.name}-${b.metageneration}`,
      timeCreated: b.timeCreated,
      updated: b.updated,
      iamConfiguration: {
        bucketPolicyOnly: { enabled: false },
        uniformBucketLevelAccess: { enabled: false },
        publicAccessPrevention: "inherited",
      },
      locationType: "region",
      ...(b.versioning ? { versioning: { enabled: true } } : { versioning: { enabled: false } }),
      ...(b.labels && Object.keys(b.labels).length ? { labels: b.labels } : {}),
      ...(b.metadata || {}),
    };
  }

  requireBucket(res, name) {
    const b = this.buckets.get(name);
    if (!b) {
      this.sendError(res, 404, "notFound", `Bucket ${name} not found`, [
        { domain: "global", reason: "notFound", message: `Bucket ${name} not found` },
      ]);
      return null;
    }
    return b;
  }

  // -------------------------------------------------------------------------
  // Buckets: list / insert / get / delete / patch / update
  // -------------------------------------------------------------------------
  listBuckets(res, q) {
    const prefix = q.get("prefix") || "";
    const items = [...this.buckets.values()]
      .filter((b) => (prefix ? b.name.startsWith(prefix) : true))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((b) => this.bucketResource(b));
    return this.sendJson(res, 200, { kind: "storage#buckets", items });
  }

  insertBucket(res, q, body) {
    let parsed;
    try {
      parsed = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, 400, "invalid", "Invalid JSON body");
    }
    const name = parsed.name || q.get("name");
    if (!name) {
      return this.sendError(res, 400, "required", "Required parameter: name");
    }
    if (!isValidBucketName(name)) {
      return this.sendError(res, 400, "invalid", `Invalid bucket name: ${name}`);
    }
    if (this.buckets.has(name)) {
      return this.sendError(res, 409, "conflict", `You already own this bucket. Please select another name.`, [
        { domain: "global", reason: "conflict", message: "You already own this bucket. Please select another name." },
      ]);
    }
    const ts = nowIso();
    const bucket = {
      name,
      timeCreated: ts,
      updated: ts,
      metageneration: 1,
      location: (parsed.location || "US").toUpperCase(),
      storageClass: parsed.storageClass || "STANDARD",
      versioning: !!(parsed.versioning && parsed.versioning.enabled),
      labels: parsed.labels || {},
      metadata: {},
      objects: new Map(),
    };
    this.buckets.set(name, bucket);
    return this.sendJson(res, 200, this.bucketResource(bucket));
  }

  getBucket(res, name) {
    const b = this.requireBucket(res, name);
    if (!b) return;
    return this.sendJson(res, 200, this.bucketResource(b));
  }

  deleteBucket(res, name, q) {
    const b = this.requireBucket(res, name);
    if (!b) return;
    const hasObjects = [...b.objects.values()].some((gens) => gens.some((g) => !g.deleted));
    if (hasObjects) {
      return this.sendError(res, 409, "conflict", `The bucket you tried to delete is not empty.`, [
        { domain: "global", reason: "conflict", message: "The bucket you tried to delete is not empty." },
      ]);
    }
    this.buckets.delete(name);
    res.statusCode = 204;
    res.end();
  }

  patchBucket(res, name, body) {
    const b = this.requireBucket(res, name);
    if (!b) return;
    let patch = {};
    try {
      patch = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, 400, "invalid", "Invalid JSON body");
    }
    this.applyBucketPatch(b, patch);
    b.metageneration += 1;
    b.updated = nowIso();
    return this.sendJson(res, 200, this.bucketResource(b));
  }

  updateBucket(res, name, body) {
    return this.patchBucket(res, name, body);
  }

  applyBucketPatch(b, patch) {
    if (patch.versioning !== undefined && patch.versioning !== null) {
      b.versioning = !!patch.versioning.enabled;
    }
    if (patch.labels !== undefined) {
      // null label values remove the key.
      const labels = { ...b.labels };
      for (const [k, v] of Object.entries(patch.labels || {})) {
        if (v === null) delete labels[k];
        else labels[k] = v;
      }
      b.labels = labels;
    }
    if (patch.storageClass) b.storageClass = patch.storageClass;
    if (patch.website !== undefined) b.metadata.website = patch.website;
    if (patch.cors !== undefined) b.metadata.cors = patch.cors;
    if (patch.lifecycle !== undefined) b.metadata.lifecycle = patch.lifecycle;
  }

  // -------------------------------------------------------------------------
  // Objects store helpers
  // -------------------------------------------------------------------------
  liveGeneration(bucket, name, generation) {
    const gens = bucket.objects.get(name);
    if (!gens || gens.length === 0) return null;
    if (generation) {
      return gens.find((g) => g.generation === String(generation)) || null;
    }
    // latest non-deleted
    for (let i = gens.length - 1; i >= 0; i -= 1) {
      if (!gens[i].deleted) return gens[i];
    }
    return null;
  }

  objectResource(o) {
    return {
      kind: "storage#object",
      id: `${o.bucket}/${o.name}/${o.generation}`,
      selfLink: `http://${this.host}:${this.port}/storage/v1/b/${o.bucket}/o/${encodeURIComponent(o.name)}`,
      mediaLink: `http://${this.host}:${this.port}/storage/v1/b/${o.bucket}/o/${encodeURIComponent(o.name)}?generation=${o.generation}&alt=media`,
      name: o.name,
      bucket: o.bucket,
      generation: o.generation,
      metageneration: String(o.metageneration),
      contentType: o.contentType,
      storageClass: o.storageClass || "STANDARD",
      size: String(o.size),
      md5Hash: o.md5Hash,
      crc32c: o.crc32c,
      etag: o.etag,
      timeCreated: o.timeCreated,
      updated: o.updated,
      timeStorageClassUpdated: o.timeCreated,
      ...(o.cacheControl ? { cacheControl: o.cacheControl } : {}),
      ...(o.contentDisposition ? { contentDisposition: o.contentDisposition } : {}),
      ...(o.contentEncoding ? { contentEncoding: o.contentEncoding } : {}),
      ...(o.contentLanguage ? { contentLanguage: o.contentLanguage } : {}),
      ...(o.metadata && Object.keys(o.metadata).length ? { metadata: o.metadata } : {}),
    };
  }

  storeObject(bucket, name, bodyBuf, meta) {
    const generation = this.nextGeneration();
    const ts = nowIso();
    const record = {
      name,
      bucket: bucket.name,
      generation,
      metageneration: 1,
      body: bodyBuf,
      size: bodyBuf.length,
      contentType: meta.contentType || "application/octet-stream",
      md5Hash: md5Base64(bodyBuf),
      crc32c: crc32c(bodyBuf),
      etag: `${md5Hex(bodyBuf).slice(0, 16)}`,
      timeCreated: ts,
      updated: ts,
      metadata: meta.metadata || {},
      cacheControl: meta.cacheControl,
      contentDisposition: meta.contentDisposition,
      contentEncoding: meta.contentEncoding,
      contentLanguage: meta.contentLanguage,
      storageClass: meta.storageClass || bucket.storageClass || "STANDARD",
      deleted: false,
    };
    let gens = bucket.objects.get(name);
    if (!gens) {
      gens = [];
      bucket.objects.set(name, gens);
    }
    if (bucket.versioning) {
      gens.push(record);
    } else {
      // Replace: drop previous live generations.
      bucket.objects.set(name, [record]);
    }
    return record;
  }

  // -------------------------------------------------------------------------
  // List objects
  // -------------------------------------------------------------------------
  listObjects(res, bucketName, q) {
    const b = this.requireBucket(res, bucketName);
    if (!b) return;
    const prefix = q.get("prefix") || "";
    const delimiter = q.get("delimiter") || "";
    const versions = q.get("versions") === "true";
    const startOffset = q.get("startOffset") || "";
    const endOffset = q.get("endOffset") || "";
    const maxResults = q.get("maxResults") ? parseInt(q.get("maxResults"), 10) : 1000;
    const pageToken = q.get("pageToken") || "";

    const allNames = [...b.objects.keys()].sort();
    const items = [];
    const prefixes = new Set();

    const flat = [];
    for (const name of allNames) {
      if (prefix && !name.startsWith(prefix)) continue;
      if (startOffset && name < startOffset) continue;
      if (endOffset && name >= endOffset) continue;
      const gens = b.objects.get(name);
      if (versions) {
        for (const g of gens) flat.push(g);
      } else {
        const live = this.liveGeneration(b, name);
        if (live) flat.push(live);
      }
    }

    // Apply delimiter to produce prefixes.
    const collapsed = [];
    for (const g of flat) {
      if (delimiter) {
        const rest = g.name.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx !== -1) {
          prefixes.add(prefix + rest.slice(0, idx + delimiter.length));
          continue;
        }
      }
      collapsed.push(g);
    }

    // Pagination by name index.
    const startIdx = pageToken ? parseInt(Buffer.from(pageToken, "base64").toString("utf8"), 10) || 0 : 0;
    const pageItems = collapsed.slice(startIdx, startIdx + maxResults);
    for (const g of pageItems) items.push(this.objectResource(g));
    const nextIdx = startIdx + maxResults;
    const nextPageToken = nextIdx < collapsed.length ? Buffer.from(String(nextIdx), "utf8").toString("base64") : undefined;

    const out = { kind: "storage#objects" };
    if (items.length) out.items = items;
    if (prefixes.size) out.prefixes = [...prefixes].sort();
    if (nextPageToken) out.nextPageToken = nextPageToken;
    return this.sendJson(res, 200, out);
  }

  // -------------------------------------------------------------------------
  // Get / download / delete / patch / update object
  // -------------------------------------------------------------------------
  getObject(res, bucketName, objectName, q) {
    const b = this.requireBucket(res, bucketName);
    if (!b) return;
    const o = this.liveGeneration(b, objectName, q.get("generation"));
    if (!o) {
      return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`, [
        { domain: "global", reason: "notFound", message: `No such object: ${bucketName}/${objectName}` },
      ]);
    }
    const cond = this.checkObjectPreconditions(q, o);
    if (cond) return this.sendError(res, cond.status, cond.reason, cond.message);
    return this.sendJson(res, 200, this.objectResource(o));
  }

  downloadObject(req, res, bucketName, objectName, q) {
    const b = this.buckets.get(bucketName);
    if (!b) {
      return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`);
    }
    const o = this.liveGeneration(b, objectName, q.get("generation"));
    if (!o) {
      return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`, [
        { domain: "global", reason: "notFound", message: `No such object: ${bucketName}/${objectName}` },
      ]);
    }

    let payload = o.body;
    let status = 200;
    const total = payload.length;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === "" ? null : parseInt(m[1], 10);
        let end = m[2] === "" ? null : parseInt(m[2], 10);
        if (start === null && end !== null) {
          start = Math.max(0, total - end);
          end = total - 1;
        } else {
          if (start === null) start = 0;
          if (end === null || end >= total) end = total - 1;
        }
        if (start > end || start >= total) {
          res.setHeader("Content-Range", `bytes */${total}`);
          res.statusCode = 416;
          return res.end();
        }
        payload = payload.subarray(start, end + 1);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        status = 206;
      }
    }

    res.setHeader("Content-Type", o.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(payload.length));
    res.setHeader("x-goog-hash", `crc32c=${o.crc32c},md5=${o.md5Hash}`);
    res.setHeader("x-goog-generation", o.generation);
    res.setHeader("x-goog-metageneration", String(o.metageneration));
    res.setHeader("x-goog-stored-content-length", String(o.size));
    res.setHeader("x-goog-stored-content-encoding", o.contentEncoding || "identity");
    res.setHeader("ETag", o.etag);
    res.setHeader("Last-Modified", new Date(o.updated).toUTCString());
    if (o.cacheControl) res.setHeader("Cache-Control", o.cacheControl);
    if (o.contentEncoding) res.setHeader("Content-Encoding", o.contentEncoding);
    if (o.contentDisposition) res.setHeader("Content-Disposition", o.contentDisposition);
    if (o.contentLanguage) res.setHeader("Content-Language", o.contentLanguage);
    res.statusCode = status;
    res.end(payload);
  }

  deleteObject(res, bucketName, objectName, q) {
    const b = this.requireBucket(res, bucketName);
    if (!b) return;
    const gens = b.objects.get(objectName);
    const generation = q.get("generation");
    if (!gens || gens.length === 0) {
      return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`, [
        { domain: "global", reason: "notFound", message: `No such object: ${bucketName}/${objectName}` },
      ]);
    }
    if (generation) {
      const idx = gens.findIndex((g) => g.generation === String(generation));
      if (idx === -1) {
        return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`);
      }
      const target = gens[idx];
      const cond = this.checkObjectPreconditions(q, target);
      if (cond) return this.sendError(res, cond.status, cond.reason, cond.message);
      gens.splice(idx, 1);
      if (gens.length === 0) b.objects.delete(objectName);
      res.statusCode = 204;
      return res.end();
    }
    const live = this.liveGeneration(b, objectName);
    if (!live) {
      return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`);
    }
    const cond = this.checkObjectPreconditions(q, live);
    if (cond) return this.sendError(res, cond.status, cond.reason, cond.message);
    if (b.versioning) {
      live.deleted = true;
    } else {
      b.objects.delete(objectName);
    }
    res.statusCode = 204;
    res.end();
  }

  patchObject(res, bucketName, objectName, q, body) {
    const b = this.requireBucket(res, bucketName);
    if (!b) return;
    const o = this.liveGeneration(b, objectName, q.get("generation"));
    if (!o) {
      return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`, [
        { domain: "global", reason: "notFound", message: `No such object: ${bucketName}/${objectName}` },
      ]);
    }
    let patch = {};
    try {
      patch = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, 400, "invalid", "Invalid JSON body");
    }
    if (patch.contentType !== undefined) o.contentType = patch.contentType;
    if (patch.cacheControl !== undefined) o.cacheControl = patch.cacheControl;
    if (patch.contentDisposition !== undefined) o.contentDisposition = patch.contentDisposition;
    if (patch.contentEncoding !== undefined) o.contentEncoding = patch.contentEncoding;
    if (patch.contentLanguage !== undefined) o.contentLanguage = patch.contentLanguage;
    if (patch.storageClass !== undefined) o.storageClass = patch.storageClass;
    if (patch.metadata !== undefined) {
      if (patch.metadata === null) {
        o.metadata = {};
      } else {
        const md = { ...o.metadata };
        for (const [k, v] of Object.entries(patch.metadata)) {
          if (v === null) delete md[k];
          else md[k] = v;
        }
        o.metadata = md;
      }
    }
    o.metageneration += 1;
    o.updated = nowIso();
    return this.sendJson(res, 200, this.objectResource(o));
  }

  updateObject(res, bucketName, objectName, q, body) {
    return this.patchObject(res, bucketName, objectName, q, body);
  }

  // -------------------------------------------------------------------------
  // Copy / rewrite / compose
  // -------------------------------------------------------------------------
  copyObject(res, srcBucket, srcObject, destBucket, destObject, q, body) {
    const sb = this.requireBucket(res, srcBucket);
    if (!sb) return;
    const db = this.buckets.get(destBucket);
    if (!db) {
      return this.sendError(res, 404, "notFound", `Bucket ${destBucket} not found`);
    }
    const src = this.liveGeneration(sb, srcObject, q.get("sourceGeneration"));
    if (!src) {
      return this.sendError(res, 404, "notFound", `No such object: ${srcBucket}/${srcObject}`, [
        { domain: "global", reason: "notFound", message: `No such object: ${srcBucket}/${srcObject}` },
      ]);
    }
    let meta = {};
    try {
      meta = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      meta = {};
    }
    const record = this.storeObject(db, destObject, Buffer.from(src.body), {
      contentType: meta.contentType || src.contentType,
      metadata: meta.metadata || { ...src.metadata },
      cacheControl: meta.cacheControl || src.cacheControl,
      contentDisposition: meta.contentDisposition || src.contentDisposition,
      contentEncoding: meta.contentEncoding || src.contentEncoding,
      contentLanguage: meta.contentLanguage || src.contentLanguage,
      storageClass: meta.storageClass || src.storageClass,
    });
    return this.sendJson(res, 200, this.objectResource(record));
  }

  rewriteObject(res, srcBucket, srcObject, destBucket, destObject, q, body) {
    const sb = this.requireBucket(res, srcBucket);
    if (!sb) return;
    const db = this.buckets.get(destBucket);
    if (!db) {
      return this.sendError(res, 404, "notFound", `Bucket ${destBucket} not found`);
    }
    const src = this.liveGeneration(sb, srcObject, q.get("sourceGeneration"));
    if (!src) {
      return this.sendError(res, 404, "notFound", `No such object: ${srcBucket}/${srcObject}`, [
        { domain: "global", reason: "notFound", message: `No such object: ${srcBucket}/${srcObject}` },
      ]);
    }
    let meta = {};
    try {
      meta = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      meta = {};
    }
    const record = this.storeObject(db, destObject, Buffer.from(src.body), {
      contentType: meta.contentType || src.contentType,
      metadata: meta.metadata || { ...src.metadata },
      cacheControl: meta.cacheControl || src.cacheControl,
      contentDisposition: meta.contentDisposition || src.contentDisposition,
      contentEncoding: meta.contentEncoding || src.contentEncoding,
      contentLanguage: meta.contentLanguage || src.contentLanguage,
      storageClass: meta.storageClass || src.storageClass,
    });
    return this.sendJson(res, 200, {
      kind: "storage#rewriteResponse",
      totalBytesRewritten: String(record.size),
      objectSize: String(record.size),
      done: true,
      resource: this.objectResource(record),
    });
  }

  composeObject(res, bucketName, objectName, q, body) {
    const b = this.requireBucket(res, bucketName);
    if (!b) return;
    let payload = {};
    try {
      payload = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, 400, "invalid", "Invalid JSON body");
    }
    const sources = payload.sourceObjects || [];
    if (!sources.length) {
      return this.sendError(res, 400, "required", "You must provide at least one source object.");
    }
    const buffers = [];
    for (const s of sources) {
      const src = this.liveGeneration(b, s.name, s.generation);
      if (!src) {
        return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${s.name}`, [
          { domain: "global", reason: "notFound", message: `No such object: ${bucketName}/${s.name}` },
        ]);
      }
      buffers.push(src.body);
    }
    const merged = Buffer.concat(buffers);
    const destMeta = payload.destination || {};
    const record = this.storeObject(b, objectName, merged, {
      contentType: destMeta.contentType || "application/octet-stream",
      metadata: destMeta.metadata || {},
      cacheControl: destMeta.cacheControl,
      contentDisposition: destMeta.contentDisposition,
      contentEncoding: destMeta.contentEncoding,
      contentLanguage: destMeta.contentLanguage,
      storageClass: destMeta.storageClass,
    });
    return this.sendJson(res, 200, this.objectResource(record));
  }

  // -------------------------------------------------------------------------
  // Uploads: simple (media), multipart, resumable
  // -------------------------------------------------------------------------
  handleUpload(req, res, method, pathname, q, body) {
    // pathname: /upload/storage/v1/b/{bucket}/o
    const rest = pathname.slice("/upload/storage/v1/b/".length);
    const parts = splitPath(rest);
    const bucketName = decodeURIComponent(parts[0] || "");
    const b = this.buckets.get(bucketName);
    if (!b) {
      return this.sendError(res, 404, "notFound", `Bucket ${bucketName} not found`, [
        { domain: "global", reason: "notFound", message: `Bucket ${bucketName} not found` },
      ]);
    }

    const uploadType = q.get("uploadType");
    const uploadId = q.get("upload_id");

    // Resumable PUT chunk
    if (method === "PUT" && uploadId) {
      return this.handleResumablePut(req, res, uploadId, body);
    }

    // Resumable start
    if (method === "POST" && uploadType === "resumable") {
      return this.startResumableUpload(req, res, b, q, body);
    }

    // Multipart
    if (method === "POST" && uploadType === "multipart") {
      return this.handleMultipartUpload(req, res, b, q, body);
    }

    // Simple media upload (uploadType=media); name comes from qs
    if (method === "POST" && uploadType === "media") {
      const name = q.get("name");
      if (!name) return this.sendError(res, 400, "required", "Required parameter: name");
      const record = this.storeObject(b, name, body, {
        contentType: req.headers["content-type"] || "application/octet-stream",
      });
      return this.sendJson(res, 200, this.objectResource(record));
    }

    // Default to multipart if a body looks like multipart/related.
    if (method === "POST") {
      const ct = req.headers["content-type"] || "";
      if (ct.includes("multipart/")) return this.handleMultipartUpload(req, res, b, q, body);
      // fall back to media
      const name = q.get("name");
      if (name) {
        const record = this.storeObject(b, name, body, { contentType: ct || "application/octet-stream" });
        return this.sendJson(res, 200, this.objectResource(record));
      }
    }

    return this.sendError(res, 400, "invalid", "Unsupported upload request");
  }

  handleMultipartUpload(req, res, bucket, q, body) {
    const ct = req.headers["content-type"] || "";
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : null;
    if (!boundary) {
      return this.sendError(res, 400, "invalid", "Missing multipart boundary");
    }
    const parsedParts = parseMultipart(body, boundary);
    if (parsedParts.length < 2) {
      return this.sendError(res, 400, "invalid", "Multipart upload requires metadata and media parts");
    }
    let metadata = {};
    try {
      metadata = JSON.parse(parsedParts[0].body.toString("utf8") || "{}");
    } catch {
      metadata = {};
    }
    const mediaPart = parsedParts[1];
    const name = metadata.name || q.get("name");
    if (!name) {
      return this.sendError(res, 400, "required", "Required parameter: name");
    }
    const contentType =
      metadata.contentType ||
      mediaPart.headers["content-type"] ||
      "application/octet-stream";
    const record = this.storeObject(bucket, name, mediaPart.body, {
      contentType,
      metadata: metadata.metadata || {},
      cacheControl: metadata.cacheControl,
      contentDisposition: metadata.contentDisposition,
      contentEncoding: metadata.contentEncoding,
      contentLanguage: metadata.contentLanguage,
      storageClass: metadata.storageClass,
    });
    return this.sendJson(res, 200, this.objectResource(record));
  }

  startResumableUpload(req, res, bucket, q, body) {
    let metadata = {};
    try {
      metadata = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      metadata = {};
    }
    const name = metadata.name || q.get("name");
    if (!name) {
      return this.sendError(res, 400, "required", "Required parameter: name");
    }
    const uploadId = md5Hex(`${bucket.name}-${name}-${Date.now()}-${Math.random()}`);
    this.resumableUploads.set(uploadId, {
      bucketName: bucket.name,
      name,
      metadata,
      contentType:
        metadata.contentType ||
        q.get("contentType") ||
        req.headers["x-upload-content-type"] ||
        "application/octet-stream",
      chunks: [],
      received: 0,
    });
    const location = `http://${req.headers.host}/upload/storage/v1/b/${bucket.name}/o?uploadType=resumable&name=${encodeURIComponent(name)}&upload_id=${uploadId}`;
    res.setHeader("Location", location);
    res.setHeader("x-guploader-uploadid", uploadId);
    res.statusCode = 200;
    res.end();
  }

  handleResumablePut(req, res, uploadId, body) {
    const upload = this.resumableUploads.get(uploadId);
    if (!upload) {
      return this.sendError(res, 404, "notFound", "Upload session not found or expired");
    }
    const bucket = this.buckets.get(upload.bucketName);
    if (!bucket) {
      return this.sendError(res, 404, "notFound", `Bucket ${upload.bucketName} not found`);
    }

    const contentRange = req.headers["content-range"];
    // Content-Range can be:
    //   bytes 0-*/11        (single-shot upload, total known, end open)
    //   bytes 0-10/11       (chunk, total known)
    //   bytes 0-10/*        (chunk, total unknown)
    //   bytes */11          (size query / final flush)
    //   bytes */*           (probe)
    let total = null;
    let isFinal = false;
    if (contentRange) {
      const m = /^bytes (\*|(\d+)-(\d+|\*))\/(\*|\d+)$/.exec(contentRange.trim());
      if (m) {
        total = m[4] === "*" ? null : parseInt(m[4], 10);
        const hasData = m[1] !== "*";
        if (hasData && body.length > 0) {
          upload.chunks.push(body);
          upload.received += body.length;
        }
        const endOpen = m[3] === "*";
        if (endOpen) {
          // bytes start-*/...  => this request carries the rest of the stream.
          // For single-shot uploads (the common @google-cloud/storage path),
          // the whole body arrives here, so the upload is complete.
          isFinal = true;
        } else if (total !== null && upload.received >= total) {
          isFinal = true;
        }
      }
    } else {
      // No content-range => single PUT with whole body.
      upload.chunks.push(body);
      upload.received += body.length;
      isFinal = true;
    }

    if (!isFinal) {
      // Resumable incomplete: respond 308 with Range header.
      res.statusCode = 308;
      if (upload.received > 0) res.setHeader("Range", `bytes=0-${upload.received - 1}`);
      res.end();
      return;
    }

    const finalBody = Buffer.concat(upload.chunks);
    const md = upload.metadata || {};
    const record = this.storeObject(bucket, upload.name, finalBody, {
      contentType: md.contentType || upload.contentType,
      metadata: md.metadata || {},
      cacheControl: md.cacheControl,
      contentDisposition: md.contentDisposition,
      contentEncoding: md.contentEncoding,
      contentLanguage: md.contentLanguage,
      storageClass: md.storageClass,
    });
    this.resumableUploads.delete(uploadId);
    return this.sendJson(res, 200, this.objectResource(record));
  }

  // -------------------------------------------------------------------------
  // ACL (canned). Object/bucket/default-object ACLs. We accept writes and
  // return synthesized control entries; the parlel fake does not enforce ACLs.
  // -------------------------------------------------------------------------
  aclResource(bucketName, objectName, entity, role, isDefault) {
    const kind = objectName
      ? "storage#objectAccessControl"
      : isDefault
        ? "storage#objectAccessControl"
        : "storage#bucketAccessControl";
    const out = {
      kind,
      entity: entity || "allUsers",
      role: (role || "READER").toUpperCase(),
      bucket: bucketName,
      etag: "CAE=",
    };
    if (objectName) {
      out.object = objectName;
      out.generation = "1";
      out.id = `${bucketName}/${objectName}/${out.entity}`;
    } else {
      out.id = `${bucketName}/${out.entity}`;
    }
    return out;
  }

  handleAcl(res, method, bucketName, objectName, entity, q, body, isDefault = false) {
    const b = this.requireBucket(res, bucketName);
    if (!b) return;
    if (objectName) {
      const o = this.liveGeneration(b, objectName, q.get("generation"));
      if (!o) {
        return this.sendError(res, 404, "notFound", `No such object: ${bucketName}/${objectName}`, [
          { domain: "global", reason: "notFound", message: `No such object: ${bucketName}/${objectName}` },
        ]);
      }
    }

    if (method === "GET" && !entity) {
      // list
      return this.sendJson(res, 200, {
        kind: objectName || isDefault ? "storage#objectAccessControls" : "storage#bucketAccessControls",
        items: [
          this.aclResource(bucketName, objectName, "project-owners", "OWNER", isDefault),
        ],
      });
    }

    if (method === "GET" && entity) {
      return this.sendJson(res, 200, this.aclResource(bucketName, objectName, entity, "READER", isDefault));
    }

    if (method === "POST" || method === "PUT" || method === "PATCH") {
      let payload = {};
      try {
        payload = body.length ? JSON.parse(body.toString("utf8")) : {};
      } catch {
        payload = {};
      }
      return this.sendJson(
        res,
        200,
        this.aclResource(bucketName, objectName, payload.entity || entity, payload.role, isDefault),
      );
    }

    if (method === "DELETE") {
      res.statusCode = 204;
      return res.end();
    }

    return this.sendError(res, 405, "methodNotAllowed", "Method Not Allowed");
  }

  // -------------------------------------------------------------------------
  // IAM (canned)
  // -------------------------------------------------------------------------
  getBucketIam(res, bucketName) {
    if (!this.requireBucket(res, bucketName)) return;
    return this.sendJson(res, 200, {
      kind: "storage#policy",
      resourceId: `projects/_/buckets/${bucketName}`,
      version: 1,
      etag: "CAE=",
      bindings: [],
    });
  }

  setBucketIam(res, bucketName, body) {
    if (!this.requireBucket(res, bucketName)) return;
    let policy = {};
    try {
      policy = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      policy = {};
    }
    return this.sendJson(res, 200, {
      kind: "storage#policy",
      resourceId: `projects/_/buckets/${bucketName}`,
      version: policy.version || 1,
      etag: policy.etag || "CAE=",
      bindings: policy.bindings || [],
    });
  }

  testBucketIam(res, bucketName, q) {
    if (!this.requireBucket(res, bucketName)) return;
    const perms = q.getAll("permissions");
    return this.sendJson(res, 200, {
      kind: "storage#testIamPermissionsResponse",
      permissions: perms,
    });
  }

  // -------------------------------------------------------------------------
  // HMAC keys
  // -------------------------------------------------------------------------
  hmacResource(k) {
    return {
      kind: "storage#hmacKeyMetadata",
      id: k.accessId,
      accessId: k.accessId,
      projectId: this.projectId,
      serviceAccountEmail: k.serviceAccountEmail,
      state: k.state,
      timeCreated: k.timeCreated,
      updated: k.updated,
      etag: `etag-${k.accessId}`,
    };
  }

  listHmacKeys(res, q) {
    const items = [...this.hmacKeys.values()].map((k) => this.hmacResource(k));
    return this.sendJson(res, 200, { kind: "storage#hmacKeysMetadata", items });
  }

  createHmacKey(res, q) {
    const email = q.get("serviceAccountEmail") || `parlel@${this.projectId}.iam.gserviceaccount.com`;
    const accessId = `GOOG${md5Hex(String(Math.random())).slice(0, 20).toUpperCase()}`;
    const ts = nowIso();
    const key = { accessId, serviceAccountEmail: email, state: "ACTIVE", timeCreated: ts, updated: ts };
    this.hmacKeys.set(accessId, key);
    return this.sendJson(res, 200, {
      kind: "storage#hmacKey",
      metadata: this.hmacResource(key),
      secret: Buffer.from(`${accessId}-secret`).toString("base64"),
    });
  }

  getHmacKey(res, accessId) {
    const k = this.hmacKeys.get(accessId);
    if (!k) return this.sendError(res, 404, "notFound", "HMAC key not found");
    return this.sendJson(res, 200, this.hmacResource(k));
  }

  updateHmacKey(res, accessId, body) {
    const k = this.hmacKeys.get(accessId);
    if (!k) return this.sendError(res, 404, "notFound", "HMAC key not found");
    let patch = {};
    try {
      patch = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      patch = {};
    }
    if (patch.state) k.state = patch.state;
    k.updated = nowIso();
    return this.sendJson(res, 200, this.hmacResource(k));
  }

  deleteHmacKey(res, accessId) {
    if (!this.hmacKeys.has(accessId)) {
      return this.sendError(res, 404, "notFound", "HMAC key not found");
    }
    this.hmacKeys.delete(accessId);
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  // Batch (minimal): execute sub-requests sequentially in-process.
  // -------------------------------------------------------------------------
  handleBatch(req, res, q, body) {
    // Batch is rarely required for happy-path SDK usage; respond with an empty
    // multipart batch acknowledgement so callers don't hard-fail.
    const ct = req.headers["content-type"] || "";
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : "batch_parlel";
    const respBoundary = `batch_parlel_${md5Hex(String(Math.random())).slice(0, 12)}`;
    res.setHeader("Content-Type", `multipart/mixed; boundary=${respBoundary}`);
    res.statusCode = 200;
    res.end(`--${respBoundary}--\r\n`);
  }

  // -------------------------------------------------------------------------
  // Preconditions
  // -------------------------------------------------------------------------
  checkObjectPreconditions(q, o) {
    const ifGenMatch = q.get("ifGenerationMatch");
    const ifGenNotMatch = q.get("ifGenerationNotMatch");
    const ifMetaMatch = q.get("ifMetagenerationMatch");
    const ifMetaNotMatch = q.get("ifMetagenerationNotMatch");
    if (ifGenMatch !== null && String(o.generation) !== String(ifGenMatch)) {
      return { status: 412, reason: "conditionNotMet", message: "Precondition Failed" };
    }
    if (ifGenNotMatch !== null && String(o.generation) === String(ifGenNotMatch)) {
      return { status: 304, reason: "conditionNotMet", message: "Not Modified" };
    }
    if (ifMetaMatch !== null && String(o.metageneration) !== String(ifMetaMatch)) {
      return { status: 412, reason: "conditionNotMet", message: "Precondition Failed" };
    }
    if (ifMetaNotMatch !== null && String(o.metageneration) === String(ifMetaNotMatch)) {
      return { status: 304, reason: "conditionNotMet", message: "Not Modified" };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    const data = JSON.stringify(obj);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(data);
  }

  sendError(res, status, reason, message, errors) {
    const payload = {
      error: {
        code: status,
        message,
        errors: errors || [{ domain: "global", reason, message }],
      },
    };
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Path + multipart helpers
// ---------------------------------------------------------------------------
function splitPath(rest) {
  return rest.split("/").filter((s) => s.length > 0);
}

// Parse a multipart/related (or /mixed) body into [{ headers, body }].
function parseMultipart(buf, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buf.indexOf(delimiter);
  if (start === -1) return parts;
  start += delimiter.length;

  while (start < buf.length) {
    // After a boundary: either "--" (end) or CRLF then part.
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // closing "--"
    // Skip leading CRLF.
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;

    const next = buf.indexOf(delimiter, start);
    if (next === -1) break;
    let segment = buf.subarray(start, next);
    // Strip trailing CRLF before boundary.
    if (segment.length >= 2 && segment[segment.length - 2] === 0x0d && segment[segment.length - 1] === 0x0a) {
      segment = segment.subarray(0, segment.length - 2);
    } else if (segment.length >= 1 && segment[segment.length - 1] === 0x0a) {
      segment = segment.subarray(0, segment.length - 1);
    }

    // Split headers from body on first blank line.
    const headerEnd = indexOfDoubleNewline(segment);
    let headers = {};
    let partBody = segment;
    if (headerEnd.idx !== -1) {
      const headerText = segment.subarray(0, headerEnd.idx).toString("utf8");
      partBody = segment.subarray(headerEnd.idx + headerEnd.len);
      for (const line of headerText.split(/\r?\n/)) {
        const ci = line.indexOf(":");
        if (ci !== -1) {
          headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
        }
      }
    }
    parts.push({ headers, body: partBody });
    start = next + delimiter.length;
  }
  return parts;
}

function indexOfDoubleNewline(buf) {
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return { idx: i, len: 4 };
    }
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) {
      return { idx: i, len: 2 };
    }
  }
  return { idx: -1, len: 0 };
}

export default GcsServer;
