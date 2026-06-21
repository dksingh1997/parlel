// parlel/gmail - a lightweight, dependency-free fake of the Gmail v1 REST API.
//
// Compatible with the `googleapis` Gmail client when pointed at this root URL:
//   const gmail = google.gmail({ version: "v1", auth });
//   gmail.context._options.rootUrl = "http://127.0.0.1:4610/";
//
// State is in-memory and ephemeral. Reset with server.reset() or POST /_parlel/reset.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const SYSTEM_LABELS = [
  ["INBOX", "Inbox"],
  ["SENT", "Sent"],
  ["DRAFT", "Drafts"],
  ["TRASH", "Trash"],
  ["SPAM", "Spam"],
  ["STARRED", "Starred"],
  ["UNREAD", "Unread"],
  ["IMPORTANT", "Important"],
  ["CATEGORY_PERSONAL", "Personal"],
  ["CATEGORY_SOCIAL", "Social"],
  ["CATEGORY_PROMOTIONS", "Promotions"],
  ["CATEGORY_UPDATES", "Updates"],
  ["CATEGORY_FORUMS", "Forums"],
];

function nowIso() {
  return new Date().toISOString();
}

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64url(value = "") {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64");
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseAddress(raw = "") {
  const match = String(raw).match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim();
}

function parseHeaders(raw) {
  const text = fromB64url(raw).toString("utf8");
  const [head = "", ...bodyParts] = text.split(/\r?\n\r?\n/);
  const headers = [];
  for (const line of head.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers.push({ name: line.slice(0, idx), value: line.slice(idx + 1).trim() });
  }
  return { headers, body: bodyParts.join("\n\n") };
}

function header(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function etag() {
  return `\"${randomBytes(8).toString("hex")}\"`;
}

export class GmailServer {
  constructor(port = 4610, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.userId = options.userId || "me";
    this.emailAddress = options.emailAddress || "parlel@example.com";
    this.server = null;
    this.reset();
  }

  reset() {
    this.messages = new Map();
    this.threads = new Map();
    this.drafts = new Map();
    this.labels = new Map();
    this.history = [];
    this.filters = new Map();
    this.forwardingAddresses = new Map();
    this.delegates = new Map();
    this.sendAs = new Map();
    this.smimeInfo = new Map();
    this.cseIdentities = new Map();
    this.cseKeyPairs = new Map();
    this.watchConfig = null;
    this.settings = {
      autoForwarding: { enabled: false, disposition: "leaveInInbox" },
      imap: { enabled: false, expungeBehavior: "archive", autoExpunge: true },
      language: { displayLanguage: "en" },
      pop: { accessWindow: "disabled", disposition: "leaveInInbox" },
      vacation: { enableAutoReply: false, responseSubject: "", responseBodyPlainText: "" },
    };
    for (const [labelId, name] of SYSTEM_LABELS) {
      this.labels.set(labelId, {
        id: labelId,
        name,
        type: "system",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
        messagesTotal: 0,
        messagesUnread: 0,
        threadsTotal: 0,
        threadsUnread: 0,
      });
    }
    this.sendAs.set(this.emailAddress, {
      sendAsEmail: this.emailAddress,
      displayName: "parlel",
      replyToAddress: this.emailAddress,
      signature: "",
      isPrimary: true,
      isDefault: true,
      verificationStatus: "accepted",
    });
    this.historyId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, error.status || 500, error.reason || "backendError", error.message || "Internal error");
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = url.pathname;
    const q = url.searchParams;

    res.setHeader("x-gmail-emulator", "parlel");

    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "gmail", messages: this.messages.size });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    const bodyBuffer = await this.readBody(req);
    const json = this.parseJson(bodyBuffer);
    const path = pathname.startsWith("/upload/gmail/v1/")
      ? pathname.slice("/upload/gmail/v1/".length)
      : pathname.startsWith("/gmail/v1/")
        ? pathname.slice("/gmail/v1/".length)
        : null;

    if (path === null) return this.sendError(res, 404, "notFound", "Not Found");
    const parts = splitPath(path);
    if (parts[0] !== "users" || !parts[1]) return this.sendError(res, 404, "notFound", "Not Found");
    if (!this.validUser(parts[1])) return this.sendError(res, 404, "notFound", "User not found");

    return this.routeUser(res, method, parts.slice(2), q, json, bodyBuffer);
  }

  routeUser(res, method, parts, q, body, bodyBuffer) {
    if (parts.length === 1 && parts[0] === "profile" && method === "GET") return this.getProfile(res);
    if (parts.length === 1 && parts[0] === "stop" && method === "POST") return this.stopWatch(res);
    if (parts.length === 1 && parts[0] === "watch" && method === "POST") return this.watch(res, body);
    if (parts[0] === "messages") return this.routeMessages(res, method, parts.slice(1), q, body, bodyBuffer);
    if (parts[0] === "drafts") return this.routeDrafts(res, method, parts.slice(1), q, body, bodyBuffer);
    if (parts[0] === "threads") return this.routeThreads(res, method, parts.slice(1), q, body);
    if (parts[0] === "labels") return this.routeLabels(res, method, parts.slice(1), body);
    if (parts[0] === "history") return this.routeHistory(res, method, parts.slice(1), q);
    if (parts[0] === "settings") return this.routeSettings(res, method, parts.slice(1), body);
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeMessages(res, method, parts, q, body, bodyBuffer) {
    if (parts.length === 0) {
      if (method === "GET") return this.listMessages(res, q);
      return this.methodNotAllowed(res);
    }
    if (parts.length === 1) {
      if (parts[0] === "send" && method === "POST") return this.sendMessage(res, body, bodyBuffer);
      if (parts[0] === "import" && method === "POST") return this.importMessage(res, body, q, bodyBuffer);
      if (parts[0] === "insert" && method === "POST") return this.insertMessage(res, body, q, bodyBuffer);
      if (parts[0] === "batchDelete" && method === "POST") return this.batchDeleteMessages(res, body);
      if (parts[0] === "batchModify" && method === "POST") return this.batchModifyMessages(res, body);
      if (method === "GET") return this.getMessage(res, parts[0], q);
      if (method === "DELETE") return this.deleteMessage(res, parts[0]);
      return this.methodNotAllowed(res);
    }
    const messageId = parts[0];
    if (parts.length === 2) {
      if (parts[1] === "modify" && method === "POST") return this.modifyMessage(res, messageId, body);
      if (parts[1] === "trash" && method === "POST") return this.trashMessage(res, messageId);
      if (parts[1] === "untrash" && method === "POST") return this.untrashMessage(res, messageId);
    }
    if (parts.length === 3 && parts[1] === "attachments" && method === "GET") {
      return this.getAttachment(res, messageId, parts[2]);
    }
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeDrafts(res, method, parts, q, body, bodyBuffer) {
    if (parts.length === 0) {
      if (method === "GET") return this.listDrafts(res, q);
      if (method === "POST") return this.createDraft(res, body, bodyBuffer);
      return this.methodNotAllowed(res);
    }
    if (parts.length === 1) {
      if (parts[0] === "send" && method === "POST") return this.sendDraft(res, body, bodyBuffer);
      if (method === "GET") return this.getDraft(res, parts[0], q);
      if (method === "DELETE") return this.deleteDraft(res, parts[0]);
      if (method === "PUT") return this.updateDraft(res, parts[0], body, bodyBuffer);
      return this.methodNotAllowed(res);
    }
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeThreads(res, method, parts, q, body) {
    if (parts.length === 0) {
      if (method === "GET") return this.listThreads(res, q);
      return this.methodNotAllowed(res);
    }
    if (parts.length === 1) {
      if (method === "GET") return this.getThread(res, parts[0], q);
      if (method === "DELETE") return this.deleteThread(res, parts[0]);
      return this.methodNotAllowed(res);
    }
    if (parts.length === 2) {
      if (parts[1] === "modify" && method === "POST") return this.modifyThread(res, parts[0], body);
      if (parts[1] === "trash" && method === "POST") return this.trashThread(res, parts[0]);
      if (parts[1] === "untrash" && method === "POST") return this.untrashThread(res, parts[0]);
    }
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeLabels(res, method, parts, body) {
    if (parts.length === 0) {
      if (method === "GET") return this.listLabels(res);
      if (method === "POST") return this.createLabel(res, body);
      return this.methodNotAllowed(res);
    }
    if (parts.length === 1) {
      if (method === "GET") return this.getLabel(res, parts[0]);
      if (method === "DELETE") return this.deleteLabel(res, parts[0]);
      if (method === "PATCH") return this.patchLabel(res, parts[0], body);
      if (method === "PUT") return this.updateLabel(res, parts[0], body);
      return this.methodNotAllowed(res);
    }
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeHistory(res, method, parts, q) {
    if (parts.length === 0 && method === "GET") return this.listHistory(res, q);
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeSettings(res, method, parts, body) {
    const simple = {
      autoForwarding: "autoForwarding",
      imap: "imap",
      language: "language",
      pop: "pop",
      vacation: "vacation",
    };
    if (parts.length === 1 && simple[parts[0]]) {
      if (method === "GET") return this.sendJson(res, 200, clone(this.settings[simple[parts[0]]]));
      if (method === "PUT") {
        this.settings[simple[parts[0]]] = { ...this.settings[simple[parts[0]]], ...body };
        return this.sendJson(res, 200, clone(this.settings[simple[parts[0]]]));
      }
      return this.methodNotAllowed(res);
    }
    if (parts[0] === "filters") return this.routeCollection(res, method, parts.slice(1), body, this.filters, "filter", this.normalizeFilter.bind(this));
    if (parts[0] === "forwardingAddresses") return this.routeCollection(res, method, parts.slice(1), body, this.forwardingAddresses, "forwardingAddress", this.normalizeForwarding.bind(this));
    if (parts[0] === "delegates") return this.routeCollection(res, method, parts.slice(1), body, this.delegates, "delegate", this.normalizeDelegate.bind(this));
    if (parts[0] === "sendAs") return this.routeSendAs(res, method, parts.slice(1), body);
    if (parts[0] === "cse") return this.routeCse(res, method, parts.slice(1), body);
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeCollection(res, method, parts, body, map, listKey, normalizer) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, { [listKey]: Array.from(map.values()).map(clone) });
      if (method === "POST") {
        const item = normalizer(body);
        map.set(item.id || item.forwardingEmail || item.delegateEmail, item);
        return this.sendJson(res, 200, clone(item));
      }
      return this.methodNotAllowed(res);
    }
    const key = parts[0];
    const item = map.get(key);
    if (method === "GET") {
      if (!item) return this.sendError(res, 404, "notFound", `${listKey} not found`);
      return this.sendJson(res, 200, clone(item));
    }
    if (method === "DELETE") {
      if (!item) return this.sendError(res, 404, "notFound", `${listKey} not found`);
      map.delete(key);
      return this.sendJson(res, 204, null);
    }
    return this.methodNotAllowed(res);
  }

  routeSendAs(res, method, parts, body) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, { sendAs: Array.from(this.sendAs.values()).map(clone) });
      if (method === "POST") {
        const item = this.normalizeSendAs(body);
        this.sendAs.set(item.sendAsEmail, item);
        return this.sendJson(res, 200, clone(item));
      }
      return this.methodNotAllowed(res);
    }
    const email = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.getMapItem(res, this.sendAs, email, "sendAs not found");
      if (method === "DELETE") return this.deleteMapItem(res, this.sendAs, email, "sendAs not found");
      if (method === "PATCH" || method === "PUT") {
        const existing = this.sendAs.get(email);
        if (!existing) return this.sendError(res, 404, "notFound", "sendAs not found");
        const updated = { ...(method === "PATCH" ? existing : { sendAsEmail: email }), ...body, sendAsEmail: email };
        this.sendAs.set(email, updated);
        return this.sendJson(res, 200, clone(updated));
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 2 && parts[1] === "verify" && method === "POST") {
      const item = this.sendAs.get(email);
      if (!item) return this.sendError(res, 404, "notFound", "sendAs not found");
      item.verificationStatus = "accepted";
      return this.sendJson(res, 200, {});
    }
    if (parts[1] === "smimeInfo") return this.routeSmime(res, method, email, parts.slice(2), body);
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeSmime(res, method, email, parts, body) {
    if (!this.sendAs.has(email)) return this.sendError(res, 404, "notFound", "sendAs not found");
    if (!this.smimeInfo.has(email)) this.smimeInfo.set(email, new Map());
    const map = this.smimeInfo.get(email);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, { smimeInfo: Array.from(map.values()).map(clone) });
      if (method === "POST") {
        const item = { id: id("smime"), encryptedKeyPassword: body.encryptedKeyPassword || "", pem: body.pem || "", isDefault: false };
        map.set(item.id, item);
        return this.sendJson(res, 200, clone(item));
      }
      return this.methodNotAllowed(res);
    }
    const item = map.get(parts[0]);
    if (parts.length === 1) {
      if (method === "GET") {
        if (!item) return this.sendError(res, 404, "notFound", "smimeInfo not found");
        return this.sendJson(res, 200, clone(item));
      }
      if (method === "DELETE") {
        if (!item) return this.sendError(res, 404, "notFound", "smimeInfo not found");
        map.delete(parts[0]);
        return this.sendJson(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    if (parts.length === 2 && parts[1] === "setDefault" && method === "POST") {
      if (!item) return this.sendError(res, 404, "notFound", "smimeInfo not found");
      for (const entry of map.values()) entry.isDefault = false;
      item.isDefault = true;
      return this.sendJson(res, 200, {});
    }
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeCse(res, method, parts, body) {
    if (parts[0] === "identities") return this.routeCseMap(res, method, parts.slice(1), body, this.cseIdentities, "cseIdentity", "emailAddress");
    if (parts[0] === "keypairs") {
      if (parts.length === 1) return this.routeCseMap(res, method, [], body, this.cseKeyPairs, "cseKeyPairs", "keyPairId", { patch: false, delete: false });
      const keyId = parts[1];
      if (parts.length === 2) return this.routeCseMap(res, method, [keyId], body, this.cseKeyPairs, "cseKeyPairs", "keyPairId", { patch: false, delete: false });
      const item = this.cseKeyPairs.get(keyId);
      if (!item) return this.sendError(res, 404, "notFound", "cseKeyPair not found");
      if (["disable", "enable", "obliterate"].includes(parts[2]) && method === "POST") {
        if (parts[2] === "obliterate") this.cseKeyPairs.delete(keyId);
        else item.state = parts[2] === "enable" ? "enabled" : "disabled";
        return this.sendJson(res, 200, parts[2] === "obliterate" ? {} : clone(item));
      }
    }
    return this.sendError(res, 404, "notFound", "Not Found");
  }

  routeCseMap(res, method, parts, body, map, listKey, idField, allowed = { patch: true, delete: true }) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, { [listKey]: Array.from(map.values()).map(clone) });
      if (method === "POST") {
        const item = { ...body };
        item[idField] = item[idField] || (idField === "emailAddress" ? item.primaryEmailAddress || this.emailAddress : id("cseKeyPair"));
        if (idField === "keyPairId") item.state = item.state || "enabled";
        map.set(item[idField], item);
        return this.sendJson(res, 200, clone(item));
      }
      return this.methodNotAllowed(res);
    }
    const item = map.get(parts[0]);
    if (method === "GET") {
      if (!item) return this.sendError(res, 404, "notFound", `${listKey} not found`);
      return this.sendJson(res, 200, clone(item));
    }
    if (method === "DELETE" && allowed.delete) {
      if (!item) return this.sendError(res, 404, "notFound", `${listKey} not found`);
      map.delete(parts[0]);
      return this.sendJson(res, 204, null);
    }
    if (method === "PATCH" && allowed.patch) {
      if (!item) return this.sendError(res, 404, "notFound", `${listKey} not found`);
      Object.assign(item, body, { [idField]: parts[0] });
      return this.sendJson(res, 200, clone(item));
    }
    return this.methodNotAllowed(res);
  }

  getProfile(res) {
    return this.sendJson(res, 200, {
      emailAddress: this.emailAddress,
      messagesTotal: this.messages.size,
      threadsTotal: this.threads.size,
      historyId: String(this.historyId),
    });
  }

  stopWatch(res) {
    this.watchConfig = null;
    return this.sendJson(res, 200, {});
  }

  watch(res, body) {
    if (!body.topicName) return this.sendError(res, 400, "invalidArgument", "topicName is required");
    this.watchConfig = { ...body };
    return this.sendJson(res, 200, { historyId: String(this.historyId), expiration: String(Date.now() + 604800000) });
  }

  listMessages(res, q) {
    let messages = Array.from(this.messages.values()).filter((m) => !m.deleted);
    const labels = q.getAll("labelIds").length ? q.getAll("labelIds") : q.get("labelIds")?.split(",").filter(Boolean) || [];
    if (labels.length) messages = messages.filter((m) => labels.every((label) => m.labelIds.includes(label)));
    const query = q.get("q");
    if (query) messages = messages.filter((m) => this.matchesQuery(m, query));
    return this.sendPaged(res, q, "messages", messages.map((m) => ({ id: m.id, threadId: m.threadId })), { resultSizeEstimate: messages.length });
  }

  getMessage(res, messageId, q) {
    const message = this.messages.get(messageId);
    if (!message || message.deleted) return this.sendError(res, 404, "notFound", "Message not found");
    return this.sendJson(res, 200, this.formatMessage(message, q.get("format") || "full", q.getAll("metadataHeaders")));
  }

  sendMessage(res, body, bodyBuffer) {
    const message = this.makeMessage(body, bodyBuffer, ["SENT"], body.threadId);
    this.storeMessage(message, "messageSent");
    return this.sendJson(res, 200, this.formatMessage(message, "full"));
  }

  importMessage(res, body, _q, bodyBuffer) {
    const message = this.makeMessage(body, bodyBuffer, body.labelIds || ["INBOX"], body.threadId);
    this.storeMessage(message, "messageAdded");
    return this.sendJson(res, 200, this.formatMessage(message, "full"));
  }

  insertMessage(res, body, _q, bodyBuffer) {
    const message = this.makeMessage(body, bodyBuffer, body.labelIds || ["INBOX"], body.threadId);
    this.storeMessage(message, "messageAdded");
    return this.sendJson(res, 200, this.formatMessage(message, "full"));
  }

  modifyMessage(res, messageId, body) {
    const message = this.messages.get(messageId);
    if (!message || message.deleted) return this.sendError(res, 404, "notFound", "Message not found");
    this.applyLabels(message, body.addLabelIds || [], body.removeLabelIds || []);
    this.addHistory("labelModified", message);
    return this.sendJson(res, 200, this.formatMessage(message, "full"));
  }

  trashMessage(res, messageId) {
    const message = this.messages.get(messageId);
    if (!message || message.deleted) return this.sendError(res, 404, "notFound", "Message not found");
    this.applyLabels(message, ["TRASH"], ["INBOX"]);
    this.addHistory("messageTrashed", message);
    return this.sendJson(res, 200, this.formatMessage(message, "full"));
  }

  untrashMessage(res, messageId) {
    const message = this.messages.get(messageId);
    if (!message || message.deleted) return this.sendError(res, 404, "notFound", "Message not found");
    this.applyLabels(message, ["INBOX"], ["TRASH"]);
    this.addHistory("messageUntrashed", message);
    return this.sendJson(res, 200, this.formatMessage(message, "full"));
  }

  deleteMessage(res, messageId) {
    const message = this.messages.get(messageId);
    if (!message || message.deleted) return this.sendError(res, 404, "notFound", "Message not found");
    message.deleted = true;
    this.addHistory("messageDeleted", message);
    return this.sendJson(res, 204, null);
  }

  batchDeleteMessages(res, body) {
    for (const messageId of body.ids || []) {
      const message = this.messages.get(messageId);
      if (message) {
        message.deleted = true;
        this.addHistory("messageDeleted", message);
      }
    }
    return this.sendJson(res, 204, null);
  }

  batchModifyMessages(res, body) {
    for (const messageId of body.ids || []) {
      const message = this.messages.get(messageId);
      if (message && !message.deleted) this.applyLabels(message, body.addLabelIds || [], body.removeLabelIds || []);
    }
    return this.sendJson(res, 204, null);
  }

  getAttachment(res, messageId, attachmentId) {
    const message = this.messages.get(messageId);
    if (!message || message.deleted) return this.sendError(res, 404, "notFound", "Message not found");
    const attachment = message.attachments.get(attachmentId);
    if (!attachment) return this.sendError(res, 404, "notFound", "Attachment not found");
    return this.sendJson(res, 200, { attachmentId, size: attachment.size, data: attachment.data });
  }

  createDraft(res, body, bodyBuffer) {
    const message = this.makeMessage(body.message || body, bodyBuffer, ["DRAFT"], body.message?.threadId || body.threadId);
    const draft = { id: id("draft"), message: this.formatMessage(message, "full") };
    this.messages.set(message.id, message);
    this.drafts.set(draft.id, draft);
    this.addToThread(message);
    return this.sendJson(res, 200, clone(draft));
  }

  listDrafts(res, q) {
    return this.sendPaged(res, q, "drafts", Array.from(this.drafts.values()).map(clone), { resultSizeEstimate: this.drafts.size });
  }

  getDraft(res, draftId, q) {
    const draft = this.drafts.get(draftId);
    if (!draft) return this.sendError(res, 404, "notFound", "Draft not found");
    const message = this.messages.get(draft.message.id);
    return this.sendJson(res, 200, { id: draft.id, message: this.formatMessage(message, q.get("format") || "full") });
  }

  updateDraft(res, draftId, body, bodyBuffer) {
    const draft = this.drafts.get(draftId);
    if (!draft) return this.sendError(res, 404, "notFound", "Draft not found");
    const oldMessage = this.messages.get(draft.message.id);
    if (oldMessage) oldMessage.deleted = true;
    const message = this.makeMessage(body.message || body, bodyBuffer, ["DRAFT"], body.message?.threadId || body.threadId);
    this.messages.set(message.id, message);
    this.addToThread(message);
    draft.message = this.formatMessage(message, "full");
    return this.sendJson(res, 200, clone(draft));
  }

  sendDraft(res, body, bodyBuffer) {
    const draftId = body.id;
    const draft = draftId ? this.drafts.get(draftId) : null;
    if (draftId && !draft) return this.sendError(res, 404, "notFound", "Draft not found");
    const message = draft ? this.messages.get(draft.message.id) : this.makeMessage(body.message || body, bodyBuffer, ["DRAFT"], body.message?.threadId || body.threadId);
    if (!message) return this.sendError(res, 404, "notFound", "Draft message not found");
    this.applyLabels(message, ["SENT"], ["DRAFT"]);
    if (draft) this.drafts.delete(draft.id);
    this.addHistory("messageSent", message);
    return this.sendJson(res, 200, this.formatMessage(message, "full"));
  }

  deleteDraft(res, draftId) {
    const draft = this.drafts.get(draftId);
    if (!draft) return this.sendError(res, 404, "notFound", "Draft not found");
    this.drafts.delete(draftId);
    const message = this.messages.get(draft.message.id);
    if (message) message.deleted = true;
    return this.sendJson(res, 204, null);
  }

  listThreads(res, q) {
    const threads = Array.from(this.threads.values()).filter((thread) => thread.messages.some((id) => !this.messages.get(id)?.deleted));
    return this.sendPaged(res, q, "threads", threads.map((t) => ({ id: t.id, snippet: t.snippet, historyId: t.historyId })), { resultSizeEstimate: threads.length });
  }

  getThread(res, threadId, q) {
    const thread = this.threads.get(threadId);
    if (!thread) return this.sendError(res, 404, "notFound", "Thread not found");
    const messages = thread.messages.map((messageId) => this.messages.get(messageId)).filter((m) => m && !m.deleted);
    if (!messages.length) return this.sendError(res, 404, "notFound", "Thread not found");
    return this.sendJson(res, 200, {
      id: thread.id,
      snippet: thread.snippet,
      historyId: thread.historyId,
      messages: messages.map((m) => this.formatMessage(m, q.get("format") || "full")),
    });
  }

  modifyThread(res, threadId, body) {
    const thread = this.threads.get(threadId);
    if (!thread) return this.sendError(res, 404, "notFound", "Thread not found");
    for (const messageId of thread.messages) {
      const message = this.messages.get(messageId);
      if (message && !message.deleted) this.applyLabels(message, body.addLabelIds || [], body.removeLabelIds || []);
    }
    return this.getThread(res, threadId, new URLSearchParams());
  }

  trashThread(res, threadId) {
    return this.modifyThread(res, threadId, { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
  }

  untrashThread(res, threadId) {
    return this.modifyThread(res, threadId, { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH"] });
  }

  deleteThread(res, threadId) {
    const thread = this.threads.get(threadId);
    if (!thread) return this.sendError(res, 404, "notFound", "Thread not found");
    for (const messageId of thread.messages) {
      const message = this.messages.get(messageId);
      if (message) message.deleted = true;
    }
    return this.sendJson(res, 204, null);
  }

  listLabels(res) {
    return this.sendJson(res, 200, { labels: Array.from(this.labels.values()).map(clone) });
  }

  createLabel(res, body) {
    if (!body.name) return this.sendError(res, 400, "invalidArgument", "Label name is required");
    for (const existing of this.labels.values()) {
      if (existing.name === body.name) return this.sendError(res, 409, "duplicate", "Label name exists or conflicts");
    }
    const label = {
      id: id("Label"),
      name: body.name,
      type: "user",
      messageListVisibility: body.messageListVisibility || "show",
      labelListVisibility: body.labelListVisibility || "labelShow",
      messagesTotal: 0,
      messagesUnread: 0,
      threadsTotal: 0,
      threadsUnread: 0,
    };
    this.labels.set(label.id, label);
    return this.sendJson(res, 200, clone(label));
  }

  getLabel(res, labelId) {
    const label = this.labels.get(labelId);
    if (!label) return this.sendError(res, 404, "notFound", "Label not found");
    return this.sendJson(res, 200, clone(label));
  }

  patchLabel(res, labelId, body) {
    const label = this.labels.get(labelId);
    if (!label) return this.sendError(res, 404, "notFound", "Label not found");
    if (label.type === "system" && body.name && body.name !== label.name) return this.sendError(res, 400, "invalidArgument", "Cannot rename system label");
    Object.assign(label, body, { id: labelId, type: label.type });
    return this.sendJson(res, 200, clone(label));
  }

  updateLabel(res, labelId, body) {
    const label = this.labels.get(labelId);
    if (!label) return this.sendError(res, 404, "notFound", "Label not found");
    if (label.type === "system" && body.name && body.name !== label.name) return this.sendError(res, 400, "invalidArgument", "Cannot rename system label");
    const updated = { ...label, ...body, id: labelId, type: label.type };
    this.labels.set(labelId, updated);
    return this.sendJson(res, 200, clone(updated));
  }

  deleteLabel(res, labelId) {
    const label = this.labels.get(labelId);
    if (!label) return this.sendError(res, 404, "notFound", "Label not found");
    if (label.type === "system") return this.sendError(res, 400, "invalidArgument", "Cannot delete system label");
    this.labels.delete(labelId);
    for (const message of this.messages.values()) message.labelIds = message.labelIds.filter((idValue) => idValue !== labelId);
    return this.sendJson(res, 204, null);
  }

  listHistory(res, q) {
    const startParam = q.get("startHistoryId");
    if (startParam === null || startParam === "") return this.sendError(res, 400, "invalidArgument", "startHistoryId is required");
    const start = Number(startParam);
    if (Number.isNaN(start)) return this.sendError(res, 400, "invalidArgument", "Invalid startHistoryId");
    const history = this.history.filter((entry) => Number(entry.id) >= start);
    return this.sendPaged(res, q, "history", history.map(clone), { historyId: String(this.historyId) });
  }

  makeMessage(body, bodyBuffer, defaultLabels, threadId) {
    const raw = body.raw || (body.message && body.message.raw) || (bodyBuffer.length ? b64url(bodyBuffer) : b64url("Subject: parlel\r\n\r\n"));
    const parsed = parseHeaders(raw);
    const messageId = id("msg");
    const resolvedThreadId = threadId || body.threadId || id("thread");
    const snippet = parsed.body.slice(0, 120) || header(parsed.headers, "Subject") || "";
    const payload = this.buildPayload(parsed.headers, parsed.body, raw);
    return {
      id: messageId,
      threadId: resolvedThreadId,
      labelIds: Array.from(new Set(defaultLabels || body.labelIds || [])),
      snippet,
      historyId: String(++this.historyId),
      internalDate: String(Date.now()),
      sizeEstimate: fromB64url(raw).length,
      raw,
      payload,
      attachments: this.collectAttachments(payload),
      deleted: false,
    };
  }

  buildPayload(headers, bodyText, raw) {
    const attachmentId = id("att");
    return {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers,
      body: { size: Buffer.byteLength(bodyText), data: b64url(bodyText) },
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/plain" }],
          body: { size: Buffer.byteLength(bodyText), data: b64url(bodyText) },
        },
        {
          partId: "1",
          mimeType: "application/octet-stream",
          filename: "raw.eml",
          headers: [{ name: "Content-Type", value: "application/octet-stream" }],
          body: { attachmentId, size: fromB64url(raw).length },
        },
      ],
    };
  }

  collectAttachments(payload) {
    const map = new Map();
    const visit = (part) => {
      if (part.body?.attachmentId) map.set(part.body.attachmentId, { size: part.body.size || 0, data: b64url(`attachment:${part.body.attachmentId}`) });
      for (const child of part.parts || []) visit(child);
    };
    visit(payload);
    return map;
  }

  storeMessage(message, historyType) {
    this.messages.set(message.id, message);
    this.addToThread(message);
    this.addHistory(historyType, message);
  }

  addToThread(message) {
    const thread = this.threads.get(message.threadId) || { id: message.threadId, historyId: message.historyId, snippet: message.snippet, messages: [] };
    if (!thread.messages.includes(message.id)) thread.messages.push(message.id);
    thread.historyId = message.historyId;
    thread.snippet = thread.snippet || message.snippet;
    this.threads.set(message.threadId, thread);
  }

  addHistory(type, message) {
    const entry = { id: String(this.historyId), messages: [{ id: message.id, threadId: message.threadId }] };
    if (type === "messageDeleted") entry.messagesDeleted = [{ message: { id: message.id, threadId: message.threadId, labelIds: message.labelIds } }];
    else if (type === "labelModified") entry.labelsAdded = [{ message: this.formatMessage(message, "minimal"), labelIds: message.labelIds }];
    else entry.messagesAdded = [{ message: this.formatMessage(message, "minimal") }];
    this.history.push(entry);
  }

  applyLabels(message, add, remove) {
    const labels = new Set(message.labelIds || []);
    for (const labelId of add) labels.add(labelId);
    for (const labelId of remove) labels.delete(labelId);
    message.labelIds = Array.from(labels);
    message.historyId = String(++this.historyId);
  }

  formatMessage(message, format, metadataHeaders = []) {
    const base = {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds,
      snippet: message.snippet,
      historyId: message.historyId,
      internalDate: message.internalDate,
      sizeEstimate: message.sizeEstimate,
    };
    if (format === "minimal") return base;
    if (format === "raw") return { ...base, raw: message.raw };
    if (format === "metadata") {
      const wanted = new Set(metadataHeaders.map((h) => h.toLowerCase()));
      const headers = wanted.size ? message.payload.headers.filter((h) => wanted.has(h.name.toLowerCase())) : message.payload.headers;
      return { ...base, payload: { ...message.payload, headers, body: undefined, parts: undefined } };
    }
    return { ...base, payload: clone(message.payload) };
  }

  matchesQuery(message, query) {
    const text = `${message.snippet} ${message.payload.headers.map((h) => `${h.name}:${h.value}`).join(" ")}`.toLowerCase();
    const q = query.toLowerCase();
    if (q.startsWith("from:")) return header(message.payload.headers, "From").toLowerCase().includes(q.slice(5));
    if (q.startsWith("to:")) return header(message.payload.headers, "To").toLowerCase().includes(q.slice(3));
    if (q.startsWith("subject:")) return header(message.payload.headers, "Subject").toLowerCase().includes(q.slice(8));
    return text.includes(q);
  }

  normalizeFilter(body) {
    return { id: body.id || id("filter"), criteria: body.criteria || {}, action: body.action || {} };
  }

  normalizeForwarding(body) {
    const forwardingEmail = body.forwardingEmail || body.emailAddress;
    if (!forwardingEmail) throw Object.assign(new Error("forwardingEmail is required"), { status: 400, reason: "invalidArgument" });
    return { forwardingEmail, verificationStatus: body.verificationStatus || "accepted" };
  }

  normalizeDelegate(body) {
    const delegateEmail = body.delegateEmail || body.emailAddress;
    if (!delegateEmail) throw Object.assign(new Error("delegateEmail is required"), { status: 400, reason: "invalidArgument" });
    return { delegateEmail, verificationStatus: body.verificationStatus || "accepted" };
  }

  normalizeSendAs(body) {
    const sendAsEmail = body.sendAsEmail || parseAddress(body.email || "");
    if (!sendAsEmail) throw Object.assign(new Error("sendAsEmail is required"), { status: 400, reason: "invalidArgument" });
    return {
      sendAsEmail,
      displayName: body.displayName || "",
      replyToAddress: body.replyToAddress || sendAsEmail,
      signature: body.signature || "",
      isPrimary: false,
      isDefault: Boolean(body.isDefault),
      verificationStatus: body.verificationStatus || "accepted",
    };
  }

  getMapItem(res, map, key, message) {
    const item = map.get(key);
    if (!item) return this.sendError(res, 404, "notFound", message);
    return this.sendJson(res, 200, clone(item));
  }

  deleteMapItem(res, map, key, message) {
    if (!map.has(key)) return this.sendError(res, 404, "notFound", message);
    map.delete(key);
    return this.sendJson(res, 204, null);
  }

  sendPaged(res, q, key, items, extra = {}) {
    const max = Math.max(0, Number(q.get("maxResults") || items.length || 100));
    const start = Math.max(0, Number(q.get("pageToken") || 0));
    const page = items.slice(start, start + max);
    const next = start + max < items.length ? String(start + max) : undefined;
    return this.sendJson(res, 200, { [key]: page, ...(next ? { nextPageToken: next } : {}), ...extra });
  }

  parseJson(buffer) {
    if (!buffer.length) return {};
    const text = buffer.toString("utf8");
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  validUser(userId) {
    return userId === "me" || userId === this.emailAddress || userId.includes("@");
  }

  methodNotAllowed(res) {
    return this.sendError(res, 405, "methodNotAllowed", "Method Not Allowed");
  }

  sendJson(res, status, payload) {
    res.statusCode = status;
    if (payload === null) return res.end();
    const body = JSON.stringify(payload);
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    return res.end(body);
  }

  sendError(res, status, reason, message) {
    const statusNames = {
      invalidArgument: "INVALID_ARGUMENT",
      notFound: "NOT_FOUND",
      duplicate: "ALREADY_EXISTS",
      permissionDenied: "PERMISSION_DENIED",
      unauthenticated: "UNAUTHENTICATED",
      failedPrecondition: "FAILED_PRECONDITION",
      methodNotAllowed: "FAILED_PRECONDITION",
      backendError: "INTERNAL",
    };
    // Map HTTP status to a canonical google.rpc.Code when the reason is unmapped,
    // so error.status is always a real code (never an arbitrary reason.toUpperCase()).
    const byStatus = {
      400: "INVALID_ARGUMENT",
      401: "UNAUTHENTICATED",
      403: "PERMISSION_DENIED",
      404: "NOT_FOUND",
      409: "ALREADY_EXISTS",
      429: "RESOURCE_EXHAUSTED",
      500: "INTERNAL",
    };
    const body = {
      error: {
        code: status,
        message,
        errors: [{ message, domain: "global", reason }],
        status: statusNames[reason] || byStatus[status] || "UNKNOWN",
      },
    };
    return this.sendJson(res, status, body);
  }
}
