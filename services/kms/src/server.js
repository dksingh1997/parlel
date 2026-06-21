// parlel/kms — a lightweight, dependency-free fake of AWS KMS.
//
// Speaks the AWS JSON 1.1 wire protocol (X-Amz-Target: TrentService.<Op>).
// Real-ish crypto: each key holds an in-memory AES-256 key; Encrypt produces a
// reversible ciphertext blob that embeds the keyId, and Decrypt reverses it.
// Sign/Verify use HMAC keyed by the per-key material. Pure Node.js.

import { createServer } from "node:http";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  NotFoundException: 400,
  AlreadyExistsException: 400,
  InvalidArnException: 400,
  InvalidCiphertextException: 400,
  InvalidKeyUsageException: 400,
  KMSInvalidStateException: 400,
  DisabledException: 400,
  ValidationException: 400,
  KMSInternalException: 500,
};

class KmsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function epochSeconds(ms = Date.now()) {
  return Math.floor(ms / 1000);
}

export class KmsServer {
  constructor(port = 4730, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.keys = new Map(); // keyId -> key
    this.aliases = new Map(); // aliasName -> { targetKeyId }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new KmsError("KMSInternalException", error.message, 500));
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

  keyArn(keyId) {
    return `arn:aws:kms:${this.region}:${this.accountId}:key/${keyId}`;
  }

  aliasArn(aliasName) {
    return `arn:aws:kms:${this.region}:${this.accountId}:${aliasName}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "kms", keys: this.keys.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-kms");

    if (method !== "POST") {
      return this.sendError(res, new KmsError("ValidationException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new KmsError("ValidationException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof KmsError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateKey": return this.createKey(input);
      case "DescribeKey": return this.describeKey(input);
      case "ListKeys": return this.listKeys(input);
      case "Encrypt": return this.encrypt(input);
      case "Decrypt": return this.decrypt(input);
      case "GenerateDataKey": return this.generateDataKey(input);
      case "GenerateDataKeyWithoutPlaintext": return this.generateDataKeyWithoutPlaintext(input);
      case "Sign": return this.sign(input);
      case "Verify": return this.verify(input);
      case "CreateAlias": return this.createAlias(input);
      case "ListAliases": return this.listAliases(input);
      case "DeleteAlias": return this.deleteAlias(input);
      case "EnableKeyRotation": return this.enableKeyRotation(input);
      case "DisableKeyRotation": return this.disableKeyRotation(input);
      case "GetKeyRotationStatus": return this.getKeyRotationStatus(input);
      case "ScheduleKeyDeletion": return this.scheduleKeyDeletion(input);
      case "EnableKey": return this.enableKey(input);
      case "DisableKey": return this.disableKey(input);
      case "ReEncrypt": return this.reEncrypt(input);
      case "ListResourceTags": return this.listResourceTags(input);
      case "TagResource": return this.tagResource(input);
      default:
        throw new KmsError("ValidationException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  resolveKeyId(keyId) {
    if (!keyId) throw new KmsError("ValidationException", "KeyId is required.");
    // alias
    if (keyId.startsWith("alias/")) {
      const alias = this.aliases.get(keyId);
      if (!alias) throw new KmsError("NotFoundException", `Alias ${keyId} is not found.`);
      return alias.targetKeyId;
    }
    if (keyId.startsWith("arn:aws:kms:")) {
      if (keyId.includes(":alias/")) {
        const aliasName = keyId.split(":").pop();
        const alias = this.aliases.get(aliasName);
        if (!alias) throw new KmsError("NotFoundException", `Alias ${aliasName} is not found.`);
        return alias.targetKeyId;
      }
      return keyId.split("/").pop();
    }
    return keyId;
  }

  requireKey(keyId) {
    const id = this.resolveKeyId(keyId);
    const key = this.keys.get(id);
    if (!key) throw new KmsError("NotFoundException", `Key ${keyId} does not exist.`);
    return key;
  }

  createKey(input = {}) {
    const keyId = randomUUID();
    const now = Date.now();
    const key = {
      KeyId: keyId,
      Arn: this.keyArn(keyId),
      Description: input.Description || "",
      KeyUsage: input.KeyUsage || "ENCRYPT_DECRYPT",
      KeySpec: input.KeySpec || input.CustomerMasterKeySpec || "SYMMETRIC_DEFAULT",
      KeyState: "Enabled",
      Enabled: true,
      Origin: input.Origin || "AWS_KMS",
      CreationDate: now,
      rotationEnabled: false,
      material: randomBytes(32), // AES-256 + HMAC key material
      tags: (input.Tags || []).map((t) => ({ TagKey: t.TagKey, TagValue: t.TagValue })),
    };
    this.keys.set(keyId, key);
    return { KeyMetadata: this.keyMetadata(key) };
  }

  keyMetadata(key) {
    return {
      AWSAccountId: this.accountId,
      KeyId: key.KeyId,
      Arn: key.Arn,
      CreationDate: epochSeconds(key.CreationDate),
      Enabled: key.Enabled,
      Description: key.Description,
      KeyUsage: key.KeyUsage,
      KeyState: key.KeyState,
      Origin: key.Origin,
      KeyManager: "CUSTOMER",
      KeySpec: key.KeySpec,
      CustomerMasterKeySpec: key.KeySpec,
      EncryptionAlgorithms: key.KeyUsage === "ENCRYPT_DECRYPT" ? ["SYMMETRIC_DEFAULT"] : undefined,
      SigningAlgorithms: key.KeyUsage === "SIGN_VERIFY" ? ["RSASSA_PKCS1_V1_5_SHA_256"] : undefined,
      MultiRegion: false,
    };
  }

  describeKey(input) {
    const key = this.requireKey(input.KeyId);
    return { KeyMetadata: this.keyMetadata(key) };
  }

  listKeys() {
    return {
      Keys: [...this.keys.values()].map((k) => ({ KeyId: k.KeyId, KeyArn: k.Arn })),
      Truncated: false,
    };
  }

  // Ciphertext blob: base64( JSON{ keyId, iv, tag, ct } ). Reversible.
  encryptBlob(key, plaintextBuf) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.material, iv);
    const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = {
      k: key.KeyId,
      iv: iv.toString("base64"),
      t: tag.toString("base64"),
      c: ct.toString("base64"),
    };
    return Buffer.from(JSON.stringify(envelope)).toString("base64");
  }

  decryptBlob(blobB64) {
    let envelope;
    try {
      envelope = JSON.parse(Buffer.from(blobB64, "base64").toString("utf8"));
    } catch {
      throw new KmsError("InvalidCiphertextException", "The ciphertext is invalid.");
    }
    const key = this.keys.get(envelope.k);
    if (!key) throw new KmsError("NotFoundException", "Key for ciphertext not found.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key.material, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.t, "base64"));
      const pt = Buffer.concat([decipher.update(Buffer.from(envelope.c, "base64")), decipher.final()]);
      return { key, plaintext: pt };
    } catch {
      throw new KmsError("InvalidCiphertextException", "The ciphertext is invalid.");
    }
  }

  encrypt(input) {
    const key = this.requireKey(input.KeyId);
    if (input.Plaintext === undefined) throw new KmsError("ValidationException", "Plaintext is required.");
    const pt = Buffer.from(String(input.Plaintext), "base64");
    const blob = this.encryptBlob(key, pt);
    return { CiphertextBlob: blob, KeyId: key.Arn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" };
  }

  decrypt(input) {
    if (input.CiphertextBlob === undefined) throw new KmsError("ValidationException", "CiphertextBlob is required.");
    const { key, plaintext } = this.decryptBlob(String(input.CiphertextBlob));
    return { Plaintext: plaintext.toString("base64"), KeyId: key.Arn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" };
  }

  dataKeyLength(spec, numberOfBytes) {
    if (numberOfBytes) return Number(numberOfBytes);
    if (spec === "AES_128") return 16;
    return 32;
  }

  generateDataKey(input) {
    const key = this.requireKey(input.KeyId);
    const len = this.dataKeyLength(input.KeySpec, input.NumberOfBytes);
    const plaintext = randomBytes(len);
    const blob = this.encryptBlob(key, plaintext);
    return {
      KeyId: key.Arn,
      Plaintext: plaintext.toString("base64"),
      CiphertextBlob: blob,
    };
  }

  generateDataKeyWithoutPlaintext(input) {
    const key = this.requireKey(input.KeyId);
    const len = this.dataKeyLength(input.KeySpec, input.NumberOfBytes);
    const plaintext = randomBytes(len);
    const blob = this.encryptBlob(key, plaintext);
    return { KeyId: key.Arn, CiphertextBlob: blob };
  }

  sign(input) {
    const key = this.requireKey(input.KeyId);
    if (input.Message === undefined) throw new KmsError("ValidationException", "Message is required.");
    const msg = Buffer.from(String(input.Message), "base64");
    const sig = createHmac("sha256", key.material).update(msg).digest();
    return {
      KeyId: key.Arn,
      Signature: sig.toString("base64"),
      SigningAlgorithm: input.SigningAlgorithm || "RSASSA_PKCS1_V1_5_SHA_256",
    };
  }

  verify(input) {
    const key = this.requireKey(input.KeyId);
    const msg = Buffer.from(String(input.Message), "base64");
    const expected = createHmac("sha256", key.material).update(msg).digest();
    const provided = Buffer.from(String(input.Signature), "base64");
    const valid = expected.length === provided.length && expected.equals(provided);
    if (!valid) {
      throw new KmsError("KMSInvalidStateException", "Signature verification failed.");
    }
    return {
      KeyId: key.Arn,
      SignatureValid: true,
      SigningAlgorithm: input.SigningAlgorithm || "RSASSA_PKCS1_V1_5_SHA_256",
    };
  }

  reEncrypt(input) {
    const { plaintext } = this.decryptBlob(String(input.CiphertextBlob));
    const destKey = this.requireKey(input.DestinationKeyId);
    const sourceArn = input.SourceKeyId ? this.requireKey(input.SourceKeyId).Arn : undefined;
    const blob = this.encryptBlob(destKey, plaintext);
    return {
      CiphertextBlob: blob,
      SourceKeyId: sourceArn,
      KeyId: destKey.Arn,
      SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    };
  }

  createAlias(input) {
    const aliasName = input.AliasName;
    if (!aliasName || !aliasName.startsWith("alias/")) {
      throw new KmsError("ValidationException", "AliasName must begin with 'alias/'.");
    }
    if (this.aliases.has(aliasName)) {
      throw new KmsError("AlreadyExistsException", `Alias ${aliasName} already exists.`);
    }
    const key = this.requireKey(input.TargetKeyId);
    this.aliases.set(aliasName, { targetKeyId: key.KeyId, createDate: Date.now() });
    return {};
  }

  listAliases(input) {
    let entries = [...this.aliases.entries()];
    if (input && input.KeyId) {
      const id = this.resolveKeyId(input.KeyId);
      entries = entries.filter(([, a]) => a.targetKeyId === id);
    }
    return {
      Aliases: entries.map(([AliasName, a]) => ({
        AliasName,
        AliasArn: this.aliasArn(AliasName),
        TargetKeyId: a.targetKeyId,
        CreationDate: epochSeconds(a.createDate),
        LastUpdatedDate: epochSeconds(a.createDate),
      })),
      Truncated: false,
    };
  }

  deleteAlias(input) {
    if (!this.aliases.has(input.AliasName)) {
      throw new KmsError("NotFoundException", `Alias ${input.AliasName} not found.`);
    }
    this.aliases.delete(input.AliasName);
    return {};
  }

  enableKeyRotation(input) {
    const key = this.requireKey(input.KeyId);
    key.rotationEnabled = true;
    return {};
  }

  disableKeyRotation(input) {
    const key = this.requireKey(input.KeyId);
    key.rotationEnabled = false;
    return {};
  }

  getKeyRotationStatus(input) {
    const key = this.requireKey(input.KeyId);
    return { KeyRotationEnabled: key.rotationEnabled };
  }

  enableKey(input) {
    const key = this.requireKey(input.KeyId);
    key.Enabled = true;
    key.KeyState = "Enabled";
    return {};
  }

  disableKey(input) {
    const key = this.requireKey(input.KeyId);
    key.Enabled = false;
    key.KeyState = "Disabled";
    return {};
  }

  scheduleKeyDeletion(input) {
    const key = this.requireKey(input.KeyId);
    const days = input.PendingWindowInDays ? Number(input.PendingWindowInDays) : 30;
    key.KeyState = "PendingDeletion";
    key.Enabled = false;
    const deletionDate = Date.now() + days * 24 * 60 * 60 * 1000;
    return { KeyId: key.Arn, DeletionDate: epochSeconds(deletionDate), KeyState: "PendingDeletion", PendingWindowInDays: days };
  }

  tagResource(input) {
    const key = this.requireKey(input.KeyId);
    for (const t of input.Tags || []) {
      const idx = key.tags.findIndex((x) => x.TagKey === t.TagKey);
      if (idx >= 0) key.tags[idx] = t;
      else key.tags.push(t);
    }
    return {};
  }

  listResourceTags(input) {
    const key = this.requireKey(input.KeyId);
    return { Tags: key.tags, Truncated: false };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "KMSInternalException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default KmsServer;
