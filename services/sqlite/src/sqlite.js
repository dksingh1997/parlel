export class SQLiteDatabase {
  constructor() {
    this.tables = new Map();
    this.nextId = new Map();
  }

  exec(sql) {
    const normalized = sql.trim().replace(/;$/, "").trim();
    const upper = normalized.toUpperCase();

    if (upper.startsWith("CREATE TABLE")) {
      return this.execCreateTable(normalized);
    }
    if (upper.startsWith("INSERT")) {
      return this.execInsert(normalized);
    }
    if (upper.startsWith("SELECT")) {
      return this.execSelect(normalized);
    }
    if (upper.startsWith("UPDATE")) {
      return this.execUpdate(normalized);
    }
    if (upper.startsWith("DELETE")) {
      return this.execDelete(normalized);
    }
    if (upper.startsWith("DROP TABLE")) {
      return this.execDropTable(normalized);
    }
    if (upper === "BEGIN" || upper === "BEGIN TRANSACTION") {
      return [];
    }
    if (upper === "COMMIT") {
      return [];
    }
    if (upper === "ROLLBACK") {
      return [];
    }

    return [];
  }

  prepare(sql) {
    return {
      all: (...params) => {
        let query = sql;
        for (let i = 0; i < params.length; i++) {
          query = query.replace("?", typeof params[i] === "string" ? `'${params[i]}'` : params[i]);
        }
        const result = this.exec(query);
        return result;
      },
      run: (...params) => {
        let query = sql;
        for (let i = 0; i < params.length; i++) {
          query = query.replace("?", typeof params[i] === "string" ? `'${params[i]}'` : params[i]);
        }
        this.exec(query);
        return { changes: 1 };
      },
    };
  }

  execCreateTable(query) {
    const match = query.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.+)\)/is);
    if (!match) return [];

    const tableName = match[1].toLowerCase();
    const columnsStr = match[2];

    if (!this.tables.has(tableName)) {
      const columns = this.parseColumns(columnsStr);
      this.tables.set(tableName, { fields: columns, rows: [] });
    }

    return [];
  }

  execInsert(query) {
    const match = query.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)/is);
    if (!match) return [];

    const tableName = match[1].toLowerCase();
    const columns = match[2].split(",").map((c) => c.trim().toLowerCase());
    const valuesStr = match[3];

    const table = this.tables.get(tableName);
    if (!table) return [];

    const values = this.parseValues(valuesStr);
    const row = new Array(table.fields.length).fill(null);

    const hasId = columns.some((c) => c === "id" || c === "rowid");
    if (!hasId) {
      const idIdx = table.fields.findIndex((f) => f.name.toLowerCase() === "id");
      if (idIdx !== -1) {
        const current = this.nextId.get(tableName) || 0;
        row[idIdx] = current + 1;
        this.nextId.set(tableName, current + 1);
      }
    }

    for (let i = 0; i < columns.length; i++) {
      const idx = table.fields.findIndex((f) => f.name.toLowerCase() === columns[i]);
      if (idx !== -1) {
        row[idx] = values[i];
      }
    }

    table.rows.push(row);
    return [];
  }

  execSelect(query) {
    const fromMatch = query.match(/FROM\s+(\w+)/i);
    if (!fromMatch) return [];

    const tableName = fromMatch[1].toLowerCase();
    const table = this.tables.get(tableName);
    if (!table) return [];

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
          const cmp = String(a[idx]).localeCompare(String(b[idx]));
          return dir === "DESC" ? -cmp : cmp;
        });
      }
    }

    const limitMatch = query.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    const selectMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
    if (selectMatch) {
      const selectCols = selectMatch[1].trim();
      if (selectCols !== "*") {
        const colNames = selectCols.split(",").map((c) => c.trim().toLowerCase());
        const indices = colNames.map((c) => table.fields.findIndex((f) => f.name.toLowerCase() === c));
        return rows.map((row) => {
          const obj = {};
          for (let i = 0; i < colNames.length; i++) {
            if (indices[i] !== -1) {
              obj[colNames[i]] = row[indices[i]];
            }
          }
          return obj;
        });
      }
    }

    return rows.map((row) => {
      const obj = {};
      table.fields.forEach((f, i) => {
        obj[f.name] = row[i];
      });
      return obj;
    });
  }

  execUpdate(query) {
    const match = query.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is);
    if (!match) return [];

    const tableName = match[1].toLowerCase();
    const setClause = match[2].trim();
    const whereClause = match[3];

    const table = this.tables.get(tableName);
    if (!table) return [];

    const setParts = setClause.split(",").map((s) => {
      const [col, val] = s.split("=").map((p) => p.trim());
      return { col: col.toLowerCase(), val: val.replace(/^'|'$/g, "") };
    });

    for (const row of table.rows) {
      if (whereClause && !this.evaluateWhere(row, whereClause, table.fields)) continue;
      for (const { col, val } of setParts) {
        const idx = table.fields.findIndex((f) => f.name.toLowerCase() === col);
        if (idx !== -1) row[idx] = val;
      }
    }

    return [];
  }

  execDelete(query) {
    const match = query.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is);
    if (!match) return [];

    const tableName = match[1].toLowerCase();
    const whereClause = match[2];

    const table = this.tables.get(tableName);
    if (!table) return [];

    if (whereClause) {
      table.rows = table.rows.filter((row) => !this.evaluateWhere(row, whereClause, table.fields));
    } else {
      table.rows = [];
    }

    return [];
  }

  execDropTable(query) {
    const match = query.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    if (match) {
      this.tables.delete(match[1].toLowerCase());
    }
    return [];
  }

  parseColumns(columnsStr) {
    return columnsStr.split(",").map((part) => {
      const tokens = part.trim().split(/\s+/);
      const name = tokens[0].toLowerCase();
      let type = "TEXT";
      if (tokens[1]) {
        const t = tokens[1].toUpperCase();
        if (t === "INTEGER" || t === "INT") type = "INTEGER";
        if (t === "REAL" || t === "FLOAT" || t === "DOUBLE") type = "REAL";
        if (t === "BLOB") type = "BLOB";
        if (t === "BOOLEAN" || t === "BOOL") type = "INTEGER";
      }
      return { name, type };
    });
  }

  parseValues(valuesStr) {
    const values = [];
    let current = "";
    let inString = false;
    for (const char of valuesStr) {
      if (char === "'") {
        inString = !inString;
        continue;
      }
      if (char === "," && !inString) {
        values.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    if (current) values.push(current.trim());
    return values.map((v) => {
      if (v === "NULL") return null;
      if (v === "TRUE") return 1;
      if (v === "FALSE") return 0;
      if (/^-?\d+$/.test(v)) return parseInt(v);
      if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
      return v;
    });
  }

  evaluateWhere(row, condition, fields) {
    const parts = condition.split(/\s+AND\s+/i);
    for (const part of parts) {
      const match = part.match(/(\w+)\s*(=|!=|<|>|<=|>=)\s*(.+)/);
      if (!match) continue;
      const col = match[1].toLowerCase();
      const op = match[2];
      let val = match[3].trim().replace(/^'|'$/g, "");
      const idx = fields.findIndex((f) => f.name.toLowerCase() === col);
      if (idx === -1) return false;
      const rowVal = row[idx];
      switch (op) {
        case "=": if (String(rowVal) !== val) return false; break;
        case "!=": if (String(rowVal) === val) return false; break;
        case "<": if (String(rowVal) >= val) return false; break;
        case ">": if (String(rowVal) <= val) return false; break;
        case "<=": if (String(rowVal) > val) return false; break;
        case ">=": if (String(rowVal) < val) return false; break;
      }
    }
    return true;
  }
}
