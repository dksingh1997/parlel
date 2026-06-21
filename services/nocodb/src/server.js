import { createServer } from "node:http";

const DEFAULT_PORT = 4612;
const API_TOKEN = "parlel-token";
const DEFAULT_EMAIL = "user@parlel.local";
const DEFAULT_PASSWORD = "password";
const SYSTEM_FIELDS = ["Id", "CreatedAt", "UpdatedAt"];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nocodbError(message, statusCode = 400, error = "Bad Request") {
  return { msg: message, error, statusCode };
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "item";
}

function parseNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function compareValues(actual, operator, expected) {
  if (operator === "like") return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
  const left = Number(actual);
  const right = Number(expected);
  const numeric = Number.isFinite(left) && Number.isFinite(right);
  const a = numeric ? left : String(actual ?? "");
  const b = numeric ? right : String(expected ?? "");
  switch (operator) {
    case "eq": return a === b;
    case "neq": return a !== b;
    case "gt": return a > b;
    case "gte": return a >= b;
    case "lt": return a < b;
    case "lte": return a <= b;
    default: return true;
  }
}

function parseWhere(where) {
  if (!where) return [];
  const source = String(where).trim();
  const conditions = [];
  const regex = /\(?\s*([^,()]+)\s*,\s*(eq|neq|gt|gte|lt|lte|like)\s*,\s*([^()]+?)\s*\)?(?=~|$)/gi;
  let match;
  while ((match = regex.exec(source))) {
    conditions.push({ field: match[1].trim(), operator: match[2].toLowerCase(), value: match[3].trim().replace(/^['"]|['"]$/g, "") });
  }
  return conditions;
}

function rowMatches(row, where) {
  const conditions = parseWhere(where);
  return conditions.every((condition) => compareValues(row[condition.field], condition.operator, condition.value));
}

function parseSort(sort) {
  return String(sort || "").split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const descending = part.startsWith("-");
    return { field: part.replace(/^[+-]/, ""), descending };
  });
}

function sortRows(rows, sort) {
  const sorts = parseSort(sort);
  if (!sorts.length) return rows;
  return [...rows].sort((a, b) => {
    for (const { field, descending } of sorts) {
      if (a[field] === b[field]) continue;
      const result = a[field] > b[field] ? 1 : -1;
      return descending ? -result : result;
    }
    return 0;
  });
}

function projectRow(row, fields) {
  if (!fields) return clone(row);
  const names = String(fields).split(",").map((field) => field.trim()).filter(Boolean);
  if (!names.length) return clone(row);
  const projected = {};
  for (const name of names) if (Object.hasOwn(row, name)) projected[name] = clone(row[name]);
  return projected;
}

export class NocodbServer {
  constructor(port = DEFAULT_PORT, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth === true;
    this.server = null;
    this.reset();
  }

  reset() {
    this.baseCounter = 1;
    this.tableCounter = 1;
    this.columnCounter = 1;
    this.viewCounter = 1;
    this.bases = new Map();
    this.tables = new Map();
    this.columns = new Map();
    this.views = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => this.send(res, 500, nocodbError(error.message, 500, "Internal Server Error")));
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

    this.setHeaders(res);
    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "HEAD" && parts[0] === "health") return this.send(res, 200, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (req.method === "POST" && parts[0] === "__reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }

    if (parts[0] === "api" && parts[1] === "v1" && parts[2] === "auth") return this.handleAuth(req, res, parts, body);

    if (!this.isAuthorized(req, url.searchParams)) return this.send(res, 401, nocodbError("Unauthorized", 401, "Unauthorized"));
    if (parts[0] === "api" && parts[1] === "v1" && parts[2] === "db" && parts[3] === "meta") return this.handleV1Meta(req, res, parts.slice(4), body);
    if (parts[0] === "api" && parts[1] === "v1" && parts[2] === "db" && parts[3] === "data") return this.handleV1Data(req, res, parts.slice(4), url.searchParams, body);
    if (parts[0] === "api" && parts[1] === "v2" && parts[2] === "meta") return this.handleV2Meta(req, res, parts.slice(3), body);
    if (parts[0] === "api" && parts[1] === "v2" && parts[2] === "tables") return this.handleV2TableData(req, res, parts.slice(3), url.searchParams, body);

    return this.send(res, 404, nocodbError("Not found", 404, "Not Found"));
  }

  root() {
    return { name: "nocodb", version: "0.1", protocol: "nocodb-rest", documentation: "/docs/nocodb.md" };
  }

  isAuthorized(req, params) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return auth === `Bearer ${API_TOKEN}` || req.headers["xc-token"] === API_TOKEN || params.get("xc-token") === API_TOKEN;
  }

  handleAuth(req, res, parts, body) {
    const action = parts.slice(3).join("/");
    if (req.method === "POST" && (action === "user/signin" || action === "user/signup")) {
      const email = body?.email || body?.username || DEFAULT_EMAIL;
      return this.send(res, 200, { token: API_TOKEN, user: { id: "us_parlel", email, roles: "org-level-creator" } });
    }
    if (req.method === "GET" && action === "user/me") {
      return this.send(res, 200, { id: "us_parlel", email: DEFAULT_EMAIL, roles: "org-level-creator" });
    }
    if (req.method === "POST" && action === "password/forgot") return this.send(res, 200, { msg: "Password reset mail sent" });
    return this.send(res, 404, nocodbError("Auth endpoint not found", 404, "Not Found"));
  }

  handleV1Meta(req, res, parts, body) {
    if (parts[0] === "projects" || parts[0] === "bases") return this.handleBaseMeta(req, res, parts, body);
    if (parts[0] === "tables") return this.handleTableMeta(req, res, parts.slice(1), body);
    if (parts[0] === "columns") return this.handleColumnMeta(req, res, parts.slice(1), body);
    if (parts[0] === "views") return this.handleViewMeta(req, res, parts.slice(1), body);
    return this.send(res, 404, nocodbError("Meta endpoint not found", 404, "Not Found"));
  }

  handleV2Meta(req, res, parts, body) {
    if (parts[0] === "bases" || parts[0] === "projects") return this.handleBaseMeta(req, res, parts, body);
    if (parts[0] === "tables") return this.handleTableMeta(req, res, parts.slice(1), body);
    if (parts[0] === "columns") return this.handleColumnMeta(req, res, parts.slice(1), body);
    if (parts[0] === "views") return this.handleViewMeta(req, res, parts.slice(1), body);
    return this.send(res, 404, nocodbError("Meta endpoint not found", 404, "Not Found"));
  }

  handleBaseMeta(req, res, parts, body) {
    const baseId = parts[1];
    if (!baseId) {
      if (req.method === "GET") return this.send(res, 200, { list: [...this.bases.values()].map((base) => this.publicBase(base)) });
      if (req.method === "POST") return this.send(res, 200, this.publicBase(this.createBase(body)));
      return this.methodNotAllowed(res);
    }

    const base = this.bases.get(baseId);
    if (!base) return this.send(res, 404, nocodbError("Base not found", 404, "Not Found"));

    if (parts[2] === "tables") return this.handleBaseTables(req, res, base, body);
    if (req.method === "GET") return this.send(res, 200, this.publicBase(base));
    if (req.method === "PATCH" || req.method === "PUT") {
      base.title = body?.title || body?.name || base.title;
      base.updated_at = now();
      return this.send(res, 200, this.publicBase(base));
    }
    if (req.method === "DELETE") {
      this.deleteBase(baseId);
      return this.send(res, 200, { msg: "The base has been deleted successfully" });
    }
    return this.methodNotAllowed(res);
  }

  handleBaseTables(req, res, base, body) {
    if (req.method === "GET") {
      return this.send(res, 200, { list: base.tables.map((id) => this.publicTable(this.tables.get(id))).filter(Boolean) });
    }
    if (req.method === "POST") return this.send(res, 200, this.publicTable(this.createTable(base.id, body)));
    return this.methodNotAllowed(res);
  }

  handleTableMeta(req, res, parts, body) {
    const tableId = parts[0];
    const table = this.resolveTable(tableId);
    if (!table) return this.send(res, 404, nocodbError("Table not found", 404, "Not Found"));

    if (parts[1] === "columns") return this.handleTableColumns(req, res, table, body);
    if (parts[1] === "views") return this.handleTableViews(req, res, table, body);
    if (req.method === "GET") return this.send(res, 200, this.publicTable(table, true));
    if (req.method === "PATCH" || req.method === "PUT") {
      table.title = body?.title || body?.table_name || body?.name || table.title;
      table.updated_at = now();
      return this.send(res, 200, this.publicTable(table, true));
    }
    if (req.method === "DELETE") {
      this.deleteTable(table.id);
      return this.send(res, 200, { msg: "The table has been deleted successfully" });
    }
    return this.methodNotAllowed(res);
  }

  handleTableColumns(req, res, table, body) {
    if (req.method === "GET") return this.send(res, 200, { list: table.columns.map((id) => this.publicColumn(this.columns.get(id))).filter(Boolean) });
    if (req.method === "POST") return this.send(res, 200, this.publicColumn(this.createColumn(table.id, body)));
    return this.methodNotAllowed(res);
  }

  handleColumnMeta(req, res, parts, body) {
    const column = this.columns.get(parts[0]);
    if (!column) return this.send(res, 404, nocodbError("Column not found", 404, "Not Found"));
    if (req.method === "GET") return this.send(res, 200, this.publicColumn(column));
    if (req.method === "PATCH" || req.method === "PUT") {
      column.title = body?.title || body?.column_name || column.title;
      column.uidt = body?.uidt || column.uidt;
      column.updated_at = now();
      return this.send(res, 200, this.publicColumn(column));
    }
    if (req.method === "DELETE") {
      this.deleteColumn(column.id);
      return this.send(res, 200, { msg: "The column has been deleted successfully" });
    }
    return this.methodNotAllowed(res);
  }

  handleTableViews(req, res, table, body) {
    if (req.method === "GET") return this.send(res, 200, { list: table.views.map((id) => this.publicView(this.views.get(id))).filter(Boolean) });
    if (req.method === "POST") return this.send(res, 200, this.publicView(this.createView(table.id, body)));
    return this.methodNotAllowed(res);
  }

  handleViewMeta(req, res, parts, body) {
    const view = this.views.get(parts[0]);
    if (!view) return this.send(res, 404, nocodbError("View not found", 404, "Not Found"));
    if (req.method === "GET") return this.send(res, 200, this.publicView(view));
    if (req.method === "PATCH" || req.method === "PUT") {
      view.title = body?.title || view.title;
      view.updated_at = now();
      return this.send(res, 200, this.publicView(view));
    }
    if (req.method === "DELETE") {
      this.deleteView(view.id);
      return this.send(res, 200, { msg: "The view has been deleted successfully" });
    }
    return this.methodNotAllowed(res);
  }

  handleV2TableData(req, res, parts, params, body) {
    const table = this.resolveTable(parts[0]);
    if (!table) return this.send(res, 404, nocodbError("Table not found", 404, "Not Found"));
    if (parts[1] !== "records") return this.send(res, 404, nocodbError("Data endpoint not found", 404, "Not Found"));
    if (parts[2] === "count") return this.send(res, 200, { count: this.filteredRows(table, params).length });
    return this.handleRecords(req, res, table, parts[2], params, body);
  }

  handleV1Data(req, res, parts, params, body) {
    if (parts.length < 2) return this.send(res, 404, nocodbError("Data endpoint not found", 404, "Not Found"));
    const directTable = this.findTableByBaseAndTitle(parts[0], parts[1]) || this.resolveTable(parts[1]);
    const hasOrgSegment = !directTable && parts.length >= 3 && !["count"].includes(parts[2]);
    const basePart = hasOrgSegment ? parts[1] : parts[0];
    const tablePart = hasOrgSegment ? parts[2] : parts[1];
    const actionPart = hasOrgSegment ? parts[3] : parts[2];
    const table = directTable || this.findTableByBaseAndTitle(basePart, tablePart) || this.resolveTable(tablePart);
    if (!table) return this.send(res, 404, nocodbError("Table not found", 404, "Not Found"));
    if (actionPart === "count") return this.send(res, 200, { count: this.filteredRows(table, params).length });
    return this.handleRecords(req, res, table, actionPart, params, body);
  }

  handleRecords(req, res, table, recordId, params, body) {
    if (!recordId) {
      if (req.method === "GET") return this.send(res, 200, this.listRecords(table, params));
      if (req.method === "POST") return this.send(res, 200, this.createRecords(table, body));
      if (req.method === "PATCH" || req.method === "PUT") return this.send(res, 200, this.updateRecords(table, body));
      if (req.method === "DELETE") return this.send(res, 200, this.deleteRecords(table, body));
      return this.methodNotAllowed(res);
    }

    const row = table.rows.get(String(recordId));
    if (!row) return this.send(res, 404, nocodbError("Record not found", 404, "Not Found"));
    if (req.method === "GET") return this.send(res, 200, projectRow(row, params.get("fields")));
    if (req.method === "PATCH" || req.method === "PUT") return this.send(res, 200, this.updateRecord(table, recordId, body));
    if (req.method === "DELETE") {
      table.rows.delete(String(recordId));
      return this.send(res, 200, { Id: Number(recordId), id: Number(recordId), deleted: true });
    }
    return this.methodNotAllowed(res);
  }

  listRecords(table, params) {
    const page = Math.max(1, parseNumber(params.get("page"), 1));
    const pageSize = Math.max(1, parseNumber(params.get("limit") || params.get("pageSize"), 25));
    const offset = parseNumber(params.get("offset"), (page - 1) * pageSize);
    const all = this.filteredRows(table, params);
    const list = all.slice(offset, offset + pageSize).map((row) => projectRow(row, params.get("fields")));
    return {
      list,
      pageInfo: {
        totalRows: all.length,
        page,
        pageSize,
        isFirstPage: offset === 0,
        isLastPage: offset + pageSize >= all.length,
      },
    };
  }

  filteredRows(table, params) {
    return sortRows([...table.rows.values()].filter((row) => rowMatches(row, params.get("where"))), params.get("sort"));
  }

  createRecords(table, body) {
    const rows = Array.isArray(body) ? body : Array.isArray(body?.records) ? body.records : Array.isArray(body?.list) ? body.list : [body];
    const created = rows.map((row) => this.createRecord(table, row));
    return Array.isArray(body) || Array.isArray(body?.records) || Array.isArray(body?.list) ? created : created[0];
  }

  createRecord(table, source = {}) {
    if (!isObject(source)) throw new Error("Record payload must be an object");
    const id = table.nextRowId++;
    const timestamp = now();
    const row = { Id: id, id, ...clone(source), CreatedAt: timestamp, UpdatedAt: timestamp };
    table.rows.set(String(id), row);
    return clone(row);
  }

  updateRecords(table, body) {
    const rows = Array.isArray(body) ? body : Array.isArray(body?.records) ? body.records : Array.isArray(body?.list) ? body.list : [body];
    const updated = rows.map((row) => {
      const id = row?.Id ?? row?.id;
      if (id === undefined) throw new Error("Record Id is required");
      return this.updateRecord(table, id, row);
    });
    return Array.isArray(body) || Array.isArray(body?.records) || Array.isArray(body?.list) ? updated : updated[0];
  }

  updateRecord(table, id, body = {}) {
    const row = table.rows.get(String(id));
    if (!row) throw new Error("Record not found");
    for (const [key, value] of Object.entries(body || {})) {
      if (key === "Id" || key === "id" || key === "CreatedAt") continue;
      row[key] = clone(value);
    }
    row.UpdatedAt = now();
    return clone(row);
  }

  deleteRecords(table, body) {
    const ids = Array.isArray(body) ? body : Array.isArray(body?.ids) ? body.ids : Array.isArray(body?.records) ? body.records.map((row) => row.Id ?? row.id) : [body?.Id ?? body?.id];
    const deleted = ids.filter((id) => id !== undefined).map((id) => {
      table.rows.delete(String(id));
      return { Id: Number(id), id: Number(id), deleted: true };
    });
    return deleted.length === 1 ? deleted[0] : deleted;
  }

  createBase(body = {}) {
    const id = body?.id || `base_${this.baseCounter++}`;
    const timestamp = now();
    const base = { id, title: body?.title || body?.name || "Untitled Base", tables: [], created_at: timestamp, updated_at: timestamp };
    this.bases.set(id, base);
    return base;
  }

  createTable(baseId, body = {}) {
    const base = this.bases.get(baseId);
    if (!base) throw new Error("Base not found");
    const title = body?.title || body?.table_name || body?.name || "Untitled Table";
    const id = body?.id || `tbl_${this.tableCounter++}`;
    const timestamp = now();
    const table = { id, base_id: baseId, title, table_name: slug(title), columns: [], views: [], rows: new Map(), nextRowId: 1, created_at: timestamp, updated_at: timestamp };
    this.tables.set(id, table);
    base.tables.push(id);
    for (const field of SYSTEM_FIELDS) this.createColumn(id, { title: field, column_name: field, uidt: field === "Id" ? "ID" : "DateTime", system: true });
    for (const column of body?.columns || body?.fields || []) this.createColumn(id, column);
    this.createView(id, { title: "Grid view", type: "grid" });
    return table;
  }

  createColumn(tableId, body = {}) {
    const table = this.tables.get(tableId);
    if (!table) throw new Error("Table not found");
    const title = body?.title || body?.column_name || body?.name;
    if (!title) throw new Error("Column title is required");
    const id = body?.id || `col_${this.columnCounter++}`;
    const timestamp = now();
    const column = { id, table_id: tableId, title, column_name: body?.column_name || slug(title), uidt: body?.uidt || body?.type || "SingleLineText", system: Boolean(body?.system), created_at: timestamp, updated_at: timestamp };
    this.columns.set(id, column);
    table.columns.push(id);
    return column;
  }

  createView(tableId, body = {}) {
    const table = this.tables.get(tableId);
    if (!table) throw new Error("Table not found");
    const id = body?.id || `vw_${this.viewCounter++}`;
    const timestamp = now();
    const view = { id, table_id: tableId, title: body?.title || "Grid view", type: body?.type || body?.view_type || "grid", created_at: timestamp, updated_at: timestamp };
    this.views.set(id, view);
    table.views.push(id);
    return view;
  }

  publicBase(base) {
    return { id: base.id, title: base.title, type: "database", created_at: base.created_at, updated_at: base.updated_at };
  }

  publicTable(table, includeChildren = false) {
    const result = { id: table.id, base_id: table.base_id, title: table.title, table_name: table.table_name, created_at: table.created_at, updated_at: table.updated_at };
    if (includeChildren) {
      result.columns = table.columns.map((id) => this.publicColumn(this.columns.get(id))).filter(Boolean);
      result.views = table.views.map((id) => this.publicView(this.views.get(id))).filter(Boolean);
    }
    return result;
  }

  publicColumn(column) {
    return { id: column.id, table_id: column.table_id, title: column.title, column_name: column.column_name, uidt: column.uidt, system: column.system, created_at: column.created_at, updated_at: column.updated_at };
  }

  publicView(view) {
    return { id: view.id, table_id: view.table_id, title: view.title, type: view.type, created_at: view.created_at, updated_at: view.updated_at };
  }

  resolveTable(idOrName) {
    if (!idOrName) return null;
    if (this.tables.has(idOrName)) return this.tables.get(idOrName);
    return [...this.tables.values()].find((table) => table.table_name === idOrName || table.title === idOrName) || null;
  }

  findTableByBaseAndTitle(baseTitleOrId, tableName) {
    const base = this.bases.get(baseTitleOrId) || [...this.bases.values()].find((item) => item.title === baseTitleOrId);
    if (!base) return null;
    return base.tables.map((id) => this.tables.get(id)).find((table) => table && (table.table_name === tableName || table.title === tableName)) || null;
  }

  deleteBase(baseId) {
    const base = this.bases.get(baseId);
    if (!base) return;
    for (const tableId of [...base.tables]) this.deleteTable(tableId);
    this.bases.delete(baseId);
  }

  deleteTable(tableId) {
    const table = this.tables.get(tableId);
    if (!table) return;
    const base = this.bases.get(table.base_id);
    if (base) base.tables = base.tables.filter((id) => id !== tableId);
    for (const columnId of [...table.columns]) this.columns.delete(columnId);
    for (const viewId of [...table.views]) this.views.delete(viewId);
    this.tables.delete(tableId);
  }

  deleteColumn(columnId) {
    const column = this.columns.get(columnId);
    if (!column) return;
    const table = this.tables.get(column.table_id);
    if (table) table.columns = table.columns.filter((id) => id !== columnId);
    this.columns.delete(columnId);
  }

  deleteView(viewId) {
    const view = this.views.get(viewId);
    if (!view) return;
    const table = this.tables.get(view.table_id);
    if (table) table.views = table.views.filter((id) => id !== viewId);
    this.views.delete(viewId);
  }

  async readBody(req) {
    if (req.method === "GET" || req.method === "HEAD") return null;
    let data = "";
    for await (const chunk of req) data += chunk;
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  setHeaders(res) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, xc-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }

  methodNotAllowed(res) {
    return this.send(res, 405, nocodbError("Method not allowed", 405, "Method Not Allowed"));
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || body === undefined || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
