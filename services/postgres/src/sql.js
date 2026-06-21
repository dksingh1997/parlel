export class SQLExecutor {
  constructor() {
    this.tables = new Map();
    this.views = new Map();
    this.sequences = new Map();
    this.nextId = new Map();
    this.functions = new Map();
  }

  // Drop all ephemeral state so a fresh test/session starts from an empty
  // catalog. Matches the resettable-state invariant the other emulators expose.
  reset() {
    this.tables.clear();
    this.views.clear();
    this.sequences.clear();
    this.nextId.clear();
    this.functions.clear();
  }

  getNextId(tableName) {
    const current = this.nextId.get(tableName) || 0;
    const next = current + 1;
    this.nextId.set(tableName, next);
    return next;
  }

  getNextSequence(seqName) {
    const seq = this.sequences.get(seqName);
    if (!seq) return null;
    seq.current += seq.increment;
    return seq.current;
  }

  execute(query) {
    const normalized = query.trim().replace(/;$/, "").trim();
    const upper = normalized.toUpperCase();

    // SELECT 1
    if (upper === "SELECT 1" || upper === "SELECT 1 AS ?COLUMN?") {
      return {
        fields: [{ name: "?column?", type: 23 }],
        rows: [[1]],
        tag: "SELECT 1",
      };
    }

    // NEXTVAL
    if (upper.startsWith("SELECT NEXTVAL")) {
      return this.executeNextval(normalized);
    }

    // CURRVAL
    if (upper.startsWith("SELECT CURRVAL")) {
      return this.executeCurrval(normalized);
    }

    // SETVAL
    if (upper.startsWith("SELECT SETVAL")) {
      return this.executeSetval(normalized);
    }

    // SELECT
    if (upper.startsWith("SELECT")) {
      return this.executeSelect(normalized);
    }

    // CREATE TABLE
    if (upper.startsWith("CREATE TABLE")) {
      return this.executeCreateTable(normalized);
    }

    // CREATE VIEW
    if (upper.startsWith("CREATE VIEW") || upper.startsWith("CREATE OR REPLACE VIEW")) {
      return this.executeCreateView(normalized);
    }

    // CREATE INDEX
    if (upper.startsWith("CREATE INDEX") || upper.startsWith("CREATE UNIQUE INDEX")) {
      return { fields: [], rows: [], tag: "CREATE INDEX" };
    }

    // CREATE SEQUENCE
    if (upper.startsWith("CREATE SEQUENCE")) {
      return this.executeCreateSequence(normalized);
    }

    // CREATE FUNCTION
    if (upper.startsWith("CREATE FUNCTION") || upper.startsWith("CREATE OR REPLACE FUNCTION")) {
      return { fields: [], rows: [], tag: "CREATE FUNCTION" };
    }

    // CREATE TRIGGER
    if (upper.startsWith("CREATE TRIGGER")) {
      return { fields: [], rows: [], tag: "CREATE TRIGGER" };
    }

    // INSERT
    if (upper.startsWith("INSERT")) {
      let insertQuery = normalized;
      if (upper.includes("ON CONFLICT")) {
        insertQuery = normalized.replace(/\s+ON\s+CONFLICT\s*\([^)]*\)\s+DO\s+NOTHING/is, "");
        insertQuery = insertQuery.replace(/\s+ON\s+CONFLICT\s*\([^)]*\)\s+DO\s+UPDATE\s+SET\s+.*/is, "");
      }
      const { sql, returning } = this.extractReturning(insertQuery);
      return this.executeInsert(sql, returning);
    }

    // UPDATE
    if (upper.startsWith("UPDATE")) {
      const { sql, returning } = this.extractReturning(normalized);
      return this.executeUpdate(sql, returning);
    }

    // DELETE
    if (upper.startsWith("DELETE")) {
      const { sql, returning } = this.extractReturning(normalized);
      return this.executeDelete(sql, returning);
    }

    // TRUNCATE
    if (upper.startsWith("TRUNCATE")) {
      return this.executeTruncate(normalized);
    }

    // DROP TABLE
    if (upper.startsWith("DROP TABLE")) {
      return this.executeDropTable(normalized);
    }

    // DROP VIEW
    if (upper.startsWith("DROP VIEW")) {
      return this.executeDropView(normalized);
    }

    // DROP SEQUENCE
    if (upper.startsWith("DROP SEQUENCE")) {
      return { fields: [], rows: [], tag: "DROP SEQUENCE" };
    }

    // ALTER TABLE
    if (upper.startsWith("ALTER TABLE")) {
      return this.executeAlterTable(normalized);
    }

    // SHOW
    if (upper.startsWith("SHOW")) {
      return this.executeShow(normalized);
    }

    // SET
    if (upper.startsWith("SET")) {
      return { fields: [], rows: [], tag: "SET" };
    }

    // BEGIN
    if (upper === "BEGIN" || upper === "START TRANSACTION") {
      return { fields: [], rows: [], tag: "BEGIN" };
    }

    // COMMIT
    if (upper === "COMMIT" || upper === "END") {
      return { fields: [], rows: [], tag: "COMMIT" };
    }

    // ROLLBACK
    if (upper === "ROLLBACK") {
      return { fields: [], rows: [], tag: "ROLLBACK" };
    }

    // SAVEPOINT
    if (upper.startsWith("SAVEPOINT")) {
      return { fields: [], rows: [], tag: "SAVEPOINT" };
    }

    // RELEASE SAVEPOINT
    if (upper.startsWith("RELEASE")) {
      return { fields: [], rows: [], tag: "RELEASE SAVEPOINT" };
    }

    // ROLLBACK TO SAVEPOINT
    if (upper.startsWith("ROLLBACK TO")) {
      return { fields: [], rows: [], tag: "ROLLBACK TO SAVEPOINT" };
    }

    // EXPLAIN
    if (upper.startsWith("EXPLAIN")) {
      return this.executeExplain(normalized);
    }

    // VACUUM
    if (upper.startsWith("VACUUM")) {
      return { fields: [], rows: [], tag: "VACUUM" };
    }

    // ANALYZE
    if (upper.startsWith("ANALYZE")) {
      return { fields: [], rows: [], tag: "ANALYZE" };
    }

    // GRANT
    if (upper.startsWith("GRANT")) {
      return { fields: [], rows: [], tag: "GRANT" };
    }

    // REVOKE
    if (upper.startsWith("REVOKE")) {
      return { fields: [], rows: [], tag: "REVOKE" };
    }

    // LISTEN
    if (upper.startsWith("LISTEN")) {
      return { fields: [], rows: [], tag: "LISTEN" };
    }

    // NOTIFY
    if (upper.startsWith("NOTIFY")) {
      return { fields: [], rows: [], tag: "NOTIFY" };
    }

    // UNLISTEN
    if (upper.startsWith("UNLISTEN")) {
      return { fields: [], rows: [], tag: "UNLISTEN" };
    }

    // PREPARE
    if (upper.startsWith("PREPARE")) {
      return { fields: [], rows: [], tag: "PREPARE" };
    }

    // EXECUTE
    if (upper.startsWith("EXECUTE")) {
      return { fields: [], rows: [], tag: "EXECUTE" };
    }

    // DEALLOCATE
    if (upper.startsWith("DEALLOCATE")) {
      return { fields: [], rows: [], tag: "DEALLOCATE" };
    }

    // COPY
    if (upper.startsWith("COPY")) {
      return { fields: [], rows: [], tag: "COPY" };
    }

    // CREATE SCHEMA
    if (upper.startsWith("CREATE SCHEMA")) {
      return { fields: [], rows: [], tag: "CREATE SCHEMA" };
    }

    // DROP SCHEMA
    if (upper.startsWith("DROP SCHEMA")) {
      return { fields: [], rows: [], tag: "DROP SCHEMA" };
    }

    // CREATE TYPE
    if (upper.startsWith("CREATE TYPE")) {
      return { fields: [], rows: [], tag: "CREATE TYPE" };
    }

    // CREATE DOMAIN
    if (upper.startsWith("CREATE DOMAIN")) {
      return { fields: [], rows: [], tag: "CREATE DOMAIN" };
    }

    // COMMENT ON
    if (upper.startsWith("COMMENT ON")) {
      return { fields: [], rows: [], tag: "COMMENT" };
    }

    // RESET
    if (upper.startsWith("RESET")) {
      return { fields: [], rows: [], tag: "RESET" };
    }

    // DISCARD
    if (upper.startsWith("DISCARD")) {
      return { fields: [], rows: [], tag: "DISCARD" };
    }

    // DECLARE
    if (upper.startsWith("DECLARE")) {
      return { fields: [], rows: [], tag: "DECLARE" };
    }

    // FETCH
    if (upper.startsWith("FETCH")) {
      return { fields: [], rows: [], tag: "FETCH" };
    }

    // MOVE
    if (upper.startsWith("MOVE")) {
      return { fields: [], rows: [], tag: "MOVE" };
    }

    // CLOSE
    if (upper.startsWith("CLOSE")) {
      return { fields: [], rows: [], tag: "CLOSE" };
    }

    // REINDEX
    if (upper.startsWith("REINDEX")) {
      return { fields: [], rows: [], tag: "REINDEX" };
    }

    // CLUSTER
    if (upper.startsWith("CLUSTER")) {
      return { fields: [], rows: [], tag: "CLUSTER" };
    }

    // REFRESH MATERIALIZED VIEW
    if (upper.startsWith("REFRESH")) {
      return { fields: [], rows: [], tag: "REFRESH" };
    }

    // CREATE MATERIALIZED VIEW
    if (upper.startsWith("CREATE MATERIALIZED")) {
      return { fields: [], rows: [], tag: "CREATE MATERIALIZED VIEW" };
    }

    // DROP MATERIALIZED VIEW
    if (upper.startsWith("DROP MATERIALIZED")) {
      return { fields: [], rows: [], tag: "DROP MATERIALIZED VIEW" };
    }

    // CREATE EXTENSION
    if (upper.startsWith("CREATE EXTENSION")) {
      return { fields: [], rows: [], tag: "CREATE EXTENSION" };
    }

    // DROP EXTENSION
    if (upper.startsWith("DROP EXTENSION")) {
      return { fields: [], rows: [], tag: "DROP EXTENSION" };
    }

    // CREATE POLICY
    if (upper.startsWith("CREATE POLICY")) {
      return { fields: [], rows: [], tag: "CREATE POLICY" };
    }

    // ALTER POLICY
    if (upper.startsWith("ALTER POLICY")) {
      return { fields: [], rows: [], tag: "ALTER POLICY" };
    }

    // DROP POLICY
    if (upper.startsWith("DROP POLICY")) {
      return { fields: [], rows: [], tag: "DROP POLICY" };
    }

    // CREATE ROLE
    if (upper.startsWith("CREATE ROLE")) {
      return { fields: [], rows: [], tag: "CREATE ROLE" };
    }

    // ALTER ROLE
    if (upper.startsWith("ALTER ROLE")) {
      return { fields: [], rows: [], tag: "ALTER ROLE" };
    }

    // DROP ROLE
    if (upper.startsWith("DROP ROLE")) {
      return { fields: [], rows: [], tag: "DROP ROLE" };
    }

    // CREATE USER
    if (upper.startsWith("CREATE USER")) {
      return { fields: [], rows: [], tag: "CREATE USER" };
    }

    // ALTER USER
    if (upper.startsWith("ALTER USER")) {
      return { fields: [], rows: [], tag: "ALTER USER" };
    }

    // DROP USER
    if (upper.startsWith("DROP USER")) {
      return { fields: [], rows: [], tag: "DROP USER" };
    }

    // CREATE DATABASE
    if (upper.startsWith("CREATE DATABASE")) {
      return { fields: [], rows: [], tag: "CREATE DATABASE" };
    }

    // DROP DATABASE
    if (upper.startsWith("DROP DATABASE")) {
      return { fields: [], rows: [], tag: "DROP DATABASE" };
    }

    // CREATE TABLESPACE
    if (upper.startsWith("CREATE TABLESPACE")) {
      return { fields: [], rows: [], tag: "CREATE TABLESPACE" };
    }

    // DROP TABLESPACE
    if (upper.startsWith("DROP TABLESPACE")) {
      return { fields: [], rows: [], tag: "DROP TABLESPACE" };
    }

    // WITH (CTE)
    if (upper.startsWith("WITH")) {
      return this.executeWith(normalized);
    }

    return { error: `syntax error at or near "${query.trim().split(/\s+/)[0] || ""}"`, code: "42601" };
  }

  // Materialize one or more CTEs as temporary tables, run the final SELECT
  // against them, then clean up. Supports: WITH a AS (...), b AS (...) SELECT ...
  executeWith(query) {
    const ctes = [];
    let rest = query.replace(/^\s*WITH\s+/i, "");
    // Parse "name AS ( ... )" entries until we hit the trailing SELECT.
    while (true) {
      const head = rest.match(/^\s*(\w+)\s+AS\s*\(/i);
      if (!head) break;
      const name = head[1].toLowerCase();
      let i = head[0].length - 1; // index of "("
      let depth = 0;
      let bodyStart = -1;
      let bodyEnd = -1;
      for (; i < rest.length; i++) {
        if (rest[i] === "(") { if (depth === 0) bodyStart = i + 1; depth++; }
        else if (rest[i] === ")") { depth--; if (depth === 0) { bodyEnd = i; break; } }
      }
      if (bodyEnd === -1) return { error: "malformed CTE", code: "42601" };
      const body = rest.slice(bodyStart, bodyEnd).trim();
      ctes.push({ name, body });
      rest = rest.slice(bodyEnd + 1).replace(/^\s*,\s*/, "");
      if (!/^\s*\w+\s+AS\s*\(/i.test(rest)) break;
    }

    const created = [];
    try {
      for (const { name, body } of ctes) {
        const sub = this.executeSelect(body);
        if (sub && sub.error) return sub;
        this.tables.set(name, {
          name,
          fields: sub.fields,
          rows: sub.rows.map((r) => [...r]),
        });
        created.push(name);
      }
      const finalSelect = rest.trim();
      return this.executeSelect(finalSelect);
    } finally {
      for (const name of created) this.tables.delete(name);
    }
  }

  executeSelect(query) {
    const upper = query.toUpperCase();

    if (upper === "SELECT 1" || upper === "SELECT 1 AS ?COLUMN?") {
      return {
        fields: [{ name: "?column?", type: 23 }],
        rows: [[1]],
        tag: "SELECT 1",
      };
    }

    // information_schema introspection (read-only catalog shim). Handles the two
    // documented forms:
    //   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    //   SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'
    if (/\bFROM\s+information_schema\./i.test(query)) {
      return this.executeInformationSchema(query);
    }

    // Check for UNION
    if (upper.includes(" UNION ")) {
      return this.executeUnion(query);
    }

    // Check for INTERSECT
    if (upper.includes(" INTERSECT ")) {
      return this.executeIntersect(query);
    }

    // Check for EXCEPT
    if (upper.includes(" EXCEPT ")) {
      return this.executeExcept(query);
    }

    // Check for JOIN
    const joinMatch = query.match(/FROM\s+(\w+)\s+(\w+)\s+(?:INNER\s+)?JOIN\s+(\w+)\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i);
    if (joinMatch) {
      return this.executeJoinSelect(query, joinMatch);
    }

    const fromMatch = query.match(/FROM\s+(\w+)/i);
    if (!fromMatch) {
      // FROM-less SELECT of constant/function expressions, e.g.
      //   SELECT 1 AS ok        SELECT 'hi' AS greeting
      //   SELECT version()      SELECT now()      SELECT current_database()
      const constResult = this.executeConstSelect(query);
      if (constResult) return constResult;
      return { error: "Invalid SELECT statement", code: "42601" };
    }

    const tableName = fromMatch[1].toLowerCase();
    const table = this.tables.get(tableName) || this.views.get(tableName);

    if (!table) {
      return { error: `relation "${tableName}" does not exist`, code: "42P01" };
    }

    let rows = [...table.rows];

    // WHERE — terminate on clause keywords only at a word boundary so a value
    // that happens to contain "order"/"group" (e.g. 'multiorder') is not split.
    const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+(?:ORDER\s+BY|GROUP\s+BY|LIMIT|OFFSET)\b|$)/is);
    if (whereMatch) {
      const condition = whereMatch[1].trim();
      rows = rows.filter((row) => this.evaluateWhere(row, condition, table.fields));
    }

    // GROUP BY
    const groupByMatch = query.match(/GROUP\s+BY\s+(.+?)(?:\s+(?:HAVING|ORDER\s+BY|LIMIT|OFFSET)\b|$)/is);
    if (groupByMatch) {
      return this.executeGroupBy(query, rows, table, groupByMatch[1].trim());
    }

    // Parse the SELECT list (may be DISTINCT + columns/aggregates).
    const selectMatch = query.match(/SELECT\s+(DISTINCT\s+)?(.+?)\s+FROM/i);
    const isDistinct = !!(selectMatch && selectMatch[1] && selectMatch[1].toUpperCase().includes("DISTINCT"));
    const selectCols = selectMatch ? selectMatch[2].trim() : "*";

    // Aggregates without GROUP BY (e.g. SELECT COUNT(*) FROM t WHERE ...).
    if (selectCols !== "*" && /(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(selectCols)) {
      return this.executeAggregates(selectCols, rows, table);
    }

    // Reject features the engine cannot evaluate correctly, rather than
    // silently returning wrong results. Window functions are the common case.
    if (/\bOVER\s*\(/i.test(query)) {
      return {
        error: "window functions are not supported by the parlel postgres emulator",
        code: "0A000",
      };
    }

    // IMPORTANT: ORDER BY / OFFSET / LIMIT / DISTINCT are applied against the
    // FULL rows first, then projection happens last. Doing projection first
    // (the old behavior) made ORDER BY index into the wrong column.
    let working = rows;

    // ORDER BY (on full-row column indices).
    const orderMatch = query.match(/ORDER\s+BY\s+(.+?)(?:\s+(?:LIMIT|OFFSET)\b|$)/is);
    if (orderMatch) {
      const orderClauses = orderMatch[1].split(",").map((c) => c.trim());
      working = [...working].sort((a, b) => {
        for (const clause of orderClauses) {
          const parts = clause.split(/\s+/);
          const field = parts[0].toLowerCase().replace(/^\w+\./, "");
          const dir = (parts[1] || "ASC").toUpperCase();
          const idx = table.fields.findIndex((f) => f.name.toLowerCase() === field);
          if (idx !== -1) {
            const aVal = a[idx];
            const bVal = b[idx];
            if (aVal === null && bVal === null) continue;
            if (aVal === null) return 1;
            if (bVal === null) return -1;
            let cmp = 0;
            if (typeof aVal === "number" && typeof bVal === "number") cmp = aVal - bVal;
            else cmp = String(aVal).localeCompare(String(bVal));
            if (cmp !== 0) return dir === "DESC" ? -cmp : cmp;
          }
        }
        return 0;
      });
    }

    // OFFSET / LIMIT (on full rows so projection preserves order).
    const offsetMatch = query.match(/OFFSET\s+(\d+)/i);
    if (offsetMatch) working = working.slice(parseInt(offsetMatch[1], 10));
    const limitMatch = query.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) working = working.slice(0, parseInt(limitMatch[1], 10));

    // Projection (last).
    let fields = table.fields;
    let resultRows = working;
    if (selectCols !== "*") {
      const colNames = selectCols.split(",").map((c) => c.trim().toLowerCase().replace(/^\w+\./, ""));
      const indices = colNames.map((c) => table.fields.findIndex((f) => f.name.toLowerCase() === c));
      fields = indices.filter((i) => i !== -1).map((i) => table.fields[i]);
      resultRows = working.map((row) => indices.filter((i) => i !== -1).map((i) => row[i]));
    }

    // DISTINCT (after projection so it dedupes on the selected columns).
    if (isDistinct) {
      const seen = new Set();
      resultRows = resultRows.filter((row) => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return {
      fields,
      rows: resultRows,
      tag: `SELECT ${resultRows.length}`,
    };
  }

  // Map our internal type OIDs back to the SQL standard data_type names that
  // information_schema.columns reports.
  _typeName(oid) {
    switch (oid) {
      case 23: return "integer";
      case 20: return "bigint";
      case 16: return "boolean";
      case 25: return "text";
      case 1700: return "numeric";
      case 700: return "real";
      case 701: return "double precision";
      case 1114: return "timestamp without time zone";
      case 1184: return "timestamp with time zone";
      case 1082: return "date";
      case 1083: return "time without time zone";
      case 3802: return "jsonb";
      case 2950: return "uuid";
      default: return "text";
    }
  }

  // Minimal read-only information_schema implementation. Supports the documented
  // table_name / column_name introspection queries with an optional WHERE filter
  // on table_schema (always 'public' here) and table_name.
  executeInformationSchema(query) {
    const rel = query.match(/FROM\s+information_schema\.(\w+)/i);
    const relation = rel ? rel[1].toLowerCase() : "";
    const selectMatch = query.match(/SELECT\s+(DISTINCT\s+)?(.+?)\s+FROM/i);
    const selectCols = selectMatch ? selectMatch[2].trim() : "*";

    // Optional WHERE filters we understand.
    const schemaFilter = query.match(/table_schema\s*=\s*'([^']*)'/i);
    const tableFilter = query.match(/table_name\s*=\s*'([^']*)'/i);

    // Synthesize a virtual table of rows keyed by well-known column names.
    let allColumns;
    if (relation === "tables") {
      allColumns = ["table_catalog", "table_schema", "table_name", "table_type"];
      let rows = [];
      for (const [name] of this.tables) {
        rows.push([this.database || "parlel", "public", name, "BASE TABLE"]);
      }
      for (const [name] of this.views) {
        rows.push([this.database || "parlel", "public", name, "VIEW"]);
      }
      if (schemaFilter && schemaFilter[1].toLowerCase() !== "public") rows = [];
      if (tableFilter) rows = rows.filter((r) => r[2] === tableFilter[1].toLowerCase());
      return this._projectInfoSchema(selectCols, allColumns, rows);
    }

    if (relation === "columns") {
      allColumns = ["table_catalog", "table_schema", "table_name", "column_name", "ordinal_position", "data_type", "is_nullable"];
      let rows = [];
      const wantTable = tableFilter ? tableFilter[1].toLowerCase() : null;
      for (const [name, table] of this.tables) {
        if (wantTable && name !== wantTable) continue;
        table.fields.forEach((f, i) => {
          rows.push([this.database || "parlel", "public", name, f.name, i + 1, this._typeName(f.type), "YES"]);
        });
      }
      if (schemaFilter && schemaFilter[1].toLowerCase() !== "public") rows = [];
      return this._projectInfoSchema(selectCols, allColumns, rows);
    }

    // Any other information_schema relation: return an empty result honestly
    // (no rows) rather than a wrong-shape error.
    return { fields: [{ name: "table_name", type: 25 }], rows: [], tag: "SELECT 0" };
  }

  // Project an information_schema virtual table down to the requested columns.
  _projectInfoSchema(selectCols, allColumns, rows) {
    if (selectCols === "*") {
      return {
        fields: allColumns.map((c) => ({ name: c, type: 25 })),
        rows,
        tag: `SELECT ${rows.length}`,
      };
    }
    const cols = selectCols.split(",").map((c) => c.trim().replace(/^"|"$/g, "").toLowerCase());
    const indices = cols.map((c) => allColumns.indexOf(c));
    const fields = indices.filter((i) => i !== -1).map((i) => ({ name: allColumns[i], type: 25 }));
    const projected = rows.map((r) => indices.filter((i) => i !== -1).map((i) => r[i]));
    return { fields, rows: projected, tag: `SELECT ${projected.length}` };
  }

  // FROM-less SELECT of constant / simple-function expressions, e.g.
  //   SELECT 1 AS ok          SELECT 'hi' AS greeting        SELECT 1, 2
  //   SELECT version()        SELECT now()                   SELECT current_database()
  // Returns null when the expression list isn't something we can evaluate, so
  // the caller can fall back to its normal error path.
  executeConstSelect(query) {
    const m = query.match(/^SELECT\s+(.+)$/is);
    if (!m) return null;
    const list = m[1].trim();
    // Bail if it references a relation construct we don't handle here.
    if (/\bFROM\b/i.test(list)) return null;

    const items = this._splitTopLevel(list, ",");
    const fields = [];
    const row = [];
    for (const rawItem of items) {
      const item = rawItem.trim();
      if (!item) return null;
      // Try the whole item as a bare expression first (e.g. "1", "version()").
      let expr = item;
      let alias = null;
      let evaluated = this._evalConstExpr(expr);
      if (evaluated === undefined) {
        // Otherwise split an explicit/implicit alias:  <expr> [AS] <name>
        const aliasMatch = item.match(/^(.*?)\s+(?:AS\s+)?"?([A-Za-z_]\w*)"?$/is);
        if (aliasMatch) {
          expr = aliasMatch[1].trim();
          alias = aliasMatch[2];
          evaluated = this._evalConstExpr(expr);
        }
      }
      if (evaluated === undefined) return null;
      fields.push({ name: alias || evaluated.name, type: evaluated.type });
      row.push(evaluated.value);
    }
    return { fields, rows: [row], tag: "SELECT 1" };
  }

  // Evaluate a single constant/function expression. Returns
  // { value, name, type } or undefined if unsupported.
  _evalConstExpr(expr) {
    const e = expr.trim();
    const upper = e.toUpperCase();
    // Integer literal
    if (/^-?\d+$/.test(e)) return { value: parseInt(e, 10), name: "?column?", type: 23 };
    // Numeric/float literal
    if (/^-?\d*\.\d+$/.test(e)) return { value: parseFloat(e), name: "?column?", type: 701 };
    // String literal 'text'
    if (/^'([^']*)'$/.test(e)) return { value: e.slice(1, -1), name: "?column?", type: 25 };
    // Boolean
    if (upper === "TRUE") return { value: true, name: "bool", type: 16 };
    if (upper === "FALSE") return { value: false, name: "bool", type: 16 };
    if (upper === "NULL") return { value: null, name: "?column?", type: 25 };
    // Common zero-arg functions used as health probes
    if (upper === "VERSION()") {
      return { value: "PostgreSQL 16.0 (parlel emulator)", name: "version", type: 25 };
    }
    if (upper === "NOW()" || upper === "CURRENT_TIMESTAMP") {
      return { value: new Date().toISOString(), name: "now", type: 1184 };
    }
    if (upper === "CURRENT_DATE") {
      return { value: new Date().toISOString().slice(0, 10), name: "current_date", type: 1082 };
    }
    if (upper === "CURRENT_DATABASE()") {
      return { value: this.database || "parlel", name: "current_database", type: 25 };
    }
    if (upper === "CURRENT_USER" || upper === "CURRENT_USER()" || upper === "USER") {
      return { value: this.user || "parlel", name: "current_user", type: 25 };
    }
    return undefined;
  }

  // Split a string on a delimiter at the top level (ignoring delimiters inside
  // quotes or parentheses).
  _splitTopLevel(str, delim) {
    const parts = [];
    let depth = 0;
    let inStr = false;
    let cur = "";
    for (const ch of str) {
      if (ch === "'") inStr = !inStr;
      else if (!inStr && ch === "(") depth++;
      else if (!inStr && ch === ")") depth--;
      if (!inStr && depth === 0 && ch === delim) {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }

  executeJoinSelect(query, joinMatch) {
    const [, table1Name, alias1, table2Name, alias2, leftAlias, leftField, rightAlias, rightField] = joinMatch;

    const table1 = this.tables.get(table1Name.toLowerCase());
    const table2 = this.tables.get(table2Name.toLowerCase());

    if (!table1 || !table2) {
      return { error: "relation does not exist", code: "42P01" };
    }

    const leftIdx = table1.fields.findIndex((f) => f.name.toLowerCase() === leftField.toLowerCase());
    const rightIdx = table2.fields.findIndex((f) => f.name.toLowerCase() === rightField.toLowerCase());

    if (leftIdx === -1 || rightIdx === -1) {
      return { error: "column does not exist", code: "42703" };
    }

    const isLeftTable1 = leftAlias.toLowerCase() === alias1.toLowerCase();
    const leftTable = isLeftTable1 ? table1 : table2;
    const rightTable = isLeftTable1 ? table2 : table1;
    const leftTableIdx = isLeftTable1 ? leftIdx : rightIdx;
    const rightTableIdx = isLeftTable1 ? rightIdx : leftIdx;

    const joinedRows = [];
    for (const leftRow of leftTable.rows) {
      for (const rightRow of rightTable.rows) {
        if (String(leftRow[leftTableIdx]) === String(rightRow[rightTableIdx])) {
          joinedRows.push([...leftRow, ...rightRow]);
        }
      }
    }

    const fields = [...leftTable.fields, ...rightTable.fields];

    let resultRows = joinedRows;
    const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+(?:ORDER\s+BY|GROUP\s+BY|LIMIT|OFFSET)\b|$)/is);
    if (whereMatch) {
      resultRows = joinedRows.filter((row) => this.evaluateWhere(row, whereMatch[1].trim(), fields));
    }

    const selectMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
    if (selectMatch) {
      const selectCols = selectMatch[1].trim();
      if (selectCols !== "*") {
        const colNames = selectCols.split(",").map((c) => {
          const parts = c.trim().split(".");
          return parts[parts.length - 1].toLowerCase();
        });

        const indices = colNames.map((c) => {
          return fields.findIndex((f) => f.name.toLowerCase() === c);
        }).filter((i) => i !== -1);

        const selectedFields = indices.map((i) => fields[i]);
        const selectedRows = resultRows.map((row) => indices.map((i) => row[i]));

        return {
          fields: selectedFields,
          rows: selectedRows,
          tag: `SELECT ${selectedRows.length}`,
        };
      }
    }

    return {
      fields,
      rows: resultRows,
      tag: `SELECT ${resultRows.length}`,
    };
  }

  executeUnion(query) {
    const parts = query.split(/\s+UNION\s+(?:ALL\s+)?/i);
    const results = [];

    for (const part of parts) {
      const result = this.executeSelect(part.trim());
      if (result.error) return result;
      results.push(result);
    }

    const fields = results[0].fields;
    let rows = results.flatMap((r) => r.rows);

    // Remove duplicates unless UNION ALL
    if (!query.toUpperCase().includes("UNION ALL")) {
      const seen = new Set();
      rows = rows.filter((row) => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return {
      fields,
      rows,
      tag: `SELECT ${rows.length}`,
    };
  }

  executeIntersect(query) {
    const parts = query.split(/\s+INTERSECT\s+(?:ALL\s+)?/i);
    const results = [];

    for (const part of parts) {
      const result = this.executeSelect(part.trim());
      if (result.error) return result;
      results.push(result);
    }

    const fields = results[0].fields;
    let rows = results[0].rows;

    for (let i = 1; i < results.length; i++) {
      const otherRows = new Set(results[i].rows.map((r) => JSON.stringify(r)));
      rows = rows.filter((row) => otherRows.has(JSON.stringify(row)));
    }

    return {
      fields,
      rows,
      tag: `SELECT ${rows.length}`,
    };
  }

  executeExcept(query) {
    const parts = query.split(/\s+EXCEPT\s+(?:ALL\s+)?/i);
    const results = [];

    for (const part of parts) {
      const result = this.executeSelect(part.trim());
      if (result.error) return result;
      results.push(result);
    }

    const fields = results[0].fields;
    let rows = results[0].rows;

    for (let i = 1; i < results.length; i++) {
      const otherRows = new Set(results[i].rows.map((r) => JSON.stringify(r)));
      rows = rows.filter((row) => !otherRows.has(JSON.stringify(row)));
    }

    return {
      fields,
      rows,
      tag: `SELECT ${rows.length}`,
    };
  }

  executeAggregates(selectCols, rows, table) {
    const fields = [];
    const resultRow = [];

    const countMatch = selectCols.match(/COUNT\s*\(\s*\*\s*\)/i);
    if (countMatch) {
      fields.push({ name: "count", type: 20 });
      resultRow.push(rows.length);
    }

    const sumMatch = selectCols.match(/SUM\s*\(\s*(\w+)\s*\)/i);
    if (sumMatch) {
      const col = sumMatch[1].toLowerCase();
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === col);
      if (idx !== -1) {
        const sum = rows.reduce((acc, row) => acc + (parseFloat(row[idx]) || 0), 0);
        fields.push({ name: `sum`, type: 1700 });
        resultRow.push(sum);
      }
    }

    const avgMatch = selectCols.match(/AVG\s*\(\s*(\w+)\s*\)/i);
    if (avgMatch) {
      const col = avgMatch[1].toLowerCase();
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === col);
      if (idx !== -1) {
        const sum = rows.reduce((acc, row) => acc + (parseFloat(row[idx]) || 0), 0);
        const avg = rows.length > 0 ? sum / rows.length : 0;
        fields.push({ name: `avg`, type: 1700 });
        resultRow.push(avg);
      }
    }

    const minMatch = selectCols.match(/MIN\s*\(\s*(\w+)\s*\)/i);
    if (minMatch) {
      const col = minMatch[1].toLowerCase();
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === col);
      if (idx !== -1) {
        const values = rows.map((row) => row[idx]).filter((v) => v !== null);
        const min = values.length > 0 ? Math.min(...values.map(Number)) : null;
        fields.push({ name: `min`, type: table.fields[idx].type });
        resultRow.push(min);
      }
    }

    const maxMatch = selectCols.match(/MAX\s*\(\s*(\w+)\s*\)/i);
    if (maxMatch) {
      const col = maxMatch[1].toLowerCase();
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === col);
      if (idx !== -1) {
        const values = rows.map((row) => row[idx]).filter((v) => v !== null);
        const max = values.length > 0 ? Math.max(...values.map(Number)) : null;
        fields.push({ name: `max`, type: table.fields[idx].type });
        resultRow.push(max);
      }
    }

    return {
      fields,
      rows: [resultRow],
      tag: `SELECT 1`,
    };
  }

  executeGroupBy(query, rows, table, groupByClause) {
    const groupCols = groupByClause.split(",").map((c) => c.trim().toLowerCase().replace(/^\w+\./, ""));
    const groupIndices = groupCols.map((c) => table.fields.findIndex((f) => f.name.toLowerCase() === c));

    const groups = new Map();
    const order = [];
    for (const row of rows) {
      const key = groupIndices.map((i) => row[i]).join("|");
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key).push(row);
    }

    const selectMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
    if (!selectMatch) return { error: "Invalid SELECT statement", code: "42601" };
    const selectCols = selectMatch[1].trim();

    // Parse the SELECT list into ordered output items: each is either a
    // grouped column reference or an aggregate expression.
    const items = this._parseSelectItems(selectCols, table, groupCols);

    // Build the field list once (from the first group's shape).
    const fields = items.map((it) => it.field);

    let resultRows = order.map((key) => {
      const groupRows = groups.get(key);
      return items.map((it) => it.eval(groupRows));
    });

    // HAVING — filter aggregated groups.
    const havingMatch = query.match(/HAVING\s+(.+?)(?:\s+(?:ORDER\s+BY|LIMIT|OFFSET)\b|$)/is);
    if (havingMatch) {
      const cond = havingMatch[1].trim();
      const hav = this._compileHaving(cond, table, groupCols, items);
      resultRows = resultRows.filter((projected, idx) => hav(groups.get(order[idx]), projected));
    }

    // ORDER BY over the projected output columns (by position / name).
    const orderMatch = query.match(/ORDER\s+BY\s+(.+?)(?:\s+(?:LIMIT|OFFSET)\b|$)/is);
    if (orderMatch) {
      const clauses = orderMatch[1].split(",").map((c) => c.trim());
      resultRows.sort((a, b) => {
        for (const clause of clauses) {
          const parts = clause.split(/\s+/);
          const ref = parts[0].toLowerCase().replace(/^\w+\./, "");
          const dir = (parts[1] || "ASC").toUpperCase();
          let idx = fields.findIndex((f) => f.name.toLowerCase() === ref);
          if (idx === -1 && /^\d+$/.test(ref)) idx = parseInt(ref, 10) - 1;
          if (idx >= 0) {
            const av = a[idx];
            const bv = b[idx];
            let cmp = (typeof av === "number" && typeof bv === "number") ? av - bv : String(av).localeCompare(String(bv));
            if (cmp !== 0) return dir === "DESC" ? -cmp : cmp;
          }
        }
        return 0;
      });
    }

    const offsetMatch = query.match(/OFFSET\s+(\d+)/i);
    if (offsetMatch) resultRows = resultRows.slice(parseInt(offsetMatch[1], 10));
    const limitMatch = query.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) resultRows = resultRows.slice(0, parseInt(limitMatch[1], 10));

    return { fields, rows: resultRows, tag: `SELECT ${resultRows.length}` };
  }

  // Parse a GROUP BY select list into ordered evaluable items.
  _parseSelectItems(selectCols, table, groupCols) {
    const parts = this._splitTopLevel(selectCols);
    return parts.map((raw) => {
      const expr = raw.trim();
      const agg = expr.match(/^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(.+?)\s*\)(?:\s+AS\s+(\w+))?$/i);
      if (agg) {
        const fn = agg[1].toUpperCase();
        const arg = agg[2].trim();
        const alias = agg[3] ? agg[3].toLowerCase() : fn.toLowerCase();
        const colIdx = arg === "*" ? -1 : table.fields.findIndex((f) => f.name.toLowerCase() === arg.toLowerCase().replace(/^\w+\./, ""));
        return {
          field: { name: alias, type: fn === "AVG" ? 1700 : 20 },
          eval: (groupRows) => this._aggregate(fn, groupRows, colIdx),
        };
      }
      // Plain grouped column.
      const name = expr.toLowerCase().replace(/^\w+\./, "").replace(/\s+as\s+\w+$/i, "");
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === name);
      return {
        field: idx >= 0 ? table.fields[idx] : { name, type: 25 },
        eval: (groupRows) => (idx >= 0 ? groupRows[0][idx] : null),
      };
    });
  }

  _aggregate(fn, groupRows, colIdx) {
    if (fn === "COUNT") {
      if (colIdx === -1) return groupRows.length;
      return groupRows.filter((r) => r[colIdx] !== null && r[colIdx] !== undefined).length;
    }
    const nums = groupRows.map((r) => r[colIdx]).filter((v) => v !== null && v !== undefined);
    if (fn === "MIN") return nums.reduce((a, b) => (a < b ? a : b), nums[0] ?? null);
    if (fn === "MAX") return nums.reduce((a, b) => (a > b ? a : b), nums[0] ?? null);
    const sum = nums.reduce((a, b) => a + Number(b), 0);
    if (fn === "SUM") return nums.length ? sum : null;
    if (fn === "AVG") return nums.length ? sum / nums.length : null;
    return null;
  }

  // Compile a HAVING predicate referencing aggregates or grouped columns.
  _compileHaving(cond, table, groupCols, items) {
    const m = cond.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/);
    if (!m) return () => true;
    const lhsRaw = m[1].trim();
    const op = m[2];
    const rhs = this._coerce(m[3].trim());
    const aggMatch = lhsRaw.match(/^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(.+?)\s*\)$/i);
    let getLeft;
    if (aggMatch) {
      const fn = aggMatch[1].toUpperCase();
      const arg = aggMatch[2].trim();
      const colIdx = arg === "*" ? -1 : table.fields.findIndex((f) => f.name.toLowerCase() === arg.toLowerCase().replace(/^\w+\./, ""));
      getLeft = (groupRows) => this._aggregate(fn, groupRows, colIdx);
    } else {
      const name = lhsRaw.toLowerCase().replace(/^\w+\./, "");
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === name);
      getLeft = (groupRows) => (idx >= 0 ? groupRows[0][idx] : null);
    }
    return (groupRows) => {
      const l = getLeft(groupRows);
      switch (op) {
        case "=": return l == rhs;
        case "<>": case "!=": return l != rhs;
        case ">": return l > rhs;
        case "<": return l < rhs;
        case ">=": return l >= rhs;
        case "<=": return l <= rhs;
        default: return true;
      }
    };
  }

  _coerce(token) {
    const t = token.trim();
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  }

  // Split a comma list at top level (not inside parentheses).
  _splitTopLevel(str) {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of str) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  executeCreateTable(query) {
    const match = query.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.+)\)/is);
    if (!match) {
      return { error: "Invalid CREATE TABLE statement", code: "42601" };
    }

    const tableName = match[1].toLowerCase();
    const columnsStr = match[2];

    if (this.tables.has(tableName)) {
      return { fields: [], rows: [], tag: "CREATE TABLE" };
    }

    const columns = this.parseColumns(columnsStr);
    this.tables.set(tableName, { fields: columns, rows: [], name: tableName });

    return { fields: [], rows: [], tag: "CREATE TABLE" };
  }

  executeCreateView(query) {
    const match = query.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(\w+)\s+AS\s+(.+)/is);
    if (!match) {
      return { error: "Invalid CREATE VIEW statement", code: "42601" };
    }

    const viewName = match[1].toLowerCase();
    const selectQuery = match[2].trim();

    // Execute the SELECT to get the structure
    const result = this.executeSelect(selectQuery);
    if (result.error) return result;

    this.views.set(viewName, {
      fields: result.fields,
      rows: result.rows,
      query: selectQuery,
    });

    return { fields: [], rows: [], tag: "CREATE VIEW" };
  }

  executeCreateSequence(query) {
    const match = query.match(/CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)(?:\s+START\s+WITH\s+(\d+))?(?:\s+INCREMENT\s+BY\s+(\d+))?/i);
    if (!match) {
      return { error: "Invalid CREATE SEQUENCE statement", code: "42601" };
    }

    const seqName = match[1].toLowerCase();
    const start = match[2] ? parseInt(match[2]) : 1;
    const increment = match[3] ? parseInt(match[3]) : 1;

    this.sequences.set(seqName, {
      current: start - increment,
      start,
      increment,
    });

    return { fields: [], rows: [], tag: "CREATE SEQUENCE" };
  }

  executeTruncate(query) {
    const match = query.match(/TRUNCATE\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    if (!match) {
      return { error: "Invalid TRUNCATE statement", code: "42601" };
    }

    const tableName = match[1].toLowerCase();
    const table = this.tables.get(tableName);
    if (!table) {
      return { error: `relation "${tableName}" does not exist`, code: "42P01" };
    }

    table.rows = [];
    return { fields: [], rows: [], tag: "TRUNCATE TABLE" };
  }

  executeDropTable(query) {
    const match = query.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    if (!match) {
      return { error: "Invalid DROP TABLE statement", code: "42601" };
    }

    const tableName = match[1].toLowerCase();
    this.tables.delete(tableName);

    return { fields: [], rows: [], tag: "DROP TABLE" };
  }

  executeDropView(query) {
    const match = query.match(/DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    if (!match) {
      return { error: "Invalid DROP VIEW statement", code: "42601" };
    }

    const viewName = match[1].toLowerCase();
    this.views.delete(viewName);

    return { fields: [], rows: [], tag: "DROP VIEW" };
  }

  executeAlterTable(query) {
    const addMatch = query.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+(\w+)/i);
    if (addMatch) {
      const tableName = addMatch[1].toLowerCase();
      const columnName = addMatch[2].toLowerCase();
      const columnType = addMatch[3].toUpperCase();

      const table = this.tables.get(tableName);
      if (!table) {
        return { error: `relation "${tableName}" does not exist`, code: "42P01" };
      }

      let type = 25; // text
      if (["INTEGER", "INT", "SERIAL"].includes(columnType)) type = 23;
      if (["BIGINT", "BIGSERIAL"].includes(columnType)) type = 20;
      if (["BOOLEAN", "BOOL"].includes(columnType)) type = 16;

      table.fields.push({ name: columnName, type });

      return { fields: [], rows: [], tag: "ALTER TABLE" };
    }

    const dropMatch = query.match(/ALTER\s+TABLE\s+(\w+)\s+DROP\s+(?:COLUMN\s+)?(\w+)/i);
    if (dropMatch) {
      const tableName = dropMatch[1].toLowerCase();
      const columnName = dropMatch[2].toLowerCase();

      const table = this.tables.get(tableName);
      if (!table) {
        return { error: `relation "${tableName}" does not exist`, code: "42P01" };
      }

      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === columnName);
      if (idx !== -1) {
        table.fields.splice(idx, 1);
        // Also remove from rows
        for (const row of table.rows) {
          row.splice(idx, 1);
        }
      }

      return { fields: [], rows: [], tag: "ALTER TABLE" };
    }

    return { fields: [], rows: [], tag: "ALTER TABLE" };
  }

  // Split a trailing `RETURNING ...` clause off a DML statement so the core
  // parsers stay simple. Returns the clause column list (or "*"), or null.
  extractReturning(query) {
    const m = query.match(/\s+RETURNING\s+(.+?)\s*;?\s*$/is);
    if (!m) return { sql: query, returning: null };
    return { sql: query.slice(0, m.index), returning: m[1].trim() };
  }

  // Build the {fields, rows} payload for a RETURNING clause given affected rows.
  buildReturning(table, rows, returning) {
    if (returning === "*" || returning === "") {
      return { fields: table.fields, rows };
    }
    const cols = returning
      .split(",")
      .map((c) => c.trim().replace(/^"|"$/g, "").toLowerCase());
    const indices = cols.map((c) =>
      table.fields.findIndex((f) => f.name.toLowerCase() === c),
    );
    const fields = indices.filter((i) => i !== -1).map((i) => table.fields[i]);
    const projected = rows.map((r) => indices.filter((i) => i !== -1).map((i) => r[i]));
    return { fields, rows: projected };
  }

  // Apply column DEFAULTs to any cell still null after explicit assignment.
  applyDefaults(table, row) {
    for (let i = 0; i < table.fields.length; i++) {
      if (row[i] === null && table.fields[i].default !== undefined) {
        let d = table.fields[i].default;
        if (typeof d === "string" && /^(CURRENT_TIMESTAMP|NOW\(\))$/i.test(d)) {
          d = new Date().toISOString();
        }
        row[i] = d;
      }
    }
  }

  executeInsert(query, returning = null) {
    const match = query.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)/is);
    if (!match) {
      const simpleMatch = query.match(/INSERT\s+INTO\s+(\w+)\s+VALUES\s*\((.+)\)/is);
      if (simpleMatch) {
        const tableName = simpleMatch[1].toLowerCase();
        const table = this.tables.get(tableName);
        if (!table) {
          return { error: `relation "${tableName}" does not exist`, code: "42P01" };
        }
        const values = this.parseValues(simpleMatch[2]);
        const row = this.assignValuesToRow(table, values);
        this.applyDefaults(table, row);
        table.rows.push(row);
        if (returning) {
          const r = this.buildReturning(table, [row], returning);
          return { fields: r.fields, rows: r.rows, tag: "INSERT 0 1" };
        }
        return { fields: [], rows: [], tag: "INSERT 0 1" };
      }
      return { error: "Invalid INSERT statement", code: "42601" };
    }

    const tableName = match[1].toLowerCase();
    const columns = match[2].split(",").map((c) => c.trim().toLowerCase());
    const valuesStr = match[3];

    const table = this.tables.get(tableName);
    if (!table) {
      return { error: `relation "${tableName}" does not exist`, code: "42P01" };
    }

    const values = this.parseValues(valuesStr);
    const row = new Array(table.fields.length).fill(null);

    const hasId = columns.some(c => c === "id");
    if (!hasId) {
      const idIdx = table.fields.findIndex((f) => f.name.toLowerCase() === "id");
      if (idIdx !== -1) {
        row[idIdx] = this.getNextId(tableName);
      }
    }

    for (let i = 0; i < columns.length; i++) {
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === columns[i]);
      if (idx !== -1) {
        row[idx] = values[i];
      }
    }

    this.applyDefaults(table, row);

    const emailIdx = table.fields.findIndex((f) => f.name.toLowerCase() === "email");
    if (emailIdx !== -1 && row[emailIdx]) {
      const existing = table.rows.find((r) => r[emailIdx] === row[emailIdx]);
      if (existing) {
        Object.assign(existing, row);
        if (returning) {
          const r = this.buildReturning(table, [existing], returning);
          return { fields: r.fields, rows: r.rows, tag: "INSERT 0 1" };
        }
        return { fields: [], rows: [], tag: "INSERT 0 1" };
      }
    }

    table.rows.push(row);

    if (returning) {
      const r = this.buildReturning(table, [row], returning);
      return { fields: r.fields, rows: r.rows, tag: "INSERT 0 1" };
    }
    return { fields: [], rows: [], tag: "INSERT 0 1" };
  }

  assignValuesToRow(table, values) {
    const row = new Array(table.fields.length).fill(null);

    if (values.length === table.fields.length) {
      for (let i = 0; i < table.fields.length; i++) row[i] = values[i];
      return row;
    }

    const idIdx = table.fields.findIndex((f) => f.name.toLowerCase() === "id");
    if (idIdx !== -1) {
      row[idIdx] = this.getNextId(table.name || "unknown");
    }

    let valueIdx = 0;
    for (let i = 0; i < table.fields.length; i++) {
      if (i === idIdx) continue;
      if (valueIdx < values.length) {
        row[i] = values[valueIdx++];
      }
    }
    return row;
  }

  executeUpdate(query, returning = null) {
    const match = query.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is);
    if (!match) {
      return { error: "Invalid UPDATE statement", code: "42601" };
    }

    const tableName = match[1].toLowerCase();
    const setClause = match[2].trim();
    const whereClause = match[3];

    const table = this.tables.get(tableName);
    if (!table) {
      return { error: `relation "${tableName}" does not exist`, code: "42P01" };
    }

    const setParts = setClause.split(",").map((s) => {
      const [col, val] = s.split("=").map((p) => p.trim());
      return { col: col.toLowerCase(), val: val.replace(/^'|'$/g, "") };
    });

    let updated = 0;
    const affected = [];
    for (const row of table.rows) {
      if (whereClause && !this.evaluateWhere(row, whereClause, table.fields)) {
        continue;
      }

      for (const { col, val } of setParts) {
        const idx = table.fields.findIndex((f) => f.name.toLowerCase() === col);
        if (idx !== -1) {
          row[idx] = val === "NULL" ? null : val;
        }
      }
      affected.push(row);
      updated++;
    }

    if (returning) {
      const r = this.buildReturning(table, affected, returning);
      return { fields: r.fields, rows: r.rows, tag: `UPDATE ${updated}` };
    }
    return { fields: [], rows: [], tag: `UPDATE ${updated}` };
  }

  executeDelete(query, returning = null) {
    const match = query.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is);
    if (!match) {
      return { error: "Invalid DELETE statement", code: "42601" };
    }

    const tableName = match[1].toLowerCase();
    const whereClause = match[2];

    const table = this.tables.get(tableName);
    if (!table) {
      return { error: `relation "${tableName}" does not exist`, code: "42P01" };
    }

    const before = table.rows.length;
    const removed = [];

    if (whereClause) {
      table.rows = table.rows.filter((row) => {
        const match = this.evaluateWhere(row, whereClause, table.fields);
        if (match) removed.push(row);
        return !match;
      });
    } else {
      removed.push(...table.rows);
      table.rows = [];
    }

    const deleted = before - table.rows.length;

    if (returning) {
      const r = this.buildReturning(table, removed, returning);
      return { fields: r.fields, rows: r.rows, tag: `DELETE ${deleted}` };
    }
    return { fields: [], rows: [], tag: `DELETE ${deleted}` };
  }

  executeExplain(query) {
    const innerQuery = query.replace(/^EXPLAIN\s+/i, "").trim();
    const result = this.execute(innerQuery);

    return {
      fields: [{ name: "QUERY PLAN", type: 25 }],
      rows: [
        [`Seq Scan on ... (cost=0.00..1.00 rows=1 width=0)`],
        [`  -> ${result.tag || "OK"}`],
      ],
      tag: "EXPLAIN",
    };
  }

  executeNextval(query) {
    const match = query.match(/SELECT\s+NEXTVAL\s*\(\s*'(\w+)'\s*\)/i);
    if (!match) {
      return { error: "Invalid NEXTVAL statement", code: "42601" };
    }

    const seqName = match[1].toLowerCase();
    const value = this.getNextSequence(seqName);

    if (value === null) {
      return { error: `sequence "${seqName}" does not exist`, code: "42P01" };
    }

    return {
      fields: [{ name: "nextval", type: 20 }],
      rows: [[value]],
      tag: "SELECT 1",
    };
  }

  executeCurrval(query) {
    const match = query.match(/SELECT\s+CURRVAL\s*\(\s*'(\w+)'\s*\)/i);
    if (!match) {
      return { error: "Invalid CURRVAL statement", code: "42601" };
    }

    const seqName = match[1].toLowerCase();
    const seq = this.sequences.get(seqName);

    if (!seq) {
      return { error: `sequence "${seqName}" does not exist`, code: "42P01" };
    }

    return {
      fields: [{ name: "currval", type: 20 }],
      rows: [[seq.current]],
      tag: "SELECT 1",
    };
  }

  executeSetval(query) {
    const match = query.match(/SELECT\s+SETVAL\s*\(\s*'(\w+)'\s*,\s*(\d+)\s*\)/i);
    if (!match) {
      return { error: "Invalid SETVAL statement", code: "42601" };
    }

    const seqName = match[1].toLowerCase();
    const value = parseInt(match[2]);

    const seq = this.sequences.get(seqName);
    if (!seq) {
      return { error: `sequence "${seqName}" does not exist`, code: "42P01" };
    }

    seq.current = value;

    return {
      fields: [{ name: "setval", type: 20 }],
      rows: [[value]],
      tag: "SELECT 1",
    };
  }

  executeShow(query) {
    const match = query.match(/SHOW\s+(\w+)/i);
    if (!match) {
      return { error: "Invalid SHOW statement", code: "42601" };
    }

    const param = match[1].toLowerCase();
    let value;

    switch (param) {
      case "server_version":
        value = "16.0";
        break;
      case "server_encoding":
        value = "UTF8";
        break;
      case "client_encoding":
        value = "UTF8";
        break;
      case "lc_collate":
        value = "en_US.UTF-8";
        break;
      case "lc_ctype":
        value = "en_US.UTF-8";
        break;
      case "is_superuser":
        value = "on";
        break;
      case "session_authorization":
        value = "parlel";
        break;
      case "standard_conforming_strings":
        value = "on";
        break;
      case "timezone":
        value = "UTC";
        break;
      case "datestyle":
        value = "ISO, MDY";
        break;
      case "integer_datetimes":
        value = "on";
        break;
      case "transaction_isolation":
        value = "read committed";
        break;
      default:
        value = "";
    }

    return {
      fields: [{ name: param, type: 25 }],
      rows: [[value]],
      tag: `SHOW`,
    };
  }

  parseColumns(columnsStr) {
    const columns = [];
    const parts = this.splitColumns(columnsStr);

    for (const part of parts) {
      const trimmed = part.trim();
      const tokens = trimmed.split(/\s+/);
      const name = tokens[0].toLowerCase();
      let type = 25; // text

      if (tokens[1]) {
        const typeStr = tokens[1].toUpperCase();
        if (typeStr === "INTEGER" || typeStr === "INT" || typeStr === "SERIAL") {
          type = 23; // int4
        } else if (typeStr === "BIGINT" || typeStr === "BIGSERIAL") {
          type = 20; // int8
        } else if (typeStr === "BOOLEAN" || typeStr === "BOOL") {
          type = 16; // bool
        } else if (typeStr === "TIMESTAMP" || typeStr === "TIMESTAMPTZ") {
          type = 1114; // timestamp
        } else if (typeStr === "TEXT" || typeStr === "VARCHAR" || typeStr === "CHAR") {
          type = 25; // text
        } else if (typeStr === "DECIMAL" || typeStr === "NUMERIC") {
          type = 1700; // numeric
        } else if (typeStr === "FLOAT" || typeStr === "DOUBLE" || typeStr === "REAL") {
          type = 700; // float4
        } else if (typeStr === "JSON" || typeStr === "JSONB") {
          type = 3802; // jsonb
        } else if (typeStr === "UUID") {
          type = 2950; // uuid
        } else if (typeStr === "DATE") {
          type = 1082; // date
        } else if (typeStr === "TIME" || typeStr === "TIMETZ") {
          type = 1083; // time
        }
      }

      // Capture a column DEFAULT (literal or keyword like CURRENT_TIMESTAMP).
      let def;
      const defMatch = trimmed.match(/\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+(?:\([^)]*\))?)/i);
      if (defMatch) {
        def = this.parseValue(defMatch[1].trim());
      }

      columns.push({ name, type, default: def });
    }

    return columns;
  }

  splitColumns(str) {
    const parts = [];
    let depth = 0;
    let current = "";

    for (const char of str) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    if (current) parts.push(current);

    return parts;
  }

  parseValues(valuesStr) {
    const values = [];
    let current = "";
    let inString = false;
    let escape = false;

    for (const char of valuesStr) {
      if (escape) {
        current += char;
        escape = false;
        continue;
      }

      if (char === "\\") {
        escape = true;
        continue;
      }

      if (char === "'") {
        inString = !inString;
        continue;
      }

      if (char === "," && !inString) {
        values.push(this.parseValue(current.trim()));
        current = "";
        continue;
      }

      current += char;
    }

    if (current) {
      values.push(this.parseValue(current.trim()));
    }

    return values;
  }

  parseValue(value) {
    if (value === "NULL" || value === "null") return null;
    if (value === "TRUE" || value === "true") return true;
    if (value === "FALSE" || value === "false") return false;
    if (value === "DEFAULT") return null;
    if (/^-?\d+$/.test(value)) return parseInt(value);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (value.startsWith("$$") && value.endsWith("$$")) return value.slice(2, -2);
    return value;
  }

  // Split a boolean condition on a keyword (AND/OR) at top level, without
  // breaking a BETWEEN ... AND ... clause or splitting inside parentheses
  // (e.g. IN (SELECT ... AND ...)).
  _splitBoolean(condition, keyword) {
    const parts = [];
    let depth = 0;
    let cur = "";
    const tokens = condition.split(/(\s+)/);
    let betweenPending = false;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const bare = tok.trim();
      for (const ch of tok) { if (ch === "(") depth++; else if (ch === ")") depth--; }
      if (depth === 0 && /^BETWEEN$/i.test(bare)) betweenPending = true;
      if (depth === 0 && bare && bare.toUpperCase() === keyword) {
        if (keyword === "AND" && betweenPending) { betweenPending = false; cur += tok; continue; }
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += tok;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }

  // Resolve the right-hand side of an IN (...) — either a literal value list
  // or a scalar subquery (SELECT one_column FROM ...). Returns string values.
  _resolveInList(val) {
    const inner = val.trim().replace(/^\(/, "").replace(/\)$/, "").trim();
    if (/^SELECT\b/i.test(inner)) {
      const sub = this.executeSelect(inner);
      if (sub && Array.isArray(sub.rows)) {
        return sub.rows.map((r) => String(Array.isArray(r) ? r[0] : r));
      }
      return [];
    }
    return inner.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
  }

  evaluateWhere(row, condition, fields) {
    // Handle AND/OR (BETWEEN-aware, paren-aware).
    const orParts = this._splitBoolean(condition, "OR");
    for (const orPart of orParts) {
      const andParts = this._splitBoolean(orPart, "AND");
      let allTrue = true;

      for (const part of andParts) {
        const match = part.trim().match(/(\w+)\s*(=|!=|<>|<=|>=|<|>|IS\s+NOT\s+NULL|IS\s+NULL|NOT\s+IN|LIKE|ILIKE|IN|BETWEEN)\s*([\s\S]+)/i);
        if (!match) {
          allTrue = false;
          continue;
        }

        const col = match[1].toLowerCase();
        const op = match[2].toUpperCase();
        let val = match[3] ? match[3].trim() : null;

        const idx = fields.findIndex((f) => f.name.toLowerCase() === col);
        if (idx === -1) {
          allTrue = false;
          continue;
        }

        const rowVal = row[idx];

        // Handle special operators
        if (op === "IS NULL") {
          if (rowVal !== null) allTrue = false;
          continue;
        }
        if (op === "IS NOT NULL") {
          if (rowVal === null) allTrue = false;
          continue;
        }

        if (!val) {
          allTrue = false;
          continue;
        }

        // Clean value
        if (val.startsWith("'") && val.endsWith("'")) {
          val = val.slice(1, -1);
        }

        // Numeric-aware comparison: when both sides look numeric, compare as
        // numbers (so 100 > 35, not the lexical "100" < "35").
        const cmp = (a, b) => {
          const na = typeof a === "number" ? a : (/^-?\d+(\.\d+)?$/.test(String(a)) ? Number(a) : null);
          const nb = /^-?\d+(\.\d+)?$/.test(String(b)) ? Number(b) : null;
          if (na !== null && nb !== null) return na - nb;
          return String(a).localeCompare(String(b));
        };

        switch (op) {
          case "=":
            if (rowVal === null || val === "NULL") {
              if (!(rowVal === null && val === "NULL")) allTrue = false;
            } else if (cmp(rowVal, val) !== 0) {
              allTrue = false;
            }
            break;
          case "!=":
          case "<>":
            if (rowVal === null || val === "NULL") {
              if (rowVal === null && val === "NULL") allTrue = false;
            } else if (cmp(rowVal, val) === 0) {
              allTrue = false;
            }
            break;
          case "<":
            if (rowVal === null || val === "NULL") allTrue = false;
            else if (cmp(rowVal, val) >= 0) allTrue = false;
            break;
          case ">":
            if (rowVal === null || val === "NULL") allTrue = false;
            else if (cmp(rowVal, val) <= 0) allTrue = false;
            break;
          case "<=":
            if (rowVal === null || val === "NULL") allTrue = false;
            else if (cmp(rowVal, val) > 0) allTrue = false;
            break;
          case ">=":
            if (rowVal === null || val === "NULL") allTrue = false;
            else if (cmp(rowVal, val) < 0) allTrue = false;
            break;
          case "LIKE":
          case "ILIKE":
            if (rowVal === null) {
              allTrue = false;
            } else {
              const pattern = val
                .replace(/%/g, ".*")
                .replace(/_/g, ".");
              const regex = new RegExp(`^${pattern}$`, op === "ILIKE" ? "i" : "");
              if (!regex.test(String(rowVal))) allTrue = false;
            }
            break;
          case "IN":
            if (rowVal === null) {
              allTrue = false;
            } else {
              const inValues = this._resolveInList(val);
              if (!inValues.includes(String(rowVal))) allTrue = false;
            }
            break;
          case "NOT IN":
            if (rowVal !== null) {
              const notInValues = this._resolveInList(val);
              if (notInValues.includes(String(rowVal))) allTrue = false;
            }
            break;
          case "BETWEEN":
            const betweenParts = val.split(/\s+AND\s+/i);
            if (betweenParts.length === 2 && rowVal !== null) {
              const low = parseFloat(betweenParts[0]);
              const high = parseFloat(betweenParts[1]);
              const numVal = parseFloat(rowVal);
              if (isNaN(numVal) || numVal < low || numVal > high) allTrue = false;
            } else {
              allTrue = false;
            }
            break;
          default:
            allTrue = false;
        }
      }

      if (allTrue) return true;
    }

    return false;
  }
}
