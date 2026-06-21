import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/snowflake — a tiny, dependency-free fake of the Snowflake SQL API v2.
//
// POST /api/v2/statements executes SQL against a minimal in-memory SQL engine
// (CREATE TABLE / INSERT / SELECT * FROM table) and returns Snowflake's
// resultSetMetaData + data-as-array-of-arrays response. Results are also
// retrievable by statementHandle via GET /api/v2/statements/:handle.
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newHandle() {
  return randomUUID();
}

// Map a JS value to a Snowflake column type string.
function sqlTypeFor(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? "FIXED" : "REAL";
  }
  if (typeof value === "boolean") return "BOOLEAN";
  return "TEXT";
}

function declaredType(raw) {
  const t = raw.toUpperCase();
  if (/INT|NUMBER|NUMERIC|DECIMAL|FIXED/.test(t)) return "FIXED";
  if (/FLOAT|REAL|DOUBLE/.test(t)) return "REAL";
  if (/BOOL/.test(t)) return "BOOLEAN";
  if (/DATE|TIME/.test(t)) return "TEXT";
  return "TEXT";
}

// ---------------------------------------------------------------------------
// Minimal SQL engine: CREATE TABLE, INSERT INTO, SELECT * FROM.
// ---------------------------------------------------------------------------
class SqlEngine {
  constructor() {
    this.tables = new Map(); // name -> { columns: [{name,type}], rows: [ [..] ] }
  }

  reset() {
    this.tables.clear();
  }

  execute(sql) {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    const head = trimmed.split(/\s+/)[0]?.toUpperCase();
    if (head === "CREATE") return this.createTable(trimmed);
    if (head === "INSERT") return this.insert(trimmed);
    if (head === "SELECT") return this.select(trimmed);
    if (head === "DROP") return this.dropTable(trimmed);
    throw new Error(`SQL compilation error: unsupported statement '${head}'`);
  }

  createTable(sql) {
    const m = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)\s*\((.*)\)\s*$/is);
    if (!m) throw new Error("SQL compilation error: malformed CREATE TABLE");
    const name = this._normName(m[1]);
    const colsRaw = this._splitColumns(m[2]);
    const columns = colsRaw.map((c) => {
      const parts = c.trim().split(/\s+/);
      const colName = parts[0].replace(/["`]/g, "");
      const type = declaredType(parts.slice(1).join(" ") || "TEXT");
      return { name: colName.toUpperCase(), type };
    });
    this.tables.set(name, { columns, rows: [] });
    return {
      kind: "ddl",
      message: `Table ${name} successfully created.`,
      columns: [{ name: "status", type: "TEXT" }],
      rows: [[`Table ${name} successfully created.`]],
    };
  }

  dropTable(sql) {
    const m = sql.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."]+)/is);
    if (!m) throw new Error("SQL compilation error: malformed DROP TABLE");
    const name = this._normName(m[1]);
    this.tables.delete(name);
    return {
      kind: "ddl",
      message: `${name} successfully dropped.`,
      columns: [{ name: "status", type: "TEXT" }],
      rows: [[`${name} successfully dropped.`]],
    };
  }

  insert(sql) {
    const m = sql.match(/INSERT\s+INTO\s+([\w."]+)\s*(?:\(([^)]*)\))?\s*VALUES\s*(.+)$/is);
    if (!m) throw new Error("SQL compilation error: malformed INSERT");
    const name = this._normName(m[1]);
    const table = this.tables.get(name);
    if (!table) throw new Error(`SQL compilation error: Object '${name}' does not exist or not authorized.`);
    const explicitCols = m[2]
      ? m[2].split(",").map((c) => c.trim().replace(/["`]/g, "").toUpperCase())
      : table.columns.map((c) => c.name);
    const tuples = this._splitTuples(m[3]);
    let inserted = 0;
    for (const tuple of tuples) {
      const values = this._splitValues(tuple).map((v) => this._parseLiteral(v));
      const row = table.columns.map((col) => {
        const idx = explicitCols.indexOf(col.name);
        return idx >= 0 && idx < values.length ? values[idx] : null;
      });
      table.rows.push(row);
      inserted += 1;
    }
    return {
      kind: "dml",
      message: `${inserted} row(s) inserted.`,
      columns: [{ name: "number of rows inserted", type: "FIXED" }],
      rows: [[inserted]],
    };
  }

  select(sql) {
    const m = sql.match(/SELECT\s+(.+?)\s+FROM\s+([\w."]+)\s*$/is);
    if (!m) throw new Error("SQL compilation error: only 'SELECT * FROM table' is supported");
    const proj = m[1].trim();
    const name = this._normName(m[2]);
    const table = this.tables.get(name);
    if (!table) throw new Error(`SQL compilation error: Object '${name}' does not exist or not authorized.`);
    if (proj !== "*") {
      throw new Error("SQL compilation error: only 'SELECT *' projections are supported");
    }
    const columns = table.columns.map((c) => ({
      name: c.name,
      type: c.type,
    }));
    // Refine FIXED/REAL based on actual data if column declared as TEXT default.
    return {
      kind: "query",
      columns,
      rows: clone(table.rows),
    };
  }

  _normName(raw) {
    return raw.replace(/["`]/g, "").toUpperCase();
  }

  _splitColumns(str) {
    // Split on commas not inside parentheses (e.g. NUMBER(10,2)).
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of str) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  _splitTuples(str) {
    // "(...),(...)" -> ["...", "..."]
    const out = [];
    let depth = 0;
    let cur = "";
    let inStr = false;
    for (const ch of str) {
      if (ch === "'") inStr = !inStr;
      if (!inStr && ch === "(") {
        depth += 1;
        if (depth === 1) { cur = ""; continue; }
      }
      if (!inStr && ch === ")") {
        depth -= 1;
        if (depth === 0) { out.push(cur); continue; }
      }
      if (depth >= 1) cur += ch;
    }
    return out;
  }

  _splitValues(str) {
    const out = [];
    let cur = "";
    let inStr = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "'") {
        inStr = !inStr;
        cur += ch;
        continue;
      }
      if (ch === "," && !inStr) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim() !== "") out.push(cur.trim());
    return out;
  }

  _parseLiteral(raw) {
    const v = raw.trim();
    if (v.toUpperCase() === "NULL") return null;
    if (v.toUpperCase() === "TRUE") return true;
    if (v.toUpperCase() === "FALSE") return false;
    if (/^'.*'$/s.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
    return v;
  }
}

export class SnowflakeServer {
  constructor(port = 4811, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.engine = new SqlEngine();
    this.reset();
  }

  reset() {
    this.engine.reset();
    this.statements = new Map(); // handle -> response
    this.history = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { code: "000000", message: error.message || "Internal server error" });
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Snowflake-Authorization-Token-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-snowflake");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (parts[0] === "api" && parts[1] === "v2" && parts[2] === "statements") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, { code: "390144", message: "Authentication token is invalid." });
      }
      // POST /api/v2/statements
      if (parts.length === 3 && req.method === "POST") {
        return this.executeStatement(res, body);
      }
      // GET /api/v2/statements/:handle
      if (parts.length === 4 && req.method === "GET") {
        const stored = this.statements.get(parts[3]);
        if (!stored) return this.send(res, 404, { code: "404", message: "statement not found" });
        return this.send(res, 200, clone(stored));
      }
    }

    return this.send(res, 404, { code: "404", message: "not found" });
  }

  executeStatement(res, body) {
    const sql = isPlainObject(body) ? body.statement : null;
    if (typeof sql !== "string" || sql.trim().length === 0) {
      return this.send(res, 400, { code: "000007", message: "statement is required" });
    }
    const handle = newHandle();
    let result;
    try {
      result = this.engine.execute(sql);
    } catch (error) {
      const errBody = {
        code: "002003",
        message: error.message,
        sqlState: "42S02",
        statementHandle: handle,
        statementStatusUrl: `/api/v2/statements/${handle}`,
      };
      this.statements.set(handle, errBody);
      this.history.push({ handle, sql, error: error.message });
      return this.send(res, 422, errBody);
    }

    const rowType = result.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: true,
      database: "PARLEL",
      schema: "PUBLIC",
      table: "",
      scale: c.type === "FIXED" ? 0 : null,
      precision: c.type === "FIXED" ? 38 : null,
      byteLength: null,
      length: c.type === "TEXT" ? 16777216 : null,
      collation: null,
    }));

    // Snowflake returns all cell values as strings in `data`.
    const data = result.rows.map((row) =>
      row.map((cell) => (cell === null ? null : String(cell)))
    );

    const response = {
      resultSetMetaData: {
        numRows: data.length,
        format: "jsonv2",
        partitionInfo: [{ rowCount: data.length, uncompressedSize: 0 }],
        rowType,
      },
      data,
      code: "090001",
      statementStatusUrl: `/api/v2/statements/${handle}`,
      sqlState: "00000",
      statementHandle: handle,
      message: "Statement executed successfully.",
      createdOn: Date.now(),
    };

    this.statements.set(handle, response);
    this.history.push({ handle, sql });
    return this.send(res, 200, response);
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "history") {
      return this.send(res, 200, { history: clone(this.history), count: this.history.length });
    }
    if (req.method === "GET" && parts[1] === "tables") {
      const tables = {};
      for (const [name, t] of this.engine.tables.entries()) {
        tables[name] = { columns: clone(t.columns), rowCount: t.rows.length };
      }
      return this.send(res, 200, { tables });
    }
    return this.send(res, 404, { code: "404", message: "not found" });
  }

  root() {
    return { name: "snowflake", version: "1.0", protocol: "snowflake-sql-api-v2", documentation: "/docs/snowflake.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { code: "000007", message: "Malformed JSON" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { code: "000007", message: "Bad request body" });
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
