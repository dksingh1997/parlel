// parlel/rds-data-api — dependency-free fake of the Amazon RDS Data API.
//
// REST/JSON protocol with operation-specific paths:
//   POST /Execute            -> ExecuteStatement
//   POST /BatchExecute       -> BatchExecuteStatement
//   POST /BeginTransaction   -> BeginTransaction
//   POST /CommitTransaction  -> CommitTransaction
//   POST /RollbackTransaction-> RollbackTransaction
//
// Ships a tiny in-memory SQL engine (CREATE TABLE / INSERT / SELECT) so that
// round trips return real data. State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class DataApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

// ---- tiny SQL engine ----------------------------------------------------
class SqlEngine {
  constructor() {
    this.databases = new Map(); // dbName -> Map<tableName, {columns:[{name,type}], rows:[]}>
  }

  db(name) {
    const key = name || "_default";
    if (!this.databases.has(key)) this.databases.set(key, new Map());
    return this.databases.get(key);
  }

  // Returns { records, columnMetadata, numberOfRecordsUpdated, generatedFields }
  execute(database, sql, params = []) {
    const trimmed = String(sql || "").trim().replace(/;$/, "");
    const upper = trimmed.toUpperCase();

    if (upper.startsWith("CREATE TABLE")) return this.createTable(database, trimmed);
    if (upper.startsWith("INSERT INTO")) return this.insert(database, trimmed, params);
    if (upper.startsWith("SELECT")) return this.select(database, trimmed, params);
    if (upper.startsWith("UPDATE")) return this.update(database, trimmed, params);
    if (upper.startsWith("DELETE")) return this.delete(database, trimmed, params);
    if (upper.startsWith("DROP TABLE")) {
      const name = trimmed.replace(/DROP TABLE\s+(IF EXISTS\s+)?/i, "").trim();
      this.db(database).delete(name.toLowerCase());
      return { records: [], columnMetadata: [], numberOfRecordsUpdated: 0 };
    }
    // Unknown statement: accept as no-op DDL.
    return { records: [], columnMetadata: [], numberOfRecordsUpdated: 0 };
  }

  createTable(database, sql) {
    const m = sql.match(/CREATE TABLE\s+(IF NOT EXISTS\s+)?([^\s(]+)\s*\(([\s\S]*)\)/i);
    if (!m) throw new DataApiError("BadRequestException", "Malformed CREATE TABLE");
    const name = m[2].toLowerCase();
    const colsDef = m[3];
    const columns = colsDef
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const parts = c.split(/\s+/);
        return { name: parts[0].replace(/["'`]/g, ""), type: (parts[1] || "TEXT").toUpperCase() };
      });
    const tbl = this.db(database);
    if (!tbl.has(name)) tbl.set(name, { columns, rows: [] });
    return { records: [], columnMetadata: [], numberOfRecordsUpdated: 0 };
  }

  paramMap(params) {
    const map = {};
    for (const p of params || []) {
      if (p && p.name !== undefined) map[p.name] = this.fieldToValue(p.value);
    }
    return map;
  }

  fieldToValue(field) {
    if (!field || typeof field !== "object") return field;
    if ("stringValue" in field) return field.stringValue;
    if ("longValue" in field) return field.longValue;
    if ("doubleValue" in field) return field.doubleValue;
    if ("booleanValue" in field) return field.booleanValue;
    if ("isNull" in field && field.isNull) return null;
    if ("blobValue" in field) return field.blobValue;
    return null;
  }

  valueToField(value) {
    if (value === null || value === undefined) return { isNull: true };
    if (typeof value === "number") {
      return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
    }
    if (typeof value === "boolean") return { booleanValue: value };
    return { stringValue: String(value) };
  }

  parseLiteral(token, paramMap) {
    token = token.trim();
    if (token.startsWith(":")) {
      const key = token.slice(1);
      return paramMap[key] !== undefined ? paramMap[key] : null;
    }
    if (/^'.*'$/.test(token)) return token.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d+$/.test(token)) return Number(token);
    if (/^-?\d*\.\d+$/.test(token)) return Number(token);
    if (token.toUpperCase() === "NULL") return null;
    if (token.toUpperCase() === "TRUE") return true;
    if (token.toUpperCase() === "FALSE") return false;
    return token;
  }

  splitArgs(str) {
    const out = [];
    let depth = 0;
    let cur = "";
    let inStr = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === "'") inStr = !inStr;
      if (c === "(" && !inStr) depth++;
      if (c === ")" && !inStr) depth--;
      if (c === "," && depth === 0 && !inStr) {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out.map((s) => s.trim());
  }

  insert(database, sql, params) {
    const paramMap = this.paramMap(params);
    const m = sql.match(/INSERT INTO\s+([^\s(]+)\s*(\(([^)]*)\))?\s*VALUES\s*\(([\s\S]*)\)/i);
    if (!m) throw new DataApiError("BadRequestException", "Malformed INSERT");
    const name = m[1].toLowerCase();
    const tbl = this.db(database).get(name);
    if (!tbl) throw new DataApiError("BadRequestException", `Table ${name} does not exist`);
    let cols;
    if (m[3]) cols = m[3].split(",").map((c) => c.trim().replace(/["'`]/g, ""));
    else cols = tbl.columns.map((c) => c.name);
    const valTokens = this.splitArgs(m[4]);
    const row = {};
    cols.forEach((col, i) => {
      row[col] = this.parseLiteral(valTokens[i], paramMap);
    });
    tbl.rows.push(row);
    const generatedFields = [];
    if (cols.includes("id") || tbl.columns.some((c) => c.name === "id")) {
      generatedFields.push(this.valueToField(row.id ?? tbl.rows.length));
    }
    return { records: [], columnMetadata: [], numberOfRecordsUpdated: 1, generatedFields };
  }

  select(database, sql, params) {
    const paramMap = this.paramMap(params);
    // SELECT <cols> FROM <table> [WHERE col = val]
    const m = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+([^\s]+)(\s+WHERE\s+([\s\S]+?))?$/i);
    if (m) {
      const name = m[2].toLowerCase();
      const tbl = this.db(database).get(name);
      if (!tbl) throw new DataApiError("BadRequestException", `Table ${name} does not exist`);
      let rows = tbl.rows;
      if (m[4]) {
        const wm = m[4].match(/([^\s=]+)\s*=\s*(.+)/);
        if (wm) {
          const col = wm[1].trim();
          const val = this.parseLiteral(wm[2].trim(), paramMap);
          rows = rows.filter((r) => r[col] == val);
        }
      }
      const colSpec = m[1].trim();
      let outCols;
      if (colSpec === "*") outCols = tbl.columns.map((c) => c.name);
      else outCols = colSpec.split(",").map((c) => c.trim());
      const columnMetadata = outCols.map((c) => {
        const def = tbl.columns.find((cc) => cc.name === c);
        return { name: c, label: c, typeName: def ? def.type : "TEXT" };
      });
      const records = rows.map((r) => outCols.map((c) => this.valueToField(r[c])));
      return { records, columnMetadata, numberOfRecordsUpdated: 0 };
    }
    // SELECT <literal> (no FROM) e.g. SELECT 1
    const litMatch = sql.match(/SELECT\s+([\s\S]+)$/i);
    const exprs = this.splitArgs(litMatch[1]);
    const columnMetadata = exprs.map((e, i) => ({ name: `_col${i}`, label: `_col${i}`, typeName: "INTEGER" }));
    const record = exprs.map((e) => this.valueToField(this.parseLiteral(e.trim(), paramMap)));
    return { records: [record], columnMetadata, numberOfRecordsUpdated: 0 };
  }

  update(database, sql, params) {
    const paramMap = this.paramMap(params);
    const m = sql.match(/UPDATE\s+([^\s]+)\s+SET\s+([\s\S]+?)(\s+WHERE\s+([\s\S]+))?$/i);
    if (!m) throw new DataApiError("BadRequestException", "Malformed UPDATE");
    const name = m[1].toLowerCase();
    const tbl = this.db(database).get(name);
    if (!tbl) throw new DataApiError("BadRequestException", `Table ${name} does not exist`);
    const assignments = this.splitArgs(m[2]).map((a) => {
      const [col, val] = a.split("=");
      return { col: col.trim(), val: this.parseLiteral(val.trim(), paramMap) };
    });
    let rows = tbl.rows;
    let predicate = () => true;
    if (m[4]) {
      const wm = m[4].match(/([^\s=]+)\s*=\s*(.+)/);
      if (wm) {
        const col = wm[1].trim();
        const val = this.parseLiteral(wm[2].trim(), paramMap);
        predicate = (r) => r[col] == val;
      }
    }
    let updated = 0;
    for (const r of rows) {
      if (predicate(r)) {
        for (const a of assignments) r[a.col] = a.val;
        updated++;
      }
    }
    return { records: [], columnMetadata: [], numberOfRecordsUpdated: updated };
  }

  delete(database, sql, params) {
    const paramMap = this.paramMap(params);
    const m = sql.match(/DELETE FROM\s+([^\s]+)(\s+WHERE\s+([\s\S]+))?$/i);
    if (!m) throw new DataApiError("BadRequestException", "Malformed DELETE");
    const name = m[1].toLowerCase();
    const tbl = this.db(database).get(name);
    if (!tbl) throw new DataApiError("BadRequestException", `Table ${name} does not exist`);
    let predicate = () => true;
    if (m[3]) {
      const wm = m[3].match(/([^\s=]+)\s*=\s*(.+)/);
      if (wm) {
        const col = wm[1].trim();
        const val = this.parseLiteral(wm[2].trim(), paramMap);
        predicate = (r) => r[col] == val;
      }
    }
    const before = tbl.rows.length;
    tbl.rows = tbl.rows.filter((r) => !predicate(r));
    return { records: [], columnMetadata: [], numberOfRecordsUpdated: before - tbl.rows.length };
  }
}

export class RdsDataApiServer {
  constructor(port = 4722, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.engine = new SqlEngine();
    this.transactions = new Map(); // txId -> { database }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new DataApiError("InternalServerErrorException", error.message, 500));
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
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "rds-data-api", transactions: this.transactions.size });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    if (method !== "POST") {
      return this.sendError(res, new DataApiError("BadRequestException", "Only POST supported.", 405));
    }

    const body = await this.readBody(req);
    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new DataApiError("BadRequestException", "Invalid JSON.", 400));
    }

    try {
      let output;
      switch (path) {
        case "/Execute":
          output = this.executeStatement(input);
          break;
        case "/BatchExecute":
          output = this.batchExecute(input);
          break;
        case "/BeginTransaction":
          output = this.beginTransaction(input);
          break;
        case "/CommitTransaction":
          output = this.commitTransaction(input);
          break;
        case "/RollbackTransaction":
          output = this.rollbackTransaction(input);
          break;
        default:
          throw new DataApiError("BadRequestException", `Unknown path: ${path}`, 404);
      }
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof DataApiError) return this.sendError(res, error);
      throw error;
    }
  }

  executeStatement(input) {
    if (!input.sql) throw new DataApiError("BadRequestException", "sql is required");
    const result = this.engine.execute(input.database, input.sql, input.parameters);
    const out = {
      records: result.records,
      columnMetadata: result.columnMetadata,
      numberOfRecordsUpdated: result.numberOfRecordsUpdated,
    };
    if (input.includeResultMetadata === false) delete out.columnMetadata;
    if (result.generatedFields && result.generatedFields.length) {
      out.generatedFields = result.generatedFields;
    } else {
      out.generatedFields = [];
    }
    if (input.formatRecordsAs === "JSON") {
      out.formattedRecords = JSON.stringify(
        result.records.map((row) =>
          Object.fromEntries(
            result.columnMetadata.map((c, i) => [c.name, this.engine.fieldToValue(row[i])]),
          ),
        ),
      );
    }
    return out;
  }

  batchExecute(input) {
    if (!input.sql) throw new DataApiError("BadRequestException", "sql is required");
    const sets = input.parameterSets || [];
    const updateResults = [];
    if (!sets.length) {
      const r = this.engine.execute(input.database, input.sql, []);
      updateResults.push({ generatedFields: r.generatedFields || [] });
    }
    for (const params of sets) {
      const r = this.engine.execute(input.database, input.sql, params);
      updateResults.push({ generatedFields: r.generatedFields || [] });
    }
    return { updateResults };
  }

  beginTransaction(input) {
    const id = `tx-${randomUUID()}`;
    this.transactions.set(id, { database: input.database, resourceArn: input.resourceArn });
    return { transactionId: id };
  }

  commitTransaction(input) {
    const id = input.transactionId;
    if (!this.transactions.has(id)) {
      throw new DataApiError("BadRequestException", `Transaction ${id} not found`, 400);
    }
    this.transactions.delete(id);
    return { transactionStatus: "Transaction Committed" };
  }

  rollbackTransaction(input) {
    const id = input.transactionId;
    if (!this.transactions.has(id)) {
      throw new DataApiError("BadRequestException", `Transaction ${id} not found`, 400);
    }
    this.transactions.delete(id);
    return { transactionStatus: "Rollback Complete" };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", error.code || "BadRequestException");
    res.end(JSON.stringify({ message: error.message, code: error.code || "BadRequestException" }));
  }
}

export default RdsDataApiServer;
