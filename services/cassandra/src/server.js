import { createServer } from "node:net";

export class CassandraServer {
  constructor(port = 9042) {
    this.port = port;
    this.server = null;
    this.reset();
  }

  // Clears all in-memory state back to empty. Used for per-test isolation
  // and by the Parlel control plane. Idempotent, no I/O.
  reset() {
    this.keyspaces = new Map();
    this.tables = new Map();
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer((socket) => {
        let buffer = Buffer.alloc(0);

        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data]);

          // CQL native frame header (v3/v4): version(1) flags(1) stream(2)
          // opcode(1) length(4) = 9 bytes, then `length` bytes of body.
          while (buffer.length >= 9) {
            const reqVersion = buffer.readUInt8(0);
            const stream = buffer.readInt16BE(2);
            const opcode = buffer.readUInt8(4);
            const length = buffer.readUInt32BE(5);
            if (buffer.length < 9 + length) break;
            const body = buffer.slice(9, 9 + length);
            buffer = buffer.slice(9 + length);

            // Response version = request version with the high (response) bit set.
            const respVersion = (reqVersion & 0x7f) | 0x80;

            switch (opcode) {
              case 0x01: // STARTUP -> READY
                socket.write(this.frame(respVersion, stream, 0x02, Buffer.alloc(0)));
                break;
              case 0x05: // OPTIONS -> SUPPORTED (string multimap of options)
                socket.write(this.frame(respVersion, stream, 0x06, this.encodeSupported()));
                break;
              case 0x0b: // REGISTER -> READY (we emit no events)
                socket.write(this.frame(respVersion, stream, 0x02, Buffer.alloc(0)));
                break;
              case 0x07: { // QUERY
                // body: [long string query][<query_parameters>]. We only need
                // the query text; the parameters block follows it.
                const qlen = body.readUInt32BE(0);
                const query = body.slice(4, 4 + qlen).toString("utf8");
                this.handleQuery(socket, query, respVersion, stream);
                break;
              }
              case 0x09: { // PREPARE -> minimal PREPARED result (id = stream)
                const qlen = body.readUInt32BE(0);
                const query = body.slice(4, 4 + qlen).toString("utf8");
                socket.write(this.frame(respVersion, stream, 0x08, this.encodePrepared(query)));
                break;
              }
              case 0x0a: // EXECUTE -> treat like a void (prepared writes)
                socket.write(this.frame(respVersion, stream, 0x08, this.encodeVoidBody()));
                break;
              default:
                // Unknown opcode: respond with an empty READY to keep the
                // driver moving rather than hang.
                socket.write(this.frame(respVersion, stream, 0x02, Buffer.alloc(0)));
            }
          }
        });

        socket.on("error", () => {});
      });

      this.server.listen(this.port, () => {
        console.log(`Cassandra server running on port ${this.port}`);
        resolve();
      });
    });
  }

  // Wrap a response body in a CQL native frame.
  frame(version, stream, opcode, body) {
    const header = Buffer.alloc(9);
    header.writeUInt8(version, 0);
    header.writeUInt8(0, 1); // flags
    header.writeInt16BE(stream, 2);
    header.writeUInt8(opcode, 4);
    header.writeUInt32BE(body.length, 5);
    return Buffer.concat([header, body]);
  }

  // SUPPORTED body: a [string multimap] of server options. Advertise the
  // protocol versions + compression the way a real node does (none required).
  encodeSupported() {
    const entries = [
      ["CQL_VERSION", ["3.4.5"]],
      ["COMPRESSION", []],
      ["PROTOCOL_VERSIONS", ["3/v3", "4/v4"]],
    ];
    const parts = [];
    const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
    const str = (s) => { const sb = Buffer.from(s, "utf8"); return Buffer.concat([u16(sb.length), sb]); };
    parts.push(u16(entries.length));
    for (const [k, vals] of entries) {
      parts.push(str(k));
      parts.push(u16(vals.length));
      for (const v of vals) parts.push(str(v));
    }
    return Buffer.concat(parts);
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve);
      else resolve();
    });
  }

  handleQuery(socket, query, version, stream) {
    const result = this.executeCql(query);
    if (result.kind === "rows") {
      const body = this.encodeRowsBody(result.fields, result.rows, result.keyspace, result.table);
      socket.write(this.frame(version, stream, 0x08, body)); // RESULT
    } else {
      socket.write(this.frame(version, stream, 0x08, this.encodeVoidBody()));
    }
  }

  // Execute a CQL string and return a structured result. Used by the wire
  // handler (handleQuery) and by the sandbox MCP adapter so agents can run CQL
  // through parlel_execute. Returns { kind: "void" } or
  // { kind: "rows", fields: [{name}], rows: [[...]] }.
  executeCql(query) {
    const upper = query.toUpperCase().trim();

    // Control-connection queries the real driver issues right after STARTUP to
    // discover the cluster. Without believable rows here the driver can't
    // select a host / data center and the connection times out.
    if (/\bFROM\s+SYSTEM\.LOCAL\b/i.test(upper)) {
      return {
        kind: "rows",
        keyspace: "system",
        table: "local",
        fields: [
          { name: "key", type: "text" },
          { name: "cluster_name", type: "text" },
          { name: "data_center", type: "text" },
          { name: "rack", type: "text" },
          { name: "release_version", type: "text" },
          { name: "cql_version", type: "text" },
          { name: "partitioner", type: "text" },
          { name: "host_id", type: "uuid" },
          { name: "schema_version", type: "uuid" },
          { name: "tokens", type: "set<text>" },
        ],
        rows: [[
          "local",
          "parlel-cluster",
          "datacenter1",
          "rack1",
          "4.0.0",
          "3.4.5",
          "org.apache.cassandra.dht.Murmur3Partitioner",
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
          ["-1"],
        ]],
      };
    }
    if (/\bFROM\s+SYSTEM\.PEERS\b/i.test(upper) || /\bFROM\s+SYSTEM\.PEERS_V2\b/i.test(upper)) {
      // Single-node cluster: no peers.
      return {
        kind: "rows",
        keyspace: "system",
        table: "peers",
        fields: [
          { name: "peer", type: "text" },
          { name: "data_center", type: "text" },
          { name: "host_id", type: "uuid" },
          { name: "rack", type: "text" },
          { name: "release_version", type: "text" },
          { name: "tokens", type: "set<text>" },
        ],
        rows: [],
      };
    }

    if (upper.startsWith("SELECT RELEASE_VERSION")) {
      return { kind: "rows", fields: [{ name: "release_version", type: "text" }], rows: [["4.0.0"]] };
    }
    if (upper.startsWith("CREATE KEYSPACE")) {
      const match = query.match(/CREATE KEYSPACE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
      if (match) this.keyspaces.set(match[1].toLowerCase(), { tables: new Map() });
      return { kind: "void" };
    }
    if (upper.startsWith("USE ")) {
      return { kind: "void" };
    }
    if (upper.startsWith("CREATE TABLE")) {
      const match = query.match(/CREATE TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\.(\w+)\s*\((.+)\)/is);
      if (match) {
        const key = `${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
        this.tables.set(key, { columns: this.parseColumns(match[3]), rows: [] });
      }
      return { kind: "void" };
    }
    if (upper.startsWith("INSERT INTO")) {
      const match = query.match(/INSERT INTO\s+(\w+)\.(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)/is);
      if (match) {
        const key = `${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
        const columns = match[3].split(",").map((c) => c.trim().toLowerCase());
        const values = this.parseValues(match[4]);
        const table = this.tables.get(key);
        if (table) {
          const row = {};
          for (let i = 0; i < columns.length; i++) row[columns[i]] = values[i];
          table.rows.push(row);
        }
      }
      return { kind: "void" };
    }
    if (upper.startsWith("SELECT")) {
      const match = query.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)\.(\w+)/i);
      if (!match) return { kind: "rows", fields: [], rows: [] };
      const key = `${match[2].toLowerCase()}.${match[3].toLowerCase()}`;
      const table = this.tables.get(key);
      if (!table) return { kind: "rows", fields: [], rows: [] };
      const colNames = match[1].trim() === "*"
        ? table.columns.map((c) => c.name)
        : match[1].split(",").map((c) => c.trim().toLowerCase());
      return {
        kind: "rows",
        fields: colNames.map((name) => ({ name })),
        rows: table.rows.map((row) => colNames.map((c) => row[c])),
      };
    }
    return { kind: "void" };
  }

  // ── CQL native-protocol result-body encoders ─────────────────────────────
  // CQL "string": [short len][utf8 bytes]
  _cqlString(s) {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length, 0);
    return Buffer.concat([len, b]);
  }

  // CQL "[int]"
  _int(n) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n, 0);
    return b;
  }

  // CQL "[option]" type — a [short type-id] plus, for collections, the element
  // type. We only need the few types our system rows + user tables use.
  _typeOption(type) {
    const TYPE_IDS = {
      ascii: 0x0001, bigint: 0x0002, blob: 0x0003, boolean: 0x0004,
      double: 0x0007, float: 0x0008, int: 0x0009, text: 0x000d,
      varchar: 0x000d, timestamp: 0x000b, uuid: 0x000c, varint: 0x000e,
      timeuuid: 0x000f, inet: 0x0010,
    };
    const short = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
    const m = /^set<(.+)>$/i.exec(type) || /^list<(.+)>$/i.exec(type);
    if (m) {
      const collId = /^set/i.test(type) ? 0x0022 : 0x0020;
      return Buffer.concat([short(collId), this._typeOption(m[1].trim())]);
    }
    return short(TYPE_IDS[String(type || "text").toLowerCase()] ?? 0x000d);
  }

  // Encode a value as a CQL [bytes] (int length + raw, -1 = null) for its type.
  _value(value, type) {
    if (value === null || value === undefined) return this._int(-1);
    const t = String(type || "text").toLowerCase();
    let raw;
    if (t === "uuid" || t === "timeuuid") {
      raw = Buffer.from(String(value).replace(/-/g, ""), "hex");
    } else if (t === "int") {
      raw = Buffer.alloc(4); raw.writeInt32BE(Number(value), 0);
    } else if (t === "bigint" || t === "timestamp") {
      raw = Buffer.alloc(8); raw.writeBigInt64BE(BigInt(value), 0);
    } else if (t === "boolean") {
      raw = Buffer.from([value ? 1 : 0]);
    } else if (/^set<(.+)>$/i.test(t) || /^list<(.+)>$/i.test(t)) {
      const sub = (/^set<(.+)>$/i.exec(t) || /^list<(.+)>$/i.exec(t))[1].trim();
      const items = Array.isArray(value) ? value : [value];
      const parts = [this._int(items.length)];
      for (const it of items) parts.push(this._value(it, sub)); // each element is [bytes]
      raw = Buffer.concat(parts);
    } else {
      raw = Buffer.from(String(value), "utf8");
    }
    return Buffer.concat([this._int(raw.length), raw]);
  }

  // RESULT body for kind=Void (0x0001).
  encodeVoidBody() {
    return this._int(1);
  }

  // RESULT body for kind=Prepared (0x0004) — minimal: id + empty metadata.
  encodePrepared(query) {
    const id = Buffer.from("0000000000000000", "hex"); // 8-byte short id
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(id.length, 0);
    const emptyMeta = Buffer.concat([this._int(0), this._int(0)]); // flags=0, col_count=0
    return Buffer.concat([this._int(4), idLen, id, emptyMeta, emptyMeta]);
  }

  // RESULT body for kind=Rows (0x0002): [int kind][metadata][int rows][values].
  // metadata = [int flags][int columns_count][col specs...]; we always send the
  // per-column keyspace/table (flags=0, no global table spec) plus the typed
  // [option] for each column — this is what cassandra-driver needs to decode.
  encodeRowsBody(fields, rows, keyspace = "parlel", table = "t") {
    const parts = [];
    parts.push(this._int(2)); // kind = Rows
    parts.push(this._int(0)); // metadata flags (no global table spec, no paging)
    parts.push(this._int(fields.length)); // columns count
    for (const f of fields) {
      parts.push(this._cqlString(keyspace));
      parts.push(this._cqlString(table));
      parts.push(this._cqlString(f.name));
      parts.push(this._typeOption(f.type || "text"));
    }
    parts.push(this._int(rows.length)); // rows count
    for (const row of rows) {
      for (let i = 0; i < fields.length; i++) {
        parts.push(this._value(row[i], fields[i].type || "text"));
      }
    }
    return Buffer.concat(parts);
  }

  parseColumns(columnsStr) {
    return columnsStr.split(",").map((part) => {
      const tokens = part.trim().split(/\s+/);
      return { name: tokens[0].toLowerCase(), type: tokens[1] || "text" };
    });
  }

  parseValues(valuesStr) {
    // Split on top-level commas, keeping quoted literals intact. CQL strings use
    // single quotes ('') with doubled-quote escaping; we also tolerate
    // double-quoted text for lenient drivers.
    const values = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < valuesStr.length; i++) {
      const char = valuesStr[i];
      if (quote) {
        if (char === quote) {
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
      if (v.toUpperCase() === "NULL") return null;
      if (/^-?\d+$/.test(v)) return parseInt(v, 10);
      if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
      const m = /^(['"])([\s\S]*)\1$/.exec(v);
      if (m) return m[2].split(m[1] + m[1]).join(m[1]); // strip quotes, unescape doubled quote
      return v;
    });
  }
}
