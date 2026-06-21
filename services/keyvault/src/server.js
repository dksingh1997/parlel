// parlel/keyvault — a lightweight, dependency-free fake of Azure Key Vault
// (Secrets data plane).
//
// Speaks the Azure Key Vault Secrets REST API (api-version 2025-07-01, the
// default emitted by @azure/keyvault-secrets@4.x) so that application code using
// the real `@azure/keyvault-secrets` SecretClient can run against it with zero
// cost and zero side effects. Pure Node.js, no external npm dependencies. State
// is in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Point the real client at this server with any TokenCredential. Because the
// fake serves over plain HTTP and presents a synthetic challenge resource, set
// `disableChallengeResourceVerification: true` on the client options:
//
//   const client = new SecretClient(
//     "http://127.0.0.1:4594",
//     credential,
//     { disableChallengeResourceVerification: true },
//   );
//
// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
// Key Vault uses challenge-based bearer auth. The SDK sends the first request
// with an empty body; the service replies 401 with a `WWW-Authenticate` header
// describing the authority + resource. The SDK acquires a token from the
// supplied credential and replays the request with `Authorization: Bearer ...`.
// This fake accepts ANY non-empty bearer token — it never validates the token —
// so any credential (ClientSecretCredential, a hand-rolled fake TokenCredential,
// etc.) works. Requests without a bearer token receive the 401 challenge.
//
// ---------------------------------------------------------------------------
// Implemented operations (Secrets data plane)
// ---------------------------------------------------------------------------
//   PUT    /secrets/{name}                       SetSecret
//   GET    /secrets/{name}/{version}             GetSecret (version "" = latest)
//   PATCH  /secrets/{name}/{version}             UpdateSecret
//   DELETE /secrets/{name}                       DeleteSecret (soft delete)
//   GET    /secrets                              GetSecrets (list, paged)
//   GET    /secrets/{name}/versions              GetSecretVersions (paged)
//   POST   /secrets/{name}/backup                BackupSecret
//   POST   /secrets/restore                      RestoreSecret
//   GET    /deletedsecrets                       GetDeletedSecrets (paged)
//   GET    /deletedsecrets/{name}                GetDeletedSecret
//   POST   /deletedsecrets/{name}/recover        RecoverDeletedSecret
//   DELETE /deletedsecrets/{name}                PurgeDeletedSecret
//
// All timestamps are Unix epoch seconds (integers), matching the proto/JSON
// wire format the SDK deserializes (it multiplies by 1000 to build a Date).

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

// Default soft-delete recovery level for this fake vault.
const RECOVERY_LEVEL = "Recoverable+Purgeable";
const RECOVERABLE_DAYS = 90;
// Scheduled purge horizon for deleted secrets (seconds).
const PURGE_DELAY_SECONDS = RECOVERABLE_DAYS * 24 * 60 * 60;

// Secret names: 1-127 chars of [0-9a-zA-Z-].
const SECRET_NAME_RE = /^[0-9a-zA-Z-]{1,127}$/;

class KvError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class KeyvaultServer {
  constructor(port = 4594, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    // The challenge resource advertised in WWW-Authenticate. The SDK only
    // enforces that the request host endsWith `.<resourceHost>` when
    // disableChallengeResourceVerification is false; tests disable that check.
    this.resource = options.resource || "https://vault.azure.net";
    this.authority =
      options.authority ||
      "https://login.microsoftonline.com/parlel-tenant-id";
    this.server = null;
    this.reset();
  }

  reset() {
    // secrets: Map<name, SecretRecord>
    //   SecretRecord = {
    //     name,
    //     versions: Map<versionId, VersionRecord>,  // insertion-ordered
    //     latest: versionId,
    //   }
    //   VersionRecord = {
    //     name, version, value, contentType, tags,
    //     enabled, nbf, exp, created, updated, managed,
    //   }
    this.secrets = new Map();
    // deleted: Map<name, DeletedRecord> — soft-deleted secrets (whole secret).
    //   DeletedRecord = { name, versions, latest, deletedDate, scheduledPurgeDate }
    this.deleted = new Map();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (error instanceof KvError) {
            this.sendError(res, error.status, error.code, error.message);
          } else {
            this.sendError(res, 500, "InternalError", error.message || "internal error");
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

  // The vault base URL as seen by the client, used to build resource ids.
  vaultUrl(req) {
    const host = req.headers.host || `${this.host}:${this.port}`;
    // The data plane is served over plain http in the fake.
    return `http://${host}`;
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    // Internal parlel endpoints (not part of Key Vault).
    if (pathname === "/_parlel/health") {
      let versions = 0;
      for (const s of this.secrets.values()) versions += s.versions.size;
      return this.sendJson(res, 200, {
        status: "ok",
        service: "keyvault",
        secrets: this.secrets.size,
        versions,
        deleted: this.deleted.size,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/_parlel/dump" && method === "GET") {
      return this.sendJson(res, 200, {
        secrets: [...this.secrets.keys()],
        deleted: [...this.deleted.keys()],
      });
    }

    // ---- Challenge-based authentication gate ----
    // Every data-plane request must carry a bearer token. The first SDK request
    // arrives without one (body nulled); we answer with the challenge. We accept
    // ANY non-empty bearer token thereafter.
    const auth = req.headers["authorization"] || "";
    if (!/^Bearer\s+\S+/i.test(auth)) {
      // Drain the body so the socket is reusable, then issue the challenge.
      await this.readBody(req);
      res.statusCode = 401;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer authorization="${this.authority}", resource="${this.resource}"`,
      );
      res.setHeader("Content-Length", "0");
      res.end();
      return;
    }

    const rawBody = await this.readBody(req);
    let body = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new KvError(400, "BadParameter", "Invalid JSON body");
      }
    }

    const vaultUrl = this.vaultUrl(req);
    const segs = pathname.split("/").filter(Boolean);

    // ---- /secrets ... ----
    if (segs[0] === "secrets") {
      // POST /secrets/restore
      if (segs.length === 2 && segs[1] === "restore" && method === "POST") {
        return this.restoreSecret(res, vaultUrl, body);
      }
      // GET /secrets  (list secrets)
      if (segs.length === 1 && method === "GET") {
        return this.listSecrets(res, vaultUrl, q);
      }
      // PUT /secrets/{name}  (set)
      if (segs.length === 2 && method === "PUT") {
        return this.setSecret(res, vaultUrl, segs[1], body);
      }
      // PATCH /secrets/{name}  (update latest — version omitted => trailing slash)
      if (segs.length === 2 && method === "PATCH") {
        return this.updateSecret(res, vaultUrl, segs[1], "", body);
      }
      // DELETE /secrets/{name}  (soft delete)
      if (segs.length === 2 && method === "DELETE") {
        return this.deleteSecret(res, vaultUrl, segs[1]);
      }
      // GET /secrets/{name}/versions  (list versions)
      if (segs.length === 3 && segs[2] === "versions" && method === "GET") {
        return this.listSecretVersions(res, vaultUrl, segs[1], q);
      }
      // POST /secrets/{name}/backup
      if (segs.length === 3 && segs[2] === "backup" && method === "POST") {
        return this.backupSecret(res, vaultUrl, segs[1]);
      }
      // GET|PATCH /secrets/{name}/{version}
      if (segs.length === 3 && method === "GET") {
        return this.getSecret(res, vaultUrl, segs[1], segs[2]);
      }
      if (segs.length === 3 && method === "PATCH") {
        return this.updateSecret(res, vaultUrl, segs[1], segs[2], body);
      }
      // GET /secrets/{name}  (no trailing version => latest)
      if (segs.length === 2 && method === "GET") {
        return this.getSecret(res, vaultUrl, segs[1], "");
      }
      throw new KvError(405, "MethodNotAllowed", `Unsupported method ${method} on ${pathname}`);
    }

    // ---- /deletedsecrets ... ----
    if (segs[0] === "deletedsecrets") {
      // GET /deletedsecrets  (list deleted)
      if (segs.length === 1 && method === "GET") {
        return this.listDeletedSecrets(res, vaultUrl, q);
      }
      // POST /deletedsecrets/{name}/recover
      if (segs.length === 3 && segs[2] === "recover" && method === "POST") {
        return this.recoverDeletedSecret(res, vaultUrl, segs[1]);
      }
      // GET /deletedsecrets/{name}
      if (segs.length === 2 && method === "GET") {
        return this.getDeletedSecret(res, vaultUrl, segs[1]);
      }
      // DELETE /deletedsecrets/{name}  (purge)
      if (segs.length === 2 && method === "DELETE") {
        return this.purgeDeletedSecret(res, segs[1]);
      }
      throw new KvError(405, "MethodNotAllowed", `Unsupported method ${method} on ${pathname}`);
    }

    throw new KvError(404, "NotFound", `Unrecognized path: ${pathname}`);
  }

  // =========================================================================
  // Secrets
  // =========================================================================
  setSecret(res, vaultUrl, name, body) {
    this._assertName(name);
    if (body.value === undefined || body.value === null) {
      throw new KvError(400, "BadParameter", "The parameter 'value' is required.");
    }
    if (typeof body.value !== "string") {
      throw new KvError(400, "BadParameter", "The parameter 'value' must be a string.");
    }
    // Block setting a secret whose name is currently soft-deleted: Key Vault
    // rejects this with Conflict until the deleted secret is purged or recovered.
    if (this.deleted.has(name)) {
      throw new KvError(
        409,
        "Conflict",
        `Secret ${name} is currently in a deleted but recoverable state, and its name cannot be reused; in this state, the secret can only be recovered or purged.`,
      );
    }
    const attrs = body.attributes || {};
    const now = nowSec();
    const version = newVersionId();
    const record = {
      name,
      version,
      value: body.value,
      contentType: body.contentType,
      tags: body.tags && Object.keys(body.tags).length ? body.tags : undefined,
      enabled: attrs.enabled === undefined ? true : !!attrs.enabled,
      nbf: numOrUndef(attrs.nbf),
      exp: numOrUndef(attrs.exp),
      created: now,
      updated: now,
      managed: undefined,
    };
    let secret = this.secrets.get(name);
    if (!secret) {
      secret = { name, versions: new Map(), latest: null };
      this.secrets.set(name, secret);
    }
    secret.versions.set(version, record);
    secret.latest = version;
    return this.sendJson(res, 200, secretBundle(vaultUrl, record));
  }

  getSecret(res, vaultUrl, name, version) {
    const record = this._resolveVersion(name, version);
    return this.sendJson(res, 200, secretBundle(vaultUrl, record));
  }

  updateSecret(res, vaultUrl, name, version, body) {
    const record = this._resolveVersion(name, version);
    const attrs = body.attributes || {};
    if (body.contentType !== undefined) record.contentType = body.contentType;
    if (body.tags !== undefined) {
      record.tags = body.tags && Object.keys(body.tags).length ? body.tags : undefined;
    }
    if (attrs.enabled !== undefined) record.enabled = !!attrs.enabled;
    if (attrs.nbf !== undefined) record.nbf = numOrUndef(attrs.nbf);
    if (attrs.exp !== undefined) record.exp = numOrUndef(attrs.exp);
    record.updated = nowSec();
    return this.sendJson(res, 200, secretBundle(vaultUrl, record));
  }

  deleteSecret(res, vaultUrl, name) {
    const secret = this.secrets.get(name);
    if (!secret) throw this._notFound(name);
    this.secrets.delete(name);
    const now = nowSec();
    const deletedRecord = {
      name,
      versions: secret.versions,
      latest: secret.latest,
      deletedDate: now,
      scheduledPurgeDate: now + PURGE_DELAY_SECONDS,
    };
    this.deleted.set(name, deletedRecord);
    const latest = secret.versions.get(secret.latest);
    return this.sendJson(res, 200, deletedSecretBundle(vaultUrl, latest, deletedRecord));
  }

  listSecrets(res, vaultUrl, q) {
    const all = [...this.secrets.values()]
      .map((s) => s.versions.get(s.latest))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const { page, nextLink } = paginate(all, q, vaultUrl, "/secrets");
    return this.sendJson(res, 200, {
      value: page.map((r) => secretItem(vaultUrl, r)),
      ...(nextLink ? { nextLink } : {}),
    });
  }

  listSecretVersions(res, vaultUrl, name, q) {
    const secret = this.secrets.get(name);
    if (!secret) {
      // Key Vault returns an empty list (200) for versions of an unknown secret
      // only when it does not exist at all it 404s on get; but the list endpoint
      // returns 404 for a missing secret. Match that.
      throw this._notFound(name);
    }
    const all = [...secret.versions.values()].sort((a, b) => b.created - a.created);
    const { page, nextLink } = paginate(all, q, vaultUrl, `/secrets/${name}/versions`);
    return this.sendJson(res, 200, {
      value: page.map((r) => secretItem(vaultUrl, r)),
      ...(nextLink ? { nextLink } : {}),
    });
  }

  backupSecret(res, vaultUrl, name) {
    const secret = this.secrets.get(name);
    if (!secret) throw this._notFound(name);
    // A backup blob is an opaque, base64url-encoded token. We encode the full
    // secret state so restore can faithfully rebuild it.
    const snapshot = {
      name: secret.name,
      latest: secret.latest,
      versions: [...secret.versions.values()],
    };
    const value = Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64url");
    return this.sendJson(res, 200, { value });
  }

  restoreSecret(res, vaultUrl, body) {
    if (!body.value || typeof body.value !== "string") {
      throw new KvError(400, "BadParameter", "The parameter 'value' is required.");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(Buffer.from(body.value, "base64url").toString("utf8"));
    } catch {
      throw new KvError(400, "BadParameter", "Backup blob is malformed.");
    }
    const name = snapshot.name;
    if (this.secrets.has(name)) {
      throw new KvError(
        409,
        "Conflict",
        `A secret with name ${name} already exists; cannot restore over an existing secret.`,
      );
    }
    if (this.deleted.has(name)) {
      throw new KvError(
        409,
        "Conflict",
        `Secret ${name} is currently in a deleted but recoverable state; purge or recover before restoring.`,
      );
    }
    const versions = new Map();
    for (const v of snapshot.versions) versions.set(v.version, v);
    this.secrets.set(name, { name, versions, latest: snapshot.latest });
    const latest = versions.get(snapshot.latest);
    return this.sendJson(res, 200, secretBundle(vaultUrl, latest));
  }

  // =========================================================================
  // Deleted secrets (soft delete)
  // =========================================================================
  getDeletedSecret(res, vaultUrl, name) {
    const record = this.deleted.get(name);
    if (!record) {
      throw new KvError(404, "SecretNotFound", `Deleted secret not found: ${name}`);
    }
    const latest = record.versions.get(record.latest);
    return this.sendJson(res, 200, deletedSecretBundle(vaultUrl, latest, record));
  }

  listDeletedSecrets(res, vaultUrl, q) {
    const all = [...this.deleted.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    const { page, nextLink } = paginate(all, q, vaultUrl, "/deletedsecrets");
    return this.sendJson(res, 200, {
      value: page.map((d) => deletedSecretItem(vaultUrl, d.versions.get(d.latest), d)),
      ...(nextLink ? { nextLink } : {}),
    });
  }

  recoverDeletedSecret(res, vaultUrl, name) {
    const record = this.deleted.get(name);
    if (!record) {
      throw new KvError(404, "SecretNotFound", `Deleted secret not found: ${name}`);
    }
    this.deleted.delete(name);
    this.secrets.set(name, {
      name,
      versions: record.versions,
      latest: record.latest,
    });
    const latest = record.versions.get(record.latest);
    return this.sendJson(res, 200, secretBundle(vaultUrl, latest));
  }

  purgeDeletedSecret(res, name) {
    const record = this.deleted.get(name);
    if (!record) {
      throw new KvError(404, "SecretNotFound", `Deleted secret not found: ${name}`);
    }
    this.deleted.delete(name);
    res.statusCode = 204;
    res.setHeader("Content-Length", "0");
    res.end();
  }

  // -------------------------------------------------------------------------
  // Internal resolution helpers
  // -------------------------------------------------------------------------
  _resolveVersion(name, version) {
    const secret = this.secrets.get(name);
    if (!secret) throw this._notFound(name);
    const id = version === undefined || version === null || version === "" ? secret.latest : version;
    const record = secret.versions.get(id);
    if (!record) {
      throw new KvError(404, "SecretNotFound", `A secret version with (name/id) ${name}/${version} was not found in this key vault.`);
    }
    return record;
  }

  _assertName(name) {
    if (!SECRET_NAME_RE.test(name)) {
      throw new KvError(
        400,
        "BadParameter",
        `The request URI contains an invalid name: '${name}'. Secret names can only contain alphanumeric characters and dashes.`,
      );
    }
  }

  _notFound(name) {
    return new KvError(
      404,
      "SecretNotFound",
      `A secret with (name/id) ${name} was not found in this key vault.`,
    );
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    const data = JSON.stringify(obj);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(data);
  }

  sendError(res, status, code, message) {
    const payload = { error: { code, message } };
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Wire-format builders
// ---------------------------------------------------------------------------
function secretId(vaultUrl, name, version) {
  return `${vaultUrl}/secrets/${name}/${version}`;
}

function attributes(record, recoveryFields) {
  const out = {
    enabled: record.enabled,
    created: record.created,
    updated: record.updated,
    recoveryLevel: RECOVERY_LEVEL,
    recoverableDays: RECOVERABLE_DAYS,
  };
  if (record.nbf !== undefined) out.nbf = record.nbf;
  if (record.exp !== undefined) out.exp = record.exp;
  if (recoveryFields) Object.assign(out, recoveryFields);
  return out;
}

function secretBundle(vaultUrl, record) {
  return prune({
    value: record.value,
    id: secretId(vaultUrl, record.name, record.version),
    contentType: record.contentType,
    attributes: attributes(record),
    tags: record.tags,
    managed: record.managed,
  });
}

function secretItem(vaultUrl, record) {
  return prune({
    id: secretId(vaultUrl, record.name, record.version),
    contentType: record.contentType,
    attributes: attributes(record),
    tags: record.tags,
    managed: record.managed,
  });
}

function deletedSecretBundle(vaultUrl, record, del) {
  const recoveryId = `${vaultUrl}/deletedsecrets/${record.name}`;
  return prune({
    value: record.value,
    id: secretId(vaultUrl, record.name, record.version),
    contentType: record.contentType,
    attributes: attributes(record),
    tags: record.tags,
    managed: record.managed,
    recoveryId,
    scheduledPurgeDate: del.scheduledPurgeDate,
    deletedDate: del.deletedDate,
  });
}

function deletedSecretItem(vaultUrl, record, del) {
  const recoveryId = `${vaultUrl}/deletedsecrets/${record.name}`;
  return prune({
    id: secretId(vaultUrl, record.name, record.version),
    contentType: record.contentType,
    attributes: attributes(record),
    tags: record.tags,
    managed: record.managed,
    recoveryId,
    scheduledPurgeDate: del.scheduledPurgeDate,
    deletedDate: del.deletedDate,
  });
}

// ---------------------------------------------------------------------------
// Pagination — Key Vault uses ?maxresults=N and an opaque nextLink URL whose
// `$skiptoken` carries the offset. The SDK follows nextLink verbatim.
// ---------------------------------------------------------------------------
const DEFAULT_MAX_RESULTS = 25;

function paginate(items, q, vaultUrl, basePath) {
  const requested = parseInt(q.get("maxresults") || "0", 10) || 0;
  const pageSize = requested > 0 ? Math.min(requested, DEFAULT_MAX_RESULTS) : DEFAULT_MAX_RESULTS;
  const skipToken = q.get("$skiptoken");
  const start = skipToken
    ? parseInt(Buffer.from(skipToken, "base64url").toString("utf8"), 10) || 0
    : 0;
  const page = items.slice(start, start + pageSize);
  const nextStart = start + pageSize;
  let nextLink = null;
  if (nextStart < items.length) {
    const token = Buffer.from(String(nextStart), "utf8").toString("base64url");
    const api = "2025-07-01";
    nextLink =
      `${vaultUrl}${basePath}?api-version=${api}` +
      `&$skiptoken=${token}&maxresults=${pageSize}`;
  }
  return { page, nextLink };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Generate a 32-hex-char version id, matching Key Vault's opaque version ids.
function newVersionId() {
  return randomBytes(16).toString("hex");
}

function numOrUndef(v) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

// Strip undefined values so JSON output omits absent optional fields, matching
// the real service's wire format.
function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function secretHash(name) {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

export default KeyvaultServer;
