import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/postmark — a tiny, dependency-free fake of the Postmark API.
//
// Speaks the wire protocol the official `postmark` Node SDK uses: JSON bodies
// with PascalCase fields (From, To, Subject, HtmlBody, TextBody) authenticated
// via the X-Postmark-Server-Token header. State is in-memory and ephemeral;
// sent mail is captured for inspection via /__parlel/* endpoints.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Postmark error envelope: { ErrorCode, Message }
function pmError(errorCode, message) {
  return { ErrorCode: errorCode, Message: message };
}

function firstRecipient(to) {
  if (typeof to !== "string") return "";
  return to.split(",")[0].trim();
}

export class PostmarkServer {
  constructor(port = 4827, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.templateCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, pmError(500, error.message || "Internal server error"));
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
      if (!this.server) {
        resolve();
        return;
      }
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
    res.setHeader("Access-Control-Allow-Headers", "X-Postmark-Server-Token, X-Postmark-Account-Token, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-postmark");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, pmError(10, "No Account or Server API tokens were supplied in the Accept request header."));
    }

    // POST /email
    if (req.method === "POST" && parts[0] === "email" && parts.length === 1) {
      return this.sendEmail(res, body);
    }
    // POST /email/batch
    if (req.method === "POST" && parts[0] === "email" && parts[1] === "batch" && parts.length === 2) {
      return this.sendBatch(res, body);
    }
    // POST /email/withTemplate
    if (req.method === "POST" && parts[0] === "email" && parts[1] === "withTemplate" && parts.length === 2) {
      return this.sendWithTemplate(res, body);
    }
    // GET /messages/outbound
    if (req.method === "GET" && parts[0] === "messages" && parts[1] === "outbound" && parts.length === 2) {
      const Messages = this.messages.map((m) => ({
        MessageID: m.MessageID,
        To: [{ Email: firstRecipient(m.body.To), Name: "" }],
        Recipients: [firstRecipient(m.body.To)],
        From: m.body.From,
        Subject: m.body.Subject ?? "",
        Status: "Sent",
        ReceivedAt: m.received_at,
      }));
      return this.send(res, 200, { TotalCount: Messages.length, Messages });
    }
    // GET /server
    if (req.method === "GET" && parts[0] === "server" && parts.length === 1) {
      return this.send(res, 200, {
        ID: 1,
        Name: "parlel-server",
        ApiTokens: ["parlel-server-token"],
        ServerLink: "https://account.postmarkapp.com/servers/1/overview",
        Color: "blue",
        DeliveryType: "Live",
        InboundAddress: "inbound@parlel",
      });
    }

    return this.send(res, 404, pmError(404, "Not Found"));
  }

  _capture(body) {
    const messageId = randomUUID();
    const record = {
      MessageID: messageId,
      received_at: now(),
      body: clone(body),
    };
    this.messages.push(record);
    return record;
  }

  _validateOne(body) {
    if (!isPlainObject(body)) {
      return pmError(300, "Invalid request body.");
    }
    if (!body.From || typeof body.From !== "string") {
      return pmError(300, "Invalid 'From' value.");
    }
    if (!body.To || typeof body.To !== "string") {
      return pmError(300, "Invalid 'To' value.");
    }
    const fromEmail = body.From.match(/<([^>]+)>/)?.[1] || body.From;
    if (!EMAIL_RE.test(fromEmail.trim())) {
      return pmError(300, "Invalid 'From' value.");
    }
    return null;
  }

  _response(record) {
    const to = firstRecipient(record.body.To);
    return {
      To: to,
      SubmittedAt: record.received_at,
      MessageID: record.MessageID,
      ErrorCode: 0,
      Message: "OK",
    };
  }

  sendEmail(res, body) {
    const error = this._validateOne(body);
    if (error) return this.send(res, 422, error);
    const record = this._capture(body);
    return this.send(res, 200, this._response(record));
  }

  sendBatch(res, body) {
    if (!Array.isArray(body)) {
      return this.send(res, 422, pmError(300, "Batch send expects an array of messages."));
    }
    const results = body.map((item) => {
      const error = this._validateOne(item);
      if (error) {
        return { ErrorCode: error.ErrorCode, Message: error.Message, To: isPlainObject(item) ? firstRecipient(item.To) : "" };
      }
      const record = this._capture(item);
      return this._response(record);
    });
    return this.send(res, 200, results);
  }

  sendWithTemplate(res, body) {
    if (!isPlainObject(body)) {
      return this.send(res, 422, pmError(300, "Invalid request body."));
    }
    if (body.TemplateId === undefined && body.TemplateAlias === undefined) {
      return this.send(res, 422, pmError(1101, "The 'TemplateId' or 'TemplateAlias' associated with this request is invalid."));
    }
    if (!body.From || !body.To) {
      return this.send(res, 422, pmError(300, "Invalid 'From' or 'To' value."));
    }
    const record = this._capture(body);
    return this.send(res, 200, this._response(record));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 2) {
      return this.send(res, 200, { messages: clone(this.messages), count: this.messages.length });
    }
    if (req.method === "GET" && parts[1] === "messages" && parts.length === 3) {
      const match = this.messages.find((m) => m.MessageID === parts[2]);
      if (!match) return this.send(res, 404, pmError(404, "message not found"));
      return this.send(res, 200, clone(match));
    }
    if (req.method === "DELETE" && parts[1] === "messages") {
      this.messages = [];
      return this.send(res, 200, { ok: true, count: 0 });
    }
    return this.send(res, 404, pmError(404, "Not Found"));
  }

  root() {
    return {
      name: "postmark",
      version: "1.0",
      protocol: "postmark-rest",
      documentation: "/docs/postmark.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const token = req.headers["x-postmark-server-token"] || req.headers["x-postmark-account-token"];
    return typeof token === "string" && token.length > 0;
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 422, pmError(300, "Invalid request body."));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 422, pmError(300, "Invalid request body."));
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
