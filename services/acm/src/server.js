// parlel/acm — a lightweight, dependency-free fake of AWS Certificate Manager.
//
// Speaks the AWS JSON 1.1 wire protocol (X-Amz-Target: CertificateManager.<Op>).
// Certificates auto-issue (Status ISSUED) with DNS validation records. Pure Node.js.

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ResourceNotFoundException: 400,
  InvalidArnException: 400,
  InvalidDomainValidationOptionsException: 400,
  InvalidParameterException: 400,
  ValidationException: 400,
  LimitExceededException: 400,
  TooManyTagsException: 400,
  RequestInProgressException: 400,
  // Common AWS error: unrecognized X-Amz-Target action → HTTP 404.
  // https://docs.aws.amazon.com/acm/latest/APIReference/CommonErrors.html
  UnknownOperationException: 404,
  InternalException: 500,
};

// ARNs ACM issues/accepts look like:
//   arn:aws:acm:<region>:<account>:certificate/<uuid>
const ACM_ARN_RE = /^arn:[\w+=/,.@-]+:acm:[\w+=/,.@-]*:[0-9]+:[\w+=,.@-]+(\/[\w+=,.@-]+)*$/;

class AcmError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function epochSeconds(ms = Date.now()) {
  return Math.floor(ms / 1000);
}

export class AcmServer {
  constructor(port = 4731, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.certificates = new Map(); // arn -> cert
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new AcmError("InternalException", error.message, 500));
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

  certArn() {
    return `arn:aws:acm:${this.region}:${this.accountId}:certificate/${randomUUID()}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "acm", certificates: this.certificates.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-acm");

    if (method !== "POST") {
      return this.sendError(res, new AcmError("ValidationException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new AcmError("ValidationException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof AcmError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "RequestCertificate": return this.requestCertificate(input);
      case "ImportCertificate": return this.importCertificate(input);
      case "DescribeCertificate": return this.describeCertificate(input);
      case "ListCertificates": return this.listCertificates(input);
      case "DeleteCertificate": return this.deleteCertificate(input);
      case "GetCertificate": return this.getCertificate(input);
      case "AddTagsToCertificate": return this.addTagsToCertificate(input);
      case "RemoveTagsFromCertificate": return this.removeTagsFromCertificate(input);
      case "ListTagsForCertificate": return this.listTagsForCertificate(input);
      case "ResendValidationEmail": return this.resendValidationEmail(input);
      case "UpdateCertificateOptions": return this.updateCertificateOptions(input);
      default:
        // Real ACM returns UnknownOperationException (HTTP 404), not a 400 validation error.
        throw new AcmError("UnknownOperationException", `The action ${operation || "(none)"} is not valid.`, 404);
    }
  }

  requireCert(arn) {
    // Distinguish the three real failure modes:
    //   missing required field  → ValidationException
    //   present but malformed   → InvalidArnException
    //   well-formed but unknown → ResourceNotFoundException
    if (arn === undefined || arn === null || arn === "") {
      throw new AcmError("ValidationException", "1 validation error detected: CertificateArn is required.");
    }
    if (typeof arn !== "string" || !ACM_ARN_RE.test(arn)) {
      throw new AcmError("InvalidArnException", `The certificate ARN '${arn}' is not valid.`);
    }
    const cert = this.certificates.get(arn);
    if (!cert) throw new AcmError("ResourceNotFoundException", `Could not find certificate ${arn} in account ${this.accountId}.`);
    return cert;
  }

  validationRecord(domain) {
    const hash = createHash("sha256").update(domain).digest("hex").slice(0, 32);
    return {
      DomainName: domain,
      ValidationDomain: domain,
      ValidationStatus: "SUCCESS",
      ValidationMethod: "DNS",
      ResourceRecord: {
        Name: `_${hash}.${domain}.`,
        Type: "CNAME",
        Value: `_${hash}.acm-validations.aws.`,
      },
    };
  }

  requestCertificate(input) {
    const domain = input.DomainName;
    if (!domain) throw new AcmError("ValidationException", "DomainName is required.");
    const arn = this.certArn();
    const now = Date.now();
    const sans = [domain, ...(input.SubjectAlternativeNames || []).filter((s) => s !== domain)];
    const cert = {
      CertificateArn: arn,
      DomainName: domain,
      SubjectAlternativeNames: sans,
      Status: "ISSUED",
      Type: "AMAZON_ISSUED",
      ValidationMethod: input.ValidationMethod || "DNS",
      KeyAlgorithm: input.KeyAlgorithm || "RSA_2048",
      CreatedAt: now,
      IssuedAt: now,
      NotBefore: now,
      NotAfter: now + 395 * 24 * 60 * 60 * 1000,
      DomainValidationOptions: sans.map((d) => this.validationRecord(d)),
      InUseBy: [],
      RenewalEligibility: "INELIGIBLE",
      tags: (input.Tags || []).map((t) => ({ Key: t.Key, Value: t.Value })),
    };
    this.certificates.set(arn, cert);
    return { CertificateArn: arn };
  }

  importCertificate(input) {
    // Real API requires Certificate + PrivateKey (PEM blobs). Omitting either is a
    // ValidationException. https://docs.aws.amazon.com/acm/latest/APIReference/API_ImportCertificate.html
    if (!input.Certificate) throw new AcmError("ValidationException", "Certificate is required.");
    if (!input.PrivateKey) throw new AcmError("ValidationException", "PrivateKey is required.");

    // Re-import (replace) when a CertificateArn is supplied.
    if (input.CertificateArn) {
      const existing = this.requireCert(input.CertificateArn);
      existing.IssuedAt = Date.now();
      return { CertificateArn: existing.CertificateArn };
    }

    const arn = this.certArn();
    const now = Date.now();
    // Imported certs have no domain name from ACM's perspective; expose a placeholder
    // derived domain so DescribeCertificate stays well-formed.
    const cert = {
      CertificateArn: arn,
      DomainName: "imported.local",
      SubjectAlternativeNames: ["imported.local"],
      Status: "ISSUED",
      Type: "IMPORTED",
      ValidationMethod: null,
      KeyAlgorithm: "RSA_2048",
      CreatedAt: now,
      IssuedAt: now,
      ImportedAt: now,
      NotBefore: now,
      NotAfter: now + 395 * 24 * 60 * 60 * 1000,
      // Imported certificates are not domain-validated by ACM.
      DomainValidationOptions: [],
      InUseBy: [],
      RenewalEligibility: "INELIGIBLE",
      tags: (input.Tags || []).map((t) => ({ Key: t.Key, Value: t.Value })),
    };
    this.certificates.set(arn, cert);
    return { CertificateArn: arn };
  }

  resendValidationEmail(input) {
    // Validates required params; ACM returns an empty body on success.
    // https://docs.aws.amazon.com/acm/latest/APIReference/API_ResendValidationEmail.html
    this.requireCert(input.CertificateArn);
    if (!input.Domain) throw new AcmError("ValidationException", "Domain is required.");
    if (!input.ValidationDomain) throw new AcmError("ValidationException", "ValidationDomain is required.");
    return {};
  }

  updateCertificateOptions(input) {
    // Updates the certificate transparency logging preference; empty body on success.
    // https://docs.aws.amazon.com/acm/latest/APIReference/API_UpdateCertificateOptions.html
    const cert = this.requireCert(input.CertificateArn);
    if (!input.Options) throw new AcmError("ValidationException", "Options is required.");
    cert.Options = {
      CertificateTransparencyLoggingPreference:
        input.Options.CertificateTransparencyLoggingPreference || "ENABLED",
    };
    return {};
  }

  certView(cert) {
    const view = {
      CertificateArn: cert.CertificateArn,
      DomainName: cert.DomainName,
      SubjectAlternativeNames: cert.SubjectAlternativeNames,
      DomainValidationOptions: cert.DomainValidationOptions,
      Serial: "01:23:45:67:89:ab:cd:ef",
      Subject: `CN=${cert.DomainName}`,
      Issuer: cert.Type === "IMPORTED" ? "Imported" : "Amazon",
      CreatedAt: epochSeconds(cert.CreatedAt),
      IssuedAt: epochSeconds(cert.IssuedAt),
      NotBefore: epochSeconds(cert.NotBefore),
      NotAfter: epochSeconds(cert.NotAfter),
      Status: cert.Status,
      KeyAlgorithm: cert.KeyAlgorithm,
      SignatureAlgorithm: "SHA256WITHRSA",
      InUseBy: cert.InUseBy,
      Type: cert.Type,
      RenewalEligibility: cert.RenewalEligibility,
      KeyUsages: [{ Name: "DIGITAL_SIGNATURE" }, { Name: "KEY_ENCIPHERMENT" }],
      ExtendedKeyUsages: [{ Name: "TLS_WEB_SERVER_AUTHENTICATION", OID: "1.3.6.1.5.5.7.3.1" }],
      Options: cert.Options || { CertificateTransparencyLoggingPreference: "ENABLED" },
    };
    if (cert.ImportedAt) view.ImportedAt = epochSeconds(cert.ImportedAt);
    return view;
  }

  describeCertificate(input) {
    const cert = this.requireCert(input.CertificateArn);
    return { Certificate: this.certView(cert) };
  }

  listCertificates(input = {}) {
    let all = [...this.certificates.values()];
    if (input.CertificateStatuses && input.CertificateStatuses.length) {
      const set = new Set(input.CertificateStatuses);
      all = all.filter((c) => set.has(c.Status));
    }

    // Pagination: honor MaxItems (1-1000) + opaque NextToken (base64 offset), matching the
    // real truncation semantics. https://docs.aws.amazon.com/acm/latest/APIReference/API_ListCertificates.html
    let start = 0;
    if (input.NextToken) {
      const decoded = Number.parseInt(Buffer.from(String(input.NextToken), "base64").toString("utf8"), 10);
      if (Number.isInteger(decoded) && decoded >= 0) start = decoded;
    }
    const max = Number.isInteger(input.MaxItems) && input.MaxItems > 0 ? input.MaxItems : all.length;
    const page = all.slice(start, start + max);
    const nextStart = start + page.length;

    const out = {
      CertificateSummaryList: page.map((c) => ({
        CertificateArn: c.CertificateArn,
        DomainName: c.DomainName,
        SubjectAlternativeNameSummaries: c.SubjectAlternativeNames,
        Status: c.Status,
        Type: c.Type,
        KeyAlgorithm: c.KeyAlgorithm,
        InUse: c.InUseBy.length > 0,
        CreatedAt: epochSeconds(c.CreatedAt),
        IssuedAt: epochSeconds(c.IssuedAt),
        NotBefore: epochSeconds(c.NotBefore),
        NotAfter: epochSeconds(c.NotAfter),
      })),
    };
    if (nextStart < all.length) {
      out.NextToken = Buffer.from(String(nextStart), "utf8").toString("base64");
    }
    return out;
  }

  deleteCertificate(input) {
    this.requireCert(input.CertificateArn);
    this.certificates.delete(input.CertificateArn);
    return {};
  }

  getCertificate(input) {
    const cert = this.requireCert(input.CertificateArn);
    const pem =
      "-----BEGIN CERTIFICATE-----\n" +
      Buffer.from(`parlel-fake-certificate-for-${cert.DomainName}`).toString("base64") +
      "\n-----END CERTIFICATE-----\n";
    const chain =
      "-----BEGIN CERTIFICATE-----\n" +
      Buffer.from("parlel-fake-chain").toString("base64") +
      "\n-----END CERTIFICATE-----\n";
    return { Certificate: pem, CertificateChain: chain };
  }

  addTagsToCertificate(input) {
    const cert = this.requireCert(input.CertificateArn);
    for (const t of input.Tags || []) {
      const idx = cert.tags.findIndex((x) => x.Key === t.Key);
      if (idx >= 0) cert.tags[idx] = { Key: t.Key, Value: t.Value };
      else cert.tags.push({ Key: t.Key, Value: t.Value });
    }
    return {};
  }

  removeTagsFromCertificate(input) {
    const cert = this.requireCert(input.CertificateArn);
    const keys = new Set((input.Tags || []).map((t) => t.Key));
    cert.tags = cert.tags.filter((t) => !keys.has(t.Key));
    return {};
  }

  listTagsForCertificate(input) {
    const cert = this.requireCert(input.CertificateArn);
    return { Tags: cert.tags };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default AcmServer;
