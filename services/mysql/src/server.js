import { createServer } from "node:net";
import { MySQLProtocol } from "./protocol.js";

export class MySQLServer {
  constructor(port = 3306, options = {}) {
    this.port = port;
    this.user = options.user || "parlel";
    this.password = options.password || "parlel";
    this.database = options.database || "parlel";
    this.tables = new Map();
    this.nextId = new Map();
    this.server = null;
    this.sessionId = 1;
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer((socket) => {
        const sessionId = this.sessionId++;
        let authenticated = false;
        let buffer = Buffer.alloc(0);

        // Send greeting
        const greeting = MySQLProtocol.encodeGreeting(sessionId);
        const header = Buffer.alloc(4);
        header.writeUIntLE(greeting.length, 0, 3);
        header.writeUInt8(0, 3);
        socket.write(Buffer.concat([header, greeting]));

        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data]);

          while (buffer.length >= 4) {
            const packet = MySQLProtocol.parsePacket(buffer);
            if (!packet) break;

            if (buffer.length < 4 + packet.length) break;
            buffer = buffer.slice(4 + packet.length);

            if (!authenticated) {
              // Handle authentication
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
              authenticated = true;
              continue;
            }

            // Handle commands
            const command = packet.payload[0];
            if (command === 0x01) {
              // COM_QUIT
              socket.end();
              return;
            }

            if (command === 0x03) {
              // COM_QUERY. Real MySQL replies with one of three packet types:
              //   - ERR packet  → the statement failed
              //   - result set  → the statement produced rows (SELECT/SHOW/…)
              //   - OK packet   → the statement succeeded with no result set
              //                   (INSERT/UPDATE/DELETE/DDL/SET/…)
              // The previous implementation sent a result set for *everything*,
              // which mis-framed writes and swallowed engine errors. Route here.
              const query = MySQLProtocol.parseQuery(packet.payload);
              if (query) {
                const result = this.executeQuery(query);
                if (result && result.error) {
                  const response = MySQLProtocol.encodeError(
                    result.error,
                    result.code || 1064,
                    result.sqlState || "42000"
                  );
                  socket.write(MySQLProtocol.frame(response, packet.sequenceId + 1));
                } else if (result && result.fields && result.fields.length > 0) {
                  // Result set is already fully framed (one packet per
                  // column-count / column-def / EOF / row), with sequence ids
                  // continuing from the query packet. Write it as-is.
                  const { buffer } = MySQLProtocol.encodeResultSet(
                    result.fields,
                    result.rows || [],
                    packet.sequenceId + 1
                  );
                  socket.write(buffer);
                } else {
                  const response = MySQLProtocol.encodeOK(
                    result && result.affectedRows ? result.affectedRows : 0,
                    result && result.insertId ? result.insertId : 0
                  );
                  socket.write(MySQLProtocol.frame(response, packet.sequenceId + 1));
                }
              }
            }

            if (command === 0x0e) {
              // COM_PING
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x01) {
              // COM_QUIT
              socket.end();
              return;
            }

            if (command === 0x02) {
              // COM_INIT_DB
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x04) {
              // COM_FIELD_LIST
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x05) {
              // COM_CREATE_DB
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x06) {
              // COM_DROP_DB
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x07) {
              // COM_REFRESH
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x08) {
              // COM_SHUTDOWN
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x09) {
              // COM_STATISTICS
              const stats = "Uptime: 1000  Threads: 1  Questions: 0  Slow queries: 0";
              const resp = Buffer.alloc(stats.length);
              resp.write(stats, 0, stats.length, "utf8");
              const respHeader = Buffer.alloc(4);
              respHeader.writeUIntLE(resp.length, 0, 3);
              respHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([respHeader, resp]));
            }

            if (command === 0x0a) {
              // COM_PROCESS_INFO
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x0c) {
              // COM_PROCESS_KILL
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x0d) {
              // COM_DEBUG
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x11) {
              // COM_CHANGE_USER
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x16) {
              // COM_STMT_PREPARE
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x17) {
              // COM_STMT_EXECUTE
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x19) {
              // COM_STMT_CLOSE
              // No response expected
            }

            if (command === 0x1a) {
              // COM_STMT_RESET
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x1c) {
              // COM_STMT_FETCH
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }

            if (command === 0x1f) {
              // COM_RESET_CONNECTION
              const ok = MySQLProtocol.encodeOK();
              const okHeader = Buffer.alloc(4);
              okHeader.writeUIntLE(ok.length, 0, 3);
              okHeader.writeUInt8(packet.sequenceId + 1, 3);
              socket.write(Buffer.concat([okHeader, ok]));
            }
          }
        });

        socket.on("error", () => {});
      });

      this.server.listen(this.port, () => {
        console.log(`MySQL server running on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }

  executeQuery(query) {
    const normalized = query.trim().replace(/;$/, "").trim();
    const upper = normalized.toUpperCase();

    // Literal/expression SELECT with no FROM clause, e.g. `SELECT 1`,
    // `SELECT 1 AS x`, `SELECT 'ok' AS status`. Drivers (mysql2) and connection
    // pools issue these as liveness/ping probes, so they must return a real
    // single-row result set rather than falling through to the table path.
    if (upper.startsWith("SELECT") && !/\bFROM\b/i.test(normalized)) {
      const exprList = normalized.slice(6).trim(); // after "SELECT"
      const cols = exprList.split(",").map((part) => {
        const m = part.trim().match(/^(.*?)\s+AS\s+(.+)$/i);
        const expr = (m ? m[1] : part).trim();
        const alias = (m ? m[2] : part).trim().replace(/^["'`]|["'`]$/g, "");
        // Evaluate the handful of literals/functions a probe uses.
        let value;
        if (/^-?\d+$/.test(expr)) value = Number(expr);
        else if (/^'(.*)'$/.test(expr) || /^"(.*)"$/.test(expr)) value = expr.slice(1, -1);
        else if (/^version\(\)$/i.test(expr)) value = "8.0.0-parlel";
        else if (/^database\(\)$/i.test(expr)) value = this.database || "parlel";
        else value = expr;
        const isNum = typeof value === "number";
        return { name: alias, value, type: isNum ? 0x03 : 0xfd };
      });
      return {
        fields: cols.map((c) => ({ name: c.name, type: c.type, length: 64 })),
        rows: [cols.map((c) => c.value)],
      };
    }

    if (upper.startsWith("CREATE TABLE")) {
      return this.executeCreateTable(normalized);
    }

    if (upper.startsWith("CREATE INDEX")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CREATE UNIQUE INDEX")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DROP INDEX")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("ALTER TABLE")) {
      return this.executeAlterTable(normalized);
    }

    if (upper.startsWith("INSERT")) {
      return this.executeInsert(normalized);
    }

    if (upper.startsWith("SELECT")) {
      return this.executeSelect(normalized);
    }

    if (upper.startsWith("UPDATE")) {
      return this.executeUpdate(normalized);
    }

    if (upper.startsWith("DELETE")) {
      return this.executeDelete(normalized);
    }

    if (upper.startsWith("TRUNCATE")) {
      return this.executeTruncate(normalized);
    }

    if (upper.startsWith("DROP TABLE")) {
      return this.executeDropTable(normalized);
    }

    if (upper.startsWith("SHOW TABLES")) {
      return this.executeShowTables();
    }

    if (upper.startsWith("SHOW DATABASES")) {
      return {
        fields: [{ name: "Database", type: 0xfd, length: 64 }],
        rows: [["parlel"]],
      };
    }

    if (upper.startsWith("DESCRIBE") || upper.startsWith("DESC")) {
      return this.executeDescribe(normalized);
    }

    if (upper.startsWith("EXPLAIN")) {
      return this.executeExplain(normalized);
    }

    if (upper.startsWith("SET")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("USE")) {
      return { fields: [], rows: [] };
    }

    if (upper === "BEGIN" || upper === "START TRANSACTION") {
      return { fields: [], rows: [] };
    }

    if (upper === "COMMIT") {
      return { fields: [], rows: [] };
    }

    if (upper === "ROLLBACK") {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("SAVEPOINT")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("RELEASE SAVEPOINT")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("ROLLBACK TO")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("GRANT")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("REVOKE")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CREATE USER")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("ALTER USER")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DROP USER")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CREATE DATABASE")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DROP DATABASE")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("FLUSH")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("LOCK TABLES")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("UNLOCK TABLES")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("PREPARE")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("EXECUTE")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DEALLOCATE")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CALL")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CREATE PROCEDURE")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CREATE FUNCTION")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DROP PROCEDURE")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DROP FUNCTION")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CREATE TRIGGER")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DROP TRIGGER")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CREATE VIEW")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DROP VIEW")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("CREATE EVENT")) {
      return { fields: [], rows: [] };
    }

    if (upper.startsWith("DROP EVENT")) {
      return { fields: [], rows: [] };
    }

    return { fields: [], rows: [] };
  }

  executeCreateTable(query) {
    const match = query.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.+)\)/is);
    if (!match) return { fields: [], rows: [] };

    const tableName = match[1].toLowerCase();
    const columnsStr = match[2];
    const columns = this.parseColumns(columnsStr);

    if (!this.tables.has(tableName)) {
      this.tables.set(tableName, { fields: columns, rows: [] });
    }

    return { fields: [], rows: [] };
  }

  executeInsert(query) {
    // Two valid forms:
    //   INSERT INTO t (a, b) VALUES (1, 2)   — explicit columns
    //   INSERT INTO t VALUES (1, 2)          — positional (all columns, in order)
    const withCols = query.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)/is);
    const noCols = query.match(/INSERT\s+INTO\s+(\w+)\s+VALUES\s*\((.+)\)/is);
    const match = withCols || noCols;
    if (!match) return { fields: [], rows: [] };

    const tableName = match[1].toLowerCase();
    const table = this.tables.get(tableName);
    if (!table) {
      // Real MySQL: ERR 1146 (42S02) "Table 'db.t' doesn't exist".
      return { error: `Table '${tableName}' doesn't exist`, code: 1146, sqlState: "42S02" };
    }

    // Column-less inserts map positionally to the table's declared fields.
    const columns = withCols
      ? withCols[2].split(",").map((c) => c.trim().toLowerCase())
      : table.fields.map((f) => f.name.toLowerCase());
    const valuesStr = withCols ? withCols[3] : noCols[2];

    const values = this.parseValues(valuesStr);
    const row = new Array(table.fields.length).fill(null);

    // Auto-increment id when the caller did not supply one. Mirrors what a real
    // INSERT reports via last_insert_id / mysql2 `result.insertId`.
    let insertId = 0;
    const hasId = columns.some((c) => c === "id");
    if (!hasId) {
      const idIdx = table.fields.findIndex((f) => f.name.toLowerCase() === "id");
      if (idIdx !== -1) {
        const current = this.nextId.get(tableName) || 0;
        insertId = current + 1;
        row[idIdx] = insertId;
        this.nextId.set(tableName, insertId);
      }
    }

    for (let i = 0; i < columns.length; i++) {
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === columns[i]);
      if (idx !== -1) {
        row[idx] = values[i];
        // Keep the auto-increment counter ahead of explicitly inserted ids.
        if (columns[i] === "id") {
          const n = Number(values[i]);
          if (Number.isFinite(n)) {
            insertId = n;
            if (n > (this.nextId.get(tableName) || 0)) this.nextId.set(tableName, n);
          }
        }
      }
    }

    table.rows.push(row);
    return { fields: [], rows: [], affectedRows: 1, insertId };
  }

  executeSelect(query) {
    // Fail loudly on unsupported constructs rather than returning wrong rows.
    // (A silently-incorrect answer is the most dangerous thing a DB fake can do.)
    if (/\bGROUP\s+BY\b/i.test(query)) {
      return { error: "GROUP BY is not supported by the parlel mysql emulator", code: 1235 };
    }
    if (/\bJOIN\b/i.test(query)) {
      return { error: "JOIN is not supported by the parlel mysql emulator", code: 1235 };
    }
    if (/\bOVER\s*\(/i.test(query)) {
      return { error: "window functions are not supported by the parlel mysql emulator", code: 1235 };
    }

    const fromMatch = query.match(/FROM\s+(\w+)/i);
    if (!fromMatch) return { fields: [], rows: [] };

    const tableName = fromMatch[1].toLowerCase();
    const table = this.tables.get(tableName);
    if (!table) {
      // Real MySQL: ERR 1146 (42S02) "Table 'db.t' doesn't exist".
      return { error: `Table '${tableName}' doesn't exist`, code: 1146, sqlState: "42S02" };
    }

    let rows = [...table.rows];

    const whereMatch = query.match(/WHERE\s+(.+?)(?:ORDER|LIMIT|$)/i);
    if (whereMatch) {
      rows = rows.filter((row) => this.evaluateWhere(row, whereMatch[1].trim(), table.fields));
    }

    const orderMatch = query.match(/ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
    if (orderMatch) {
      const field = orderMatch[1].toLowerCase();
      const dir = (orderMatch[2] || "ASC").toUpperCase();
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === field);
      if (idx !== -1) {
        rows.sort((a, b) => {
          if (a[idx] === null) return 1;
          if (b[idx] === null) return -1;
          const av = a[idx];
          const bv = b[idx];
          // Numeric-aware: compare as numbers when both sides are numeric.
          const cmp = (typeof av === "number" && typeof bv === "number")
            ? av - bv
            : String(av).localeCompare(String(bv));
          return dir === "DESC" ? -cmp : cmp;
        });
      }
    }

    const limitMatch = query.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    const selectMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
    let fields = table.fields;
    let resultRows = rows;

    if (selectMatch) {
      const selectCols = selectMatch[1].trim();

      // COUNT(*) / COUNT(col) — the most common aggregate. Supports an optional
      // alias (COUNT(*) AS c). Other aggregates fail loudly (see below).
      const countMatch = selectCols.match(/^COUNT\s*\(\s*(\*|\w+)\s*\)(?:\s+AS\s+(\w+))?$/i);
      if (countMatch) {
        const alias = countMatch[2] || "COUNT(*)";
        return {
          fields: [{ name: alias, type: 0x08, length: 21 }],
          rows: [[rows.length]],
        };
      }

      // Fail loudly on other aggregates rather than returning a wrong/empty
      // answer (a silently-incorrect result is the most dangerous thing here).
      if (/\b(SUM|AVG|MIN|MAX|COUNT)\s*\(/i.test(selectCols)) {
        return {
          error: "only COUNT(*) is supported by the parlel mysql emulator aggregate set",
          code: 1235,
        };
      }

      if (selectCols !== "*") {
        const colNames = selectCols.split(",").map((c) => c.trim().toLowerCase());
        const indices = colNames.map((c) => table.fields.findIndex((f) => f.name.toLowerCase() === c));
        fields = indices.filter((i) => i !== -1).map((i) => table.fields[i]);
        resultRows = rows.map((row) => indices.filter((i) => i !== -1).map((i) => row[i]));
      }
    }

    return { fields, rows: resultRows };
  }

  executeUpdate(query) {
    const match = query.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is);
    if (!match) return { fields: [], rows: [] };

    const tableName = match[1].toLowerCase();
    const setClause = match[2].trim();
    const whereClause = match[3];

    const table = this.tables.get(tableName);
    if (!table) {
      return { error: `Table '${tableName}' doesn't exist`, code: 1146, sqlState: "42S02" };
    }

    const setParts = setClause.split(",").map((s) => {
      const [col, val] = s.split("=").map((p) => p.trim());
      return { col: col.toLowerCase(), val: val.replace(/^'|'$/g, "") };
    });

    let affectedRows = 0;
    for (const row of table.rows) {
      if (whereClause && !this.evaluateWhere(row, whereClause, table.fields)) continue;
      affectedRows++;
      for (const { col, val } of setParts) {
        const idx = table.fields.findIndex((f) => f.name.toLowerCase() === col);
        if (idx !== -1) row[idx] = val;
      }
    }

    return { fields: [], rows: [], affectedRows };
  }

  executeDelete(query) {
    const match = query.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is);
    if (!match) return { fields: [], rows: [] };

    const tableName = match[1].toLowerCase();
    const whereClause = match[2];

    const table = this.tables.get(tableName);
    if (!table) {
      return { error: `Table '${tableName}' doesn't exist`, code: 1146, sqlState: "42S02" };
    }

    const before = table.rows.length;
    if (whereClause) {
      table.rows = table.rows.filter((row) => !this.evaluateWhere(row, whereClause, table.fields));
    } else {
      table.rows = [];
    }

    return { fields: [], rows: [], affectedRows: before - table.rows.length };
  }

  executeDropTable(query) {
    const match = query.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    if (match) {
      this.tables.delete(match[1].toLowerCase());
    }
    return { fields: [], rows: [] };
  }

  parseColumns(columnsStr) {
    return columnsStr.split(",").map((part) => {
      const tokens = part.trim().split(/\s+/);
      const name = tokens[0].toLowerCase();
      let type = 0xfd; // VARCHAR
      if (tokens[1]) {
        const t = tokens[1].toUpperCase();
        if (t === "INT" || t === "INTEGER") type = 0x03;
        if (t === "BIGINT") type = 0x05;
        if (t === "TEXT" || t === "VARCHAR") type = 0xfd;
        if (t === "BOOLEAN" || t === "BOOL") type = 0x01;
      }
      return { name, type };
    });
  }

  parseValues(valuesStr) {
    // Split on top-level commas, honoring both single- and double-quoted string
    // literals (MySQL accepts "..." as a string when ANSI_QUOTES is off, which
    // is the default), and backslash escapes inside them.
    const values = [];
    let current = "";
    let quote = null; // "'" or '"' when inside a string literal
    for (let i = 0; i < valuesStr.length; i++) {
      const char = valuesStr[i];
      if (quote) {
        if (char === "\\" && i + 1 < valuesStr.length) { current += char + valuesStr[++i]; continue; }
        if (char === quote) {
          // Doubled quote inside a literal is an escaped quote, not the end.
          if (valuesStr[i + 1] === quote) { current += char + valuesStr[++i]; continue; }
          quote = null; current += char; continue;
        }
        current += char; continue;
      }
      if (char === "'" || char === '"') { quote = char; current += char; continue; }
      if (char === ",") { values.push(current.trim()); current = ""; continue; }
      current += char;
    }
    if (current.trim()) values.push(current.trim());

    return values.map((v) => {
      const up = v.toUpperCase();
      if (up === "NULL") return null;
      if (up === "TRUE") return 1;
      if (up === "FALSE") return 0;
      if (/^-?\d+$/.test(v)) return parseInt(v, 10);
      if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
      // Strip surrounding quotes from a string literal and unescape doubled
      // quotes / backslash escapes.
      const m = /^(['"])([\s\S]*)\1$/.exec(v);
      if (m) {
        const q = m[1];
        return m[2].replace(new RegExp(`\\\\([\\s\\S])`, "g"), "$1").split(q + q).join(q);
      }
      return v;
    });
  }

  // Split a condition on a keyword at top level, leaving BETWEEN ... AND ...
  // and parenthesized lists intact.
  _splitBool(condition, keyword) {
    const parts = [];
    let depth = 0;
    let cur = "";
    let betweenPending = false;
    const tokens = condition.split(/(\s+)/);
    for (const tok of tokens) {
      const bare = tok.trim();
      for (const ch of tok) { if (ch === "(") depth++; else if (ch === ")") depth--; }
      if (depth === 0 && /^BETWEEN$/i.test(bare)) betweenPending = true;
      if (depth === 0 && bare && bare.toUpperCase() === keyword) {
        if (keyword === "AND" && betweenPending) { betweenPending = false; cur += tok; continue; }
        parts.push(cur); cur = ""; continue;
      }
      cur += tok;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }

  evaluateWhere(row, condition, fields) {
    const cmp = (a, b) => {
      const na = typeof a === "number" ? a : (/^-?\d+(\.\d+)?$/.test(String(a)) ? Number(a) : null);
      const nb = /^-?\d+(\.\d+)?$/.test(String(b)) ? Number(b) : null;
      if (na !== null && nb !== null) return na - nb;
      return String(a).localeCompare(String(b));
    };

    const orParts = this._splitBool(condition, "OR");
    for (const orPart of orParts) {
      const andParts = this._splitBool(orPart, "AND");
      let allTrue = true;
      for (const part of andParts) {
        const m = part.trim().match(/(\w+)\s*(<=|>=|<>|!=|=|<|>|IS\s+NOT\s+NULL|IS\s+NULL|NOT\s+IN|LIKE|IN|BETWEEN)\s*([\s\S]*)/i);
        if (!m) { allTrue = false; break; }
        const col = m[1].toLowerCase();
        const op = m[2].toUpperCase().replace(/\s+/g, " ");
        const rawVal = (m[3] || "").trim();
        const idx = fields.findIndex((f) => f.name.toLowerCase() === col);
        if (idx === -1) { allTrue = false; break; }
        const rowVal = row[idx];

        if (op === "IS NULL") { if (rowVal !== null && rowVal !== undefined) allTrue = false; continue; }
        if (op === "IS NOT NULL") { if (rowVal === null || rowVal === undefined) allTrue = false; continue; }

        if (op === "BETWEEN") {
          const bp = rawVal.split(/\s+AND\s+/i);
          if (bp.length === 2 && rowVal !== null) {
            const lo = parseFloat(bp[0]); const hi = parseFloat(bp[1]); const n = parseFloat(rowVal);
            if (Number.isNaN(n) || n < lo || n > hi) allTrue = false;
          } else allTrue = false;
          continue;
        }
        if (op === "IN" || op === "NOT IN") {
          const list = rawVal.replace(/^\(|\)$/g, "").split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
          const inList = list.some((v) => cmp(rowVal, v) === 0);
          if (op === "IN" && !inList) allTrue = false;
          if (op === "NOT IN" && inList) allTrue = false;
          continue;
        }
        if (op === "LIKE") {
          const pat = "^" + rawVal.replace(/^'|'$/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$";
          if (rowVal === null || !new RegExp(pat, "i").test(String(rowVal))) allTrue = false;
          continue;
        }

        const val = rawVal.replace(/^'|'$/g, "");
        const c = (rowVal === null || rowVal === undefined) ? null : cmp(rowVal, val);
        switch (op) {
          case "=": if (c === null || c !== 0) allTrue = false; break;
          case "!=": case "<>": if (c === null || c === 0) allTrue = false; break;
          case "<": if (c === null || c >= 0) allTrue = false; break;
          case ">": if (c === null || c <= 0) allTrue = false; break;
          case "<=": if (c === null || c > 0) allTrue = false; break;
          case ">=": if (c === null || c < 0) allTrue = false; break;
          default: allTrue = false;
        }
      }
      if (allTrue) return true;
    }
    return false;
  }

  executeAlterTable(query) {
    const addMatch = query.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+(\w+)/i);
    if (addMatch) {
      const tableName = addMatch[1].toLowerCase();
      const columnName = addMatch[2].toLowerCase();
      const columnType = addMatch[3].toUpperCase();
      const table = this.tables.get(tableName);
      if (table) {
        let type = 0xfd;
        if (["INT", "INTEGER"].includes(columnType)) type = 0x03;
        if (["BIGINT"].includes(columnType)) type = 0x05;
        if (["BOOLEAN", "BOOL"].includes(columnType)) type = 0x01;
        table.fields.push({ name: columnName, type });
      }
    }
    return { fields: [], rows: [] };
  }

  executeTruncate(query) {
    const match = query.match(/TRUNCATE\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    if (match) {
      const table = this.tables.get(match[1].toLowerCase());
      if (table) table.rows = [];
    }
    return { fields: [], rows: [] };
  }

  executeShowTables() {
    const tables = Array.from(this.tables.keys());
    return {
      fields: [{ name: "Tables_in_parlel", type: 0xfd, length: 64 }],
      rows: tables.map((t) => [t]),
    };
  }

  executeDescribe(query) {
    const match = query.match(/(?:DESCRIBE|DESC)\s+(\w+)/i);
    if (!match) return { fields: [], rows: [] };
    const table = this.tables.get(match[1].toLowerCase());
    if (!table) return { fields: [], rows: [] };
    return {
      fields: [
        { name: "Field", type: 0xfd, length: 64 },
        { name: "Type", type: 0xfd, length: 64 },
        { name: "Null", type: 0xfd, length: 4 },
        { name: "Key", type: 0xfd, length: 4 },
        { name: "Default", type: 0xfd, length: 64 },
        { name: "Extra", type: 0xfd, length: 64 },
      ],
      rows: table.fields.map((f) => [f.name, this.getColumnType(f.type), "YES", "", null, ""]),
    };
  }

  executeExplain(query) {
    return {
      fields: [
        { name: "id", type: 0x03, length: 11 },
        { name: "select_type", type: 0xfd, length: 64 },
        { name: "table", type: 0xfd, length: 64 },
        { name: "type", type: 0xfd, length: 64 },
        { name: "possible_keys", type: 0xfd, length: 64 },
        { name: "key", type: 0xfd, length: 64 },
        { name: "key_len", type: 0xfd, length: 64 },
        { name: "ref", type: 0xfd, length: 64 },
        { name: "rows", type: 0x03, length: 11 },
        { name: "Extra", type: 0xfd, length: 64 },
      ],
      rows: [[1, "SIMPLE", "table", "ALL", null, null, null, null, 1, ""]],
    };
  }

  getColumnType(type) {
    const types = {
      0x01: "tinyint",
      0x03: "int",
      0x05: "bigint",
      0xfd: "varchar(255)",
      0xfe: "text",
    };
    return types[type] || "varchar(255)";
  }
}
