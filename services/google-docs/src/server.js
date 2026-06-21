// parlel/google-docs - lightweight, dependency-free fake of Google Docs API v1.
// Compatible with the `googleapis` Docs client when its rootUrl is pointed at
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

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function applyFields(target, patch = {}, fields = "*") {
  if (!fields || fields === "*") return Object.assign(target, clone(patch));
  for (const field of String(fields).split(",").map((f) => f.trim()).filter(Boolean)) {
    const key = field.split(".")[0];
    if (Object.prototype.hasOwnProperty.call(patch, key)) target[key] = clone(patch[key]);
  }
  return target;
}

function textMatches(haystack, needle, matchCase) {
  if (matchCase) return haystack.indexOf(needle);
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

export class GoogleDocsServer {
  constructor(port = 4616, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.documents = new Map();
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
    res.setHeader("x-google-docs-emulator", "parlel");

    if (pathname === "/_parlel/health") return this.sendJson(res, 200, { status: "ok", service: "google-docs", documents: this.documents.size });
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/" || pathname === "/v1" || pathname === "/docs/v1") return this.sendJson(res, 200, { kind: "docs#parlel" });

    const bodyBuffer = await this.readBody(req);
    let body = {};
    if (bodyBuffer.length) {
      try {
        body = JSON.parse(bodyBuffer.toString("utf8"));
      } catch {
        throw new ApiError(400, "Invalid JSON payload received. Unknown name.", "parseError");
      }
    }

    let path = pathname;
    if (path.startsWith("/docs/v1/")) path = path.slice("/docs".length);
    if (!path.startsWith("/v1/")) throw new ApiError(404, "Not Found", "notFound");
    const parts = splitPath(path.slice("/v1/".length));
    return this.route(res, method, parts, url.searchParams, body);
  }

  route(res, method, parts, q, body) {
    if (parts[0] !== "documents") throw new ApiError(404, "Not Found", "notFound");
    if (parts.length === 1) {
      if (method === "POST") return this.createDocument(res, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }

    if (parts.length !== 2) throw new ApiError(404, "Not Found", "notFound");
    if (parts[1].endsWith(":batchUpdate")) {
      if (method !== "POST") throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
      return this.batchUpdate(res, parts[1].slice(0, -":batchUpdate".length), body);
    }
    if (method === "GET") return this.getDocument(res, parts[1], q);
    throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
  }

  createDocument(res, body) {
    const documentId = id("doc");
    const doc = this.makeDocument(documentId, body.title || "Untitled document");
    this.documents.set(documentId, doc);
    return this.sendJson(res, 200, this.publicDocument(doc));
  }

  getDocument(res, documentId, q) {
    const doc = this.mustDocument(documentId);
    const suggestionsViewMode = q.get("suggestionsViewMode") || undefined;
    const includeTabsContent = q.get("includeTabsContent") === "true";
    return this.sendJson(res, 200, this.publicDocument(doc, { suggestionsViewMode, includeTabsContent }));
  }

  batchUpdate(res, documentId, body) {
    const doc = this.mustDocument(documentId);
    if (!Array.isArray(body.requests)) throw new ApiError(400, "Invalid value at 'requests' (type.googleapis.com/google.apps.docs.v1.Request), must be an array", "invalidArgument");
    if (body.writeControl?.requiredRevisionId && body.writeControl.requiredRevisionId !== doc.revisionId) {
      throw new ApiError(400, "The required revision ID does not match the latest revision ID.", "failedPrecondition");
    }
    const snapshot = this.snapshotDocument(doc);
    let replies;
    try {
      replies = body.requests.map((request) => this.applyRequest(doc, request || {}));
      doc.revisionId = id("rev");
      doc.modifiedTime = now();
    } catch (error) {
      this.restoreDocument(doc, snapshot);
      throw error;
    }
    return this.sendJson(res, 200, { documentId, replies, writeControl: { requiredRevisionId: doc.revisionId } });
  }

  applyRequest(doc, request) {
    const entries = Object.entries(request).filter(([, value]) => value !== undefined && value !== null);
    if (entries.length !== 1) throw new ApiError(400, "Exactly one request field must be set.", "invalidArgument");
    const [type, payload] = entries[0];
    const handlers = {
      insertText: () => this.insertText(doc, payload),
      deleteContentRange: () => this.deleteContentRange(doc, payload),
      replaceAllText: () => this.replaceAllText(doc, payload),
      updateTextStyle: () => this.updateTextStyle(doc, payload),
      createParagraphBullets: () => this.createParagraphBullets(doc, payload),
      deleteParagraphBullets: () => this.deleteParagraphBullets(doc, payload),
      updateParagraphStyle: () => this.updateParagraphStyle(doc, payload),
      createNamedRange: () => this.createNamedRange(doc, payload),
      deleteNamedRange: () => this.deleteNamedRange(doc, payload),
      replaceNamedRangeContent: () => this.replaceNamedRangeContent(doc, payload),
      insertInlineImage: () => this.insertInlineImage(doc, payload),
      replaceImage: () => this.replaceImage(doc, payload),
      insertTable: () => this.insertTable(doc, payload),
      insertTableRow: () => this.insertTableRow(doc, payload),
      insertTableColumn: () => this.insertTableColumn(doc, payload),
      deleteTableRow: () => this.deleteTableRow(doc, payload),
      deleteTableColumn: () => this.deleteTableColumn(doc, payload),
      deleteTable: () => this.deleteTable(doc, payload),
      mergeTableCells: () => this.mergeTableCells(doc, payload),
      unmergeTableCells: () => this.unmergeTableCells(doc, payload),
      updateTableCellStyle: () => this.updateTableCellStyle(doc, payload),
      updateTableColumnProperties: () => this.updateTableColumnProperties(doc, payload),
      updateTableRowStyle: () => this.updateTableRowStyle(doc, payload),
      insertPageBreak: () => this.insertPageBreak(doc, payload),
      insertSectionBreak: () => this.insertSectionBreak(doc, payload),
      updateDocumentStyle: () => this.updateDocumentStyle(doc, payload),
      updateSectionStyle: () => this.updateSectionStyle(doc, payload),
      createHeader: () => this.createHeader(doc, payload),
      deleteHeader: () => this.deleteHeader(doc, payload),
      createFooter: () => this.createFooter(doc, payload),
      deleteFooter: () => this.deleteFooter(doc, payload),
      createFootnote: () => this.createFootnote(doc, payload),
      deletePositionedObject: () => this.deletePositionedObject(doc, payload),
      pinTableHeaderRows: () => this.pinTableHeaderRows(doc, payload),
      addDocumentTab: () => this.addDocumentTab(doc, payload),
      deleteTab: () => this.deleteTab(doc, payload),
      updateDocumentTabProperties: () => this.updateDocumentTabProperties(doc, payload),
      updateNamedStyle: () => this.updateNamedStyle(doc, payload),
      insertDate: () => this.insertDate(doc, payload),
      insertPerson: () => this.insertPerson(doc, payload),
      insertRichLink: () => this.insertRichLink(doc, payload),
    };
    if (!handlers[type]) throw new ApiError(400, `Unsupported request type: ${type}`, "invalidArgument");
    return handlers[type]();
  }

  insertText(doc, request) {
    const text = String(request.text ?? "");
    if (!text) throw new ApiError(400, "Text cannot be empty.", "invalidArgument");
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    this.spliceText(doc, index, index, text);
    return {};
  }

  deleteContentRange(doc, request) {
    const range = this.validRange(doc, request.range);
    if (range.startIndex === 1 && range.endIndex >= doc.text.length + 1) throw new ApiError(400, "Cannot delete the last newline character of a segment.", "invalidArgument");
    this.spliceText(doc, range.startIndex, range.endIndex, "");
    return {};
  }

  replaceAllText(doc, request) {
    const needle = request.containsText?.text;
    if (!needle) throw new ApiError(400, "containsText.text is required.", "invalidArgument");
    const replacement = String(request.replaceText ?? "");
    const matchCase = request.containsText.matchCase === true;
    let occurrencesChanged = 0;
    let start = textMatches(doc.text, needle, matchCase);
    while (start >= 0) {
      doc.text = doc.text.slice(0, start) + replacement + doc.text.slice(start + needle.length);
      occurrencesChanged += 1;
      const nextFrom = start + replacement.length;
      const remaining = doc.text.slice(nextFrom);
      const next = textMatches(remaining, needle, matchCase);
      start = next < 0 ? -1 : nextFrom + next;
    }
    return { replaceAllText: { occurrencesChanged } };
  }

  updateTextStyle(doc, request) {
    const range = this.validRange(doc, request.range);
    doc.textStyles.push({ range, textStyle: clone(request.textStyle || {}), fields: request.fields || "*" });
    return {};
  }

  createParagraphBullets(doc, request) {
    const range = this.validRange(doc, request.range);
    doc.bullets.push({ range, bulletPreset: request.bulletPreset || "BULLET_DISC_CIRCLE_SQUARE" });
    return {};
  }

  deleteParagraphBullets(doc, request) {
    const range = this.validRange(doc, request.range);
    doc.bullets = doc.bullets.filter((bullet) => !rangesOverlap(bullet.range, range));
    return {};
  }

  updateParagraphStyle(doc, request) {
    const range = this.validRange(doc, request.range);
    doc.paragraphStyles.push({ range, paragraphStyle: clone(request.paragraphStyle || {}), fields: request.fields || "*" });
    return {};
  }

  createNamedRange(doc, request) {
    if (!request.name) throw new ApiError(400, "name is required.", "invalidArgument");
    const namedRangeId = id("namedRange");
    const namedRange = { namedRangeId, name: request.name, ranges: [this.validRange(doc, request.range)] };
    doc.namedRanges[request.name] = { name: request.name, namedRanges: [...(doc.namedRanges[request.name]?.namedRanges || []), namedRange] };
    return { createNamedRange: { namedRangeId } };
  }

  deleteNamedRange(doc, request) {
    let deleted = false;
    for (const [name, group] of Object.entries(doc.namedRanges)) {
      const kept = group.namedRanges.filter((range) => {
        const remove = (request.name && range.name === request.name) || (request.namedRangeId && range.namedRangeId === request.namedRangeId);
        if (remove) deleted = true;
        return !remove;
      });
      if (kept.length) group.namedRanges = kept;
      else delete doc.namedRanges[name];
    }
    if (!deleted) throw new ApiError(404, "Named range not found.", "notFound");
    return {};
  }

  replaceNamedRangeContent(doc, request) {
    const ranges = this.findNamedRanges(doc, request);
    const text = String(request.text ?? "");
    for (const range of ranges.sort((a, b) => b.startIndex - a.startIndex)) this.spliceText(doc, range.startIndex, range.endIndex, text);
    return {};
  }

  insertInlineImage(doc, request) {
    if (!request.uri) throw new ApiError(400, "uri is required.", "invalidArgument");
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    const objectId = request.objectId || id("inlineObject");
    doc.inlineObjects[objectId] = {
      objectId,
      inlineObjectProperties: {
        embeddedObject: {
          title: request.uri,
          imageProperties: { sourceUri: request.uri, contentUri: request.uri },
          size: clone(request.objectSize || {}),
        },
      },
    };
    this.spliceText(doc, index, index, "\uFFFC");
    return { insertInlineImage: { objectId } };
  }

  replaceImage(doc, request) {
    const object = doc.inlineObjects[request.imageObjectId] || doc.positionedObjects[request.imageObjectId];
    if (!object) throw new ApiError(404, "Image not found.", "notFound");
    const embedded = object.inlineObjectProperties?.embeddedObject || object.positionedObjectProperties?.embeddedObject;
    embedded.imageProperties = { ...(embedded.imageProperties || {}), sourceUri: request.uri, contentUri: request.uri };
    embedded.replaceMethod = request.imageReplaceMethod || "CENTER_CROP";
    return {};
  }

  insertTable(doc, request) {
    const rows = Number(request.rows || 0);
    const columns = Number(request.columns || 0);
    if (rows < 1 || columns < 1) throw new ApiError(400, "rows and columns must be positive.", "invalidArgument");
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    const tableId = id("table");
    const table = { tableId, startIndex: index, rows, columns, headerRows: 0, mergedRanges: [], cellStyleUpdates: [], rowStyleUpdates: [], columnPropertyUpdates: [] };
    doc.tables.set(index, table);
    this.spliceText(doc, index, index, "\n");
    return {};
  }

  insertTableRow(doc, request) {
    const table = this.tableAt(doc, request.tableCellLocation?.tableStartLocation?.index);
    table.rows += 1;
    return {};
  }

  insertTableColumn(doc, request) {
    const table = this.tableAt(doc, request.tableCellLocation?.tableStartLocation?.index);
    table.columns += 1;
    return {};
  }

  deleteTableRow(doc, request) {
    const table = this.tableAt(doc, request.tableCellLocation?.tableStartLocation?.index);
    table.rows = Math.max(0, table.rows - 1);
    if (table.rows === 0) doc.tables.delete(table.startIndex);
    return {};
  }

  deleteTableColumn(doc, request) {
    const table = this.tableAt(doc, request.tableCellLocation?.tableStartLocation?.index);
    table.columns = Math.max(0, table.columns - 1);
    if (table.columns === 0) doc.tables.delete(table.startIndex);
    return {};
  }

  deleteTable(doc, request) {
    const table = this.tableAt(doc, request.tableCellLocation?.tableStartLocation?.index);
    doc.tables.delete(table.startIndex);
    return {};
  }

  mergeTableCells(doc, request) {
    const table = this.tableAt(doc, request.tableRange?.tableCellLocation?.tableStartLocation?.index);
    table.mergedRanges.push(clone(request.tableRange));
    return {};
  }

  unmergeTableCells(doc, request) {
    const table = this.tableAt(doc, request.tableRange?.tableCellLocation?.tableStartLocation?.index);
    table.mergedRanges = [];
    return {};
  }

  updateTableCellStyle(doc, request) {
    const table = this.tableAt(doc, request.tableRange?.tableCellLocation?.tableStartLocation?.index);
    table.cellStyleUpdates.push({ tableRange: clone(request.tableRange), tableCellStyle: clone(request.tableCellStyle || {}), fields: request.fields || "*" });
    return {};
  }

  updateTableColumnProperties(doc, request) {
    const table = this.tableAt(doc, request.tableStartLocation?.index);
    table.columnPropertyUpdates.push({ columnIndices: request.columnIndices || [], tableColumnProperties: clone(request.tableColumnProperties || {}), fields: request.fields || "*" });
    return {};
  }

  updateTableRowStyle(doc, request) {
    const table = this.tableAt(doc, request.tableStartLocation?.index);
    table.rowStyleUpdates.push({ rowIndices: request.rowIndices || [], tableRowStyle: clone(request.tableRowStyle || {}), fields: request.fields || "*" });
    return {};
  }

  pinTableHeaderRows(doc, request) {
    const table = this.tableAt(doc, request.tableStartLocation?.index);
    table.headerRows = Number(request.pinnedHeaderRowsCount || 0);
    return {};
  }

  insertPageBreak(doc, request) {
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    this.spliceText(doc, index, index, "\n");
    return {};
  }

  insertSectionBreak(doc, request) {
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    doc.sectionBreaks.push({ startIndex: index, sectionType: request.sectionType || "NEXT_PAGE" });
    this.spliceText(doc, index, index, "\n");
    return {};
  }

  updateDocumentStyle(doc, request) {
    applyFields(doc.documentStyle, request.documentStyle || {}, request.fields);
    return {};
  }

  updateSectionStyle(doc, request) {
    const range = this.validRange(doc, request.range || { startIndex: 1, endIndex: doc.text.length + 1 });
    doc.sectionStyles.push({ range, sectionStyle: clone(request.sectionStyle || {}), fields: request.fields || "*" });
    return {};
  }

  createHeader(doc, request) {
    const headerId = id("header");
    doc.headers[headerId] = { headerId, content: [] };
    doc.documentStyle.defaultHeaderId = headerId;
    return { createHeader: { headerId } };
  }

  deleteHeader(doc, request) {
    if (!doc.headers[request.headerId]) throw new ApiError(404, "Header not found.", "notFound");
    delete doc.headers[request.headerId];
    if (doc.documentStyle.defaultHeaderId === request.headerId) delete doc.documentStyle.defaultHeaderId;
    return {};
  }

  createFooter(doc, request) {
    const footerId = id("footer");
    doc.footers[footerId] = { footerId, content: [] };
    doc.documentStyle.defaultFooterId = footerId;
    return { createFooter: { footerId } };
  }

  deleteFooter(doc, request) {
    if (!doc.footers[request.footerId]) throw new ApiError(404, "Footer not found.", "notFound");
    delete doc.footers[request.footerId];
    if (doc.documentStyle.defaultFooterId === request.footerId) delete doc.documentStyle.defaultFooterId;
    return {};
  }

  createFootnote(doc, request) {
    const footnoteId = id("footnote");
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    doc.footnotes[footnoteId] = { footnoteId, content: [] };
    this.spliceText(doc, index, index, "\uFFFC");
    return { createFootnote: { footnoteId } };
  }

  deletePositionedObject(doc, request) {
    if (!doc.positionedObjects[request.objectId]) throw new ApiError(404, "Positioned object not found.", "notFound");
    delete doc.positionedObjects[request.objectId];
    return {};
  }

  addDocumentTab(doc, request) {
    const tabId = request.tabProperties?.tabId || id("tab");
    if (doc.tabs.some((tab) => tab.tabProperties.tabId === tabId)) throw new ApiError(409, "Tab already exists.", "alreadyExists");
    const tab = {
      tabProperties: {
        tabId,
        title: request.tabProperties?.title || "Untitled tab",
        parentTabId: request.tabProperties?.parentTabId,
        index: request.tabProperties?.index ?? doc.tabs.length,
        nestingLevel: request.tabProperties?.parentTabId ? 1 : 0,
        iconEmoji: request.tabProperties?.iconEmoji,
      },
      childTabs: [],
      documentTab: this.documentTab(doc),
    };
    doc.tabs.push(tab);
    return { addDocumentTab: { tabProperties: clone(tab.tabProperties) } };
  }

  deleteTab(doc, request) {
    const tabId = request.tabId;
    const index = doc.tabs.findIndex((tab) => tab.tabProperties.tabId === tabId);
    if (index < 0) throw new ApiError(404, "Tab not found.", "notFound");
    if (doc.tabs.length === 1) throw new ApiError(400, "Cannot delete the last tab.", "invalidArgument");
    doc.tabs.splice(index, 1);
    doc.tabs.forEach((tab, tabIndex) => { tab.tabProperties.index = tabIndex; });
    return {};
  }

  updateDocumentTabProperties(doc, request) {
    const tabId = request.tabProperties?.tabId;
    const tab = doc.tabs.find((item) => item.tabProperties.tabId === tabId);
    if (!tab) throw new ApiError(404, "Tab not found.", "notFound");
    applyFields(tab.tabProperties, request.tabProperties || {}, request.fields);
    return {};
  }

  updateNamedStyle(doc, request) {
    const namedStyleType = request.namedStyleType || request.namedStyle?.namedStyleType;
    if (!namedStyleType) throw new ApiError(400, "namedStyleType is required.", "invalidArgument");
    const existing = doc.namedStyles.styles.find((style) => style.namedStyleType === namedStyleType);
    const target = existing || { namedStyleType, textStyle: {}, paragraphStyle: {} };
    if (!existing) doc.namedStyles.styles.push(target);
    applyFields(target.textStyle, request.textStyle || request.namedStyle?.textStyle || {}, request.fields || "*");
    applyFields(target.paragraphStyle, request.paragraphStyle || request.namedStyle?.paragraphStyle || {}, request.fields || "*");
    return {};
  }

  insertDate(doc, request) {
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    const date = request.date || {};
    const text = request.text || [date.year, date.month, date.day].filter(Boolean).join("-") || new Date().toISOString().slice(0, 10);
    doc.dates.push({ startIndex: index, date: clone(date), text });
    this.spliceText(doc, index, index, text);
    return {};
  }

  insertPerson(doc, request) {
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    const person = clone(request.personProperties || request.person || {});
    const text = person.email || person.name || person.displayName || "person";
    doc.people.push({ startIndex: index, personProperties: person });
    this.spliceText(doc, index, index, text);
    return {};
  }

  insertRichLink(doc, request) {
    const index = this.locationIndex(doc, request.location, request.endOfSegmentLocation);
    const richLinkId = request.richLinkId || id("richLink");
    const uri = request.uri || request.richLinkProperties?.uri || request.richLinkProperties?.title || richLinkId;
    doc.richLinks[richLinkId] = { richLinkId, startIndex: index, richLinkProperties: clone(request.richLinkProperties || { uri }) };
    this.spliceText(doc, index, index, uri);
    return {};
  }

  makeDocument(documentId, title) {
    return {
      documentId,
      title,
      text: "\n",
      revisionId: id("rev"),
      createdTime: now(),
      modifiedTime: now(),
      namedRanges: {},
      inlineObjects: {},
      positionedObjects: {},
      headers: {},
      footers: {},
      footnotes: {},
      lists: {},
      tabs: [{ tabProperties: { tabId: "tab_0", title, index: 0, nestingLevel: 0 }, childTabs: [] }],
      namedStyles: { styles: [{ namedStyleType: "NORMAL_TEXT", textStyle: {}, paragraphStyle: { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" } }] },
      dates: [],
      people: [],
      richLinks: {},
      tables: new Map(),
      textStyles: [],
      paragraphStyles: [],
      sectionStyles: [],
      sectionBreaks: [],
      bullets: [],
      documentStyle: {
        background: { color: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } },
        pageSize: { width: { magnitude: 612, unit: "PT" }, height: { magnitude: 792, unit: "PT" } },
        marginTop: { magnitude: 72, unit: "PT" },
        marginBottom: { magnitude: 72, unit: "PT" },
        marginLeft: { magnitude: 72, unit: "PT" },
        marginRight: { magnitude: 72, unit: "PT" },
      },
    };
  }

  snapshotDocument(doc) {
    return { data: clone({ ...doc, tables: undefined }), tables: clone([...doc.tables.entries()]) };
  }

  restoreDocument(doc, snapshot) {
    for (const key of Object.keys(doc)) delete doc[key];
    Object.assign(doc, clone(snapshot.data));
    doc.tables = new Map(snapshot.tables);
  }

  publicDocument(doc, options = {}) {
    const documentTab = this.documentTab(doc);
    const includeTabsContent = options.includeTabsContent === true;
    const document = {
      documentId: doc.documentId,
      title: doc.title,
      revisionId: doc.revisionId,
      suggestionsViewMode: options.suggestionsViewMode || "DEFAULT_FOR_CURRENT_ACCESS",
      body: includeTabsContent ? undefined : documentTab.body,
      headers: includeTabsContent ? undefined : clone(doc.headers),
      footers: includeTabsContent ? undefined : clone(doc.footers),
      footnotes: includeTabsContent ? undefined : clone(doc.footnotes),
      documentStyle: includeTabsContent ? undefined : clone(doc.documentStyle),
      namedRanges: includeTabsContent ? undefined : clone(doc.namedRanges),
      inlineObjects: includeTabsContent ? undefined : clone(doc.inlineObjects),
      positionedObjects: includeTabsContent ? undefined : clone(doc.positionedObjects),
      lists: includeTabsContent ? undefined : clone(doc.lists),
      namedStyles: includeTabsContent ? undefined : clone(doc.namedStyles),
      tabs: includeTabsContent ? doc.tabs.map((tab) => ({ ...clone(tab), documentTab })) : [],
    };
    return Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined));
  }

  documentTab(doc) {
    return {
      body: { content: this.bodyContent(doc) },
      headers: clone(doc.headers),
      footers: clone(doc.footers),
      footnotes: clone(doc.footnotes),
      documentStyle: clone(doc.documentStyle),
      namedStyles: clone(doc.namedStyles),
      lists: clone(doc.lists),
      namedRanges: clone(doc.namedRanges),
      inlineObjects: clone(doc.inlineObjects),
      positionedObjects: clone(doc.positionedObjects),
    };
  }

  bodyContent(doc) {
    const content = [];
    let index = 1;
    for (const table of [...doc.tables.values()].sort((a, b) => a.startIndex - b.startIndex)) {
      if (table.startIndex >= index) {
        const before = doc.text.slice(index - 1, table.startIndex - 1);
        content.push(...this.paragraphsForText(before, index, doc));
        index = table.startIndex;
      }
      content.push(this.publicTable(table));
    }
    content.push(...this.paragraphsForText(doc.text.slice(index - 1), index, doc));
    return content.length ? content : this.paragraphsForText("\n", 1, doc);
  }

  paragraphsForText(text, startIndex, doc) {
    if (!text) return [];
    const paragraphs = [];
    let cursor = startIndex;
    const chunks = text.match(/[^\n]*\n|[^\n]+$/g) || ["\n"];
    for (const chunk of chunks) {
      const endIndex = cursor + chunk.length;
      paragraphs.push({
        startIndex: cursor,
        endIndex,
        paragraph: {
          elements: [{ startIndex: cursor, endIndex, textRun: { content: chunk, textStyle: this.styleAt(doc, cursor, endIndex) } }],
          paragraphStyle: this.paragraphStyleAt(doc, cursor, endIndex),
          bullet: this.bulletAt(doc, cursor, endIndex),
        },
      });
      cursor = endIndex;
    }
    return paragraphs;
  }

  publicTable(table) {
    return {
      startIndex: table.startIndex,
      endIndex: table.startIndex + 1,
      table: {
        rows: table.rows,
        columns: table.columns,
        tableRows: Array.from({ length: table.rows }, (_, rowIndex) => ({
          startIndex: table.startIndex,
          endIndex: table.startIndex + 1,
          tableCells: Array.from({ length: table.columns }, (_, columnIndex) => ({
            startIndex: table.startIndex,
            endIndex: table.startIndex + 1,
            content: this.paragraphsForText("\n", table.startIndex, { textStyles: [], paragraphStyles: [], bullets: [] }),
            rowSpan: 1,
            columnSpan: 1,
            tableCellStyle: table.cellStyleUpdates.at(-1)?.tableCellStyle || {},
            rowIndex,
            columnIndex,
          })),
          tableRowStyle: table.rowStyleUpdates.at(-1)?.tableRowStyle || {},
        })),
      },
    };
  }

  styleAt(doc, startIndex, endIndex) {
    return doc.textStyles.find((style) => rangesOverlap(style.range, { startIndex, endIndex }))?.textStyle || {};
  }

  paragraphStyleAt(doc, startIndex, endIndex) {
    return doc.paragraphStyles.find((style) => rangesOverlap(style.range, { startIndex, endIndex }))?.paragraphStyle || { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" };
  }

  bulletAt(doc, startIndex, endIndex) {
    const bullet = doc.bullets.find((item) => rangesOverlap(item.range, { startIndex, endIndex }));
    return bullet ? { listId: bullet.bulletPreset, textStyle: {} } : undefined;
  }

  mustDocument(documentId) {
    const doc = this.documents.get(documentId);
    if (!doc) throw new ApiError(404, "Requested entity was not found.", "notFound");
    return doc;
  }

  locationIndex(doc, location, endOfSegmentLocation) {
    if (endOfSegmentLocation) return doc.text.length;
    if (!location || typeof location.index !== "number") throw new ApiError(400, "location.index is required.", "invalidArgument");
    const index = Number(location.index);
    if (index < 1 || index > doc.text.length + 1) throw new ApiError(400, "Index must be within the bounds of the document.", "invalidArgument");
    return index;
  }

  validRange(doc, range) {
    if (!range || typeof range.startIndex !== "number" || typeof range.endIndex !== "number") throw new ApiError(400, "range.startIndex and range.endIndex are required.", "invalidArgument");
    const startIndex = Number(range.startIndex);
    const endIndex = Number(range.endIndex);
    if (startIndex < 1 || endIndex <= startIndex || endIndex > doc.text.length + 1) throw new ApiError(400, "Range must be within the bounds of the document.", "invalidArgument");
    return { startIndex, endIndex, segmentId: range.segmentId, tabId: range.tabId };
  }

  spliceText(doc, startIndex, endIndex, replacement) {
    const start = startIndex - 1;
    const end = endIndex - 1;
    doc.text = doc.text.slice(0, start) + replacement + doc.text.slice(end);
    if (!doc.text.endsWith("\n")) doc.text += "\n";
  }

  findNamedRanges(doc, request) {
    const ranges = [];
    for (const group of Object.values(doc.namedRanges)) {
      for (const namedRange of group.namedRanges) {
        if ((request.namedRangeName && namedRange.name === request.namedRangeName) || (request.name && namedRange.name === request.name) || (request.namedRangeId && namedRange.namedRangeId === request.namedRangeId)) ranges.push(...namedRange.ranges);
      }
    }
    if (!ranges.length) throw new ApiError(404, "Named range not found.", "notFound");
    return ranges;
  }

  tableAt(doc, index) {
    if (typeof index !== "number") throw new ApiError(400, "tableStartLocation.index is required.", "invalidArgument");
    const table = doc.tables.get(Number(index));
    if (!table) throw new ApiError(404, "Table not found.", "notFound");
    return table;
  }

  sendJson(res, status, data) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
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

function rangesOverlap(a, b) {
  return a.startIndex < b.endIndex && b.startIndex < a.endIndex;
}

export default GoogleDocsServer;
