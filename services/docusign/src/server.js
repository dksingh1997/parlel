import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/docusign — a tiny, dependency-free fake of the DocuSign eSignature
// REST API v2.1. Envelope create/get, recipients, and status updates.
// Bearer auth. State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class DocusignServer {
  constructor(port = 4814, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.envelopes = new Map(); // envelopeId -> envelope
    this.recipientCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { errorCode: "INTERNAL_ERROR", message: error.message || "error" });
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-docusign");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // restapi/v2.1/accounts/:accountId/envelopes[...]
    if (parts[0] === "restapi" && parts[1] === "v2.1" && parts[2] === "accounts") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, { errorCode: "AUTHORIZATION_INVALID_TOKEN", message: "The access token provided is expired, revoked or malformed." });
      }
      const accountId = parts[3];
      const route = parts.slice(4);
      if (route[0] === "envelopes") {
        return this.handleEnvelopes(req, res, accountId, route.slice(1), body, url);
      }
    }

    return this.send(res, 404, { errorCode: "RESOURCE_NOT_FOUND", message: "not found" });
  }

  handleEnvelopes(req, res, accountId, route, body, url) {
    // POST /envelopes  (create)
    if (route.length === 0 && req.method === "POST") {
      return this.createEnvelope(res, body);
    }
    // GET /envelopes (list)
    if (route.length === 0 && req.method === "GET") {
      return this.send(res, 200, {
        envelopes: Array.from(this.envelopes.values()).map(clone),
        resultSetSize: String(this.envelopes.size),
        totalSetSize: String(this.envelopes.size),
      });
    }

    const envelopeId = route[0];
    const envelope = this.envelopes.get(envelopeId);

    // GET /envelopes/:id
    if (route.length === 1 && req.method === "GET") {
      if (!envelope) return this.send(res, 404, { errorCode: "ENVELOPE_DOES_NOT_EXIST", message: "The envelopeId is invalid." });
      return this.send(res, 200, clone(envelope));
    }
    // PUT /envelopes/:id  (status update: void / send draft)
    if (route.length === 1 && req.method === "PUT") {
      if (!envelope) return this.send(res, 404, { errorCode: "ENVELOPE_DOES_NOT_EXIST", message: "The envelopeId is invalid." });
      if (isPlainObject(body) && typeof body.status === "string") {
        envelope.status = body.status;
        envelope.statusDateTime = new Date().toISOString();
      }
      return this.send(res, 200, {
        envelopeId,
        status: envelope.status,
        statusDateTime: envelope.statusDateTime,
      });
    }
    // GET /envelopes/:id/recipients
    if (route.length === 2 && route[1] === "recipients" && req.method === "GET") {
      if (!envelope) return this.send(res, 404, { errorCode: "ENVELOPE_DOES_NOT_EXIST", message: "The envelopeId is invalid." });
      return this.send(res, 200, clone(envelope.recipients));
    }
    // POST /envelopes/:id/recipients (add)
    if (route.length === 2 && route[1] === "recipients" && req.method === "POST") {
      if (!envelope) return this.send(res, 404, { errorCode: "ENVELOPE_DOES_NOT_EXIST", message: "The envelopeId is invalid." });
      const signers = isPlainObject(body) && Array.isArray(body.signers) ? body.signers : [];
      for (const s of signers) {
        this.recipientCounter += 1;
        envelope.recipients.signers.push(this._makeSigner(s, this.recipientCounter));
      }
      envelope.recipients.recipientCount = String(envelope.recipients.signers.length);
      return this.send(res, 201, clone(envelope.recipients));
    }

    return this.send(res, 405, { errorCode: "METHOD_NOT_ALLOWED", message: "method not allowed" });
  }

  _makeSigner(s, num) {
    return {
      recipientId: String(s.recipientId || num),
      name: s.name || "",
      email: s.email || "",
      recipientIdGuid: randomUUID(),
      status: "created",
      routingOrder: String(s.routingOrder || "1"),
      deliveryMethod: "email",
    };
  }

  createEnvelope(res, body) {
    const envelopeId = randomUUID();
    const requestedStatus = isPlainObject(body) && typeof body.status === "string" ? body.status : "sent";
    const statusDateTime = new Date().toISOString();
    const signers = [];
    if (isPlainObject(body) && isPlainObject(body.recipients) && Array.isArray(body.recipients.signers)) {
      body.recipients.signers.forEach((s, i) => {
        signers.push(this._makeSigner(s, i + 1));
      });
    }
    const envelope = {
      envelopeId,
      status: requestedStatus,
      statusDateTime,
      uri: `/envelopes/${envelopeId}`,
      emailSubject: isPlainObject(body) ? body.emailSubject || "" : "",
      sentDateTime: requestedStatus === "sent" ? statusDateTime : undefined,
      recipients: {
        signers,
        recipientCount: String(signers.length),
        carbonCopies: [],
      },
      documents: isPlainObject(body) && Array.isArray(body.documents) ? clone(body.documents) : [],
      createdDateTime: statusDateTime,
    };
    this.envelopes.set(envelopeId, envelope);
    // The create response is a summary, not the full envelope.
    return this.send(res, 201, {
      envelopeId,
      status: requestedStatus,
      statusDateTime,
      uri: `/envelopes/${envelopeId}`,
    });
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "envelopes") {
      return this.send(res, 200, {
        envelopes: Array.from(this.envelopes.values()).map(clone),
        count: this.envelopes.size,
      });
    }
    return this.send(res, 404, { errorCode: "RESOURCE_NOT_FOUND", message: "not found" });
  }

  root() {
    return { name: "docusign", version: "1.0", protocol: "docusign-esign-v2.1", documentation: "/docs/docusign.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { errorCode: "INVALID_REQUEST_BODY", message: "Malformed JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { errorCode: "INVALID_REQUEST_BODY", message: "Bad request body" });
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
