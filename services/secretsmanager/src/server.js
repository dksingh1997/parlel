// parlel/secretsmanager — a lightweight, dependency-free fake of AWS Secrets Manager.
//
// Speaks the AWS JSON 1.1 wire protocol so that application code using the real
// `@aws-sdk/client-secrets-manager` client can run against it with zero cost and
// zero side effects. Pure Node.js, no external npm dependencies. State is
// in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-secrets-manager v3):
//   * Requests are POST / with header `X-Amz-Target: secretsmanager.<Operation>`
//     and `Content-Type: application/x-amz-json-1.1`. Body is JSON input.
//   * Blob fields (SecretBinary) are base64-encoded strings on the wire.
//   * Timestamp fields (CreatedDate, DeletionDate, ...) are epoch-seconds numbers.
//   * Success: 200, JSON output, `Content-Type: application/x-amz-json-1.1`.
//   * Error: non-2xx, JSON `{ "__type": "<Code>", "message": "<msg>" }`.

import { createServer } from "node:http";
import { createHash, randomUUID, randomBytes } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";
const TARGET_PREFIX = "secretsmanager";

// Secrets Manager error codes -> HTTP status. All of these are modeled by the
// real client; Sender (client) faults are 400, Receiver (server) faults 500.
const ERROR_STATUS = {
  ResourceNotFoundException: 400,
  ResourceExistsException: 400,
  InvalidParameterException: 400,
  InvalidRequestException: 400,
  InvalidNextTokenException: 400,
  LimitExceededException: 400,
  MalformedPolicyDocumentException: 400,
  PreconditionNotMetException: 400,
  PublicPolicyException: 400,
  DecryptionFailure: 400,
  EncryptionFailure: 400,
  InternalServiceError: 500,
  InternalFailure: 500,
  UnrecognizedClientException: 403,
  AccessDeniedException: 403,
};

class SecretsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// AWS version ids are 36-char UUID-shaped tokens.
function newVersionId() {
  return randomUUID();
}

// 6-char random suffix used by ARNs (e.g. ...:secret:MySecret-aBc1Z9).
function arnSuffix() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Timestamps are returned as epoch-seconds numbers across the JSON 1.1 wire.
function epochSeconds(ms = Date.now()) {
  return Math.floor(ms / 1000);
}

// Decode an inbound SecretBinary (base64 string on the wire) into a Buffer.
function decodeBinary(value) {
  if (value === undefined || value === null) return undefined;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  // Wire form is a base64 string.
  return Buffer.from(String(value), "base64");
}

// Encode an outbound SecretBinary (Buffer) as a base64 string for the wire.
function encodeBinary(buf) {
  if (buf === undefined || buf === null) return undefined;
  return Buffer.from(buf).toString("base64");
}

const STAGE_CURRENT = "AWSCURRENT";
const STAGE_PREVIOUS = "AWSPREVIOUS";
const STAGE_PENDING = "AWSPENDING";

const VALID_FILTER_KEYS = new Set([
  "description",
  "name",
  "tag-key",
  "tag-value",
  "primary-region",
  "owning-service",
  "all",
]);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class SecretsmanagerServer {
  constructor(port = 4572, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // secrets: Map<name, Secret>
    // Secret = {
    //   name, arn, description, kmsKeyId, createdAt,
    //   lastChangedDate, lastAccessedDate, lastRotatedDate,
    //   deletedDate (ms|undefined), deletionDate (ms|undefined),
    //   rotationEnabled, rotationLambdaARN, rotationRules,
    //   primaryRegion, owningService, type,
    //   tags: Map<key,value>,
    //   resourcePolicy: string|undefined,
    //   replicaRegions: [{Region, KmsKeyId, Status, StatusMessage}],
    //   versions: Map<versionId, { secretString, secretBinary, stages:Set, createdAt }>,
    //   clientTokens: Map<clientRequestToken, versionId>,
    // }
    this.secrets = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new SecretsError("InternalFailure", error.message, 500));
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

  secretArn(name) {
    return `arn:aws:secretsmanager:${this.region}:${this.accountId}:secret:${name}-${arnSuffix()}`;
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    // Internal/health endpoints (not part of Secrets Manager).
    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "secretsmanager",
        secrets: this.secrets.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-secretsmanager");

    if (method !== "POST") {
      return this.sendError(
        res,
        new SecretsError("AccessDeniedException", "Only POST is supported by the parlel secretsmanager fake.", 405),
      );
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(
        res,
        new SecretsError("InvalidRequestException", "Request body is not valid JSON.", 400),
      );
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof SecretsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateSecret":
        return this.createSecret(input);
      case "DeleteSecret":
        return this.deleteSecret(input);
      case "DescribeSecret":
        return this.describeSecret(input);
      case "GetSecretValue":
        return this.getSecretValue(input);
      case "PutSecretValue":
        return this.putSecretValue(input);
      case "UpdateSecret":
        return this.updateSecret(input);
      case "ListSecrets":
        return this.listSecrets(input);
      case "ListSecretVersionIds":
        return this.listSecretVersionIds(input);
      case "RestoreSecret":
        return this.restoreSecret(input);
      case "GetRandomPassword":
        return this.getRandomPassword(input);
      case "TagResource":
        return this.tagResource(input);
      case "UntagResource":
        return this.untagResource(input);
      case "UpdateSecretVersionStage":
        return this.updateSecretVersionStage(input);
      case "BatchGetSecretValue":
        return this.batchGetSecretValue(input);
      case "CancelRotateSecret":
        return this.cancelRotateSecret(input);
      case "RotateSecret":
        return this.rotateSecret(input);
      case "PutResourcePolicy":
        return this.putResourcePolicy(input);
      case "GetResourcePolicy":
        return this.getResourcePolicy(input);
      case "DeleteResourcePolicy":
        return this.deleteResourcePolicy(input);
      case "ValidateResourcePolicy":
        return this.validateResourcePolicy(input);
      case "ReplicateSecretToRegions":
        return this.replicateSecretToRegions(input);
      case "RemoveRegionsFromReplication":
        return this.removeRegionsFromReplication(input);
      case "StopReplicationToReplica":
        return this.stopReplicationToReplica(input);
      default:
        throw new SecretsError(
          "InvalidParameterException",
          `The action ${operation || "(none)"} is not valid for this endpoint.`,
          400,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Secret resolution
  // -------------------------------------------------------------------------
  // SecretId may be a bare name or a full ARN. Resolve to the stored secret.
  resolveSecretId(secretId) {
    if (typeof secretId !== "string" || secretId.length === 0) {
      throw new SecretsError(
        "InvalidParameterException",
        "Invalid SecretId: must be a non-empty string.",
      );
    }
    // Direct name match first.
    if (this.secrets.has(secretId)) return this.secrets.get(secretId);
    // ARN match.
    for (const secret of this.secrets.values()) {
      if (secret.arn === secretId) return secret;
    }
    // ARN without 6-char suffix (AWS accepts both forms).
    if (secretId.startsWith("arn:aws:secretsmanager:")) {
      const namePart = secretId.split(":secret:").pop();
      if (namePart) {
        const withoutSuffix = namePart.replace(/-[A-Za-z0-9]{6}$/, "");
        if (this.secrets.has(withoutSuffix)) return this.secrets.get(withoutSuffix);
        if (this.secrets.has(namePart)) return this.secrets.get(namePart);
      }
    }
    return undefined;
  }

  requireSecret(secretId, { allowDeleted = false } = {}) {
    const secret = this.resolveSecretId(secretId);
    if (!secret) {
      throw new SecretsError(
        "ResourceNotFoundException",
        "Secrets Manager can't find the specified secret.",
      );
    }
    if (secret.deletedDate && !allowDeleted) {
      throw new SecretsError(
        "ResourceNotFoundException",
        "Secrets Manager can't find the specified secret that was marked for deletion.",
      );
    }
    return secret;
  }

  // Resolve the version that currently carries AWSCURRENT.
  currentVersionId(secret) {
    for (const [vid, version] of secret.versions) {
      if (version.stages.has(STAGE_CURRENT)) return vid;
    }
    return undefined;
  }

  versionByStage(secret, stage) {
    for (const [vid, version] of secret.versions) {
      if (version.stages.has(stage)) return vid;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // CreateSecret
  // -------------------------------------------------------------------------
  createSecret(input) {
    const name = input.Name;
    if (!name) {
      throw new SecretsError(
        "InvalidParameterException",
        "The parameter Name must not be empty.",
      );
    }
    if (typeof name !== "string" || name.length > 512 || !/^[A-Za-z0-9/_+=.@!-]+$/.test(name)) {
      throw new SecretsError(
        "ValidationException",
        "Invalid name. Must be a valid name containing alphanumeric characters, or any of the following: -/_+=.@!",
        400,
      );
    }
    if (input.SecretString !== undefined && input.SecretBinary !== undefined) {
      throw new SecretsError(
        "InvalidParameterException",
        "You can't specify both SecretString and SecretBinary.",
      );
    }

    const existing = this.secrets.get(name);
    if (existing && !existing.deletedDate) {
      // Idempotency: if the same ClientRequestToken was used and the value
      // matches, AWS returns the existing secret. Otherwise ResourceExists.
      if (
        input.ClientRequestToken &&
        existing.clientTokens.has(input.ClientRequestToken)
      ) {
        const vid = existing.clientTokens.get(input.ClientRequestToken);
        return {
          ARN: existing.arn,
          Name: existing.name,
          VersionId: vid,
          ...(existing.replicaRegions.length ? { ReplicationStatus: this.replicationStatus(existing) } : {}),
        };
      }
      throw new SecretsError(
        "ResourceExistsException",
        "The operation failed because the secret already exists.",
      );
    }
    if (existing && existing.deletedDate) {
      throw new SecretsError(
        "InvalidRequestException",
        "You can't create this secret because a secret with this name is already scheduled for deletion.",
      );
    }

    const now = Date.now();
    const versionId = input.ClientRequestToken || newVersionId();
    const hasValue = input.SecretString !== undefined || input.SecretBinary !== undefined;

    const version = {
      versionId,
      secretString: input.SecretString,
      secretBinary: decodeBinary(input.SecretBinary),
      stages: new Set(hasValue ? [STAGE_CURRENT] : []),
      createdAt: now,
    };

    const tags = new Map();
    for (const t of input.Tags || []) {
      if (t && t.Key !== undefined) tags.set(t.Key, t.Value ?? "");
    }

    const replicaRegions = (input.AddReplicaRegions || []).map((r) => ({
      Region: r.Region,
      KmsKeyId: r.KmsKeyId,
      Status: "InProgress",
      StatusMessage: "Replication in progress.",
      LastAccessedDate: now,
    }));

    const secret = {
      name,
      arn: this.secretArn(name),
      description: input.Description,
      kmsKeyId: input.KmsKeyId,
      type: input.Type,
      createdAt: now,
      lastChangedDate: now,
      lastAccessedDate: undefined,
      lastRotatedDate: undefined,
      nextRotationDate: undefined,
      deletedDate: undefined,
      deletionDate: undefined,
      rotationEnabled: false,
      rotationLambdaARN: undefined,
      rotationRules: undefined,
      primaryRegion: this.region,
      owningService: undefined,
      tags,
      resourcePolicy: undefined,
      replicaRegions,
      versions: new Map([[versionId, version]]),
      clientTokens: new Map(input.ClientRequestToken ? [[input.ClientRequestToken, versionId]] : []),
    };
    this.secrets.set(name, secret);

    const out = { ARN: secret.arn, Name: secret.name, VersionId: versionId };
    if (replicaRegions.length) out.ReplicationStatus = this.replicationStatus(secret);
    return out;
  }

  replicationStatus(secret) {
    return secret.replicaRegions.map((r) => {
      const entry = { Region: r.Region, Status: r.Status };
      if (r.KmsKeyId) entry.KmsKeyId = r.KmsKeyId;
      if (r.StatusMessage) entry.StatusMessage = r.StatusMessage;
      if (r.LastAccessedDate) entry.LastAccessedDate = epochSeconds(r.LastAccessedDate);
      return entry;
    });
  }

  // -------------------------------------------------------------------------
  // PutSecretValue
  // -------------------------------------------------------------------------
  putSecretValue(input) {
    const secret = this.requireSecret(input.SecretId);
    if (input.SecretString === undefined && input.SecretBinary === undefined) {
      throw new SecretsError(
        "InvalidParameterException",
        "You must provide either SecretString or SecretBinary.",
      );
    }
    if (input.SecretString !== undefined && input.SecretBinary !== undefined) {
      throw new SecretsError(
        "InvalidParameterException",
        "You can't specify both SecretString and SecretBinary.",
      );
    }

    const token = input.ClientRequestToken;
    // Idempotency on ClientRequestToken.
    if (token && secret.clientTokens.has(token)) {
      const vid = secret.clientTokens.get(token);
      const v = secret.versions.get(vid);
      return {
        ARN: secret.arn,
        Name: secret.name,
        VersionId: vid,
        VersionStages: v ? [...v.stages] : undefined,
      };
    }

    const now = Date.now();
    const versionId = token || newVersionId();

    // Stages requested for this new version (default AWSCURRENT).
    const requestedStages = input.VersionStages && input.VersionStages.length
      ? [...input.VersionStages]
      : [STAGE_CURRENT];

    const version = {
      versionId,
      secretString: input.SecretString,
      secretBinary: decodeBinary(input.SecretBinary),
      stages: new Set(requestedStages),
      createdAt: now,
    };

    // If this version takes AWSCURRENT, the old current becomes AWSPREVIOUS.
    if (requestedStages.includes(STAGE_CURRENT)) {
      const oldCurrent = this.currentVersionId(secret);
      if (oldCurrent && oldCurrent !== versionId) {
        const oldVersion = secret.versions.get(oldCurrent);
        oldVersion.stages.delete(STAGE_CURRENT);
        // Demote any existing AWSPREVIOUS first.
        const oldPrevious = this.versionByStage(secret, STAGE_PREVIOUS);
        if (oldPrevious && oldPrevious !== oldCurrent) {
          secret.versions.get(oldPrevious).stages.delete(STAGE_PREVIOUS);
        }
        oldVersion.stages.add(STAGE_PREVIOUS);
      }
    }
    // Remove the requested stages from any other versions that hold them.
    for (const stage of requestedStages) {
      for (const [vid, v] of secret.versions) {
        if (vid !== versionId) v.stages.delete(stage);
      }
    }

    secret.versions.set(versionId, version);
    if (token) secret.clientTokens.set(token, versionId);
    secret.lastChangedDate = now;
    this.pruneVersions(secret);

    return {
      ARN: secret.arn,
      Name: secret.name,
      VersionId: versionId,
      VersionStages: [...version.stages],
    };
  }

  // Drop versions that no longer carry any staging label (AWS deprecates them).
  pruneVersions(secret) {
    for (const [vid, v] of secret.versions) {
      if (v.stages.size === 0) {
        // Keep at least the current version safety net; deprecated versions
        // with no stages are eventually removed by AWS. We remove immediately.
        secret.versions.delete(vid);
        for (const [token, tvid] of secret.clientTokens) {
          if (tvid === vid) secret.clientTokens.delete(token);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // GetSecretValue
  // -------------------------------------------------------------------------
  getSecretValue(input) {
    const secret = this.requireSecret(input.SecretId);
    if (input.VersionId && input.VersionStage) {
      // AWS allows both but they must match the same version.
    }

    let versionId;
    if (input.VersionId) {
      versionId = input.VersionId;
      if (!secret.versions.has(versionId)) {
        throw new SecretsError(
          "ResourceNotFoundException",
          "Secrets Manager can't find the specified secret version.",
        );
      }
    } else {
      const stage = input.VersionStage || STAGE_CURRENT;
      versionId = this.versionByStage(secret, stage);
      if (!versionId) {
        throw new SecretsError(
          "ResourceNotFoundException",
          `Secrets Manager can't find the specified secret value for staging label: ${stage}`,
        );
      }
    }

    const version = secret.versions.get(versionId);
    if (!version || (version.secretString === undefined && version.secretBinary === undefined)) {
      throw new SecretsError(
        "ResourceNotFoundException",
        "Secrets Manager can't find the specified secret value for VersionId.",
      );
    }

    secret.lastAccessedDate = Date.now();

    const out = {
      ARN: secret.arn,
      Name: secret.name,
      VersionId: versionId,
      VersionStages: [...version.stages],
      CreatedDate: epochSeconds(version.createdAt),
    };
    if (version.secretString !== undefined) out.SecretString = version.secretString;
    if (version.secretBinary !== undefined) out.SecretBinary = encodeBinary(version.secretBinary);
    return out;
  }

  // -------------------------------------------------------------------------
  // BatchGetSecretValue
  // -------------------------------------------------------------------------
  batchGetSecretValue(input) {
    const hasList = Array.isArray(input.SecretIdList) && input.SecretIdList.length > 0;
    const hasFilters = Array.isArray(input.Filters) && input.Filters.length > 0;
    if (hasList && hasFilters) {
      throw new SecretsError(
        "InvalidParameterException",
        "Either 'SecretIdList' or 'Filters' must be provided, but not both.",
      );
    }

    let secrets;
    if (hasList) {
      secrets = input.SecretIdList.map((id) => ({ id, secret: this.resolveSecretId(id) }));
    } else {
      const matched = this.applyFilters([...this.secrets.values()].filter((s) => !s.deletedDate), input.Filters || []);
      secrets = matched.map((secret) => ({ id: secret.name, secret }));
    }

    const values = [];
    const errors = [];
    for (const { id, secret } of secrets) {
      if (!secret || secret.deletedDate) {
        errors.push({
          SecretId: id,
          ErrorCode: "ResourceNotFoundException",
          Message: "Secrets Manager can't find the specified secret.",
        });
        continue;
      }
      const versionId = this.currentVersionId(secret);
      if (!versionId) continue;
      const version = secret.versions.get(versionId);
      secret.lastAccessedDate = Date.now();
      const entry = {
        ARN: secret.arn,
        Name: secret.name,
        VersionId: versionId,
        VersionStages: [...version.stages],
        CreatedDate: epochSeconds(version.createdAt),
      };
      if (version.secretString !== undefined) entry.SecretString = version.secretString;
      if (version.secretBinary !== undefined) entry.SecretBinary = encodeBinary(version.secretBinary);
      values.push(entry);
    }

    const out = { SecretValues: values };
    if (errors.length) out.Errors = errors;
    return out;
  }

  // -------------------------------------------------------------------------
  // DescribeSecret
  // -------------------------------------------------------------------------
  describeSecret(input) {
    const secret = this.requireSecret(input.SecretId, { allowDeleted: true });
    const out = {
      ARN: secret.arn,
      Name: secret.name,
      CreatedDate: epochSeconds(secret.createdAt),
      LastChangedDate: epochSeconds(secret.lastChangedDate),
    };
    if (secret.description !== undefined) out.Description = secret.description;
    if (secret.kmsKeyId !== undefined) out.KmsKeyId = secret.kmsKeyId;
    if (secret.type !== undefined) out.Type = secret.type;
    out.RotationEnabled = secret.rotationEnabled;
    if (secret.rotationLambdaARN !== undefined) out.RotationLambdaARN = secret.rotationLambdaARN;
    if (secret.rotationRules !== undefined) out.RotationRules = secret.rotationRules;
    if (secret.lastRotatedDate) out.LastRotatedDate = epochSeconds(secret.lastRotatedDate);
    if (secret.nextRotationDate) out.NextRotationDate = epochSeconds(secret.nextRotationDate);
    if (secret.lastAccessedDate) out.LastAccessedDate = epochSeconds(secret.lastAccessedDate);
    if (secret.deletedDate) out.DeletedDate = epochSeconds(secret.deletedDate);
    if (secret.owningService !== undefined) out.OwningService = secret.owningService;
    if (secret.primaryRegion !== undefined) out.PrimaryRegion = secret.primaryRegion;

    // Tags
    out.Tags = [...secret.tags.entries()].map(([Key, Value]) => ({ Key, Value }));

    // VersionIdsToStages
    const vts = {};
    for (const [vid, v] of secret.versions) {
      if (v.stages.size > 0) vts[vid] = [...v.stages];
    }
    out.VersionIdsToStages = vts;

    if (secret.replicaRegions.length) out.ReplicationStatus = this.replicationStatus(secret);
    return out;
  }

  // -------------------------------------------------------------------------
  // UpdateSecret
  // -------------------------------------------------------------------------
  updateSecret(input) {
    const secret = this.requireSecret(input.SecretId);
    if (input.SecretString !== undefined && input.SecretBinary !== undefined) {
      throw new SecretsError(
        "InvalidParameterException",
        "You can't specify both SecretString and SecretBinary.",
      );
    }
    const now = Date.now();
    if (input.Description !== undefined) secret.description = input.Description;
    if (input.KmsKeyId !== undefined) secret.kmsKeyId = input.KmsKeyId;

    const out = { ARN: secret.arn, Name: secret.name };

    // Updating the value creates a new AWSCURRENT version.
    if (input.SecretString !== undefined || input.SecretBinary !== undefined) {
      const token = input.ClientRequestToken;
      if (token && secret.clientTokens.has(token)) {
        out.VersionId = secret.clientTokens.get(token);
        secret.lastChangedDate = now;
        return out;
      }
      const versionId = token || newVersionId();
      const oldCurrent = this.currentVersionId(secret);
      if (oldCurrent) {
        const oldVersion = secret.versions.get(oldCurrent);
        oldVersion.stages.delete(STAGE_CURRENT);
        const oldPrevious = this.versionByStage(secret, STAGE_PREVIOUS);
        if (oldPrevious) secret.versions.get(oldPrevious).stages.delete(STAGE_PREVIOUS);
        oldVersion.stages.add(STAGE_PREVIOUS);
      }
      secret.versions.set(versionId, {
        versionId,
        secretString: input.SecretString,
        secretBinary: decodeBinary(input.SecretBinary),
        stages: new Set([STAGE_CURRENT]),
        createdAt: now,
      });
      if (token) secret.clientTokens.set(token, versionId);
      this.pruneVersions(secret);
      out.VersionId = versionId;
    }

    secret.lastChangedDate = now;
    return out;
  }

  // -------------------------------------------------------------------------
  // UpdateSecretVersionStage
  // -------------------------------------------------------------------------
  updateSecretVersionStage(input) {
    const secret = this.requireSecret(input.SecretId);
    const stage = input.VersionStage;
    if (!stage) {
      throw new SecretsError(
        "InvalidParameterException",
        "You must specify the VersionStage parameter.",
      );
    }
    const { MoveToVersionId, RemoveFromVersionId } = input;
    if (!MoveToVersionId && !RemoveFromVersionId) {
      throw new SecretsError(
        "InvalidParameterException",
        "You must specify at least one of MoveToVersionId or RemoveFromVersionId.",
      );
    }

    if (RemoveFromVersionId) {
      const v = secret.versions.get(RemoveFromVersionId);
      if (!v) {
        throw new SecretsError(
          "InvalidParameterException",
          `The RemoveFromVersionId ${RemoveFromVersionId} does not exist.`,
        );
      }
      if (!v.stages.has(stage)) {
        throw new SecretsError(
          "InvalidParameterException",
          `Staging label ${stage} is not currently attached to version ${RemoveFromVersionId}.`,
        );
      }
    }

    if (MoveToVersionId) {
      const target = secret.versions.get(MoveToVersionId);
      if (!target) {
        throw new SecretsError(
          "InvalidParameterException",
          `The MoveToVersionId ${MoveToVersionId} does not exist.`,
        );
      }
      // Detach the stage from whoever holds it.
      for (const v of secret.versions.values()) v.stages.delete(stage);
      // AWSCURRENT moving implicitly shifts AWSPREVIOUS.
      if (stage === STAGE_CURRENT && RemoveFromVersionId) {
        const old = secret.versions.get(RemoveFromVersionId);
        if (old) {
          for (const v of secret.versions.values()) v.stages.delete(STAGE_PREVIOUS);
          old.stages.add(STAGE_PREVIOUS);
        }
      }
      target.stages.add(stage);
    } else if (RemoveFromVersionId) {
      secret.versions.get(RemoveFromVersionId).stages.delete(stage);
    }

    this.pruneVersions(secret);
    secret.lastChangedDate = Date.now();
    return { ARN: secret.arn, Name: secret.name };
  }

  // -------------------------------------------------------------------------
  // DeleteSecret
  // -------------------------------------------------------------------------
  deleteSecret(input) {
    const secret = this.requireSecret(input.SecretId, { allowDeleted: true });
    const force = input.ForceDeleteWithoutRecovery === true;
    if (force && input.RecoveryWindowInDays !== undefined) {
      throw new SecretsError(
        "InvalidParameterException",
        "You can't use ForceDeleteWithoutRecovery in conjunction with RecoveryWindowInDays.",
      );
    }

    if (force) {
      const out = { ARN: secret.arn, Name: secret.name, DeletionDate: epochSeconds() };
      this.secrets.delete(secret.name);
      return out;
    }

    const days = input.RecoveryWindowInDays !== undefined ? Number(input.RecoveryWindowInDays) : 30;
    if (days < 7 || days > 30) {
      throw new SecretsError(
        "InvalidParameterException",
        "The RecoveryWindowInDays value must be between 7 and 30 days.",
      );
    }
    const now = Date.now();
    secret.deletedDate = now;
    secret.deletionDate = now + days * 24 * 60 * 60 * 1000;
    return { ARN: secret.arn, Name: secret.name, DeletionDate: epochSeconds(secret.deletionDate) };
  }

  // -------------------------------------------------------------------------
  // RestoreSecret
  // -------------------------------------------------------------------------
  restoreSecret(input) {
    const secret = this.requireSecret(input.SecretId, { allowDeleted: true });
    secret.deletedDate = undefined;
    secret.deletionDate = undefined;
    secret.lastChangedDate = Date.now();
    return { ARN: secret.arn, Name: secret.name };
  }

  // -------------------------------------------------------------------------
  // ListSecrets
  // -------------------------------------------------------------------------
  listSecrets(input = {}) {
    const includeDeleted = input.IncludePlannedDeletion === true;
    let list = [...this.secrets.values()].filter((s) => includeDeleted || !s.deletedDate);

    list = this.applyFilters(list, input.Filters || []);

    // Sorting.
    const sortBy = input.SortBy;
    const order = input.SortOrder === "desc" ? -1 : 1;
    if (sortBy === "name") {
      list.sort((a, b) => order * a.name.localeCompare(b.name));
    } else {
      list.sort((a, b) => order * (a.createdAt - b.createdAt));
    }

    // Pagination.
    const max = input.MaxResults ? Number(input.MaxResults) : list.length;
    let start = 0;
    if (input.NextToken) {
      start = Number(Buffer.from(input.NextToken, "base64").toString("utf8"));
      if (!Number.isFinite(start) || start < 0) {
        throw new SecretsError("InvalidNextTokenException", "Invalid NextToken.");
      }
    }
    const page = list.slice(start, start + max);
    const out = { SecretList: page.map((s) => this.secretListEntry(s)) };
    if (start + max < list.length) {
      out.NextToken = Buffer.from(String(start + max)).toString("base64");
    }
    return out;
  }

  applyFilters(list, filters) {
    for (const filter of filters) {
      const key = filter.Key;
      const values = (filter.Values || []).map((v) => String(v).toLowerCase());
      if (key && !VALID_FILTER_KEYS.has(key)) {
        throw new SecretsError(
          "ValidationException",
          `1 validation error detected: Value '${key}' at 'filters' failed to satisfy constraint.`,
          400,
        );
      }
      list = list.filter((s) => {
        return values.some((val) => {
          // Negation support: "!foo".
          const negate = val.startsWith("!");
          const needle = negate ? val.slice(1) : val;
          let match = false;
          switch (key) {
            case "name":
              match = s.name.toLowerCase().includes(needle);
              break;
            case "description":
              match = (s.description || "").toLowerCase().includes(needle);
              break;
            case "tag-key":
              match = [...s.tags.keys()].some((k) => k.toLowerCase().includes(needle));
              break;
            case "tag-value":
              match = [...s.tags.values()].some((v) => v.toLowerCase().includes(needle));
              break;
            case "primary-region":
              match = (s.primaryRegion || "").toLowerCase().includes(needle);
              break;
            case "owning-service":
              match = (s.owningService || "").toLowerCase().includes(needle);
              break;
            case "all":
            default:
              match =
                s.name.toLowerCase().includes(needle) ||
                (s.description || "").toLowerCase().includes(needle) ||
                [...s.tags.keys()].some((k) => k.toLowerCase().includes(needle)) ||
                [...s.tags.values()].some((v) => v.toLowerCase().includes(needle));
              break;
          }
          return negate ? !match : match;
        });
      });
    }
    return list;
  }

  secretListEntry(secret) {
    const entry = {
      ARN: secret.arn,
      Name: secret.name,
      CreatedDate: epochSeconds(secret.createdAt),
      LastChangedDate: epochSeconds(secret.lastChangedDate),
      RotationEnabled: secret.rotationEnabled,
    };
    if (secret.description !== undefined) entry.Description = secret.description;
    if (secret.kmsKeyId !== undefined) entry.KmsKeyId = secret.kmsKeyId;
    if (secret.type !== undefined) entry.Type = secret.type;
    if (secret.rotationLambdaARN !== undefined) entry.RotationLambdaARN = secret.rotationLambdaARN;
    if (secret.rotationRules !== undefined) entry.RotationRules = secret.rotationRules;
    if (secret.lastRotatedDate) entry.LastRotatedDate = epochSeconds(secret.lastRotatedDate);
    if (secret.nextRotationDate) entry.NextRotationDate = epochSeconds(secret.nextRotationDate);
    if (secret.lastAccessedDate) entry.LastAccessedDate = epochSeconds(secret.lastAccessedDate);
    if (secret.deletedDate) entry.DeletedDate = epochSeconds(secret.deletedDate);
    if (secret.owningService !== undefined) entry.OwningService = secret.owningService;
    if (secret.primaryRegion !== undefined) entry.PrimaryRegion = secret.primaryRegion;
    entry.Tags = [...secret.tags.entries()].map(([Key, Value]) => ({ Key, Value }));
    const sts = {};
    for (const [vid, v] of secret.versions) {
      if (v.stages.size > 0) sts[vid] = [...v.stages];
    }
    entry.SecretVersionsToStages = sts;
    return entry;
  }

  // -------------------------------------------------------------------------
  // ListSecretVersionIds
  // -------------------------------------------------------------------------
  listSecretVersionIds(input) {
    const secret = this.requireSecret(input.SecretId, { allowDeleted: true });
    const includeDeprecated = input.IncludeDeprecated === true;
    let versions = [...secret.versions.entries()].filter(([, v]) => {
      return includeDeprecated || v.stages.size > 0;
    });
    versions.sort((a, b) => a[1].createdAt - b[1].createdAt);

    const max = input.MaxResults ? Number(input.MaxResults) : versions.length;
    let start = 0;
    if (input.NextToken) {
      start = Number(Buffer.from(input.NextToken, "base64").toString("utf8"));
      if (!Number.isFinite(start) || start < 0) {
        throw new SecretsError("InvalidNextTokenException", "Invalid NextToken.");
      }
    }
    const page = versions.slice(start, start + max);

    const out = {
      ARN: secret.arn,
      Name: secret.name,
      Versions: page.map(([vid, v]) => {
        const e = {
          VersionId: vid,
          CreatedDate: epochSeconds(v.createdAt),
        };
        if (v.stages.size > 0) e.VersionStages = [...v.stages];
        if (secret.lastAccessedDate) e.LastAccessedDate = epochSeconds(secret.lastAccessedDate);
        return e;
      }),
    };
    if (start + max < versions.length) {
      out.NextToken = Buffer.from(String(start + max)).toString("base64");
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // GetRandomPassword
  // -------------------------------------------------------------------------
  getRandomPassword(input = {}) {
    const length = input.PasswordLength !== undefined ? Number(input.PasswordLength) : 32;
    if (!Number.isInteger(length) || length < 1 || length > 4096) {
      throw new SecretsError(
        "InvalidParameterException",
        "The password length must be between 1 and 4096 characters.",
      );
    }
    let upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let lower = "abcdefghijklmnopqrstuvwxyz";
    let numbers = "0123456789";
    let punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    const space = " ";

    if (input.ExcludeUppercase) upper = "";
    if (input.ExcludeLowercase) lower = "";
    if (input.ExcludeNumbers) numbers = "";
    if (input.ExcludePunctuation) punctuation = "";

    let pool = upper + lower + numbers + punctuation + (input.IncludeSpace ? space : "");
    if (input.ExcludeCharacters) {
      const excluded = new Set(input.ExcludeCharacters.split(""));
      pool = [...pool].filter((c) => !excluded.has(c)).join("");
    }
    if (pool.length === 0) {
      throw new SecretsError(
        "InvalidParameterException",
        "The password character pool is empty after applying exclusions.",
      );
    }

    const pickFrom = (set) => set[randomBytes(1)[0] % set.length];
    const chars = [];

    if (input.RequireEachIncludedType) {
      const required = [upper, lower, numbers, punctuation, input.IncludeSpace ? space : ""]
        .map((s) => (input.ExcludeCharacters ? [...s].filter((c) => !new Set(input.ExcludeCharacters.split("")).has(c)).join("") : s))
        .filter((s) => s.length > 0);
      for (const set of required) {
        if (chars.length < length) chars.push(pickFrom(set));
      }
    }
    while (chars.length < length) chars.push(pickFrom(pool));
    // Shuffle so required chars are not always at the front.
    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = randomBytes(1)[0] % (i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return { RandomPassword: chars.slice(0, length).join("") };
  }

  // -------------------------------------------------------------------------
  // Tagging
  // -------------------------------------------------------------------------
  tagResource(input) {
    const secret = this.requireSecret(input.SecretId);
    const tags = input.Tags || [];
    for (const t of tags) {
      if (t && t.Key !== undefined) secret.tags.set(t.Key, t.Value ?? "");
    }
    secret.lastChangedDate = Date.now();
    return {};
  }

  untagResource(input) {
    const secret = this.requireSecret(input.SecretId);
    const keys = input.TagKeys || [];
    for (const k of keys) secret.tags.delete(k);
    secret.lastChangedDate = Date.now();
    return {};
  }

  // -------------------------------------------------------------------------
  // Rotation
  // -------------------------------------------------------------------------
  rotateSecret(input) {
    const secret = this.requireSecret(input.SecretId);
    if (input.RotationLambdaARN !== undefined) secret.rotationLambdaARN = input.RotationLambdaARN;
    if (input.RotationRules !== undefined) secret.rotationRules = input.RotationRules;
    // A configured Lambda (existing or supplied) enables rotation.
    secret.rotationEnabled = Boolean(secret.rotationLambdaARN);

    const now = Date.now();
    let versionId = this.currentVersionId(secret);

    // RotateImmediately defaults to true. It creates a new AWSPENDING version
    // that the (fake) rotation Lambda would normally populate. We simulate the
    // single-user rotation strategy producing a fresh AWSCURRENT version.
    const rotateNow = input.RotateImmediately !== false;
    if (rotateNow) {
      const newId = input.ClientRequestToken || newVersionId();
      const current = secret.versions.get(versionId);
      const newVersion = {
        versionId: newId,
        secretString: current ? current.secretString : undefined,
        secretBinary: current ? current.secretBinary : undefined,
        stages: new Set([STAGE_CURRENT]),
        createdAt: now,
      };
      if (versionId) {
        current.stages.delete(STAGE_CURRENT);
        const oldPrev = this.versionByStage(secret, STAGE_PREVIOUS);
        if (oldPrev) secret.versions.get(oldPrev).stages.delete(STAGE_PREVIOUS);
        current.stages.add(STAGE_PREVIOUS);
      }
      secret.versions.set(newId, newVersion);
      this.pruneVersions(secret);
      versionId = newId;
      secret.lastRotatedDate = now;
    }

    // Schedule the next rotation if rules say so.
    if (secret.rotationRules && secret.rotationRules.AutomaticallyAfterDays) {
      secret.nextRotationDate = now + Number(secret.rotationRules.AutomaticallyAfterDays) * 24 * 60 * 60 * 1000;
    }
    secret.lastChangedDate = now;

    return { ARN: secret.arn, Name: secret.name, VersionId: versionId };
  }

  cancelRotateSecret(input) {
    const secret = this.requireSecret(input.SecretId);
    secret.rotationEnabled = false;
    secret.rotationRules = undefined;
    secret.nextRotationDate = undefined;
    // Remove any in-flight AWSPENDING version.
    const pending = this.versionByStage(secret, STAGE_PENDING);
    if (pending) {
      secret.versions.get(pending).stages.delete(STAGE_PENDING);
      this.pruneVersions(secret);
    }
    secret.lastChangedDate = Date.now();
    const out = { ARN: secret.arn, Name: secret.name };
    const current = this.currentVersionId(secret);
    if (current) out.VersionId = current;
    return out;
  }

  // -------------------------------------------------------------------------
  // Resource policies
  // -------------------------------------------------------------------------
  putResourcePolicy(input) {
    const secret = this.requireSecret(input.SecretId);
    const policy = input.ResourcePolicy;
    if (!policy) {
      throw new SecretsError(
        "InvalidParameterException",
        "You must specify the ResourcePolicy parameter.",
      );
    }
    try {
      JSON.parse(policy);
    } catch {
      throw new SecretsError(
        "MalformedPolicyDocumentException",
        "The resource policy is not a valid JSON document.",
      );
    }
    if (input.BlockPublicPolicy === true && /"Principal"\s*:\s*"\*"/.test(policy)) {
      throw new SecretsError(
        "PublicPolicyException",
        "Resource policy blocked due to public access and BlockPublicPolicy=true.",
      );
    }
    secret.resourcePolicy = policy;
    secret.lastChangedDate = Date.now();
    return { ARN: secret.arn, Name: secret.name };
  }

  getResourcePolicy(input) {
    const secret = this.requireSecret(input.SecretId);
    const out = { ARN: secret.arn, Name: secret.name };
    if (secret.resourcePolicy !== undefined) out.ResourcePolicy = secret.resourcePolicy;
    return out;
  }

  deleteResourcePolicy(input) {
    const secret = this.requireSecret(input.SecretId);
    secret.resourcePolicy = undefined;
    secret.lastChangedDate = Date.now();
    return { ARN: secret.arn, Name: secret.name };
  }

  validateResourcePolicy(input) {
    const policy = input.ResourcePolicy;
    if (!policy) {
      throw new SecretsError(
        "InvalidParameterException",
        "You must specify the ResourcePolicy parameter.",
      );
    }
    if (input.SecretId) {
      // Ensure the secret exists if an id is supplied.
      this.requireSecret(input.SecretId);
    }
    const errors = [];
    let passed = true;
    try {
      const parsed = JSON.parse(policy);
      if (!parsed || typeof parsed !== "object") {
        passed = false;
        errors.push({ CheckName: "JSON_PARSE", ErrorMessage: "Policy is not a JSON object." });
      }
    } catch {
      passed = false;
      errors.push({ CheckName: "JSON_PARSE", ErrorMessage: "The policy is not valid JSON." });
    }
    const out = { PolicyValidationPassed: passed };
    if (errors.length) out.ValidationErrors = errors;
    return out;
  }

  // -------------------------------------------------------------------------
  // Replication
  // -------------------------------------------------------------------------
  replicateSecretToRegions(input) {
    const secret = this.requireSecret(input.SecretId);
    const add = input.AddReplicaRegions || [];
    if (!add.length) {
      throw new SecretsError(
        "InvalidParameterException",
        "You must specify at least one region in AddReplicaRegions.",
      );
    }
    const now = Date.now();
    for (const r of add) {
      const existing = secret.replicaRegions.find((x) => x.Region === r.Region);
      if (existing && input.ForceOverwriteReplicaSecret !== true) {
        existing.Status = "InProgress";
        existing.StatusMessage = "Replication in progress.";
        existing.KmsKeyId = r.KmsKeyId || existing.KmsKeyId;
        existing.LastAccessedDate = now;
      } else if (existing) {
        existing.Status = "InProgress";
        existing.KmsKeyId = r.KmsKeyId || existing.KmsKeyId;
        existing.LastAccessedDate = now;
      } else {
        secret.replicaRegions.push({
          Region: r.Region,
          KmsKeyId: r.KmsKeyId,
          Status: "InProgress",
          StatusMessage: "Replication in progress.",
          LastAccessedDate: now,
        });
      }
    }
    secret.lastChangedDate = now;
    return { ARN: secret.arn, ReplicationStatus: this.replicationStatus(secret) };
  }

  removeRegionsFromReplication(input) {
    const secret = this.requireSecret(input.SecretId);
    const remove = new Set(input.RemoveReplicaRegions || []);
    if (!remove.size) {
      throw new SecretsError(
        "InvalidParameterException",
        "You must specify at least one region in RemoveReplicaRegions.",
      );
    }
    secret.replicaRegions = secret.replicaRegions.filter((r) => !remove.has(r.Region));
    secret.lastChangedDate = Date.now();
    return { ARN: secret.arn, ReplicationStatus: this.replicationStatus(secret) };
  }

  stopReplicationToReplica(input) {
    const secret = this.requireSecret(input.SecretId);
    // Called from a replica region; promotes the replica to a standalone secret.
    secret.replicaRegions = [];
    secret.lastChangedDate = Date.now();
    return { ARN: secret.arn };
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalFailure";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    // x-amzn-errortype helps some clients; __type is the canonical field.
    res.setHeader("x-amzn-errortype", code);
    res.end(
      JSON.stringify({
        __type: code,
        message: error.message || code,
        Message: error.message || code,
      }),
    );
  }
}

export default SecretsmanagerServer;
