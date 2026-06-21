// parlel/gcp-secretmanager — a lightweight, dependency-free fake of Google
// Cloud Secret Manager.
//
// Speaks the Secret Manager v1 REST API
// (https://secretmanager.googleapis.com/v1) so that application code using the
// real `@google-cloud/secret-manager` client can run against it with zero cost
// and zero side effects. Pure Node.js, no external npm dependencies. State is
// in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Point the gapic SecretManagerServiceClient at this server with:
//   new SecretManagerServiceClient({
//     projectId: "parlel",
//     fallback: true,        // use HTTP/1.1 REST transport, not gRPC
//     protocol: "http",
//     apiEndpoint: "127.0.0.1",
//     port: 4585,
//   })
//
// The google-gax REST fallback transcodes RPCs to these endpoints
// (google.api.http annotations from the Secret Manager v1 proto). Every route
// also has a regional additional_binding under projects/*/locations/* which we
// accept transparently.
//
//   SecretManagerService
//   GET    /v1/{parent=projects/*}/secrets                            ListSecrets
//   POST   /v1/{parent=projects/*}/secrets                            CreateSecret
//   POST   /v1/{parent=projects/*/secrets/*}:addVersion               AddSecretVersion
//   GET    /v1/{name=projects/*/secrets/*}                            GetSecret
//   PATCH  /v1/{secret.name=projects/*/secrets/*}                     UpdateSecret
//   DELETE /v1/{name=projects/*/secrets/*}                            DeleteSecret
//   GET    /v1/{parent=projects/*/secrets/*}/versions                 ListSecretVersions
//   GET    /v1/{name=projects/*/secrets/*/versions/*}                 GetSecretVersion
//   GET    /v1/{name=projects/*/secrets/*/versions/*}:access          AccessSecretVersion
//   POST   /v1/{name=projects/*/secrets/*/versions/*}:disable         DisableSecretVersion
//   POST   /v1/{name=projects/*/secrets/*/versions/*}:enable          EnableSecretVersion
//   POST   /v1/{name=projects/*/secrets/*/versions/*}:destroy         DestroySecretVersion
//   POST   /v1/{resource=projects/*/secrets/*}:setIamPolicy           SetIamPolicy
//   GET    /v1/{resource=projects/*/secrets/*}:getIamPolicy           GetIamPolicy
//   POST   /v1/{resource=projects/*/secrets/*}:testIamPermissions     TestIamPermissions

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// gRPC canonical status codes (used to derive HTTP status + error shape).
// ---------------------------------------------------------------------------
const GRPC = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};

// The google-gax REST decoder maps an error back to a canonical gRPC status by
// the HTTP status code we send. We pick the HTTP status whose canonical mapping
// recovers the intended gRPC status on the client side. ALREADY_EXISTS has no
// HTTP status that decodes back to code 6 through the gax REST table (409
// decodes to ABORTED, which is retried); we therefore surface create-conflicts
// as FAILED_PRECONDITION (412 -> code 9): a non-retryable, immediately-rejecting
// status — matching how the real client surfaces a duplicate-create rejection.
const GRPC_TO_HTTP = {
  [GRPC.OK]: 200,
  [GRPC.CANCELLED]: 499,
  [GRPC.UNKNOWN]: 500,
  [GRPC.INVALID_ARGUMENT]: 400,
  [GRPC.DEADLINE_EXCEEDED]: 504,
  [GRPC.NOT_FOUND]: 404,
  [GRPC.ALREADY_EXISTS]: 409,
  [GRPC.PERMISSION_DENIED]: 403,
  [GRPC.RESOURCE_EXHAUSTED]: 429,
  [GRPC.FAILED_PRECONDITION]: 400,
  [GRPC.ABORTED]: 409,
  [GRPC.OUT_OF_RANGE]: 400,
  [GRPC.UNIMPLEMENTED]: 501,
  [GRPC.INTERNAL]: 500,
  [GRPC.UNAVAILABLE]: 503,
  [GRPC.DATA_LOSS]: 500,
  [GRPC.UNAUTHENTICATED]: 401,
};

const GRPC_STATUS_NAME = {
  [GRPC.OK]: "OK",
  [GRPC.CANCELLED]: "CANCELLED",
  [GRPC.UNKNOWN]: "UNKNOWN",
  [GRPC.INVALID_ARGUMENT]: "INVALID_ARGUMENT",
  [GRPC.DEADLINE_EXCEEDED]: "DEADLINE_EXCEEDED",
  [GRPC.NOT_FOUND]: "NOT_FOUND",
  [GRPC.ALREADY_EXISTS]: "ALREADY_EXISTS",
  [GRPC.PERMISSION_DENIED]: "PERMISSION_DENIED",
  [GRPC.RESOURCE_EXHAUSTED]: "RESOURCE_EXHAUSTED",
  [GRPC.FAILED_PRECONDITION]: "FAILED_PRECONDITION",
  [GRPC.ABORTED]: "ABORTED",
  [GRPC.OUT_OF_RANGE]: "OUT_OF_RANGE",
  [GRPC.UNIMPLEMENTED]: "UNIMPLEMENTED",
  [GRPC.INTERNAL]: "INTERNAL",
  [GRPC.UNAVAILABLE]: "UNAVAILABLE",
  [GRPC.DATA_LOSS]: "DATA_LOSS",
  [GRPC.UNAUTHENTICATED]: "UNAUTHENTICATED",
};

// SecretVersion.State enum — REST fallback emits ints, gRPC uses string names.
const VERSION_STATE = {
  0: "STATE_UNSPECIFIED",
  1: "ENABLED",
  2: "DISABLED",
  3: "DESTROYED",
};

// Secret ids: 1-255 chars of [A-Za-z0-9_-].
const SECRET_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;

class SmError extends Error {
  constructor(grpcCode, message) {
    super(message);
    this.grpcCode = grpcCode;
  }
}

export class GcpSecretmanagerServer {
  constructor(port = 4585, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.projectId = options.projectId || "parlel";
    this.server = null;
    this.reset();
  }

  reset() {
    // secrets: Map<fullName, SecretRecord>
    //   SecretRecord = {
    //     name, createTime, labels, annotations, topics, etag,
    //     replication, expireTime, ttl, rotation, versionAliases,
    //     versionDestroyTtl, customerManagedEncryption,
    //     versions: Map<fullVersionName, VersionRecord>,
    //     versionCounter: number,
    //   }
    //   VersionRecord = {
    //     name, createTime, destroyTime, state, etag, payload(Buffer|null),
    //     clientSpecifiedPayloadChecksum, replicationStatus,
    //   }
    this.secrets = new Map();
    // policies: Map<resourceName, Policy>
    this.policies = new Map();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (error instanceof SmError) {
            this.sendError(res, error.grpcCode, error.message);
          } else {
            this.sendError(res, GRPC.INTERNAL, error.message || "internal error");
          }
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
    const pathname = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    // Internal parlel endpoints (not part of Secret Manager).
    if (pathname === "/_parlel/health") {
      let versionCount = 0;
      for (const s of this.secrets.values()) versionCount += s.versions.size;
      return this.sendJson(res, 200, {
        status: "ok",
        service: "gcp-secretmanager",
        secrets: this.secrets.size,
        versions: versionCount,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/_parlel/dump" && method === "GET") {
      return this.sendJson(res, 200, {
        secrets: [...this.secrets.values()].map((s) => ({
          ...cleanSecret(s),
          versions: [...s.versions.values()].map(cleanVersion),
        })),
      });
    }

    const rawBody = await this.readBody(req);
    let body = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new SmError(GRPC.INVALID_ARGUMENT, "Invalid JSON body");
      }
    }

    if (!pathname.startsWith("/v1/")) {
      throw new SmError(GRPC.NOT_FOUND, "Not Found");
    }
    const rest = pathname.slice("/v1/".length);

    // Split off a trailing custom verb ":<verb>".
    const colon = rest.lastIndexOf(":");
    let verb = null;
    let resourcePath = rest;
    if (colon !== -1 && !rest.slice(colon + 1).includes("/")) {
      verb = rest.slice(colon + 1);
      resourcePath = rest.slice(0, colon);
    }

    // Normalize a regional resource path (projects/*/locations/*/...) down to
    // the global form (projects/*/...). The fake is region-agnostic: a secret
    // created globally is reachable regionally and vice-versa, mirroring how
    // the real service treats the two parents as bindings on the same RPCs.
    resourcePath = stripLocation(resourcePath);
    const segs = resourcePath.split("/");

    // ---- custom verbs ----
    if (verb) {
      switch (verb) {
        case "addVersion":
          return this.addSecretVersion(res, resourcePath, body);
        case "access":
          return this.accessSecretVersion(res, resourcePath);
        case "enable":
          return this.enableSecretVersion(res, resourcePath, body);
        case "disable":
          return this.disableSecretVersion(res, resourcePath, body);
        case "destroy":
          return this.destroySecretVersion(res, resourcePath, body);
        case "getIamPolicy":
          return this.getIamPolicy(res, resourcePath, q);
        case "setIamPolicy":
          return this.setIamPolicy(res, resourcePath, body);
        case "testIamPermissions":
          return this.testIamPermissions(res, resourcePath, body);
        default:
          throw new SmError(GRPC.UNIMPLEMENTED, `Unknown verb: ${verb}`);
      }
    }

    // ---- secrets collection: projects/{p}/secrets ----
    if (segs.length === 3 && segs[0] === "projects" && segs[2] === "secrets") {
      const parent = `projects/${segs[1]}`;
      if (method === "GET") return this.listSecrets(res, parent, q);
      if (method === "POST") return this.createSecret(res, parent, q, body);
      throw new SmError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    // ---- single secret: projects/{p}/secrets/{s} ----
    if (segs.length === 4 && segs[0] === "projects" && segs[2] === "secrets") {
      const name = resourcePath;
      if (method === "GET") return this.getSecret(res, name);
      if (method === "PATCH") return this.updateSecret(res, name, body, q);
      if (method === "DELETE") return this.deleteSecret(res, name, q);
      throw new SmError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    // ---- versions collection: projects/{p}/secrets/{s}/versions ----
    if (segs.length === 5 && segs[2] === "secrets" && segs[4] === "versions") {
      const parent = segs.slice(0, 4).join("/");
      if (method === "GET") return this.listSecretVersions(res, parent, q);
      throw new SmError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    // ---- single version: projects/{p}/secrets/{s}/versions/{v} ----
    if (segs.length === 6 && segs[2] === "secrets" && segs[4] === "versions") {
      const name = resourcePath;
      if (method === "GET") return this.getSecretVersion(res, name);
      throw new SmError(GRPC.INVALID_ARGUMENT, "Unsupported method");
    }

    throw new SmError(GRPC.NOT_FOUND, `Unrecognized path: /v1/${rest}`);
  }

  // =========================================================================
  // Secrets
  // =========================================================================
  createSecret(res, parent, q, body) {
    const m = parent.match(/^projects\/([^/]+)$/);
    if (!m) throw new SmError(GRPC.INVALID_ARGUMENT, `Invalid parent: ${parent}`);
    // secretId arrives as a query parameter; the Secret body is the request body.
    const secretId = q.get("secretId") || body.secretId;
    if (!secretId) {
      throw new SmError(GRPC.INVALID_ARGUMENT, "secretId is required");
    }
    if (!SECRET_ID_RE.test(secretId)) {
      throw new SmError(
        GRPC.INVALID_ARGUMENT,
        `Secret id must match ${SECRET_ID_RE} but was "${secretId}"`,
      );
    }
    const secret = body.secret || body || {};
    const name = `${parent}/secrets/${secretId}`;
    if (this.secrets.has(name)) {
      throw new SmError(GRPC.ALREADY_EXISTS, `Secret [${name}] already exists.`);
    }
    // Replication is required by the real API. Default to automatic when the
    // caller omits it so the happy path is friction-free.
    const replication = normReplication(secret.replication);
    const record = {
      name,
      createTime: nowTs(),
      labels: secret.labels || {},
      annotations: secret.annotations || {},
      topics: Array.isArray(secret.topics) ? secret.topics : [],
      replication,
      expireTime: resolveExpireTime(secret),
      rotation: secret.rotation || undefined,
      versionAliases: secret.versionAliases || undefined,
      versionDestroyTtl: secret.versionDestroyTtl || undefined,
      customerManagedEncryption: secret.customerManagedEncryption || undefined,
      etag: makeEtag(),
      versions: new Map(),
      versionCounter: 0,
    };
    this.secrets.set(name, record);
    return this.sendJson(res, 200, cleanSecret(record));
  }

  getSecret(res, name) {
    const secret = this.secrets.get(name);
    if (!secret) throw new SmError(GRPC.NOT_FOUND, `Secret [${name}] not found.`);
    return this.sendJson(res, 200, cleanSecret(secret));
  }

  listSecrets(res, parent, q) {
    const m = parent.match(/^projects\/([^/]+)$/);
    if (!m) throw new SmError(GRPC.INVALID_ARGUMENT, `Invalid parent: ${parent}`);
    let all = [...this.secrets.values()]
      .filter((s) => s.name.startsWith(`${parent}/secrets/`))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const filter = q.get("filter");
    if (filter) all = all.filter((s) => matchSecretFilter(s, filter));
    const totalSize = all.length;
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      secrets: page.map(cleanSecret),
      totalSize,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  updateSecret(res, name, body, q) {
    const secret = this.secrets.get(name);
    if (!secret) throw new SmError(GRPC.NOT_FOUND, `Secret [${name}] not found.`);
    const update = body.secret || body;
    const mask = fieldsOf(body.updateMask || q.get("updateMask"));
    if (!mask.length) {
      throw new SmError(GRPC.INVALID_ARGUMENT, "updateMask is required for UpdateSecret");
    }
    const MUTABLE = new Set([
      "labels",
      "annotations",
      "topics",
      "expireTime",
      "ttl",
      "rotation",
      "versionAliases",
      "versionDestroyTtl",
    ]);
    for (const rawPath of mask) {
      const path = snakeToCamelPath(rawPath);
      const field = path.split(".")[0];
      if (!MUTABLE.has(field)) {
        throw new SmError(
          GRPC.INVALID_ARGUMENT,
          `Field "${field}" is immutable or unknown and cannot be updated.`,
        );
      }
      if (field === "ttl") {
        // ttl is an input-only convenience that resolves into expireTime.
        secret.expireTime = resolveExpireTime({ ttl: update.ttl });
      } else if (field === "expireTime") {
        secret.expireTime = update.expireTime || undefined;
      } else {
        secret[field] = update[field];
      }
    }
    secret.etag = makeEtag();
    return this.sendJson(res, 200, cleanSecret(secret));
  }

  deleteSecret(res, name, q) {
    const secret = this.secrets.get(name);
    if (!secret) throw new SmError(GRPC.NOT_FOUND, `Secret [${name}] not found.`);
    const etag = q.get("etag");
    if (etag && stripEtagQuotes(etag) !== stripEtagQuotes(secret.etag)) {
      throw new SmError(GRPC.FAILED_PRECONDITION, "etag mismatch");
    }
    this.secrets.delete(name);
    this.policies.delete(name);
    return this.sendJson(res, 200, {});
  }

  // =========================================================================
  // Secret Versions
  // =========================================================================
  addSecretVersion(res, parent, body) {
    const secret = this.secrets.get(parent);
    if (!secret) throw new SmError(GRPC.NOT_FOUND, `Secret [${parent}] not found.`);
    const payload = body.payload || {};
    if (payload.data === undefined || payload.data === null) {
      throw new SmError(GRPC.INVALID_ARGUMENT, "SecretPayload.data is required");
    }
    // payload.data is base64-encoded bytes over the wire (proto3 JSON).
    const data = Buffer.from(String(payload.data), "base64");

    // Optional client-specified CRC32C integrity check.
    let clientSpecifiedPayloadChecksum = false;
    if (payload.dataCrc32c !== undefined && payload.dataCrc32c !== null) {
      const expected = BigInt(payload.dataCrc32c);
      const actual = BigInt(crc32c(data));
      if (expected !== actual) {
        throw new SmError(
          GRPC.INVALID_ARGUMENT,
          "Data corruption detected: payload checksum does not match data.",
        );
      }
      clientSpecifiedPayloadChecksum = true;
    }

    secret.versionCounter += 1;
    const id = String(secret.versionCounter);
    const name = `${parent}/versions/${id}`;
    const record = {
      name,
      createTime: nowTs(),
      destroyTime: undefined,
      state: "ENABLED",
      etag: makeEtag(),
      payload: data,
      clientSpecifiedPayloadChecksum,
      dataCrc32c: crc32c(data),
      replicationStatus: replicationStatusFor(secret.replication),
    };
    secret.versions.set(name, record);
    return this.sendJson(res, 200, cleanVersion(record));
  }

  getSecretVersion(res, name) {
    const { version } = this._resolveVersion(name);
    return this.sendJson(res, 200, cleanVersion(version));
  }

  listSecretVersions(res, parent, q) {
    const secret = this.secrets.get(parent);
    if (!secret) throw new SmError(GRPC.NOT_FOUND, `Secret [${parent}] not found.`);
    let all = [...secret.versions.values()].sort((a, b) => versionNum(b) - versionNum(a));
    const filter = q.get("filter");
    if (filter) all = all.filter((v) => matchVersionFilter(v, filter));
    const totalSize = all.length;
    const { page, nextPageToken } = paginate(all, q);
    return this.sendJson(res, 200, {
      versions: page.map(cleanVersion),
      totalSize,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  accessSecretVersion(res, name) {
    const { version } = this._resolveVersion(name);
    if (version.state === "DISABLED") {
      throw new SmError(
        GRPC.FAILED_PRECONDITION,
        `Secret version [${version.name}] is in DISABLED state.`,
      );
    }
    if (version.state === "DESTROYED") {
      throw new SmError(
        GRPC.FAILED_PRECONDITION,
        `Secret version [${version.name}] is in DESTROYED state.`,
      );
    }
    const data = version.payload || Buffer.alloc(0);
    return this.sendJson(res, 200, {
      name: version.name,
      payload: {
        data: data.toString("base64"),
        dataCrc32c: String(crc32c(data)),
      },
    });
  }

  enableSecretVersion(res, name, body) {
    const { version } = this._resolveVersion(name);
    this._checkVersionEtag(version, body);
    if (version.state === "DESTROYED") {
      throw new SmError(
        GRPC.FAILED_PRECONDITION,
        `Secret version [${version.name}] is in DESTROYED state and cannot be enabled.`,
      );
    }
    version.state = "ENABLED";
    version.etag = makeEtag();
    return this.sendJson(res, 200, cleanVersion(version));
  }

  disableSecretVersion(res, name, body) {
    const { version } = this._resolveVersion(name);
    this._checkVersionEtag(version, body);
    if (version.state === "DESTROYED") {
      throw new SmError(
        GRPC.FAILED_PRECONDITION,
        `Secret version [${version.name}] is in DESTROYED state and cannot be disabled.`,
      );
    }
    version.state = "DISABLED";
    version.etag = makeEtag();
    return this.sendJson(res, 200, cleanVersion(version));
  }

  destroySecretVersion(res, name, body) {
    const { version } = this._resolveVersion(name);
    this._checkVersionEtag(version, body);
    if (version.state === "DESTROYED") {
      throw new SmError(
        GRPC.FAILED_PRECONDITION,
        `Secret version [${version.name}] is already in DESTROYED state.`,
      );
    }
    version.state = "DESTROYED";
    version.destroyTime = nowTs();
    version.payload = null; // secret material is irrecoverably erased.
    version.etag = makeEtag();
    return this.sendJson(res, 200, cleanVersion(version));
  }

  // Resolve a version name, including the "latest" alias and any numeric id.
  // "latest" -> the highest-numbered version that is not DESTROYED.
  _resolveVersion(name) {
    const m = name.match(/^(projects\/[^/]+\/secrets\/[^/]+)\/versions\/([^/]+)$/);
    if (!m) throw new SmError(GRPC.INVALID_ARGUMENT, `Invalid version name: ${name}`);
    const secret = this.secrets.get(m[1]);
    if (!secret) throw new SmError(GRPC.NOT_FOUND, `Secret [${m[1]}] not found.`);
    const id = m[2];
    if (id === "latest") {
      const candidates = [...secret.versions.values()]
        .filter((v) => v.state !== "DESTROYED")
        .sort((a, b) => versionNum(b) - versionNum(a));
      if (!candidates.length) {
        throw new SmError(
          GRPC.NOT_FOUND,
          `Secret Version [${name}] not found.`,
        );
      }
      return { secret, version: candidates[0] };
    }
    // Alias lookup: version_aliases maps alias -> numeric version.
    let lookupId = id;
    if (!/^\d+$/.test(id) && secret.versionAliases && secret.versionAliases[id] !== undefined) {
      lookupId = String(secret.versionAliases[id]);
    }
    const full = `${m[1]}/versions/${lookupId}`;
    const version = secret.versions.get(full);
    if (!version) throw new SmError(GRPC.NOT_FOUND, `Secret Version [${name}] not found.`);
    return { secret, version };
  }

  _checkVersionEtag(version, body) {
    if (body && body.etag && stripEtagQuotes(body.etag) !== stripEtagQuotes(version.etag)) {
      throw new SmError(GRPC.FAILED_PRECONDITION, "etag mismatch");
    }
  }

  // =========================================================================
  // IAM (resource-level policies on a secret)
  // =========================================================================
  getIamPolicy(res, resource, q) {
    this._assertSecretExists(resource);
    const policy = this.policies.get(resource) || defaultPolicy();
    void q;
    return this.sendJson(res, 200, policy);
  }

  setIamPolicy(res, resource, body) {
    this._assertSecretExists(resource);
    const incoming = body.policy || {};
    const policy = {
      version: incoming.version || 1,
      bindings: incoming.bindings || [],
      etag: makeEtag(),
    };
    if (incoming.auditConfigs) policy.auditConfigs = incoming.auditConfigs;
    this.policies.set(resource, policy);
    return this.sendJson(res, 200, policy);
  }

  testIamPermissions(res, resource, body) {
    this._assertSecretExists(resource);
    const permissions = body.permissions || [];
    // The fake grants every requested permission.
    return this.sendJson(res, 200, permissions.length ? { permissions } : {});
  }

  _assertSecretExists(resource) {
    if (!this.secrets.has(resource)) {
      throw new SmError(GRPC.NOT_FOUND, `Secret [${resource}] not found.`);
    }
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

  sendError(res, grpcCode, message) {
    const httpStatus = GRPC_TO_HTTP[grpcCode] || 500;
    const status = GRPC_STATUS_NAME[grpcCode] || "UNKNOWN";
    const payload = {
      error: {
        code: httpStatus,
        message,
        status,
      },
    };
    res.statusCode = httpStatus;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
function nowTs() {
  // proto3 JSON timestamp with nanosecond precision.
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
}

function makeEtag() {
  return `"${randomBytes(8).toString("hex")}"`;
}

function stripEtagQuotes(e) {
  if (typeof e !== "string") return e;
  return e.replace(/^"+|"+$/g, "");
}

// Strip a regional "/locations/{loc}" segment so global + regional bindings
// resolve to the same in-memory record. e.g.
//   projects/p/locations/us/secrets/s -> projects/p/secrets/s
function stripLocation(path) {
  return path.replace(/^(projects\/[^/]+)\/locations\/[^/]+\//, "$1/");
}

function versionNum(v) {
  const m = v.name.match(/\/versions\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

const DEFAULT_PAGE_SIZE = 25000;

// Stable pagination via pageSize + pageToken (token is the start offset).
function paginate(items, q) {
  const requested = parseInt(q.get("pageSize") || "0", 10) || 0;
  const pageSize = requested > 0 ? requested : DEFAULT_PAGE_SIZE;
  const startToken = q.get("pageToken");
  const start = startToken
    ? parseInt(Buffer.from(startToken, "base64").toString("utf8"), 10) || 0
    : 0;
  const page = items.slice(start, start + pageSize);
  const nextStart = start + pageSize;
  const nextPageToken =
    nextStart < items.length ? Buffer.from(String(nextStart), "utf8").toString("base64") : null;
  return { page, nextPageToken };
}

function fieldsOf(mask) {
  if (!mask) return [];
  if (typeof mask === "string") return mask.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(mask.paths)) return mask.paths;
  if (Array.isArray(mask)) return mask;
  return [];
}

function snakeToCamelPath(path) {
  return path
    .split(".")
    .map((seg) => seg.replace(/_([a-z])/g, (_, c) => c.toUpperCase()))
    .join(".");
}

// Replication normalization. The real API requires exactly one of
// automatic / userManaged; we default to automatic when omitted.
function normReplication(rep) {
  if (!rep || (!rep.automatic && !rep.userManaged)) {
    return { automatic: {} };
  }
  if (rep.userManaged) {
    const replicas = Array.isArray(rep.userManaged.replicas) ? rep.userManaged.replicas : [];
    return { userManaged: { replicas } };
  }
  return { automatic: rep.automatic || {} };
}

function replicationStatusFor(replication) {
  if (replication && replication.userManaged) {
    const replicas = (replication.userManaged.replicas || []).map((r) => ({
      location: r.location,
    }));
    return { userManaged: { replicas } };
  }
  return { automatic: {} };
}

// Resolve ttl (a duration like "3600s") into an absolute expireTime. If the
// caller passed expireTime directly, prefer that.
function resolveExpireTime(secret) {
  if (secret.expireTime) return secret.expireTime;
  if (secret.ttl) {
    const secs = parseDurationSeconds(secret.ttl);
    if (secs !== null) {
      return new Date(Date.now() + secs * 1000)
        .toISOString()
        .replace(/\.(\d{3})Z$/, ".$1000000Z");
    }
  }
  return undefined;
}

function parseDurationSeconds(d) {
  if (typeof d === "number") return d;
  if (typeof d === "string") {
    const m = d.match(/^(-?\d+(?:\.\d+)?)s$/);
    if (m) return parseFloat(m[1]);
    if (/^-?\d+$/.test(d)) return parseInt(d, 10);
  }
  if (d && typeof d === "object" && "seconds" in d) return Number(d.seconds);
  return null;
}

// Very small server-side filter approximation for ListSecrets. Supports
// "name:substr" and "labels.key=value" and bare substring matches on name.
function matchSecretFilter(secret, filter) {
  const f = filter.trim();
  let m = f.match(/^name\s*[:=]\s*(.+)$/);
  if (m) return secret.name.includes(m[1].trim());
  m = f.match(/^labels\.([^:=\s]+)\s*[:=]\s*(.+)$/);
  if (m) return secret.labels && secret.labels[m[1]] === m[2].trim();
  return secret.name.includes(f);
}

function matchVersionFilter(version, filter) {
  const f = filter.trim();
  const m = f.match(/^state\s*[:=]\s*(.+)$/i);
  if (m) return version.state === m[1].trim().toUpperCase();
  return version.name.includes(f);
}

function defaultPolicy() {
  return { version: 1, bindings: [], etag: makeEtag() };
}

function cleanSecret(s) {
  return prune({
    name: s.name,
    replication: s.replication,
    createTime: s.createTime,
    labels: s.labels && Object.keys(s.labels).length ? s.labels : undefined,
    annotations:
      s.annotations && Object.keys(s.annotations).length ? s.annotations : undefined,
    topics: s.topics && s.topics.length ? s.topics : undefined,
    expireTime: s.expireTime,
    etag: s.etag,
    rotation: s.rotation,
    versionAliases:
      s.versionAliases && Object.keys(s.versionAliases).length ? s.versionAliases : undefined,
    versionDestroyTtl: s.versionDestroyTtl,
    customerManagedEncryption: s.customerManagedEncryption,
  });
}

function cleanVersion(v) {
  return prune({
    name: v.name,
    createTime: v.createTime,
    destroyTime: v.destroyTime,
    state: typeof v.state === "number" ? VERSION_STATE[v.state] : v.state,
    replicationStatus: v.replicationStatus,
    etag: v.etag,
    clientSpecifiedPayloadChecksum: v.clientSpecifiedPayloadChecksum || undefined,
  });
}

// Strip undefined values so JSON output matches the proto3-JSON wire format
// (absent optional fields are omitted).
function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRC32C (Castagnoli) — used for SecretPayload.data_crc32c integrity checks.
// Pure, table-driven, dependency-free. Returns an unsigned 32-bit integer.
// ---------------------------------------------------------------------------
const CRC32C_POLY = 0x82f63b78;
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? CRC32C_POLY ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32c(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32C_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function secretHash(name) {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

export default GcpSecretmanagerServer;
