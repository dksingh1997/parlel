// parlel/azurequeue — a lightweight, dependency-free fake of Azure Queue Storage.
//
// Speaks the Azure Queue Storage REST API (XML wire protocol + x-ms-* headers)
// so application code using the real `@azure/storage-queue` client can run
// against it with zero cost and zero side effects. Pure Node.js, no external
// npm dependencies. State is in-memory and ephemeral (resettable via reset() or
// POST /_parlel/reset).
//
// URL shape (path-style, like Azurite):
//   http://127.0.0.1:4593/<account>/<queue>?<comp>...
//   http://127.0.0.1:4593/<account>/<queue>/messages?...
//   http://127.0.0.1:4593/<account>/<queue>/messages/<messageid>?...
//
// Implements the surfaces of QueueServiceClient and QueueClient:
//   Service:  getProperties, setProperties, getStatistics, listQueuesSegment
//   Queue:    create, delete, getProperties, setMetadata, getAccessPolicy,
//             setAccessPolicy
//   Messages: enqueue, dequeue, peek, clear
//   MessageId: update, delete

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';
const API_VERSION = "2025-05-05";
const DEFAULT_ACCOUNT = "devstoreaccount1";

// Azure Queue defaults.
const DEFAULT_MESSAGE_TTL = 7 * 24 * 60 * 60; // 7 days, in seconds
const DEFAULT_VISIBILITY_TIMEOUT = 30; // seconds
const MAX_PEEK_OR_DEQUEUE = 32;
const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KiB encoded text

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(name, value) {
  if (value === undefined || value === null) return "";
  return `<${name}>${escapeXml(value)}</${name}>`;
}

// Queue message timestamps use RFC1123 (HTTP date) format in XML bodies.
function httpDate(d = new Date()) {
  return d.toUTCString();
}

function requestId() {
  return randomUUID();
}

// Pop receipts in real Azure are opaque base64-ish tokens. We generate random
// ones and store them so update/delete can validate them.
function makePopReceipt() {
  return Buffer.from(randomUUID() + ":" + Date.now()).toString("base64");
}

// Queue names: 3-63 chars, lowercase letters/numbers/hyphens, no leading/
// trailing hyphen, no consecutive hyphens.
function isValidQueueName(name) {
  if (typeof name !== "string") return false;
  if (name.length < 3 || name.length > 63) return false;
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.endsWith("-")) return false;
  if (name.includes("--")) return false;
  return true;
}

// Extract the single tag value from a small XML body.
function extractTag(xml, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i");
  const m = re.exec(xml);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class AzurequeueServer {
  constructor(port = 4593, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.account = options.account || DEFAULT_ACCOUNT;
    this.server = null;
    this.reset();
  }

  reset() {
    // queues: Map<queueName, Queue>
    // Queue = {
    //   name, metadata: {}, createdOn,
    //   signedIdentifiers: [{ id, accessPolicy }],
    //   messages: [Message],   // ordered FIFO
    //   counter: number,       // for stable message ordering
    // }
    // Message = {
    //   messageId, messageText (raw, base64 or text as sent),
    //   insertedOn: Date, expiresOn: Date, visibleOn: Date,
    //   popReceipt: string, dequeueCount: number,
    // }
    this.queues = new Map();
    this.serviceProperties = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, 500, "InternalError", error.message);
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
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // -------------------------------------------------------------------------
  // Addressing: /<account>/<queue>[/messages[/<messageid>]]
  // -------------------------------------------------------------------------
  resolveAddress(url) {
    const pathname = decodeURIComponent(url.pathname);
    const trimmed = pathname.replace(/^\//, "").replace(/\/$/, "");
    if (trimmed === "") return { account: null, queue: null, messages: false, messageId: null };
    const parts = trimmed.split("/");
    const account = parts[0];
    const queue = parts[1] || null;
    let messages = false;
    let messageId = null;
    if (parts[2] === "messages") {
      messages = true;
      if (parts[3] !== undefined) messageId = parts[3];
    }
    return { account, queue, messages, messageId };
  }

  // -------------------------------------------------------------------------
  // Metadata parsing from x-ms-meta-* headers
  // -------------------------------------------------------------------------
  parseMetadata(req) {
    const meta = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase().startsWith("x-ms-meta-")) {
        meta[k.slice("x-ms-meta-".length)] = Array.isArray(v) ? v.join(",") : v;
      }
    }
    return meta;
  }

  setMetadataHeaders(res, metadata) {
    for (const [k, v] of Object.entries(metadata || {})) {
      res.setHeader(`x-ms-meta-${k}`, v);
    }
  }

  // -------------------------------------------------------------------------
  // Visibility / expiry housekeeping
  // -------------------------------------------------------------------------
  pruneExpired(queue, now = Date.now()) {
    queue.messages = queue.messages.filter((m) => m.expiresOn.getTime() > now);
  }

  approximateCount(queue, now = Date.now()) {
    this.pruneExpired(queue, now);
    return queue.messages.length;
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const params = url.searchParams;

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "azurequeue", queues: this.queues.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    const { account, queue, messages, messageId } = this.resolveAddress(url);
    const body = await this.readBody(req);

    res.setHeader("x-ms-request-id", requestId());
    res.setHeader("x-ms-version", API_VERSION);
    const clientReqId = req.headers["x-ms-client-request-id"];
    if (clientReqId) res.setHeader("x-ms-client-request-id", clientReqId);
    res.setHeader("Server", "parlel-azurequeue");
    res.setHeader("Date", httpDate());

    if (!account) {
      return this.sendError(res, 400, "InvalidUri", "The requested URI does not represent any resource on the server.");
    }

    const comp = params.get("comp");

    // Service-level: /<account>/?comp=...  (no queue)
    if (!queue) {
      return this.handleService(req, res, method, comp, params, body);
    }

    // Message-id level: /<account>/<queue>/messages/<id>
    if (messages && messageId !== null) {
      return this.handleMessageId(req, res, method, queue, messageId, params, body);
    }

    // Messages level: /<account>/<queue>/messages
    if (messages) {
      return this.handleMessages(req, res, method, queue, params, body);
    }

    // Queue-level: /<account>/<queue>?comp=...
    return this.handleQueue(req, res, method, queue, comp, params, body);
  }

  // -------------------------------------------------------------------------
  // Service-level operations
  // -------------------------------------------------------------------------
  handleService(req, res, method, comp, params, body) {
    if (comp === "properties" && method === "GET") {
      return this.getServiceProperties(res);
    }
    if (comp === "properties" && method === "PUT") {
      return this.setServiceProperties(res, body);
    }
    if (comp === "stats" && method === "GET") {
      return this.getServiceStats(res);
    }
    if (comp === "userdelegationkey" && method === "POST") {
      return this.getUserDelegationKey(res, body);
    }
    if (comp === "list" && method === "GET") {
      return this.listQueues(res, params);
    }
    return this.sendError(res, 400, "InvalidQueryParameterValue", "Unsupported service operation.");
  }

  getServiceProperties(res) {
    const xml =
      `${XML_HEADER}<StorageServiceProperties>` +
      `<Logging><Version>1.0</Version><Delete>false</Delete><Read>false</Read><Write>false</Write><RetentionPolicy><Enabled>false</Enabled></RetentionPolicy></Logging>` +
      `<HourMetrics><Version>1.0</Version><Enabled>false</Enabled><RetentionPolicy><Enabled>false</Enabled></RetentionPolicy></HourMetrics>` +
      `<MinuteMetrics><Version>1.0</Version><Enabled>false</Enabled><RetentionPolicy><Enabled>false</Enabled></RetentionPolicy></MinuteMetrics>` +
      `<Cors />` +
      `</StorageServiceProperties>`;
    return this.sendXml(res, 200, xml);
  }

  setServiceProperties(res, body) {
    this.serviceProperties = body.toString("utf8");
    res.statusCode = 202;
    res.end();
  }

  getServiceStats(res) {
    const xml =
      `${XML_HEADER}<StorageServiceStats><GeoReplication>` +
      `<Status>live</Status><LastSyncTime>${httpDate()}</LastSyncTime>` +
      `</GeoReplication></StorageServiceStats>`;
    return this.sendXml(res, 200, xml);
  }

  getUserDelegationKey(res, body) {
    // AAD/token-credential only in real Azure. We return a deterministic fake
    // key so token-credential SAS flows can be exercised offline.
    const xml = body.toString("utf8");
    const start = extractTag(xml, "Start") || new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const expiry =
      extractTag(xml, "Expiry") ||
      new Date(Date.now() + 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const out =
      `${XML_HEADER}<UserDelegationKey>` +
      tag("SignedOid", "00000000-0000-0000-0000-000000000000") +
      tag("SignedTid", "00000000-0000-0000-0000-000000000000") +
      tag("SignedStart", unescapeXml(start)) +
      tag("SignedExpiry", unescapeXml(expiry)) +
      tag("SignedService", "q") +
      tag("SignedVersion", API_VERSION) +
      tag("Value", Buffer.from("parlel-fake-user-delegation-key").toString("base64")) +
      `</UserDelegationKey>`;
    return this.sendXml(res, 200, out);
  }

  listQueues(res, params) {
    const prefix = params.get("prefix") || "";
    const marker = params.get("marker") || "";
    const maxResultsRaw = params.get("maxresults");
    const maxResults = maxResultsRaw ? parseInt(maxResultsRaw, 10) : 5000;
    const include = (params.get("include") || "").split(",").map((s) => s.trim());
    const includeMetadata = include.includes("metadata");

    let names = Array.from(this.queues.keys())
      .filter((n) => n.startsWith(prefix))
      .sort();
    if (marker) names = names.filter((n) => n > marker);

    const page = names.slice(0, maxResults);
    const nextMarker = names.length > maxResults ? page[page.length - 1] : "";

    let items = "";
    for (const name of page) {
      const q = this.queues.get(name);
      let metaXml = "";
      if (includeMetadata && q.metadata && Object.keys(q.metadata).length) {
        metaXml = "<Metadata>";
        for (const [k, v] of Object.entries(q.metadata)) metaXml += tag(k, v);
        metaXml += "</Metadata>";
      }
      items += `<Queue><Name>${escapeXml(name)}</Name>${metaXml}</Queue>`;
    }

    const xml =
      `${XML_HEADER}<EnumerationResults ServiceEndpoint="http://${this.host}:${this.port}/${this.account}">` +
      tag("Prefix", prefix) +
      (marker ? tag("Marker", marker) : "") +
      (maxResultsRaw ? tag("MaxResults", maxResults) : "") +
      `<Queues>${items}</Queues>` +
      `<NextMarker>${escapeXml(nextMarker)}</NextMarker>` +
      `</EnumerationResults>`;
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // Queue-level operations
  // -------------------------------------------------------------------------
  handleQueue(req, res, method, name, comp, params, body) {
    if (!comp && method === "PUT") return this.createQueue(req, res, name);
    if (!comp && method === "DELETE") return this.deleteQueue(res, name);
    if (comp === "metadata" && method === "GET") return this.getQueueProperties(res, name);
    if (comp === "metadata" && method === "PUT") return this.setQueueMetadata(req, res, name);
    if (comp === "acl" && method === "GET") return this.getAccessPolicy(res, name);
    if (comp === "acl" && method === "PUT") return this.setAccessPolicy(res, name, body);
    return this.sendError(res, 400, "InvalidQueryParameterValue", "Unsupported queue operation.");
  }

  createQueue(req, res, name) {
    if (!isValidQueueName(name)) {
      return this.sendError(res, 400, "OutOfRangeInput", "One of the request inputs is out of range.");
    }
    const metadata = this.parseMetadata(req);
    const existing = this.queues.get(name);
    if (existing) {
      // Idempotent if metadata matches, else conflict.
      const sameMeta =
        JSON.stringify(existing.metadata) === JSON.stringify(metadata);
      if (sameMeta) {
        res.statusCode = 204; // already exists, no change
        res.end();
        return;
      }
      return this.sendError(res, 409, "QueueAlreadyExists", "The specified queue already exists.");
    }
    this.queues.set(name, {
      name,
      metadata,
      createdOn: new Date(),
      signedIdentifiers: [],
      messages: [],
      counter: 0,
    });
    res.statusCode = 201;
    res.end();
  }

  deleteQueue(res, name) {
    if (!this.queues.has(name)) {
      return this.sendError(res, 404, "QueueNotFound", "The specified queue does not exist.");
    }
    this.queues.delete(name);
    res.statusCode = 204;
    res.end();
  }

  getQueueProperties(res, name) {
    const q = this.queues.get(name);
    if (!q) {
      return this.sendError(res, 404, "QueueNotFound", "The specified queue does not exist.");
    }
    this.setMetadataHeaders(res, q.metadata);
    res.setHeader("x-ms-approximate-messages-count", String(this.approximateCount(q)));
    res.statusCode = 200;
    res.end();
  }

  setQueueMetadata(req, res, name) {
    const q = this.queues.get(name);
    if (!q) {
      return this.sendError(res, 404, "QueueNotFound", "The specified queue does not exist.");
    }
    q.metadata = this.parseMetadata(req);
    res.statusCode = 204;
    res.end();
  }

  getAccessPolicy(res, name) {
    const q = this.queues.get(name);
    if (!q) {
      return this.sendError(res, 404, "QueueNotFound", "The specified queue does not exist.");
    }
    let items = "";
    for (const si of q.signedIdentifiers) {
      const ap = si.accessPolicy || {};
      let apXml = "";
      if (ap.start || ap.expiry || ap.permission) {
        apXml =
          "<AccessPolicy>" +
          (ap.start ? tag("Start", ap.start) : "") +
          (ap.expiry ? tag("Expiry", ap.expiry) : "") +
          (ap.permission ? tag("Permission", ap.permission) : "") +
          "</AccessPolicy>";
      }
      items += `<SignedIdentifier>${tag("Id", si.id)}${apXml}</SignedIdentifier>`;
    }
    const xml = `${XML_HEADER}<SignedIdentifiers>${items}</SignedIdentifiers>`;
    return this.sendXml(res, 200, xml);
  }

  setAccessPolicy(res, name, body) {
    const q = this.queues.get(name);
    if (!q) {
      return this.sendError(res, 404, "QueueNotFound", "The specified queue does not exist.");
    }
    const xml = body.toString("utf8");
    const identifiers = [];
    const re = /<SignedIdentifier>([\s\S]*?)<\/SignedIdentifier>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const block = m[1];
      const id = extractTag(block, "Id");
      const start = extractTag(block, "Start");
      const expiry = extractTag(block, "Expiry");
      const permission = extractTag(block, "Permission");
      identifiers.push({
        id: id ? unescapeXml(id) : "",
        accessPolicy: {
          start: start ? unescapeXml(start) : undefined,
          expiry: expiry ? unescapeXml(expiry) : undefined,
          permission: permission ? unescapeXml(permission) : undefined,
        },
      });
    }
    if (identifiers.length > 5) {
      return this.sendError(res, 400, "InvalidXmlDocument", "A queue can have at most 5 stored access policies.");
    }
    q.signedIdentifiers = identifiers;
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  // Messages-level operations
  // -------------------------------------------------------------------------
  handleMessages(req, res, method, queueName, params, body) {
    const q = this.queues.get(queueName);
    if (!q) {
      return this.sendError(res, 404, "QueueNotFound", "The specified queue does not exist.");
    }
    if (method === "POST") return this.enqueue(res, q, params, body);
    if (method === "DELETE") return this.clearMessages(res, q);
    if (method === "GET") {
      const peekOnly = params.get("peekonly") === "true";
      if (peekOnly) return this.peekMessages(res, q, params);
      return this.dequeueMessages(res, q, params);
    }
    return this.sendError(res, 405, "UnsupportedHttpVerb", "The resource doesn't support the specified HTTP verb.");
  }

  enqueue(res, q, params, body) {
    const xml = body.toString("utf8");
    const rawText = extractTag(xml, "MessageText");
    const messageText = rawText === null ? "" : unescapeXml(rawText);

    if (Buffer.byteLength(messageText, "utf8") > MAX_MESSAGE_BYTES) {
      return this.sendError(
        res,
        400,
        "RequestBodyTooLarge",
        "The request body is too large and exceeds the maximum permissible limit."
      );
    }

    const ttlRaw = params.get("messagettl");
    let ttl = ttlRaw !== null ? parseInt(ttlRaw, 10) : DEFAULT_MESSAGE_TTL;
    // -1 means never expires (Azure uses a far-future date).
    const visRaw = params.get("visibilitytimeout");
    const visibilityTimeout = visRaw !== null ? parseInt(visRaw, 10) : 0;

    if (visibilityTimeout < 0 || visibilityTimeout > 7 * 24 * 60 * 60) {
      return this.sendError(res, 400, "OutOfRangeQueryParameterValue",
        "One of the query parameters specified in the request URI is outside the permissible range.",
        { QueryParameterName: "visibilitytimeout", QueryParameterValue: String(visibilityTimeout),
          MinimumAllowed: "0", MaximumAllowed: String(7 * 24 * 60 * 60) });
    }
    if (ttlRaw !== null && ttl !== -1 && (ttl < 1 || ttl > 7 * 24 * 60 * 60)) {
      return this.sendError(res, 400, "OutOfRangeQueryParameterValue",
        "One of the query parameters specified in the request URI is outside the permissible range.",
        { QueryParameterName: "messagettl", QueryParameterValue: String(ttl),
          MinimumAllowed: "1", MaximumAllowed: String(7 * 24 * 60 * 60) });
    }
    if (ttlRaw !== null && ttl !== -1 && visibilityTimeout >= ttl) {
      return this.sendError(res, 400, "OutOfRangeQueryParameterValue",
        "One of the query parameters specified in the request URI is outside the permissible range.",
        { QueryParameterName: "visibilitytimeout", QueryParameterValue: String(visibilityTimeout),
          Reason: "Visibility timeout must be less than the TTL." });
    }

    const now = new Date();
    const expiresOn =
      ttl === -1
        ? new Date("9999-12-31T23:59:59.000Z")
        : new Date(now.getTime() + ttl * 1000);
    const visibleOn = new Date(now.getTime() + visibilityTimeout * 1000);

    const message = {
      messageId: randomUUID(),
      messageText,
      insertedOn: now,
      expiresOn,
      visibleOn,
      popReceipt: makePopReceipt(),
      dequeueCount: 0,
      seq: q.counter++,
    };
    q.messages.push(message);

    const xmlOut =
      `${XML_HEADER}<QueueMessagesList><QueueMessage>` +
      tag("MessageId", message.messageId) +
      tag("InsertionTime", httpDate(message.insertedOn)) +
      tag("ExpirationTime", httpDate(message.expiresOn)) +
      tag("PopReceipt", message.popReceipt) +
      tag("TimeNextVisible", httpDate(message.visibleOn)) +
      `</QueueMessage></QueueMessagesList>`;
    return this.sendXml(res, 201, xmlOut);
  }

  dequeueMessages(res, q, params) {
    const now = Date.now();
    this.pruneExpired(q, now);

    const numRaw = params.get("numofmessages");
    let num = numRaw !== null ? parseInt(numRaw, 10) : 1;
    if (num < 1 || num > MAX_PEEK_OR_DEQUEUE) {
      return this.sendError(res, 400, "OutOfRangeQueryParameterValue",
        "One of the query parameters specified in the request URI is outside the permissible range.",
        { QueryParameterName: "numofmessages", QueryParameterValue: String(num),
          MinimumAllowed: "1", MaximumAllowed: String(MAX_PEEK_OR_DEQUEUE) });
    }
    const visRaw = params.get("visibilitytimeout");
    const visibilityTimeout = visRaw !== null ? parseInt(visRaw, 10) : DEFAULT_VISIBILITY_TIMEOUT;
    if (visibilityTimeout < 1 || visibilityTimeout > 7 * 24 * 60 * 60) {
      return this.sendError(res, 400, "OutOfRangeQueryParameterValue",
        "One of the query parameters specified in the request URI is outside the permissible range.",
        { QueryParameterName: "visibilitytimeout", QueryParameterValue: String(visibilityTimeout),
          MinimumAllowed: "1", MaximumAllowed: String(7 * 24 * 60 * 60) });
    }

    // Visible messages, in FIFO order.
    const visible = q.messages
      .filter((m) => m.visibleOn.getTime() <= now)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, num);

    let items = "";
    for (const m of visible) {
      m.dequeueCount += 1;
      m.popReceipt = makePopReceipt();
      m.visibleOn = new Date(now + visibilityTimeout * 1000);
      items +=
        "<QueueMessage>" +
        tag("MessageId", m.messageId) +
        tag("InsertionTime", httpDate(m.insertedOn)) +
        tag("ExpirationTime", httpDate(m.expiresOn)) +
        tag("PopReceipt", m.popReceipt) +
        tag("TimeNextVisible", httpDate(m.visibleOn)) +
        tag("DequeueCount", m.dequeueCount) +
        tag("MessageText", m.messageText) +
        "</QueueMessage>";
    }
    const xml = `${XML_HEADER}<QueueMessagesList>${items}</QueueMessagesList>`;
    return this.sendXml(res, 200, xml);
  }

  peekMessages(res, q, params) {
    const now = Date.now();
    this.pruneExpired(q, now);

    const numRaw = params.get("numofmessages");
    let num = numRaw !== null ? parseInt(numRaw, 10) : 1;
    if (num < 1 || num > MAX_PEEK_OR_DEQUEUE) {
      return this.sendError(res, 400, "OutOfRangeQueryParameterValue",
        "One of the query parameters specified in the request URI is outside the permissible range.",
        { QueryParameterName: "numofmessages", QueryParameterValue: String(num),
          MinimumAllowed: "1", MaximumAllowed: String(MAX_PEEK_OR_DEQUEUE) });
    }

    const visible = q.messages
      .filter((m) => m.visibleOn.getTime() <= now)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, num);

    let items = "";
    for (const m of visible) {
      items +=
        "<QueueMessage>" +
        tag("MessageId", m.messageId) +
        tag("InsertionTime", httpDate(m.insertedOn)) +
        tag("ExpirationTime", httpDate(m.expiresOn)) +
        tag("DequeueCount", m.dequeueCount) +
        tag("MessageText", m.messageText) +
        "</QueueMessage>";
    }
    const xml = `${XML_HEADER}<QueueMessagesList>${items}</QueueMessagesList>`;
    return this.sendXml(res, 200, xml);
  }

  clearMessages(res, q) {
    q.messages = [];
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  // MessageId-level operations
  // -------------------------------------------------------------------------
  handleMessageId(req, res, method, queueName, messageId, params, body) {
    const q = this.queues.get(queueName);
    if (!q) {
      return this.sendError(res, 404, "QueueNotFound", "The specified queue does not exist.");
    }
    if (method === "PUT") return this.updateMessage(res, q, messageId, params, body);
    if (method === "DELETE") return this.deleteMessage(res, q, messageId, params);
    return this.sendError(res, 405, "UnsupportedHttpVerb", "The resource doesn't support the specified HTTP verb.");
  }

  findMessage(q, messageId) {
    return q.messages.find((m) => m.messageId === messageId) || null;
  }

  updateMessage(res, q, messageId, params, body) {
    const now = Date.now();
    this.pruneExpired(q, now);

    const popReceipt = params.get("popreceipt");
    if (!popReceipt) {
      return this.sendError(res, 400, "MissingRequiredQueryParameter", "popreceipt is required.",
        { QueryParameterName: "popreceipt", QueryParameterValue: "" });
    }
    const visRaw = params.get("visibilitytimeout");
    const visibilityTimeout = visRaw !== null ? parseInt(visRaw, 10) : 0;
    if (visibilityTimeout < 0 || visibilityTimeout > 7 * 24 * 60 * 60) {
      return this.sendError(res, 400, "OutOfRangeQueryParameterValue",
        "One of the query parameters specified in the request URI is outside the permissible range.",
        { QueryParameterName: "visibilitytimeout", QueryParameterValue: String(visibilityTimeout),
          MinimumAllowed: "0", MaximumAllowed: String(7 * 24 * 60 * 60) });
    }

    const m = this.findMessage(q, messageId);
    if (!m) {
      return this.sendError(res, 404, "MessageNotFound", "The specified message does not exist.");
    }
    if (m.popReceipt !== popReceipt) {
      return this.sendError(res, 400, "PopReceiptMismatch",
        "The specified pop receipt did not match the pop receipt for a dequeued message.");
    }

    // Optional message text update.
    const xml = body.toString("utf8");
    const rawText = extractTag(xml, "MessageText");
    if (rawText !== null) {
      m.messageText = unescapeXml(rawText);
    }

    m.popReceipt = makePopReceipt();
    m.visibleOn = new Date(now + visibilityTimeout * 1000);

    res.setHeader("x-ms-popreceipt", m.popReceipt);
    res.setHeader("x-ms-time-next-visible", httpDate(m.visibleOn));
    res.statusCode = 204;
    res.end();
  }

  deleteMessage(res, q, messageId, params) {
    const now = Date.now();
    this.pruneExpired(q, now);

    const popReceipt = params.get("popreceipt");
    if (!popReceipt) {
      return this.sendError(res, 400, "MissingRequiredQueryParameter", "popreceipt is required.",
        { QueryParameterName: "popreceipt", QueryParameterValue: "" });
    }
    const m = this.findMessage(q, messageId);
    if (!m) {
      return this.sendError(res, 404, "MessageNotFound", "The specified message does not exist.");
    }
    if (m.popReceipt !== popReceipt) {
      return this.sendError(res, 400, "PopReceiptMismatch",
        "The specified pop receipt did not match the pop receipt for a dequeued message.");
    }
    q.messages = q.messages.filter((x) => x.messageId !== messageId);
    res.statusCode = 204;
    res.end();
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendXml(res, status, xml) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/xml");
    res.end(xml);
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, status, code, message, extra) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("x-ms-error-code", code);
    let extraXml = "";
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null) extraXml += tag(k, v);
      }
    }
    const xml = `${XML_HEADER}<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message>${extraXml}</Error>`;
    res.end(xml);
  }
}

export default AzurequeueServer;
