// parlel/google-sheets - lightweight, dependency-free fake of Google Sheets API v4.
// Compatible with the `googleapis` Sheets client when its rootUrl is pointed at
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

function colToIndex(col) {
  let n = 0;
  for (const c of String(col || "").toUpperCase()) n = n * 26 + c.charCodeAt(0) - 64;
  return Math.max(0, n - 1);
}

function indexToCol(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function valueFromCell(cell = {}) {
  const v = cell.userEnteredValue || cell.effectiveValue || cell;
  if (Object.prototype.hasOwnProperty.call(v, "stringValue")) return v.stringValue;
  if (Object.prototype.hasOwnProperty.call(v, "numberValue")) return v.numberValue;
  if (Object.prototype.hasOwnProperty.call(v, "boolValue")) return v.boolValue;
  if (Object.prototype.hasOwnProperty.call(v, "formulaValue")) return v.formulaValue;
  return "";
}

function cellFromValue(value) {
  const userEnteredValue = typeof value === "number"
    ? { numberValue: value }
    : typeof value === "boolean"
      ? { boolValue: value }
      : { stringValue: value == null ? "" : String(value) };
  return { userEnteredValue, effectiveValue: clone(userEnteredValue), formattedValue: String(value ?? "") };
}

function transpose(values) {
  const rows = values || [];
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return Array.from({ length: width }, (_, c) => rows.map((row) => row[c] ?? ""));
}

function trimValues(values) {
  const rows = values.map((row) => {
    const copy = row.slice();
    while (copy.length && (copy[copy.length - 1] === "" || copy[copy.length - 1] == null)) copy.pop();
    return copy;
  });
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

export class GoogleSheetsServer {
  constructor(port = 4613, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.spreadsheets = new Map();
    this._sheetId = 0;
    this._metadataId = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, error instanceof ApiError ? error : new ApiError(500, error.message || "Internal error", "internalError"));
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
    const pathname = decodeURIComponent(url.pathname);
    res.setHeader("x-google-sheets-emulator", "parlel");

    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "google-sheets", spreadsheets: this.spreadsheets.size });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/" || pathname === "/v4" || pathname === "/sheets/v4") {
      return this.sendJson(res, 200, { kind: "sheets#parlel" });
    }

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
    if (path.startsWith("/sheets/v4/")) path = path.slice("/sheets".length);
    if (!path.startsWith("/v4/")) throw new ApiError(404, `Unsupported path: ${pathname}`, "notFound");
    const parts = path.slice("/v4/".length).split("/").filter(Boolean);
    if (parts[0] !== "spreadsheets") throw new ApiError(404, "Not Found", "notFound");
    return this.routeSpreadsheets(res, method, parts.slice(1), url.searchParams, body);
  }

  routeSpreadsheets(res, method, parts, q, body) {
    if (parts.length === 0) {
      if (method === "POST") return this.createSpreadsheet(res, body);
      throw new ApiError(405, "Method not allowed", "methodNotAllowed");
    }

    if (parts[0].endsWith(":getByDataFilter") && method === "POST") return this.getSpreadsheetByDataFilter(res, parts[0].slice(0, -":getByDataFilter".length), body);
    if (parts[0].endsWith(":batchUpdate") && method === "POST") return this.batchUpdate(res, parts[0].slice(0, -":batchUpdate".length), body);

    const spreadsheetId = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.getSpreadsheet(res, spreadsheetId, q);
      throw new ApiError(405, "Method not allowed", "methodNotAllowed");
    }

    const ss = this.mustSpreadsheet(spreadsheetId);
    if (parts[1] === "values" || parts[1]?.startsWith("values:")) return this.routeValues(res, method, ss, parts.slice(2), q, body, parts[1]);
    if (parts[1] === "developerMetadata" || parts[1]?.startsWith("developerMetadata:")) return this.routeDeveloperMetadata(res, method, ss, parts.slice(2), body, parts[1]);
    if (parts[1] === "sheets" && parts.length === 3 && parts[2].endsWith(":copyTo") && method === "POST") return this.copySheetTo(res, ss, Number(parts[2].slice(0, -":copyTo".length)), body);
    throw new ApiError(404, "Requested entity was not found.", "notFound");
  }

  createSpreadsheet(res, body) {
    const spreadsheetId = body.spreadsheetId || id("spreadsheet");
    if (this.spreadsheets.has(spreadsheetId)) throw new ApiError(409, "Spreadsheet already exists", "alreadyExists");
    const sheets = (body.sheets?.length ? body.sheets : [{ properties: { title: "Sheet1" } }]).map((sheet, index) => this.makeSheet(sheet.properties || {}, index, sheet.data));
    const ss = {
      spreadsheetId,
      properties: { title: body.properties?.title || "Untitled spreadsheet", locale: "en_US", autoRecalc: "ON_CHANGE", timeZone: "Etc/GMT", ...body.properties },
      sheets,
      namedRanges: body.namedRanges || [],
      developerMetadata: body.developerMetadata || [],
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    };
    this.spreadsheets.set(spreadsheetId, ss);
    return this.sendJson(res, 200, this.publicSpreadsheet(ss, true));
  }

  getSpreadsheet(res, spreadsheetId, q) {
    const ss = this.mustSpreadsheet(spreadsheetId);
    const includeGridData = q.get("includeGridData") === "true";
    const ranges = q.getAll("ranges");
    return this.sendJson(res, 200, this.publicSpreadsheet(ss, includeGridData, ranges));
  }

  getSpreadsheetByDataFilter(res, spreadsheetId, body) {
    const ss = this.mustSpreadsheet(spreadsheetId);
    const ranges = (body.dataFilters || []).map((f) => f.a1Range).filter(Boolean);
    return this.sendJson(res, 200, this.publicSpreadsheet(ss, body.includeGridData !== false, ranges));
  }

  batchUpdate(res, spreadsheetId, body) {
    const ss = this.mustSpreadsheet(spreadsheetId);
    const replies = (body.requests || []).map((request) => this.applyBatchRequest(ss, request));
    return this.sendJson(res, 200, { spreadsheetId, replies, updatedSpreadsheet: body.includeSpreadsheetInResponse ? this.publicSpreadsheet(ss, true) : undefined });
  }

  routeValues(res, method, ss, parts, q, body, collectionPart) {
    if (collectionPart === "values:batchGet" && method === "GET") return this.batchGetValues(res, ss, q);
    if (collectionPart === "values:batchUpdate" && method === "POST") return this.batchUpdateValues(res, ss, body);
    if (collectionPart === "values:batchClear" && method === "POST") return this.batchClearValues(res, ss, body);
    if (collectionPart === "values:batchGetByDataFilter" && method === "POST") return this.batchGetValuesByDataFilter(res, ss, body);
    if (collectionPart === "values:batchUpdateByDataFilter" && method === "POST") return this.batchUpdateValuesByDataFilter(res, ss, body);
    if (collectionPart === "values:batchClearByDataFilter" && method === "POST") return this.batchClearValuesByDataFilter(res, ss, body);

    const rangeWithVerb = parts.join("/");
    if (!rangeWithVerb) throw new ApiError(404, "Not Found", "notFound");
    if (rangeWithVerb.endsWith(":append") && method === "POST") return this.appendValues(res, ss, rangeWithVerb.slice(0, -":append".length), q, body);
    if (rangeWithVerb.endsWith(":clear") && method === "POST") return this.clearValues(res, ss, rangeWithVerb.slice(0, -":clear".length));
    if (method === "GET") return this.getValues(res, ss, rangeWithVerb, q);
    if (method === "PUT") return this.updateValues(res, ss, rangeWithVerb, q, body);
    throw new ApiError(405, "Method not allowed", "methodNotAllowed");
  }

  routeDeveloperMetadata(res, method, ss, parts, body, collectionPart) {
    if (collectionPart === "developerMetadata:search" && method === "POST") return this.searchDeveloperMetadata(res, ss, body);
    if (parts.length === 1 && method === "GET") {
      const item = ss.developerMetadata.find((m) => String(m.metadataId) === String(parts[0]));
      if (!item) throw new ApiError(404, "Developer metadata not found", "notFound");
      return this.sendJson(res, 200, item);
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  makeSheet(properties = {}, index = 0, data) {
    this._sheetId += 1;
    const sheetId = properties.sheetId ?? this._sheetId;
    this._sheetId = Math.max(this._sheetId, Number(sheetId));
    return {
      properties: {
        sheetId,
        title: properties.title || `Sheet${index + 1}`,
        index: properties.index ?? index,
        sheetType: properties.sheetType || "GRID",
        gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 0, frozenColumnCount: 0, ...(properties.gridProperties || {}) },
        hidden: properties.hidden || false,
        tabColor: properties.tabColor,
      },
      data: data || [],
      basicFilter: null,
      merges: [],
    };
  }

  mustSpreadsheet(spreadsheetId) {
    const ss = this.spreadsheets.get(spreadsheetId);
    if (!ss) throw new ApiError(404, "Requested entity was not found.", "notFound");
    return ss;
  }

  // The real Sheets API requires a valueInputOption on update/append/batchUpdate
  // writes; omitting it or sending an unsupported value returns 400 INVALID_ARGUMENT.
  requireValueInputOption(option) {
    if (option == null || option === "") {
      throw new ApiError(400, "Invalid value at 'data.value_input_option' (TYPE_ENUM), \"\"", "badRequest");
    }
    if (option !== "RAW" && option !== "USER_ENTERED") {
      throw new ApiError(400, `Invalid value at 'value_input_option' (type.googleapis.com/google.apps.sheets.v4.ValueInputOption), "${option}"`, "badRequest");
    }
  }

  sheetByTitle(ss, title) {
    const sheet = ss.sheets.find((s) => s.properties.title === title);
    if (!sheet) throw new ApiError(400, `Unable to parse range: ${title}`, "badRequest");
    return sheet;
  }

  sheetById(ss, sheetId) {
    const sheet = ss.sheets.find((s) => Number(s.properties.sheetId) === Number(sheetId));
    if (!sheet) throw new ApiError(404, "Sheet not found", "notFound");
    return sheet;
  }

  parseA1(ss, rawRange) {
    const raw = String(rawRange || "");
    let title = ss.sheets[0]?.properties.title;
    let a1 = raw;
    const bang = raw.lastIndexOf("!");
    if (bang >= 0) {
      title = raw.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
      a1 = raw.slice(bang + 1);
    }
    const sheet = this.sheetByTitle(ss, title);
    if (!a1) a1 = "A1";
    const match = a1.match(/^([A-Za-z]*)(\d*)?(?::([A-Za-z]*)(\d*)?)?$/);
    if (!match) throw new ApiError(400, `Unable to parse range: ${rawRange}`, "badRequest");
    const [, sc, sr, ec, er] = match;
    const startCol = sc ? colToIndex(sc) : 0;
    const startRow = sr ? Number(sr) - 1 : 0;
    const singleCell = sc && sr && ec == null && er == null;
    const endCol = ec ? colToIndex(ec) + 1 : singleCell ? startCol + 1 : sheet.properties.gridProperties.columnCount;
    const endRow = er ? Number(er) : singleCell ? startRow + 1 : sheet.properties.gridProperties.rowCount;
    if (startRow < 0 || startCol < 0 || endRow < startRow || endCol < startCol) throw new ApiError(400, `Unable to parse range: ${rawRange}`, "badRequest");
    return { sheet, sheetTitle: sheet.properties.title, startRow, startCol, endRow, endCol };
  }

  parseGridRange(ss, gridRange = {}) {
    const sheet = gridRange.sheetId == null ? ss.sheets[0] : this.sheetById(ss, gridRange.sheetId);
    return {
      sheet,
      sheetTitle: sheet.properties.title,
      startRow: gridRange.startRowIndex || 0,
      endRow: gridRange.endRowIndex ?? sheet.properties.gridProperties.rowCount,
      startCol: gridRange.startColumnIndex || 0,
      endCol: gridRange.endColumnIndex ?? sheet.properties.gridProperties.columnCount,
    };
  }

  rangeName(r) {
    return `${r.sheetTitle}!${indexToCol(r.startCol)}${r.startRow + 1}:${indexToCol(Math.max(r.startCol, r.endCol - 1))}${Math.max(r.startRow + 1, r.endRow)}`;
  }

  ensureCell(sheet, row, col) {
    while (sheet.data.length <= row) sheet.data.push([]);
    while (sheet.data[row].length <= col) sheet.data[row].push("");
  }

  valuesForRange(r, majorDimension = "ROWS") {
    const values = [];
    for (let row = r.startRow; row < r.endRow; row++) {
      const out = [];
      for (let col = r.startCol; col < r.endCol; col++) out.push(r.sheet.data[row]?.[col] ?? "");
      values.push(out);
    }
    const trimmed = trimValues(values);
    return majorDimension === "COLUMNS" ? transpose(trimmed) : trimmed;
  }

  setValues(r, values = [], majorDimension = "ROWS") {
    const rows = majorDimension === "COLUMNS" ? transpose(values) : values;
    let cells = 0;
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < (rows[y] || []).length; x++) {
        this.ensureCell(r.sheet, r.startRow + y, r.startCol + x);
        r.sheet.data[r.startRow + y][r.startCol + x] = rows[y][x];
        cells += 1;
      }
    }
    return { rows: rows.length, columns: rows.reduce((m, row) => Math.max(m, row.length), 0), cells };
  }

  clearRange(r) {
    let cells = 0;
    for (let row = r.startRow; row < r.endRow; row++) {
      for (let col = r.startCol; col < r.endCol; col++) {
        if (r.sheet.data[row]?.[col] !== undefined && r.sheet.data[row][col] !== "") cells += 1;
        if (r.sheet.data[row]) r.sheet.data[row][col] = "";
      }
    }
    return cells;
  }

  getValues(res, ss, range, q) {
    const r = this.parseA1(ss, range);
    return this.sendJson(res, 200, { range: this.rangeName(r), majorDimension: q.get("majorDimension") || "ROWS", values: this.valuesForRange(r, q.get("majorDimension") || "ROWS") });
  }

  updateValues(res, ss, range, q, body) {
    this.requireValueInputOption(q.get("valueInputOption"));
    const r = this.parseA1(ss, range);
    const updated = this.setValues(r, body.values || [], body.majorDimension || "ROWS");
    const response = { spreadsheetId: ss.spreadsheetId, updatedRange: this.rangeName({ ...r, endRow: r.startRow + updated.rows, endCol: r.startCol + updated.columns }), updatedRows: updated.rows, updatedColumns: updated.columns, updatedCells: updated.cells };
    if (q.get("includeValuesInResponse") === "true") response.updatedData = { range: response.updatedRange, majorDimension: body.majorDimension || "ROWS", values: this.valuesForRange(this.parseA1(ss, response.updatedRange), body.majorDimension || "ROWS") };
    return this.sendJson(res, 200, response);
  }

  appendValues(res, ss, range, q, body) {
    this.requireValueInputOption(q.get("valueInputOption"));
    const r = this.parseA1(ss, range);
    // Detect the existing "table" anchored at the start of the search range. The
    // real API returns the pre-append table range as `tableRange`, or "" when no
    // table is found (the anchor cell is empty).
    let row = r.startRow;
    let lastRow = r.startRow - 1;
    while (r.sheet.data[row]?.some((v) => v !== "" && v != null)) {
      lastRow = row;
      row += 1;
    }
    const hasTable = lastRow >= r.startRow;
    const tableRange = hasTable
      ? this.rangeName({ ...r, endRow: lastRow + 1, endCol: Math.max(r.startCol + 1, r.endCol) })
      : "";
    const writeRange = { ...r, startRow: row, endRow: row + (body.values || []).length };
    const updated = this.setValues(writeRange, body.values || [], body.majorDimension || "ROWS");
    return this.sendJson(res, 200, { spreadsheetId: ss.spreadsheetId, tableRange, updates: { spreadsheetId: ss.spreadsheetId, updatedRange: this.rangeName({ ...writeRange, endCol: writeRange.startCol + updated.columns }), updatedRows: updated.rows, updatedColumns: updated.columns, updatedCells: updated.cells } });
  }

  clearValues(res, ss, range) {
    const r = this.parseA1(ss, range);
    this.clearRange(r);
    return this.sendJson(res, 200, { spreadsheetId: ss.spreadsheetId, clearedRange: this.rangeName(r) });
  }

  batchGetValues(res, ss, q) {
    const ranges = q.getAll("ranges");
    const majorDimension = q.get("majorDimension") || "ROWS";
    return this.sendJson(res, 200, { spreadsheetId: ss.spreadsheetId, valueRanges: ranges.map((range) => {
      const r = this.parseA1(ss, range);
      return { range: this.rangeName(r), majorDimension, values: this.valuesForRange(r, majorDimension) };
    }) });
  }

  batchUpdateValues(res, ss, body) {
    this.requireValueInputOption(body.valueInputOption);
    let totalUpdatedRows = 0;
    let totalUpdatedColumns = 0;
    let totalUpdatedCells = 0;
    const responses = (body.data || []).map((entry) => {
      const r = this.parseA1(ss, entry.range);
      const updated = this.setValues(r, entry.values || [], entry.majorDimension || body.majorDimension || "ROWS");
      totalUpdatedRows += updated.rows;
      totalUpdatedColumns += updated.columns;
      totalUpdatedCells += updated.cells;
      return { spreadsheetId: ss.spreadsheetId, updatedRange: this.rangeName({ ...r, endRow: r.startRow + updated.rows, endCol: r.startCol + updated.columns }), updatedRows: updated.rows, updatedColumns: updated.columns, updatedCells: updated.cells };
    });
    return this.sendJson(res, 200, { spreadsheetId: ss.spreadsheetId, totalUpdatedRows, totalUpdatedColumns, totalUpdatedCells, totalUpdatedSheets: responses.length, responses });
  }

  batchClearValues(res, ss, body) {
    return this.sendJson(res, 200, { spreadsheetId: ss.spreadsheetId, clearedRanges: (body.ranges || []).map((range) => {
      const r = this.parseA1(ss, range);
      this.clearRange(r);
      return this.rangeName(r);
    }) });
  }

  dataFilterRange(ss, filter) {
    if (filter.a1Range) return this.parseA1(ss, filter.a1Range);
    if (filter.gridRange) return this.parseGridRange(ss, filter.gridRange);
    return this.parseGridRange(ss, {});
  }

  batchGetValuesByDataFilter(res, ss, body) {
    const majorDimension = body.majorDimension || "ROWS";
    return this.sendJson(res, 200, { spreadsheetId: ss.spreadsheetId, valueRanges: (body.dataFilters || []).map((dataFilter) => {
      const r = this.dataFilterRange(ss, dataFilter);
      return { dataFilters: [dataFilter], valueRange: { range: this.rangeName(r), majorDimension, values: this.valuesForRange(r, majorDimension) } };
    }) });
  }

  batchUpdateValuesByDataFilter(res, ss, body) {
    this.requireValueInputOption(body.valueInputOption);
    let totalUpdatedCells = 0;
    const responses = (body.data || []).map((entry) => {
      const r = this.dataFilterRange(ss, entry.dataFilter || {});
      const updated = this.setValues(r, entry.values || [], entry.majorDimension || "ROWS");
      totalUpdatedCells += updated.cells;
      return { updatedRange: this.rangeName({ ...r, endRow: r.startRow + updated.rows, endCol: r.startCol + updated.columns }), updatedRows: updated.rows, updatedColumns: updated.columns, updatedCells: updated.cells, dataFilter: entry.dataFilter };
    });
    return this.sendJson(res, 200, { spreadsheetId: ss.spreadsheetId, totalUpdatedCells, totalUpdatedRows: responses.reduce((n, r) => n + r.updatedRows, 0), totalUpdatedColumns: responses.reduce((n, r) => n + r.updatedColumns, 0), totalUpdatedSheets: responses.length, responses });
  }

  batchClearValuesByDataFilter(res, ss, body) {
    const clearedRanges = (body.dataFilters || []).map((filter) => {
      const r = this.dataFilterRange(ss, filter);
      this.clearRange(r);
      return this.rangeName(r);
    });
    return this.sendJson(res, 200, { spreadsheetId: ss.spreadsheetId, clearedRanges });
  }

  applyBatchRequest(ss, request) {
    if (request.addSheet) {
      const sheet = this.makeSheet(request.addSheet.properties || {}, ss.sheets.length);
      ss.sheets.push(sheet);
      this.reindex(ss);
      return { addSheet: { properties: clone(sheet.properties) } };
    }
    if (request.duplicateSheet) {
      const src = this.sheetById(ss, request.duplicateSheet.sourceSheetId);
      const sheet = this.makeSheet({ ...src.properties, sheetId: request.duplicateSheet.newSheetId, title: request.duplicateSheet.newSheetName || `${src.properties.title} Copy`, index: request.duplicateSheet.insertSheetIndex ?? ss.sheets.length }, ss.sheets.length, clone(src.data));
      ss.sheets.push(sheet);
      this.reindex(ss);
      return { duplicateSheet: { properties: clone(sheet.properties) } };
    }
    if (request.deleteSheet) {
      if (ss.sheets.length === 1) throw new ApiError(400, "You can't remove all the sheets in a document.", "badRequest");
      ss.sheets = ss.sheets.filter((s) => Number(s.properties.sheetId) !== Number(request.deleteSheet.sheetId));
      this.reindex(ss);
      return { deleteSheet: {} };
    }
    if (request.updateSheetProperties) {
      const sheet = this.sheetById(ss, request.updateSheetProperties.properties.sheetId);
      this.merge(sheet.properties, request.updateSheetProperties.properties, request.updateSheetProperties.fields);
      this.reindex(ss);
      return { updateSheetProperties: { properties: clone(sheet.properties) } };
    }
    if (request.updateSpreadsheetProperties) {
      this.merge(ss.properties, request.updateSpreadsheetProperties.properties || {}, request.updateSpreadsheetProperties.fields);
      return { updateSpreadsheetProperties: { properties: clone(ss.properties) } };
    }
    if (request.updateCells) {
      const start = request.updateCells.start || request.updateCells.range || {};
      const r = request.updateCells.range ? this.parseGridRange(ss, request.updateCells.range) : this.parseGridRange(ss, { sheetId: start.sheetId, startRowIndex: start.rowIndex, startColumnIndex: start.columnIndex });
      this.writeCellRows(r, request.updateCells.rows || []);
      return { updateCells: {} };
    }
    if (request.appendCells) {
      const sheet = this.sheetById(ss, request.appendCells.sheetId);
      const r = { sheet, sheetTitle: sheet.properties.title, startRow: sheet.data.length, startCol: 0, endRow: sheet.data.length + (request.appendCells.rows || []).length, endCol: sheet.properties.gridProperties.columnCount };
      this.writeCellRows(r, request.appendCells.rows || []);
      return { appendCells: {} };
    }
    if (request.repeatCell) {
      const r = this.parseGridRange(ss, request.repeatCell.range || {});
      const value = valueFromCell(request.repeatCell.cell || {});
      const rows = Array.from({ length: r.endRow - r.startRow }, () => Array.from({ length: r.endCol - r.startCol }, () => value));
      this.setValues(r, rows);
      return { repeatCell: {} };
    }
    if (request.createDeveloperMetadata || request.addDeveloperMetadata) {
      const createDeveloperMetadata = request.createDeveloperMetadata || request.addDeveloperMetadata;
      this._metadataId += 1;
      const metadata = { metadataId: this._metadataId, visibility: "DOCUMENT", location: { spreadsheet: true }, ...createDeveloperMetadata.developerMetadata };
      ss.developerMetadata.push(metadata);
      return { createDeveloperMetadata: { developerMetadata: clone(metadata) } };
    }
    if (request.updateDeveloperMetadata) {
      const matches = this.metadataMatches(ss, request.updateDeveloperMetadata.dataFilters || []);
      for (const metadata of matches) this.merge(metadata, request.updateDeveloperMetadata.developerMetadata || {}, request.updateDeveloperMetadata.fields);
      return { updateDeveloperMetadata: { developerMetadata: clone(matches) } };
    }
    if (request.deleteDeveloperMetadata) {
      const matches = this.metadataMatches(ss, request.deleteDeveloperMetadata.dataFilters || []);
      const ids = new Set(matches.map((m) => m.metadataId));
      ss.developerMetadata = ss.developerMetadata.filter((m) => !ids.has(m.metadataId));
      return { deleteDeveloperMetadata: { deletedDeveloperMetadata: clone(matches) } };
    }
    if (request.copyPaste) {
      const source = this.parseGridRange(ss, request.copyPaste.source || {});
      const destination = this.parseGridRange(ss, request.copyPaste.destination || {});
      this.setValues(destination, this.valuesForRange(source));
      return { copyPaste: {} };
    }
    if (request.setBasicFilter) {
      this.parseGridRange(ss, request.setBasicFilter.filter?.range || {}).sheet.basicFilter = request.setBasicFilter.filter;
      return { setBasicFilter: {} };
    }
    if (request.clearBasicFilter) {
      this.sheetById(ss, request.clearBasicFilter.sheetId).basicFilter = null;
      return { clearBasicFilter: {} };
    }
    if (request.appendDimension) {
      const sheet = this.sheetById(ss, request.appendDimension.sheetId);
      const key = request.appendDimension.dimension === "COLUMNS" ? "columnCount" : "rowCount";
      sheet.properties.gridProperties[key] += request.appendDimension.length || 0;
      return { appendDimension: {} };
    }
    if (request.insertDimension || request.deleteDimension || request.autoResizeDimensions || request.mergeCells || request.unmergeCells || request.updateBorders || request.updateDimensionProperties || request.addBanding || request.deleteBanding || request.updateBanding || request.addNamedRange || request.deleteNamedRange || request.updateNamedRange || request.addFilterView || request.duplicateFilterView || request.deleteFilterView || request.updateFilterView || request.sortRange || request.cutPaste || request.pasteData || request.textToColumns || request.deleteDuplicates || request.trimWhitespace || request.addProtectedRange || request.updateProtectedRange || request.deleteProtectedRange || request.addChart || request.updateChartSpec || request.deleteEmbeddedObject || request.addSlicer || request.updateSlicerSpec || request.randomizeRange) {
      return {};
    }
    return {};
  }

  writeCellRows(r, rows) {
    const values = rows.map((row) => (row.values || []).map(valueFromCell));
    this.setValues(r, values);
  }

  merge(target, source, fields) {
    if (!fields || fields === "*") {
      Object.assign(target, clone(source));
      return;
    }
    for (const field of fields.split(",").map((f) => f.trim()).filter(Boolean)) {
      const parts = field.split(".");
      let src = source;
      let dst = target;
      for (let i = 0; i < parts.length - 1; i++) {
        src = src?.[parts[i]];
        dst[parts[i]] ||= {};
        dst = dst[parts[i]];
      }
      const key = parts[parts.length - 1];
      if (src && Object.prototype.hasOwnProperty.call(src, key)) dst[key] = clone(src[key]);
    }
  }

  reindex(ss) {
    ss.sheets.sort((a, b) => (a.properties.index || 0) - (b.properties.index || 0));
    ss.sheets.forEach((sheet, index) => { sheet.properties.index = index; });
  }

  copySheetTo(res, ss, sheetId, body) {
    const destination = this.mustSpreadsheet(body.destinationSpreadsheetId);
    const source = this.sheetById(ss, sheetId);
    const sheet = this.makeSheet({ ...source.properties, sheetId: undefined, title: `${source.properties.title} Copy` }, destination.sheets.length, clone(source.data));
    destination.sheets.push(sheet);
    this.reindex(destination);
    return this.sendJson(res, 200, clone(sheet.properties));
  }

  searchDeveloperMetadata(res, ss, body) {
    return this.sendJson(res, 200, { matchedDeveloperMetadata: this.metadataMatches(ss, body.dataFilters || []).map((developerMetadata) => ({ developerMetadata, dataFilters: body.dataFilters || [] })) });
  }

  metadataMatches(ss, filters) {
    if (!filters.length) return ss.developerMetadata;
    return ss.developerMetadata.filter((metadata) => filters.some((filter) => {
      const lookup = filter.developerMetadataLookup;
      if (!lookup) return true;
      if (lookup.metadataId != null && Number(lookup.metadataId) !== Number(metadata.metadataId)) return false;
      if (lookup.metadataKey != null && lookup.metadataKey !== metadata.metadataKey) return false;
      if (lookup.metadataValue != null && lookup.metadataValue !== metadata.metadataValue) return false;
      if (lookup.visibility != null && lookup.visibility !== metadata.visibility) return false;
      return true;
    }));
  }

  publicSpreadsheet(ss, includeGridData = false, ranges = []) {
    const wanted = ranges.length ? ranges.map((range) => this.parseA1(ss, range).sheet.properties.sheetId) : null;
    return {
      spreadsheetId: ss.spreadsheetId,
      properties: clone(ss.properties),
      sheets: ss.sheets.filter((s) => !wanted || wanted.includes(s.properties.sheetId)).map((sheet) => {
        const out = { properties: clone(sheet.properties) };
        if (includeGridData) {
          out.data = [{ rowData: sheet.data.map((row) => ({ values: row.map(cellFromValue) })), startRow: 0, startColumn: 0 }];
        }
        if (sheet.basicFilter) out.basicFilter = clone(sheet.basicFilter);
        if (sheet.merges.length) out.merges = clone(sheet.merges);
        return out;
      }),
      namedRanges: clone(ss.namedRanges),
      developerMetadata: clone(ss.developerMetadata),
      spreadsheetUrl: ss.spreadsheetUrl,
    };
  }

  parseJson(buffer) {
    if (!buffer.length) return {};
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new ApiError(400, "Invalid JSON payload received. Unknown name.", "parseError");
    }
  }

  sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(body));
  }

  sendError(res, error) {
    // Google Sheets API v4 returns the shared google.rpc.Status envelope:
    // { error: { code, message, status, details: [ { "@type": ErrorInfo, reason, domain, metadata } ] } }.
    // It does NOT emit the legacy JSON-API `errors: [{ message, domain, reason }]` array.
    this.sendJson(res, error.code || 500, {
      error: {
        code: error.code || 500,
        message: error.message || "Internal error",
        status: error.status || statusForCode(error.code || 500),
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: error.reason || "internalError",
            domain: "googleapis.com",
            metadata: { service: "sheets.googleapis.com" },
          },
        ],
      },
    });
  }
}

export default GoogleSheetsServer;
