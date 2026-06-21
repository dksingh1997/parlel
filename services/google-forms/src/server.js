// parlel/google-forms - lightweight, dependency-free fake of Google Forms API v1.
// Compatible with the `googleapis` Forms client when its rootUrl is pointed at
// this server. State is in-memory and ephemeral. Reset with reset() or
// POST /_parlel/reset.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

class ApiError extends Error {
  constructor(code, message, reason = "badRequest", status) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.status = status || statusForCode(code);
  }
}

function statusForCode(code) {
  return {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "ALREADY_EXISTS",
    500: "INTERNAL",
  }[code] || "UNKNOWN";
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function singleRequestField(request) {
  const entries = Object.entries(request || {}).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length !== 1) throw new ApiError(400, "Exactly one request field must be set.", "invalidArgument");
  return entries[0];
}

function fields(mask, source) {
  if (!mask || mask === "*") return Object.keys(source || {});
  return String(mask).split(",").map((field) => field.trim()).filter(Boolean);
}

function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const parts = path.split(".");
  let target = object;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = clone(value);
}

function applyMask(target, patch = {}, mask = "*") {
  for (const field of fields(mask, patch)) {
    const value = field.includes(".") ? getPath(patch, field) : patch[field];
    if (value !== undefined) setPath(target, field, value);
  }
  return target;
}

function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, withoutUndefined(v)]));
}

export class GoogleFormsServer {
  constructor(port = 4625, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.forms = new Map();
    this.responses = new Map();
    this.watches = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, error instanceof ApiError ? error : new ApiError(500, error.message || "Internal error", "backendError"));
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

  addResponse(formId, response = {}) {
    this.mustForm(formId);
    const responseId = response.responseId || id("response");
    const submitted = response.lastSubmittedTime || response.createTime || now();
    const stored = withoutUndefined({
      formId,
      responseId,
      createTime: response.createTime || submitted,
      lastSubmittedTime: submitted,
      respondentEmail: response.respondentEmail,
      answers: clone(response.answers || {}),
      totalScore: response.totalScore,
    });
    this.responses.get(formId).set(responseId, stored);
    return clone(stored);
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
    res.setHeader("x-google-forms-emulator", "parlel");

    if (pathname === "/_parlel/health") return this.sendJson(res, 200, { status: "ok", service: "google-forms", forms: this.forms.size });
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/" || pathname === "/v1" || pathname === "/forms/v1") return this.sendJson(res, 200, { kind: "forms#parlel" });

    const bodyBuffer = await this.readBody(req);
    let body = {};
    if (bodyBuffer.length) {
      try {
        body = JSON.parse(bodyBuffer.toString("utf8"));
      } catch {
        throw new ApiError(400, "Invalid JSON payload received. Unknown name.", "parseError");
      }
    }

    if (pathname.startsWith("/_parlel/forms/")) return this.routeParlel(res, method, splitPath(pathname), body);

    let path = pathname;
    if (path.startsWith("/forms/v1/")) path = path.slice("/forms".length);
    if (!path.startsWith("/v1/")) throw new ApiError(404, "Not Found", "notFound");
    const parts = splitPath(path.slice("/v1/".length));
    return this.route(res, method, parts, url.searchParams, body);
  }

  route(res, method, parts, q, body) {
    if (parts[0] !== "forms") throw new ApiError(404, "Not Found", "notFound");
    if (parts.length === 1) {
      if (method === "POST") return this.createForm(res, body, q);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }

    const formId = parts[1];
    if (parts.length === 2) {
      if (formId.endsWith(":batchUpdate") && method === "POST") return this.batchUpdate(res, formId.slice(0, -":batchUpdate".length), body);
      if (formId.endsWith(":setPublishSettings") && method === "POST") return this.setPublishSettings(res, formId.slice(0, -":setPublishSettings".length), body);
      if (method === "GET") return this.getForm(res, formId);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }

    if (parts[2] === "responses") return this.routeResponses(res, method, formId, parts.slice(3), q);
    if (parts[2] === "watches") return this.routeWatches(res, method, formId, parts.slice(3), body);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeParlel(res, method, parts, body) {
    if (parts.length === 4 && parts[0] === "_parlel" && parts[1] === "forms" && parts[3] === "responses" && method === "POST") {
      return this.sendJson(res, 200, this.addResponse(parts[2], body));
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  createForm(res, body, q) {
    if (body.items || body.settings || body.formId || body.revisionId || body.responderUri) {
      throw new ApiError(400, "Only info.title and info.documentTitle can be set when creating a form.", "invalidArgument");
    }
    const title = body.info?.title;
    if (!title) throw new ApiError(400, "Form info.title is required.", "invalidArgument");
    const formId = id("form");
    const unpublished = q.get("unpublished") === "true";
    const form = {
      formId,
      info: withoutUndefined({ title, documentTitle: body.info?.documentTitle || title }),
      settings: { quizSettings: { isQuiz: false }, emailCollectionType: "DO_NOT_COLLECT" },
      items: [],
      revisionId: id("rev"),
      responderUri: `https://docs.google.com/forms/d/e/${formId}/viewform`,
      publishSettings: { publishState: { isPublished: !unpublished, isAcceptingResponses: !unpublished } },
    };
    this.forms.set(formId, form);
    this.responses.set(formId, new Map());
    this.watches.set(formId, new Map());
    return this.sendJson(res, 200, this.publicForm(form));
  }

  getForm(res, formId) {
    return this.sendJson(res, 200, this.publicForm(this.mustForm(formId)));
  }

  batchUpdate(res, formId, body) {
    const form = this.mustForm(formId);
    if (!Array.isArray(body.requests)) throw new ApiError(400, "Invalid value at 'requests' (type.googleapis.com/google.apps.forms.v1.Request), must be an array", "invalidArgument");
    this.checkWriteControl(form, body.writeControl);

    const updated = clone(form);
    const replies = body.requests.map((request) => this.applyRequest(updated, request));
    updated.revisionId = id("rev");
    this.forms.set(formId, updated);

    const response = { replies, writeControl: { requiredRevisionId: updated.revisionId } };
    if (body.includeFormInResponse) response.form = this.publicForm(updated);
    return this.sendJson(res, 200, response);
  }

  setPublishSettings(res, formId, body) {
    const form = this.mustForm(formId);
    const desired = body.publishSettings;
    if (!desired) throw new ApiError(400, "publishSettings is required.", "invalidArgument");
    const state = desired.publishState;
    if (state?.isPublished === false && state?.isAcceptingResponses === true) {
      throw new ApiError(400, "A form cannot accept responses while unpublished.", "invalidArgument");
    }
    const next = clone(form.publishSettings || {});
    applyMask(next, desired, body.updateMask || "*");
    if (next.publishState?.isPublished === false) next.publishState.isAcceptingResponses = false;
    form.publishSettings = next;
    return this.sendJson(res, 200, { formId, publishSettings: clone(form.publishSettings) });
  }

  applyRequest(form, request) {
    const [type, payload] = singleRequestField(request);
    const handlers = {
      updateFormInfo: () => this.updateFormInfo(form, payload),
      updateSettings: () => this.updateSettings(form, payload),
      createItem: () => this.createItem(form, payload),
      moveItem: () => this.moveItem(form, payload),
      deleteItem: () => this.deleteItem(form, payload),
      updateItem: () => this.updateItem(form, payload),
    };
    if (!handlers[type]) throw new ApiError(400, `Unsupported request type: ${type}`, "invalidArgument");
    return handlers[type]();
  }

  updateFormInfo(form, request = {}) {
    if (!request.info) throw new ApiError(400, "info is required.", "invalidArgument");
    if (!request.updateMask) throw new ApiError(400, "updateMask is required.", "invalidArgument");
    const info = { ...request.info };
    delete info.documentTitle;
    applyMask(form.info, info, request.updateMask);
    return {};
  }

  updateSettings(form, request = {}) {
    if (!request.settings) throw new ApiError(400, "settings is required.", "invalidArgument");
    if (!request.updateMask) throw new ApiError(400, "updateMask is required.", "invalidArgument");
    applyMask(form.settings, request.settings, request.updateMask);
    return {};
  }

  createItem(form, request = {}) {
    if (!request.item) throw new ApiError(400, "item is required.", "invalidArgument");
    const index = this.locationIndexForInsert(form, request.location);
    const item = this.prepareItem(form, request.item);
    form.items.splice(index, 0, item);
    return { createItem: { itemId: item.itemId, questionId: this.questionIds(item) } };
  }

  moveItem(form, request = {}) {
    const original = this.locationIndexExisting(form, request.originalLocation);
    const [item] = form.items.splice(original, 1);
    const target = this.locationIndexForInsert(form, request.newLocation);
    form.items.splice(target, 0, item);
    return {};
  }

  deleteItem(form, request = {}) {
    const index = this.locationIndexExisting(form, request.location);
    form.items.splice(index, 1);
    return {};
  }

  updateItem(form, request = {}) {
    const index = this.locationIndexExisting(form, request.location);
    if (!request.item) throw new ApiError(400, "item is required.", "invalidArgument");
    if (!request.updateMask) throw new ApiError(400, "updateMask is required.", "invalidArgument");
    const current = form.items[index];
    if (request.updateMask === "*") form.items[index] = this.prepareItem(form, { ...request.item, itemId: request.item.itemId || current.itemId }, current.itemId);
    else {
      const patch = clone(request.item);
      if (patch.itemId && patch.itemId !== current.itemId && this.itemIdExists(form, patch.itemId)) throw new ApiError(400, "Item ID already exists.", "invalidArgument");
      applyMask(current, patch, request.updateMask);
      this.ensureItemIds(form, current, current.itemId);
    }
    return {};
  }

  routeResponses(res, method, formId, parts, q) {
    this.mustForm(formId);
    if (parts.length === 0 && method === "GET") return this.listResponses(res, formId, q);
    if (parts.length === 1 && method === "GET") return this.getResponse(res, formId, parts[0]);
    throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
  }

  listResponses(res, formId, q) {
    let rows = [...this.responses.get(formId).values()].sort((a, b) => a.lastSubmittedTime.localeCompare(b.lastSubmittedTime));
    const filter = q.get("filter");
    if (filter) rows = this.filterResponses(rows, filter);
    const pageSize = Math.min(Math.max(Number(q.get("pageSize") || 5000), 0) || 5000, 5000);
    const start = q.get("pageToken") ? Number(q.get("pageToken")) : 0;
    if (!Number.isInteger(start) || start < 0) throw new ApiError(400, "Invalid page token.", "invalidArgument");
    const page = rows.slice(start, start + pageSize).map((response) => {
      const item = clone(response);
      delete item.formId;
      return item;
    });
    const body = { responses: page };
    if (start + pageSize < rows.length) body.nextPageToken = String(start + pageSize);
    return this.sendJson(res, 200, body);
  }

  getResponse(res, formId, responseId) {
    const response = this.responses.get(formId).get(responseId);
    if (!response) throw new ApiError(404, "Response not found", "notFound");
    return this.sendJson(res, 200, clone(response));
  }

  filterResponses(rows, filter) {
    const match = String(filter).match(/^timestamp\s*(>=|>)\s*([^\s]+)$/);
    if (!match) throw new ApiError(400, "Invalid filter. Supported filters are 'timestamp > RFC3339' and 'timestamp >= RFC3339'.", "invalidArgument");
    const [, op, timestamp] = match;
    const cutoff = Date.parse(timestamp);
    if (Number.isNaN(cutoff)) throw new ApiError(400, "Invalid timestamp in filter.", "invalidArgument");
    return rows.filter((response) => op === ">=" ? Date.parse(response.lastSubmittedTime) >= cutoff : Date.parse(response.lastSubmittedTime) > cutoff);
  }

  routeWatches(res, method, formId, parts, body) {
    this.mustForm(formId);
    if (parts.length === 0) {
      if (method === "GET") return this.listWatches(res, formId);
      if (method === "POST") return this.createWatch(res, formId, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1) {
      if (parts[0].endsWith(":renew") && method === "POST") return this.renewWatch(res, formId, parts[0].slice(0, -":renew".length));
      if (method === "DELETE") return this.deleteWatch(res, formId, parts[0]);
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  createWatch(res, formId, body) {
    const watch = body.watch || {};
    if (!watch.target?.topic?.topicName) throw new ApiError(400, "watch.target.topic.topicName is required.", "invalidArgument");
    if (!watch.eventType || watch.eventType === "EVENT_TYPE_UNSPECIFIED") throw new ApiError(400, "watch.eventType is required.", "invalidArgument");
    const watchId = body.watchId || id("watch");
    if (body.watchId && !/^[a-z-]{4,63}$/.test(body.watchId)) throw new ApiError(400, "watchId must be 4-63 characters using lowercase letters and hyphens.", "invalidArgument");
    const watches = this.watches.get(formId);
    if (watches.has(watchId)) throw new ApiError(409, "Watch already exists", "alreadyExists");
    if ([...watches.values()].some((existing) => existing.eventType === watch.eventType)) throw new ApiError(409, "A watch for this event type already exists", "alreadyExists");
    const stored = {
      id: watchId,
      target: clone(watch.target),
      eventType: watch.eventType,
      createTime: now(),
      expireTime: daysFromNow(7),
      state: "ACTIVE",
    };
    watches.set(watchId, stored);
    return this.sendJson(res, 200, clone(stored));
  }

  listWatches(res, formId) {
    return this.sendJson(res, 200, { watches: [...this.watches.get(formId).values()].map(clone) });
  }

  renewWatch(res, formId, watchId) {
    const watch = this.watches.get(formId).get(watchId);
    if (!watch || Date.parse(watch.expireTime) < Date.now()) throw new ApiError(404, "Watch not found", "notFound");
    watch.expireTime = daysFromNow(7);
    watch.state = "ACTIVE";
    delete watch.errorType;
    return this.sendJson(res, 200, clone(watch));
  }

  deleteWatch(res, formId, watchId) {
    const watches = this.watches.get(formId);
    if (!watches.has(watchId)) throw new ApiError(404, "Watch not found", "notFound");
    watches.delete(watchId);
    return this.sendJson(res, 200, {});
  }

  checkWriteControl(form, writeControl = {}) {
    if (writeControl.requiredRevisionId && writeControl.requiredRevisionId !== form.revisionId) {
      throw new ApiError(400, "The requested revision ID does not match the latest revision.", "invalidArgument");
    }
  }

  prepareItem(form, input, replacingItemId) {
    const item = clone(input);
    if (!item.itemId) item.itemId = id("item");
    if (item.itemId !== replacingItemId && this.itemIdExists(form, item.itemId)) throw new ApiError(400, "Item ID already exists.", "invalidArgument");
    this.ensureItemIds(form, item, replacingItemId);
    return item;
  }

  ensureItemIds(form, item, replacingItemId) {
    const ids = this.existingQuestionIds(form, replacingItemId);
    const assign = (question) => {
      if (!question) return;
      if (!question.questionId) question.questionId = id("question");
      if (ids.has(question.questionId)) throw new ApiError(400, "Question ID already exists.", "invalidArgument");
      ids.add(question.questionId);
    };
    assign(item.questionItem?.question);
    for (const question of item.questionGroupItem?.questions || []) assign(question);
  }

  questionIds(item) {
    const ids = [];
    if (item.questionItem?.question?.questionId) ids.push(item.questionItem.question.questionId);
    for (const question of item.questionGroupItem?.questions || []) if (question.questionId) ids.push(question.questionId);
    return ids;
  }

  itemIdExists(form, itemId) {
    return form.items.some((item) => item.itemId === itemId);
  }

  existingQuestionIds(form, excludingItemId) {
    const ids = new Set();
    for (const item of form.items) {
      if (item.itemId === excludingItemId) continue;
      for (const questionId of this.questionIds(item)) ids.add(questionId);
    }
    return ids;
  }

  locationIndexForInsert(form, location = {}) {
    const index = location.index ?? form.items.length;
    if (!Number.isInteger(index) || index < 0 || index > form.items.length) throw new ApiError(400, "Location index is out of bounds.", "invalidArgument");
    return index;
  }

  locationIndexExisting(form, location = {}) {
    const index = location.index;
    if (!Number.isInteger(index) || index < 0 || index >= form.items.length) throw new ApiError(400, "Location index is out of bounds.", "invalidArgument");
    return index;
  }

  mustForm(formId) {
    const form = this.forms.get(formId);
    if (!form) throw new ApiError(404, "Form not found", "notFound");
    return form;
  }

  publicForm(form) {
    return clone(form);
  }

  sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }

  sendError(res, error) {
    this.sendJson(res, error.code || 500, {
      error: {
        code: error.code || 500,
        message: error.message,
        status: error.status || statusForCode(error.code || 500),
        errors: [{ message: error.message, domain: "global", reason: error.reason || "backendError" }],
      },
    });
  }
}

export default GoogleFormsServer;
