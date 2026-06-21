export class MySQLProtocol {
  static encodeGreeting(sessionId) {
    const buf = Buffer.alloc(100);
    let pos = 0;

    // Protocol version
    buf.writeUInt8(10, pos); pos++;

    // Server version
    const version = "8.0.0-parlel";
    buf.write(version, pos, version.length, "utf8"); pos += version.length;
    buf.writeUInt8(0, pos); pos++;

    // Connection ID
    buf.writeUInt32LE(sessionId, pos); pos += 4;

    // Auth plugin data part 1 (8 bytes)
    const authData = Buffer.from("12345678");
    authData.copy(buf, pos); pos += 8;

    // Filler
    buf.writeUInt8(0, pos); pos++;

    // Capability flags. We advertise a realistic 4.1+ feature set but must NOT
    // claim CLIENT_QUERY_ATTRIBUTES (bit 27): if we do, clients like mysql2
    // prefix COM_QUERY payloads with a parameter block (param_count +
    // param_set_count + …), which would corrupt the parsed SQL. Lower 16 bits =
    // 0xF7DF (all of the common 4.1 flags); upper 16 bits = 0x000A
    // (CLIENT_PLUGIN_AUTH | CLIENT_SECURE_CONNECTION) — deliberately without
    // bit 27.
    // Lower 2 bytes
    buf.writeUInt16LE(0xf7df, pos); pos += 2;

    // Character set (utf8)
    buf.writeUInt8(0x21, pos); pos++;

    // Status flags
    buf.writeUInt16LE(0x0002, pos); pos += 2;

    // Capability flags (upper 2 bytes) — no CLIENT_QUERY_ATTRIBUTES (bit 27).
    buf.writeUInt16LE(0x000a, pos); pos += 2;

    // Auth plugin data length
    buf.writeUInt8(21, pos); pos++;

    // Reserved (10 bytes)
    for (let i = 0; i < 10; i++) {
      buf.writeUInt8(0, pos); pos++;
    }

    // Auth plugin data part 2
    const authData2 = Buffer.from("123456789012345678901");
    authData2.copy(buf, pos); pos += 21;

    // Auth plugin name
    const plugin = "mysql_native_password";
    buf.write(plugin, pos, plugin.length, "utf8"); pos += plugin.length;
    buf.writeUInt8(0, pos); pos++;

    return buf.slice(0, pos);
  }

  // Length-encoded integer (lenenc) per the MySQL protocol. Values < 251 are a
  // single byte; this covers the row counts an in-memory emulator produces.
  static encodeLenEncInt(buf, pos, value) {
    if (value < 0xfb) {
      buf.writeUInt8(value, pos);
      return pos + 1;
    }
    if (value <= 0xffff) {
      buf.writeUInt8(0xfc, pos);
      buf.writeUInt16LE(value, pos + 1);
      return pos + 3;
    }
    if (value <= 0xffffff) {
      buf.writeUInt8(0xfd, pos);
      buf.writeUIntLE(value, pos + 1, 3);
      return pos + 4;
    }
    buf.writeUInt8(0xfe, pos);
    buf.writeBigUInt64LE(BigInt(value), pos + 1);
    return pos + 9;
  }

  // OK_Packet: header 0x00, lenenc affected_rows, lenenc last_insert_id, then
  // (CLIENT_PROTOCOL_41) status_flags + warnings. The spec distinguishes OK from
  // a deprecated EOF by "header = 0 AND length >= 7", so we always emit the full
  // 4-1.x layout (header + 2 lenenc ints + 4 bytes) — never a sub-7-byte packet.
  // https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basic_ok_packet.html
  static encodeOK(affectedRows = 0, lastInsertId = 0) {
    const buf = Buffer.alloc(32);
    let pos = 0;

    // Header
    buf.writeUInt8(0x00, pos); pos++;

    // Affected rows (lenenc)
    pos = MySQLProtocol.encodeLenEncInt(buf, pos, affectedRows);

    // Last insert ID (lenenc)
    pos = MySQLProtocol.encodeLenEncInt(buf, pos, lastInsertId);

    // Status flags (SERVER_STATUS_AUTOCOMMIT)
    buf.writeUInt16LE(0x0002, pos); pos += 2;

    // Warnings
    buf.writeUInt16LE(0, pos); pos += 2;

    return buf.slice(0, pos);
  }

  // ERR_Packet: 0xFF, int<2> error_code, '#' marker, 5-char SQLSTATE, message.
  // https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basic_err_packet.html
  static encodeError(message, code = 1064, sqlState = "42000") {
    const msgLen = Buffer.byteLength(message);
    const buf = Buffer.alloc(1 + 2 + 1 + 5 + msgLen);
    let pos = 0;

    // Error marker
    buf.writeUInt8(0xff, pos); pos++;

    // Error code
    buf.writeUInt16LE(code, pos); pos += 2;

    // SQL state marker '#'
    buf.writeUInt8(0x23, pos); pos++;

    // SQL state (exactly 5 chars)
    const state = (sqlState + "00000").slice(0, 5);
    buf.write(state, pos, 5, "utf8"); pos += 5;

    // Error message
    pos += buf.write(message, pos, msgLen, "utf8");

    return buf.slice(0, pos);
  }

  // Frame a single payload as a MySQL packet: int<3> length + int<1> seq + body.
  static frame(payload, seq) {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header.writeUInt8(seq & 0xff, 3);
    return Buffer.concat([header, payload]);
  }

  // Encode a full COM_QUERY result set as a sequence of *individually framed*
  // packets, starting at sequence id `startSeq` (the query packet's seq + 1).
  //
  // A text-protocol result set is: column-count packet, one column-definition
  // packet per field, an EOF packet, one row packet per row, and a final EOF.
  // Each of these is its own MySQL packet with a 4-byte header and an
  // incrementing sequence id — the previous code concatenated the payloads and
  // wrapped them in a single header, which real clients (mysql2) cannot parse.
  // https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_com_query_response.html
  static encodeResultSet(fields, rows, startSeq = 1) {
    const packets = [];
    let seq = startSeq;
    const push = (payload) => {
      packets.push(MySQLProtocol.frame(payload, seq));
      seq = (seq + 1) & 0xff;
    };

    // Column count (lenenc int).
    const countBuf = Buffer.alloc(9);
    const countLen = MySQLProtocol.encodeLenEncInt(countBuf, 0, fields.length);
    push(countBuf.slice(0, countLen));

    // Column definitions — each is its own packet.
    for (const field of fields) {
      const colBuf = Buffer.alloc(256 + Buffer.byteLength(field.name || "") + Buffer.byteLength(field.table || ""));
      let pos = 0;
      const lenEncStr = (s) => {
        const str = s || "";
        const len = Buffer.byteLength(str);
        pos = MySQLProtocol.encodeLenEncInt(colBuf, pos, len);
        pos += colBuf.write(str, pos, len, "utf8");
      };
      lenEncStr("def");          // catalog
      lenEncStr("parlel");       // schema
      lenEncStr(field.table || "");   // table
      lenEncStr(field.table || "");   // org_table
      lenEncStr(field.name);     // name
      lenEncStr(field.name);     // org_name
      colBuf.writeUInt8(0x0c, pos); pos++;          // length of fixed-length fields
      colBuf.writeUInt16LE(0x21, pos); pos += 2;    // charset (utf8)
      colBuf.writeUInt32LE(field.length || 255, pos); pos += 4; // column length
      colBuf.writeUInt8(field.type ?? 0xfd, pos); pos++;        // column type
      colBuf.writeUInt16LE(0, pos); pos += 2;       // flags
      colBuf.writeUInt8(0, pos); pos++;             // decimals
      colBuf.writeUInt16LE(0, pos); pos += 2;       // filler
      push(colBuf.slice(0, pos));
    }

    // EOF after column definitions: 0xFE + int<2> warnings + int<2> status.
    const eof = () => {
      const b = Buffer.alloc(5);
      b.writeUInt8(0xfe, 0);
      b.writeUInt16LE(0, 1);       // warnings
      b.writeUInt16LE(0x0002, 3);  // SERVER_STATUS_AUTOCOMMIT
      return b;
    };
    push(eof());

    // Row packets — each value is a lenenc string; NULL is 0xFB.
    for (const row of rows) {
      const rowBuf = Buffer.alloc(64 + row.reduce((n, v) => n + (v == null ? 1 : Buffer.byteLength(String(v)) + 9), 0));
      let pos = 0;
      for (const value of row) {
        if (value === null || value === undefined) {
          rowBuf.writeUInt8(0xfb, pos); pos++;
        } else {
          const str = String(value);
          const len = Buffer.byteLength(str);
          pos = MySQLProtocol.encodeLenEncInt(rowBuf, pos, len);
          pos += rowBuf.write(str, pos, len, "utf8");
        }
      }
      push(rowBuf.slice(0, pos));
    }

    // Final EOF.
    push(eof());

    return { buffer: Buffer.concat(packets), nextSeq: seq };
  }

  static parsePacket(data) {
    if (data.length < 4) return null;

    const length = data.readUIntLE(0, 3);
    const sequenceId = data.readUInt8(3);
    const payload = data.slice(4, 4 + length);

    return { length, sequenceId, payload };
  }

  static parseQuery(payload) {
    if (payload[0] !== 0x03) return null;
    let body = payload.slice(1);
    // Defensive: if a client still sent CLIENT_QUERY_ATTRIBUTES prefix bytes
    // (parameter_count + parameter_set_count as lenenc ints, both 0/1 for a
    // plain query), strip any leading non-printable bytes before the SQL text.
    let start = 0;
    while (start < body.length && body[start] < 0x20 && body[start] !== 0x09 && body[start] !== 0x0a) {
      start++;
    }
    if (start > 0) body = body.slice(start);
    return body.toString("utf8");
  }
}
