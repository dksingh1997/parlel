// parlel/ses-v2 — a lightweight, dependency-free fake of Amazon SES v2 (SESv2).
// Speaks the SESv2 REST/JSON API. Pure Node.js, no external npm deps.
// Captures sent emails in memory for test assertions.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class SesError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class SesV2Server {
  constructor(port = 4746, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.identities = new Map();
    this.suppressed = new Map();
    // sentEmails: captured for assertions
    this.sentEmails = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new SesError("InternalServiceErrorException", error.message, 500));
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "ses-v2",
        identities: this.identities.size,
        sent: this.sentEmails.length,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    // Test helper: list captured emails.
    if (path === "/_parlel/sent" && method === "GET") {
      return this.sendJson(res, 200, { sent: this.sentEmails });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-ses-v2");

    const bodyBuf = await this.readBody(req);
    let body = {};
    if (bodyBuf.length) {
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        return this.sendError(res, new SesError("BadRequestException", "Invalid JSON body."));
      }
    }

    try {
      return this.route(method, path, body, url, res);
    } catch (error) {
      if (error instanceof SesError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, body, url, res) {
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
    // /v2/email/...
    if (seg[0] !== "v2" || seg[1] !== "email") {
      throw new SesError("NotFoundException", `Unknown path ${path}`, 404);
    }
    const resource = seg[2];

    if (resource === "outbound-emails") {
      if (method === "POST") return this.sendJson(res, 200, this.sendEmail(body));
    } else if (resource === "identities") {
      if (seg.length === 3) {
        if (method === "POST") return this.sendJson(res, 200, this.createEmailIdentity(body));
        if (method === "GET") return this.sendJson(res, 200, this.listEmailIdentities());
      } else if (seg.length === 4) {
        const id = seg[3];
        if (method === "GET") return this.sendJson(res, 200, this.getEmailIdentity(id));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteEmailIdentity(id));
      }
    } else if (resource === "suppression") {
      // /v2/email/suppression/addresses[/{email}]
      if (seg[3] === "addresses") {
        if (seg.length === 4) {
          if (method === "GET") return this.sendJson(res, 200, this.listSuppressed(url));
        } else if (seg.length === 5) {
          const email = seg[4];
          if (method === "PUT") return this.sendJson(res, 200, this.putSuppressed(email, body));
          if (method === "GET") return this.sendJson(res, 200, this.getSuppressed(email));
          if (method === "DELETE") return this.sendJson(res, 200, this.deleteSuppressed(email));
        }
      }
    }
    throw new SesError("NotFoundException", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  // SendEmail
  // -------------------------------------------------------------------------
  sendEmail(body) {
    const from = body.FromEmailAddress;
    const dest = body.Destination || {};
    const content = body.Content || {};
    if (!content.Simple && !content.Raw && !content.Template) {
      throw new SesError("BadRequestException", "Content must include Simple, Raw, or Template.");
    }
    const toAddrs = dest.ToAddresses || [];
    if (!content.Raw && toAddrs.length === 0 && (!dest.CcAddresses || !dest.CcAddresses.length)) {
      throw new SesError("BadRequestException", "At least one destination address is required.");
    }
    const messageId = `${randomUUID().replace(/-/g, "")}-000000`;
    const record = {
      MessageId: messageId,
      FromEmailAddress: from,
      Destination: dest,
      Content: content,
      FromEmailAddressIdentityArn: body.FromEmailAddressIdentityArn,
      ReplyToAddresses: body.ReplyToAddresses || [],
      EmailTags: body.EmailTags || [],
      timestamp: new Date().toISOString(),
    };
    if (content.Simple) {
      record.Subject = content.Simple.Subject && content.Simple.Subject.Data;
      record.Body =
        content.Simple.Body &&
        ((content.Simple.Body.Text && content.Simple.Body.Text.Data) ||
          (content.Simple.Body.Html && content.Simple.Body.Html.Data));
    }
    if (content.Raw) {
      record.RawData = content.Raw.Data;
    }
    this.sentEmails.push(record);
    return { MessageId: messageId };
  }

  // -------------------------------------------------------------------------
  // Identities
  // -------------------------------------------------------------------------
  createEmailIdentity(body) {
    const id = body.EmailIdentity;
    if (!id) throw new SesError("BadRequestException", "EmailIdentity is required.");
    if (this.identities.has(id)) {
      throw new SesError("AlreadyExistsException", `Email identity ${id} already exists.`);
    }
    const isDomain = !id.includes("@");
    const identity = {
      EmailIdentity: id,
      IdentityType: isDomain ? "DOMAIN" : "EMAIL_ADDRESS",
      VerifiedForSendingStatus: true,
      VerificationStatus: "SUCCESS",
      Tags: body.Tags || [],
      DkimAttributes: {
        SigningEnabled: true,
        Status: "SUCCESS",
        Tokens: isDomain ? [randomUUID().slice(0, 12), randomUUID().slice(0, 12)] : [],
        SigningAttributesOrigin: "AWS_SES",
      },
    };
    this.identities.set(id, identity);
    return {
      IdentityType: identity.IdentityType,
      VerifiedForSendingStatus: true,
      DkimAttributes: identity.DkimAttributes,
    };
  }

  listEmailIdentities() {
    return {
      EmailIdentities: [...this.identities.values()].map((i) => ({
        IdentityType: i.IdentityType,
        IdentityName: i.EmailIdentity,
        SendingEnabled: i.VerifiedForSendingStatus,
        VerificationStatus: i.VerificationStatus,
      })),
    };
  }

  getEmailIdentity(id) {
    const i = this.identities.get(id);
    if (!i) throw new SesError("NotFoundException", `Email identity ${id} not found.`, 404);
    return {
      IdentityType: i.IdentityType,
      FeedbackForwardingStatus: true,
      VerifiedForSendingStatus: i.VerifiedForSendingStatus,
      VerificationStatus: i.VerificationStatus,
      DkimAttributes: i.DkimAttributes,
      Tags: i.Tags,
    };
  }

  deleteEmailIdentity(id) {
    if (!this.identities.has(id)) {
      throw new SesError("NotFoundException", `Email identity ${id} not found.`, 404);
    }
    this.identities.delete(id);
    return {};
  }

  // -------------------------------------------------------------------------
  // Suppression list
  // -------------------------------------------------------------------------
  putSuppressed(email, body) {
    this.suppressed.set(email.toLowerCase(), {
      EmailAddress: email,
      Reason: body.Reason || "BOUNCE",
      LastUpdateTime: new Date().toISOString(),
      Attributes: body.Attributes,
    });
    return {};
  }

  listSuppressed(url) {
    const reasonFilter = url.searchParams.getAll("Reason");
    let items = [...this.suppressed.values()];
    if (reasonFilter.length) items = items.filter((s) => reasonFilter.includes(s.Reason));
    return {
      SuppressedDestinationSummaries: items.map((s) => ({
        EmailAddress: s.EmailAddress,
        Reason: s.Reason,
        LastUpdateTime: s.LastUpdateTime,
      })),
    };
  }

  getSuppressed(email) {
    const s = this.suppressed.get(email.toLowerCase());
    if (!s) throw new SesError("NotFoundException", `${email} is not on the suppression list.`, 404);
    return {
      SuppressedDestination: {
        EmailAddress: s.EmailAddress,
        Reason: s.Reason,
        LastUpdateTime: s.LastUpdateTime,
        Attributes: s.Attributes,
      },
    };
  }

  deleteSuppressed(email) {
    if (!this.suppressed.has(email.toLowerCase())) {
      throw new SesError("NotFoundException", `${email} is not on the suppression list.`, 404);
    }
    this.suppressed.delete(email.toLowerCase());
    return {};
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", error.code || "BadRequestException");
    res.end(JSON.stringify({ __type: error.code, message: error.message, Message: error.message }));
  }
}

export default SesV2Server;
