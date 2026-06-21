import { createServer } from "node:http";

const MAX_BATCH_RECORDS = 10;
const DEFAULT_PAGE_SIZE = 100;
const RECORD_ID_PREFIX = "rec";
const RECORD_ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RECORD_ID_LENGTH = 14;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function airtableError(type, message) {
  return { error: { type, message } };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseComparable(raw) {
  const value = String(raw).trim().replace(/^['"]|['"]$/g, "");
  const number = toNumber(value);
  if (number !== null) return number;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return value;
}

function compareValues(actual, operator, expected) {
  switch (operator) {
    case "=": return actual === expected || String(actual) === String(expected);
    case "!=": return actual !== expected && String(actual) !== String(expected);
    case ">": return Number(actual) > Number(expected);
    case ">=": return Number(actual) >= Number(expected);
    case "<": return Number(actual) < Number(expected);
    case "<=": return Number(actual) <= Number(expected);
    default: return true;
  }
}

function splitFormulaArgs(source) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args.filter(Boolean);
}

function recordMatchesFormula(record, formula) {
  const source = String(formula || "").trim();
  if (!source) return true;

  const call = source.match(/^(AND|OR)\((.*)\)$/i);
  if (call) {
    const [, operator, inner] = call;
    const args = splitFormulaArgs(inner);
    return operator.toUpperCase() === "AND"
      ? args.every((arg) => recordMatchesFormula(record, arg))
      : args.some((arg) => recordMatchesFormula(record, arg));
  }

  const find = source.match(/^(FIND|SEARCH)\((['"])(.*?)\2\s*,\s*\{([^}]+)\}\)$/i);
  if (find) {
    const [, , , needle, field] = find;
    const haystack = String(record.fields[field] ?? "").toLowerCase();
    return haystack.includes(needle.toLowerCase());
  }

  const comparison = source.match(/^\{([^}]+)\}\s*(=|!=|>=|<=|>|<)\s*(.+)$/);
  if (comparison) {
    const [, field, operator, rawExpected] = comparison;
    return compareValues(record.fields[field], operator, parseComparable(rawExpected));
  }

  const truthyField = source.match(/^\{([^}]+)\}$/);
  if (truthyField) return Boolean(record.fields[truthyField[1]]);

  return true;
}

function parseSorts(params) {
  const sorts = [];
  for (let i = 0; i < 32; i += 1) {
    const field = params.get(`sort[${i}][field]`);
    if (!field) continue;
    sorts.push({ field, direction: (params.get(`sort[${i}][direction]`) || "asc").toLowerCase() });
  }
  const field = params.get("sortField");
  if (field) sorts.push({ field, direction: (params.get("sortDirection") || "asc").toLowerCase() });
  return sorts;
}

function sortRecords(records, sorts) {
  if (!sorts.length) return records;
  return [...records].sort((a, b) => {
    for (const sort of sorts) {
      const av = a.fields[sort.field];
      const bv = b.fields[sort.field];
      if (av === bv) continue;
      const result = av > bv ? 1 : -1;
      return sort.direction === "desc" ? -result : result;
    }
    return 0;
  });
}

function selectedFields(params, body) {
  const fromQuery = [...params.getAll("fields[]"), ...params.getAll("fields")];
  if (fromQuery.length) return fromQuery;
  if (Array.isArray(body?.fields)) return body.fields;
  return null;
}

function projectRecord(record, fields) {
  if (!fields || !fields.length) return clone(record);
  const projected = { id: record.id, createdTime: record.createdTime, fields: {} };
  for (const field of fields) {
    if (Object.hasOwn(record.fields, field)) projected.fields[field] = clone(record.fields[field]);
  }
  return projected;
}

export class AirtableServer {
  constructor(port = 4611, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.bases = new Map();
    this.recordCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, airtableError("SERVER_ERROR", error.message));
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
    const body = await this.readBody(req);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (req.method === "POST" && parts[0] === "__reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }

    if (parts[0] !== "v0" || parts.length < 3) {
      return this.send(res, 404, airtableError("NOT_FOUND", "Could not find the requested endpoint"));
    }

    if (!this.isAuthorized(req, url.searchParams)) {
      return this.send(res, 401, airtableError("AUTHENTICATION_REQUIRED", "Authentication required"));
    }

    const [, baseId, tableName, recordId, action] = parts;
    if (!baseId || !tableName) {
      return this.send(res, 404, airtableError("NOT_FOUND", "Could not find the requested endpoint"));
    }

    if (recordId === "listRecords" && !action && req.method === "POST") {
      return this.listRecords(res, baseId, tableName, url.searchParams, body);
    }

    if (recordId && action) {
      return this.send(res, 404, airtableError("NOT_FOUND", "Could not find the requested endpoint"));
    }

    if (recordId) return this.handleRecord(req, res, baseId, tableName, recordId, body);
    return this.handleTable(req, res, baseId, tableName, url.searchParams, body);
  }

  root() {
    return {
      name: "airtable",
      version: "0.1",
      protocol: "airtable-rest",
      documentation: "/docs/airtable.md",
    };
  }

  isAuthorized(req, params) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    if (params.get("api_key")) return true;
    return false;
  }

  getBase(baseId, create = false) {
    let base = this.bases.get(baseId);
    if (!base && create) {
      base = { id: baseId, tables: new Map() };
      this.bases.set(baseId, base);
    }
    return base;
  }

  getTable(baseId, tableName, create = false) {
    const base = this.getBase(baseId, create);
    if (!base) return null;
    let table = base.tables.get(tableName);
    if (!table && create) {
      table = { name: tableName, records: new Map() };
      base.tables.set(tableName, table);
    }
    return table;
  }

  nextRecordId() {
    this.recordCounter += 1;
    let n = this.recordCounter;
    let id = "";
    for (let i = 0; i < RECORD_ID_LENGTH; i += 1) {
      id = RECORD_ID_CHARS[n % 62] + id;
      n = Math.floor(n / 62);
    }
    return `${RECORD_ID_PREFIX}${id}`;
  }

  handleTable(req, res, baseId, tableName, params, body) {
    if ((req.method === "GET") || (req.method === "POST" && params.get("method") === "list")) {
      return this.listRecords(res, baseId, tableName, params, body);
    }
    if (req.method === "POST") return this.createRecords(res, baseId, tableName, body);
    if (req.method === "PATCH") return this.batchMutateRecords(res, baseId, tableName, body, false);
    if (req.method === "PUT") return this.batchMutateRecords(res, baseId, tableName, body, true);
    if (req.method === "DELETE") return this.batchDeleteRecords(res, baseId, tableName, params);
    return this.send(res, 405, airtableError("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  handleRecord(req, res, baseId, tableName, recordId, body) {
    if (req.method === "GET") return this.findRecord(res, baseId, tableName, recordId);
    if (req.method === "PATCH") return this.updateRecord(res, baseId, tableName, recordId, body, false);
    if (req.method === "PUT") return this.updateRecord(res, baseId, tableName, recordId, body, true);
    if (req.method === "DELETE") return this.deleteRecord(res, baseId, tableName, recordId);
    return this.send(res, 405, airtableError("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  listRecords(res, baseId, tableName, params, body = {}) {
    const table = this.getTable(baseId, tableName, false);
    let records = table ? Array.from(table.records.values()) : [];
    const filterByFormula = body.filterByFormula ?? params.get("filterByFormula");
    if (filterByFormula) records = records.filter((record) => recordMatchesFormula(record, filterByFormula));
    records = sortRecords(records, parseSorts(params));

    const maxRecords = toNumber(body.maxRecords ?? params.get("maxRecords"));
    if (maxRecords !== null) records = records.slice(0, Math.max(0, maxRecords));

    const pageSize = Math.min(Math.max(toNumber(body.pageSize ?? params.get("pageSize")) ?? DEFAULT_PAGE_SIZE, 1), DEFAULT_PAGE_SIZE);
    const start = Math.max(toNumber(body.offset ?? params.get("offset")) ?? 0, 0);
    const page = records.slice(start, start + pageSize);
    const fields = selectedFields(params, body);
    const response = { records: page.map((record) => projectRecord(record, fields)) };
    if (start + pageSize < records.length) response.offset = String(start + pageSize);
    return this.send(res, 200, response);
  }

  findRecord(res, baseId, tableName, recordId) {
    const record = this.getTable(baseId, tableName, false)?.records.get(recordId);
    if (!record) return this.send(res, 404, airtableError("NOT_FOUND", "Could not find record"));
    return this.send(res, 200, clone(record));
  }

  createRecords(res, baseId, tableName, body = {}) {
    if (Array.isArray(body.records)) {
      if (body.records.length > MAX_BATCH_RECORDS) return this.send(res, 422, airtableError("INVALID_REQUEST_UNKNOWN", "Cannot create more than 10 records per request"));
      const records = body.records.map((entry) => this.createRecord(baseId, tableName, entry.fields));
      return this.send(res, 200, { records: records.map(clone) });
    }
    if (!isPlainObject(body.fields)) {
      return this.send(res, 422, airtableError("INVALID_REQUEST_BODY", "Request body must include fields"));
    }
    return this.send(res, 200, clone(this.createRecord(baseId, tableName, body.fields)));
  }

  createRecord(baseId, tableName, fields = {}) {
    if (!isPlainObject(fields)) throw new Error("fields must be an object");
    const table = this.getTable(baseId, tableName, true);
    const record = { id: this.nextRecordId(), createdTime: now(), fields: clone(fields) };
    table.records.set(record.id, record);
    return record;
  }

  batchMutateRecords(res, baseId, tableName, body = {}, replace) {
    if (!Array.isArray(body.records)) {
      return this.send(res, 422, airtableError("INVALID_REQUEST_BODY", "Request body must include records"));
    }
    if (body.records.length > MAX_BATCH_RECORDS) return this.send(res, 422, airtableError("INVALID_REQUEST_UNKNOWN", "Cannot update more than 10 records per request"));

    const updated = [];
    for (const entry of body.records) {
      if (!entry.id || !isPlainObject(entry.fields)) {
        return this.send(res, 422, airtableError("INVALID_REQUEST_BODY", "Each record must include id and fields"));
      }
      const result = this.mutateRecord(baseId, tableName, entry.id, entry.fields, replace);
      if (!result) return this.send(res, 404, airtableError("NOT_FOUND", "Could not find record"));
      updated.push(result);
    }
    return this.send(res, 200, { records: updated.map(clone) });
  }

  updateRecord(res, baseId, tableName, recordId, body = {}, replace) {
    if (!isPlainObject(body.fields)) {
      return this.send(res, 422, airtableError("INVALID_REQUEST_BODY", "Request body must include fields"));
    }
    const record = this.mutateRecord(baseId, tableName, recordId, body.fields, replace);
    if (!record) return this.send(res, 404, airtableError("NOT_FOUND", "Could not find record"));
    return this.send(res, 200, clone(record));
  }

  mutateRecord(baseId, tableName, recordId, fields, replace) {
    const record = this.getTable(baseId, tableName, false)?.records.get(recordId);
    if (!record) return null;
    record.fields = replace ? clone(fields) : { ...record.fields, ...clone(fields) };
    return record;
  }

  batchDeleteRecords(res, baseId, tableName, params) {
    const ids = [...params.getAll("records[]"), ...params.getAll("records")];
    if (!ids.length) return this.send(res, 422, airtableError("INVALID_REQUEST_BODY", "Request must include records[]"));
    if (ids.length > MAX_BATCH_RECORDS) return this.send(res, 422, airtableError("INVALID_REQUEST_UNKNOWN", "Cannot delete more than 10 records per request"));
    const deleted = [];
    for (const id of ids) {
      const result = this.deleteRecordInternal(baseId, tableName, id);
      if (!result) return this.send(res, 404, airtableError("NOT_FOUND", "Could not find record"));
      deleted.push(result);
    }
    return this.send(res, 200, { records: deleted });
  }

  deleteRecord(res, baseId, tableName, recordId) {
    const result = this.deleteRecordInternal(baseId, tableName, recordId);
    if (!result) return this.send(res, 404, airtableError("NOT_FOUND", "Could not find record"));
    return this.send(res, 200, result);
  }

  deleteRecordInternal(baseId, tableName, recordId) {
    const table = this.getTable(baseId, tableName, false);
    if (!table?.records.has(recordId)) return null;
    table.records.delete(recordId);
    return { id: recordId, deleted: true };
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
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
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
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
