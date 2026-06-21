// parlel/outlook - lightweight, dependency-free fake of Microsoft Graph mail.
// Compatible with @microsoft/microsoft-graph-client when its base URL points at
// http://127.0.0.1:4620/v1.0. State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const SYSTEM_FOLDERS = [
  ["inbox", "Inbox"],
  ["drafts", "Drafts"],
  ["sentitems", "Sent Items"],
  ["deleteditems", "Deleted Items"],
  ["junkemail", "Junk Email"],
  ["archive", "Archive"],
  ["outbox", "Outbox"],
];

class GraphError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function changeKey() {
  return randomBytes(8).toString("base64url");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function address(value, fallback = "") {
  if (!value) return { emailAddress: { name: fallback || "parlel", address: fallback || "parlel@example.com" } };
  if (value.emailAddress) return { emailAddress: { name: value.emailAddress.name || value.emailAddress.address || fallback, address: value.emailAddress.address || fallback } };
  return { emailAddress: { name: value.name || value.address || fallback, address: value.address || fallback } };
}

function addresses(values) {
  return Array.isArray(values) ? values.map((value) => address(value)) : [];
}

function bodyPreview(body) {
  return String(body?.content || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 255);
}

function graphCollection(items, q, collectionPath, extras = {}) {
  let list = [...items];
  const filter = q.get("$filter");
  const search = q.get("$search");
  const orderby = q.get("$orderby");
  const select = q.get("$select");
  const count = q.get("$count") === "true";

  if (filter) list = list.filter((item) => matchesFilter(item, filter));
  if (search) {
    const needle = search.replace(/^"|"$/g, "").toLowerCase();
    list = list.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }
  if (orderby) {
    const [field, dir = "asc"] = orderby.split(/\s+/);
    list.sort((a, b) => String(readField(a, field) || "").localeCompare(String(readField(b, field) || "")) * (dir.toLowerCase() === "desc" ? -1 : 1));
  }

  const total = list.length;
  const top = Math.max(0, Number(q.get("$top") || q.get("top") || total || 100));
  const skip = Math.max(0, Number(q.get("$skip") || q.get("skip") || 0));
  let page = list.slice(skip, skip + top);
  if (select) page = page.map((item) => selectFields(item, select));
  const nextSkip = skip + top;
  const nextLink = nextSkip < total ? `${collectionPath}${collectionPath.includes("?") ? "&" : "?"}$skip=${nextSkip}` : undefined;
  return { "@odata.context": "$metadata#collection", value: page.map(clone), ...(count ? { "@odata.count": total } : {}), ...(nextLink ? { "@odata.nextLink": nextLink } : {}), ...extras };
}

function readField(item, field) {
  return String(field).split("/").reduce((value, key) => value?.[key], item);
}

function selectFields(item, select) {
  const selected = { id: item.id };
  for (const field of select.split(",").map((part) => part.trim()).filter(Boolean)) selected[field] = item[field];
  return selected;
}

function matchesFilter(item, filter) {
  const normalized = filter.trim();
  const eq = normalized.match(/^([A-Za-z0-9_/.]+)\s+eq\s+'([^']*)'$/i);
  if (eq) return String(readField(item, eq[1]) ?? "") === eq[2];
  const contains = normalized.match(/^contains\(([A-Za-z0-9_/.]+),'([^']*)'\)$/i);
  if (contains) return String(readField(item, contains[1]) ?? "").toLowerCase().includes(contains[2].toLowerCase());
  return true;
}

export class OutlookServer {
  constructor(port = 4620, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.emailAddress = options.emailAddress || "parlel@example.com";
    this.displayName = options.displayName || "parlel";
    this.server = null;
    this.reset();
  }

  reset() {
    this.mailFolders = new Map();
    this.messages = new Map();
    this.messageRules = new Map();
    this.attachments = new Map();
    this.masterCategories = new Map();
    this.subscriptions = new Map();
    this.mailboxSettings = {
      automaticRepliesSetting: { status: "disabled", externalAudience: "none" },
      archiveFolder: "archive",
      timeZone: "UTC",
      language: { locale: "en-US", displayName: "English (United States)" },
      dateFormat: "M/d/yyyy",
      timeFormat: "h:mm tt",
      workingHours: { daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"], startTime: "08:00:00.0000000", endTime: "17:00:00.0000000", timeZone: { name: "UTC" } },
    };
    for (const [folderId, displayName] of SYSTEM_FOLDERS) this.mailFolders.set(folderId, this.makeFolder({ id: folderId, displayName, wellKnownName: folderId }));
    this.masterCategories.set("cat_blue", { id: "cat_blue", displayName: "Blue category", color: "preset0" });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, error instanceof GraphError ? error : new GraphError(500, "InternalServerError", error.message || "Internal error"), req.headers["client-request-id"]);
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
    res.setHeader("x-outlook-emulator", "parlel");

    if (url.pathname === "/_parlel/health") return this.sendJson(res, 200, { status: "ok", service: "outlook", messages: this.messages.size, folders: this.mailFolders.size });
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (["/", "/v1.0", "/beta"].includes(url.pathname)) return this.sendJson(res, 200, { "@odata.context": "$metadata", service: "outlook", emulator: "parlel" });

    const body = this.parseJson(await this.readBody(req));
    const prefix = url.pathname.startsWith("/v1.0/") ? "/v1.0/" : url.pathname.startsWith("/beta/") ? "/beta/" : "/";
    const parts = splitPath(url.pathname.slice(prefix.length));
    return this.route(res, method, parts, url.searchParams, body, prefix === "/" ? "" : prefix.slice(0, -1), req.headers["client-request-id"]);
  }

  route(res, method, parts, q, body, basePath = "/v1.0", clientRequestId) {
    if (parts[0] === "$batch" && method === "POST") return this.batch(res, body, basePath);
    if (parts[0] === "subscriptions") return this.routeSubscriptions(res, method, parts.slice(1), q, body, basePath);
    if (parts[0] === "me") return this.routeMailbox(res, method, parts.slice(1), q, body, basePath);
    if (parts[0] === "users" && parts[1]) return this.routeMailbox(res, method, parts.slice(2), q, body, basePath, parts[1]);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeMailbox(res, method, parts, q, body, basePath, userId = "me") {
    if (!this.validUser(userId)) throw new GraphError(404, "ErrorItemNotFound", "User not found");
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, this.user());
    if (parts[0] === "mailboxSettings") return this.routeMailboxSettings(res, method, parts.slice(1), body);
    if (parts[0] === "sendMail" && method === "POST") return this.sendMail(res, body);
    if (parts[0] === "messages") return this.routeMessages(res, method, parts.slice(1), q, body, `${basePath}/me/messages`);
    if (parts[0] === "mailFolders") return this.routeMailFolders(res, method, parts.slice(1), q, body, basePath);
    if (parts[0] === "outlook" && parts[1] === "masterCategories") return this.routeMasterCategories(res, method, parts.slice(2), q, body, `${basePath}/me/outlook/masterCategories`);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeMailboxSettings(res, method, parts, body) {
    if (parts.length !== 0) throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
    if (method === "GET") return this.sendJson(res, 200, clone(this.mailboxSettings));
    if (method === "PATCH") {
      this.mailboxSettings = { ...this.mailboxSettings, ...body };
      return this.sendJson(res, 200, clone(this.mailboxSettings));
    }
    throw new GraphError(405, "Request_BadRequest", "Specified HTTP method is not allowed for the request target.");
  }

  routeMailFolders(res, method, parts, q, body, basePath) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(this.folderList(null), q, `${basePath}/me/mailFolders`));
      if (method === "POST") return this.sendJson(res, 201, this.createFolder(body, null));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const folderId = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, this.mustFolder(folderId));
      if (method === "PATCH") return this.sendJson(res, 200, this.updateFolder(folderId, body));
      if (method === "DELETE") return this.deleteFolder(res, folderId);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts[1] === "childFolders") return this.routeChildFolders(res, method, folderId, parts.slice(2), q, body, `${basePath}/me/mailFolders/${encodeURIComponent(folderId)}/childFolders`);
    if (parts[1] === "messages") return this.routeFolderMessages(res, method, folderId, parts.slice(2), q, body, `${basePath}/me/mailFolders/${encodeURIComponent(folderId)}/messages`);
    if (parts[1] === "messageRules") return this.routeMessageRules(res, method, folderId, parts.slice(2), q, body, `${basePath}/me/mailFolders/${encodeURIComponent(folderId)}/messageRules`);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeChildFolders(res, method, parentId, parts, q, body, collectionPath) {
    this.mustFolder(parentId);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(this.folderList(parentId), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createFolder(body, parentId));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts.length === 1) {
      const folder = this.mustFolder(parts[0]);
      if (folder.parentFolderId !== parentId) throw new GraphError(404, "ErrorItemNotFound", "Folder not found");
      if (method === "GET") return this.sendJson(res, 200, folder);
      if (method === "PATCH") return this.sendJson(res, 200, this.updateFolder(parts[0], body));
      if (method === "DELETE") return this.deleteFolder(res, parts[0]);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeFolderMessages(res, method, folderId, parts, q, body, collectionPath) {
    this.mustFolder(folderId);
    if (parts.length === 1 && parts[0] === "delta" && method === "GET") return this.listMessages(res, q, collectionPath, folderId, true);
    if (parts.length === 0) {
      if (method === "GET") return this.listMessages(res, q, collectionPath, folderId);
      if (method === "POST") return this.sendJson(res, 201, this.createMessage({ ...body, parentFolderId: folderId, isDraft: true }));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeMessages(res, method, parts, q, body, collectionPath) {
    if (parts.length === 0) {
      if (method === "GET") return this.listMessages(res, q, collectionPath);
      if (method === "POST") return this.sendJson(res, 201, this.createMessage({ ...body, parentFolderId: body.parentFolderId || "drafts", isDraft: body.isDraft ?? true }));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts.length === 1 && parts[0] === "delta" && method === "GET") return this.listMessages(res, q, collectionPath, null, true);
    if (parts.length === 1 && parts[0] === "$count" && method === "GET") return this.sendText(res, 200, String(this.visibleMessages().length));

    const messageId = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, this.projectMessage(this.mustMessage(messageId), q));
      if (method === "PATCH") return this.sendJson(res, 200, this.updateMessage(messageId, body));
      if (method === "DELETE") return this.deleteMessage(res, messageId);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts[1] === "attachments") return this.routeAttachments(res, method, messageId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(messageId)}/attachments`);
    if (parts.length === 2 && ["send", "reply", "replyAll", "forward"].includes(parts[1]) && method === "POST") return this.messageAction(res, messageId, parts[1], body);
    if (parts.length === 2 && ["createReply", "createReplyAll", "createForward"].includes(parts[1]) && method === "POST") return this.createActionDraft(res, messageId, parts[1], body);
    if (parts.length === 2 && ["move", "copy"].includes(parts[1]) && method === "POST") return this.moveOrCopy(res, messageId, parts[1], body);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeAttachments(res, method, messageId, parts, q, body, collectionPath) {
    const message = this.mustMessage(messageId);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(this.messageAttachments(message.id), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createAttachment(message, body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const attachment = this.mustAttachment(message, parts[0]);
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, attachment);
      if (method === "DELETE") return this.deleteAttachment(res, message, parts[0]);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts.length === 2 && parts[1] === "$value" && method === "GET") return this.sendBinary(res, attachment);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeMessageRules(res, method, folderId, parts, q, body, collectionPath) {
    this.mustFolder(folderId);
    if (!this.messageRules.has(folderId)) this.messageRules.set(folderId, new Map());
    const rules = this.messageRules.get(folderId);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(rules.values()), q, collectionPath));
      if (method === "POST") {
        const rule = { id: id("rule"), displayName: body.displayName || "Rule", sequence: body.sequence || rules.size + 1, isEnabled: body.isEnabled ?? true, conditions: body.conditions || {}, actions: body.actions || {} };
        rules.set(rule.id, rule);
        return this.sendJson(res, 201, clone(rule));
      }
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const rule = rules.get(parts[0]);
    if (!rule) throw new GraphError(404, "ErrorItemNotFound", "Message rule not found");
    if (method === "GET") return this.sendJson(res, 200, clone(rule));
    if (method === "PATCH") {
      Object.assign(rule, body, { id: rule.id });
      return this.sendJson(res, 200, clone(rule));
    }
    if (method === "DELETE") {
      rules.delete(parts[0]);
      return this.sendJson(res, 204, null);
    }
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routeMasterCategories(res, method, parts, q, body, collectionPath) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(this.masterCategories.values()), q, collectionPath));
      if (method === "POST") {
        if (!body.displayName) throw new GraphError(400, "ErrorInvalidRequest", "displayName is required");
        const category = { id: id("category"), displayName: body.displayName, color: body.color || "preset0" };
        this.masterCategories.set(category.id, category);
        return this.sendJson(res, 201, clone(category));
      }
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const category = this.masterCategories.get(parts[0]);
    if (!category) throw new GraphError(404, "ErrorItemNotFound", "Category not found");
    if (method === "GET") return this.sendJson(res, 200, clone(category));
    if (method === "PATCH") {
      Object.assign(category, body, { id: category.id });
      return this.sendJson(res, 200, clone(category));
    }
    if (method === "DELETE") {
      this.masterCategories.delete(parts[0]);
      return this.sendJson(res, 204, null);
    }
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routeSubscriptions(res, method, parts, q, body, collectionPath) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(this.subscriptions.values()), q, `${collectionPath}/subscriptions`));
      if (method === "POST") {
        if (!body.changeType || !body.notificationUrl || !body.resource) throw new GraphError(400, "ErrorInvalidRequest", "changeType, notificationUrl, and resource are required");
        const subscription = { id: id("sub"), changeType: body.changeType, notificationUrl: body.notificationUrl, resource: body.resource, expirationDateTime: body.expirationDateTime || new Date(Date.now() + 3600000).toISOString(), clientState: body.clientState };
        this.subscriptions.set(subscription.id, subscription);
        return this.sendJson(res, 201, clone(subscription));
      }
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const subscription = this.subscriptions.get(parts[0]);
    if (!subscription) throw new GraphError(404, "ErrorItemNotFound", "Subscription not found");
    if (method === "GET") return this.sendJson(res, 200, clone(subscription));
    if (method === "PATCH") {
      Object.assign(subscription, body, { id: subscription.id });
      return this.sendJson(res, 200, clone(subscription));
    }
    if (method === "DELETE") {
      this.subscriptions.delete(parts[0]);
      return this.sendJson(res, 204, null);
    }
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  batch(res, body, basePath) {
    const responses = [];
    for (const request of body.requests || []) {
      try {
        const requestUrl = new URL(request.url, `http://parlel${request.url.startsWith("/") ? "" : "/"}`);
        let payload;
        let status = 200;
        const fakeRes = {
          statusCode: 200,
          headers: {},
          setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
          end: (text = "") => {
            status = fakeRes.statusCode;
            payload = text ? JSON.parse(text) : undefined;
          },
        };
        const prefix = requestUrl.pathname.startsWith("/v1.0/") ? "/v1.0/" : requestUrl.pathname.startsWith("/beta/") ? "/beta/" : "/";
        this.route(fakeRes, request.method || "GET", splitPath(requestUrl.pathname.slice(prefix.length)), requestUrl.searchParams, request.body || {}, basePath);
        responses.push({ id: request.id, status, headers: { "content-type": "application/json" }, body: payload });
      } catch (error) {
        const graphError = error instanceof GraphError ? error : new GraphError(500, "InternalServerError", error.message || "Internal error");
        responses.push({ id: request.id, status: graphError.status, body: { error: this.errorBody(graphError) } });
      }
    }
    return this.sendJson(res, 200, { responses });
  }

  user() {
    return { id: "me", displayName: this.displayName, mail: this.emailAddress, userPrincipalName: this.emailAddress };
  }

  makeFolder(input) {
    return { id: input.id || id("folder"), displayName: input.displayName || "Folder", parentFolderId: input.parentFolderId || null, childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0, wellKnownName: input.wellKnownName };
  }

  createFolder(body, parentFolderId) {
    if (!body.displayName) throw new GraphError(400, "ErrorInvalidRequest", "displayName is required");
    const folder = this.makeFolder({ displayName: body.displayName, parentFolderId });
    this.mailFolders.set(folder.id, folder);
    this.recountFolders();
    return clone(folder);
  }

  updateFolder(folderId, body) {
    const folder = this.mustFolder(folderId);
    if (body.displayName !== undefined) folder.displayName = body.displayName;
    folder.changeKey = changeKey();
    return clone(folder);
  }

  deleteFolder(res, folderId) {
    const folder = this.mustFolder(folderId);
    if (folder.wellKnownName) throw new GraphError(400, "ErrorInvalidRequest", "Default folders cannot be deleted");
    for (const child of this.folderList(folderId)) this.mailFolders.delete(child.id);
    for (const message of this.messages.values()) if (message.parentFolderId === folderId) message.deleted = true;
    this.mailFolders.delete(folderId);
    this.recountFolders();
    return this.sendJson(res, 204, null);
  }

  folderList(parentFolderId) {
    return Array.from(this.mailFolders.values()).filter((folder) => folder.parentFolderId === parentFolderId).map(clone);
  }

  listMessages(res, q, collectionPath, folderId = null, delta = false) {
    let messages = this.visibleMessages();
    if (folderId) messages = messages.filter((message) => message.parentFolderId === folderId);
    const payload = graphCollection(messages.map((message) => this.projectMessage(message, new URLSearchParams())), q, collectionPath);
    if (delta) payload["@odata.deltaLink"] = `${collectionPath}/delta?$deltatoken=${Date.now()}`;
    return this.sendJson(res, 200, payload);
  }

  createMessage(input = {}) {
    const created = now();
    const message = {
      id: input.id || id("msg"),
      createdDateTime: created,
      lastModifiedDateTime: created,
      changeKey: changeKey(),
      categories: input.categories || [],
      receivedDateTime: input.receivedDateTime || created,
      sentDateTime: input.sentDateTime || created,
      hasAttachments: false,
      internetMessageId: input.internetMessageId || `<${id("internet")}@parlel.local>`,
      subject: input.subject || "",
      bodyPreview: bodyPreview(input.body),
      importance: input.importance || "normal",
      parentFolderId: input.parentFolderId || "drafts",
      conversationId: input.conversationId || id("conv"),
      conversationIndex: input.conversationIndex || randomBytes(8).toString("base64"),
      isDeliveryReceiptRequested: input.isDeliveryReceiptRequested ?? false,
      isReadReceiptRequested: input.isReadReceiptRequested ?? false,
      isRead: input.isRead ?? false,
      isDraft: input.isDraft ?? true,
      webLink: `https://outlook.office.com/mail/id/${input.id || "local"}`,
      inferenceClassification: input.inferenceClassification || "focused",
      body: { contentType: input.body?.contentType || "text", content: input.body?.content || "" },
      sender: address(input.sender || input.from, this.emailAddress),
      from: address(input.from || input.sender, this.emailAddress),
      toRecipients: addresses(input.toRecipients),
      ccRecipients: addresses(input.ccRecipients),
      bccRecipients: addresses(input.bccRecipients),
      replyTo: addresses(input.replyTo),
      deleted: false,
    };
    this.messages.set(message.id, message);
    this.attachments.set(message.id, new Map());
    for (const attachment of input.attachments || []) this.createAttachment(message, attachment);
    this.recountFolders();
    return this.projectMessage(message, new URLSearchParams());
  }

  projectMessage(message, q) {
    const base = clone(message);
    delete base.deleted;
    if (q.get("$expand")?.includes("attachments")) base.attachments = this.messageAttachments(message.id);
    if (q.get("$select")) return selectFields(base, q.get("$select"));
    return base;
  }

  updateMessage(messageId, body) {
    const message = this.mustMessage(messageId);
    const allowed = ["subject", "body", "importance", "categories", "isRead", "isDraft", "inferenceClassification", "toRecipients", "ccRecipients", "bccRecipients", "replyTo"];
    for (const field of allowed) if (body[field] !== undefined) message[field] = field.endsWith("Recipients") || field === "replyTo" ? addresses(body[field]) : body[field];
    if (body.body !== undefined) message.bodyPreview = bodyPreview(body.body);
    message.lastModifiedDateTime = now();
    message.changeKey = changeKey();
    return this.projectMessage(message, new URLSearchParams());
  }

  deleteMessage(res, messageId) {
    const message = this.mustMessage(messageId);
    message.deleted = true;
    this.recountFolders();
    return this.sendJson(res, 204, null);
  }

  sendMail(res, body) {
    const message = this.createMessage({ ...(body.message || {}), parentFolderId: "sentitems", isDraft: false });
    if (body.saveToSentItems === false) this.messages.get(message.id).deleted = true;
    this.recountFolders();
    return this.sendJson(res, 202, null);
  }

  messageAction(res, messageId, action, body) {
    const original = this.mustMessage(messageId);
    if (action === "send") {
      Object.assign(original, { parentFolderId: "sentitems", isDraft: false, sentDateTime: now(), lastModifiedDateTime: now(), changeKey: changeKey() });
      this.recountFolders();
      return this.sendJson(res, 202, null);
    }
    const prefix = action === "forward" ? "FW" : "RE";
    this.createMessage({ subject: `${prefix}: ${original.subject}`, body: body.message?.body || { contentType: "text", content: body.comment || "" }, toRecipients: body.toRecipients || body.message?.toRecipients || [], parentFolderId: "sentitems", isDraft: false, conversationId: original.conversationId });
    return this.sendJson(res, 202, null);
  }

  createActionDraft(res, messageId, action, body) {
    const original = this.mustMessage(messageId);
    const prefix = action === "createForward" ? "FW" : "RE";
    return this.sendJson(res, 201, this.createMessage({ subject: `${prefix}: ${original.subject}`, body: body.message?.body || { contentType: "text", content: body.comment || "" }, toRecipients: body.toRecipients || body.message?.toRecipients || [], parentFolderId: "drafts", isDraft: true, conversationId: original.conversationId }));
  }

  moveOrCopy(res, messageId, action, body) {
    const original = this.mustMessage(messageId);
    const destinationId = body.destinationId || body.DestinationId;
    this.mustFolder(destinationId);
    if (action === "move") {
      original.parentFolderId = destinationId;
      original.lastModifiedDateTime = now();
      original.changeKey = changeKey();
      this.recountFolders();
      return this.sendJson(res, 201, this.projectMessage(original, new URLSearchParams()));
    }
    const copy = this.createMessage({ ...original, id: id("msg"), parentFolderId: destinationId, internetMessageId: undefined });
    return this.sendJson(res, 201, copy);
  }

  createAttachment(message, body) {
    if (!body.name) throw new GraphError(400, "ErrorInvalidRequest", "Attachment name is required");
    const bytes = body.contentBytes || Buffer.from(body.content || "").toString("base64");
    const attachment = {
      "@odata.type": body["@odata.type"] || "#microsoft.graph.fileAttachment",
      id: body.id || id("att"),
      lastModifiedDateTime: now(),
      name: body.name,
      contentType: body.contentType || "application/octet-stream",
      size: Buffer.byteLength(bytes, "base64"),
      isInline: body.isInline || false,
      contentId: body.contentId,
      contentBytes: bytes,
    };
    this.attachments.get(message.id).set(attachment.id, attachment);
    message.hasAttachments = true;
    message.lastModifiedDateTime = now();
    return clone(attachment);
  }

  deleteAttachment(res, message, attachmentId) {
    this.mustAttachment(message, attachmentId);
    this.attachments.get(message.id).delete(attachmentId);
    message.hasAttachments = this.attachments.get(message.id).size > 0;
    return this.sendJson(res, 204, null);
  }

  sendBinary(res, attachment) {
    const body = Buffer.from(attachment.contentBytes || "", "base64");
    res.statusCode = 200;
    res.setHeader("Content-Type", attachment.contentType || "application/octet-stream");
    res.setHeader("Content-Length", body.length);
    return res.end(body);
  }

  messageAttachments(messageId) {
    return Array.from((this.attachments.get(messageId) || new Map()).values()).map(clone);
  }

  mustFolder(folderId) {
    const folder = this.mailFolders.get(folderId);
    if (!folder) throw new GraphError(404, "ErrorItemNotFound", "Folder not found");
    return folder;
  }

  mustMessage(messageId) {
    const message = this.messages.get(messageId);
    if (!message || message.deleted) throw new GraphError(404, "ErrorItemNotFound", "Message not found");
    return message;
  }

  mustAttachment(message, attachmentId) {
    const attachment = this.attachments.get(message.id)?.get(attachmentId);
    if (!attachment) throw new GraphError(404, "ErrorItemNotFound", "Attachment not found");
    return attachment;
  }

  visibleMessages() {
    return Array.from(this.messages.values()).filter((message) => !message.deleted);
  }

  recountFolders() {
    for (const folder of this.mailFolders.values()) {
      folder.childFolderCount = this.folderList(folder.id).length;
      const messages = this.visibleMessages().filter((message) => message.parentFolderId === folder.id);
      folder.totalItemCount = messages.length;
      folder.unreadItemCount = messages.filter((message) => !message.isRead).length;
    }
  }

  validUser(userId) {
    return userId === "me" || userId === this.emailAddress || userId.includes("@");
  }

  parseJson(buffer) {
    if (!buffer.length) return {};
    const text = buffer.toString("utf8");
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new GraphError(400, "ErrorInvalidRequest", "Invalid JSON payload");
    }
  }

  sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader("request-id", id("req"));
    if (payload === null) return res.end();
    const body = JSON.stringify(payload);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    return res.end(body);
  }

  sendText(res, status, text) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(text));
    return res.end(text);
  }

  sendError(res, error, clientRequestId) {
    return this.sendJson(res, error.status, { error: this.errorBody(error, clientRequestId) });
  }

  errorBody(error, clientRequestId) {
    return {
      code: error.code,
      message: error.message,
      innerError: {
        date: now(),
        "request-id": id("req"),
        ...(clientRequestId ? { "client-request-id": clientRequestId } : {}),
      },
    };
  }
}
