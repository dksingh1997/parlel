// Decode a binary-format bound parameter (Bind format code 1) to a value the
// SQL layer can store as text. Clients send fixed-width big-endian integers in
// binary by default; map the common widths back to their numeric value. Other
// widths (e.g. variable-length text/bytea sent as binary) fall back to a utf8
// string, preserving prior best-effort behaviour.
function decodeBinaryParam(slice) {
  switch (slice.length) {
    case 2:
      return String(slice.readInt16BE(0));
    case 4:
      return String(slice.readInt32BE(0));
    case 8:
      return String(slice.readBigInt64BE(0));
    default:
      return slice.toString("utf8");
  }
}

export class PostgresProtocol {
  static MESSAGE_TYPES = {
    AuthenticationOk: 0x52,
    BackendKeyData: 0x4b,
    BindComplete: 0x32,
    CloseComplete: 0x33,
    CommandComplete: 0x43,
    CopyData: 0x64,
    CopyDone: 0x63,
    CopyInResponse: 0x47,
    CopyOutResponse: 0x48,
    DataRow: 0x44,
    EmptyQueryResponse: 0x49,
    ErrorResponse: 0x45,
    NoData: 0x6e,
    NoticeResponse: 0x4e,
    NotificationResponse: 0x41,
    ParameterDescription: 0x74,
    ParameterStatus: 0x53,
    ParseComplete: 0x31,
    PortalSuspended: 0x73,
    ReadyForQuery: 0x5a,
    RowDescription: 0x54,
    AuthenticationCleartextPassword: 0x52,
    AuthenticationMD5Password: 0x52,
    AuthenticationOk2: 0x52,
  };

  static ERROR_FIELDS = {
    Severity: "S",
    SeverityNonLocalized: "V",
    Code: "C",
    Message: "M",
    Detail: "D",
    Hint: "H",
    Position: "P",
    InternalPosition: "p",
    InternalQuery: "q",
    Where: "W",
    Schema: "s",
    Table: "t",
    Column: "c",
    DataType: "d",
    Constraint: "n",
    File: "F",
    Line: "L",
    Routine: "R",
  };

  static encodeAuthenticationOk() {
    const buf = Buffer.alloc(9);
    buf.writeUInt8(0x52, 0);
    buf.writeInt32BE(8, 1);
    buf.writeInt32BE(0, 5);
    return buf;
  }

  static encodeParameterStatus(name, value) {
    const nameBuf = Buffer.from(name + "\0");
    const valueBuf = Buffer.from(value + "\0");
    const buf = Buffer.alloc(5 + nameBuf.length + valueBuf.length);
    buf.writeUInt8(0x53, 0);
    buf.writeInt32BE(4 + nameBuf.length + valueBuf.length, 1);
    nameBuf.copy(buf, 5);
    valueBuf.copy(buf, 5 + nameBuf.length);
    return buf;
  }

  static encodeBackendKeyData(pid, key) {
    const buf = Buffer.alloc(13);
    buf.writeUInt8(0x4b, 0);
    buf.writeInt32BE(12, 1);
    buf.writeInt32BE(pid, 5);
    buf.writeInt32BE(key, 9);
    return buf;
  }

  static encodeReadyForQuery(status = "I") {
    const buf = Buffer.alloc(6);
    buf.writeUInt8(0x5a, 0);
    buf.writeInt32BE(5, 1);
    buf.write(status, 5, 1, "utf8");
    return buf;
  }

  static encodeRowDescription(fields) {
    const fieldBuffers = [];
    for (const field of fields) {
      const nameBuf = Buffer.from(field.name + "\0");
      const fieldBuf = Buffer.alloc(18 + nameBuf.length);
      nameBuf.copy(fieldBuf, 0);
      fieldBuf.writeInt32BE(0, nameBuf.length);
      fieldBuf.writeInt16BE(0, nameBuf.length + 4);
      fieldBuf.writeInt32BE(field.type || 25, nameBuf.length + 6);
      fieldBuf.writeInt16BE(field.typeSize || -1, nameBuf.length + 10);
      fieldBuf.writeInt32BE(field.typeModifier || -1, nameBuf.length + 12);
      fieldBuf.writeInt16BE(0, nameBuf.length + 16);
      fieldBuffers.push(fieldBuf);
    }

    const totalLength = 7 + fieldBuffers.reduce((sum, buf) => sum + buf.length, 0);
    const buf = Buffer.alloc(5 + 2 + fieldBuffers.reduce((sum, buf) => sum + buf.length, 0));
    buf.writeUInt8(0x54, 0);
    buf.writeInt32BE(4 + 2 + fieldBuffers.reduce((sum, buf) => sum + buf.length, 0), 1);
    buf.writeInt16BE(fields.length, 5);

    let offset = 7;
    for (const fieldBuf of fieldBuffers) {
      fieldBuf.copy(buf, offset);
      offset += fieldBuf.length;
    }

    return buf;
  }

  static encodeDataRow(values, fields) {
    const valueBuffers = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === null || value === undefined) {
        valueBuffers.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
      } else {
        const strValue = String(value);
        const valueBuf = Buffer.alloc(4 + Buffer.byteLength(strValue));
        valueBuf.writeInt32BE(Buffer.byteLength(strValue), 0);
        valueBuf.write(strValue, 4);
        valueBuffers.push(valueBuf);
      }
    }

    const totalLength = 7 + valueBuffers.reduce((sum, buf) => sum + buf.length, 0);
    const buf = Buffer.alloc(5 + 2 + valueBuffers.reduce((sum, buf) => sum + buf.length, 0));
    buf.writeUInt8(0x44, 0);
    buf.writeInt32BE(4 + 2 + valueBuffers.reduce((sum, buf) => sum + buf.length, 0), 1);
    buf.writeInt16BE(values.length, 5);

    let offset = 7;
    for (const valueBuf of valueBuffers) {
      valueBuf.copy(buf, offset);
      offset += valueBuf.length;
    }

    return buf;
  }

  static encodeCommandComplete(tag) {
    const tagBuf = Buffer.from(tag + "\0");
    const buf = Buffer.alloc(5 + tagBuf.length);
    buf.writeUInt8(0x43, 0);
    buf.writeInt32BE(4 + tagBuf.length, 1);
    tagBuf.copy(buf, 5);
    return buf;
  }

  static encodeErrorResponse(message, code = "42P01") {
    // Real Postgres (>=9.6) sends both S (localizable severity) and V
    // (non-localized severity); node-postgres reads V into err.severity.
    const fields = [
      [PostgresProtocol.ERROR_FIELDS.Severity, "ERROR"],
      [PostgresProtocol.ERROR_FIELDS.SeverityNonLocalized, "ERROR"],
      [PostgresProtocol.ERROR_FIELDS.Code, code],
      [PostgresProtocol.ERROR_FIELDS.Message, message],
    ];

    const fieldBuffers = [];
    let totalLength = 5; // type (1) + length (4)

    for (const [type, value] of fields) {
      const valueBuf = Buffer.from(value, "utf8");
      const fieldBuf = Buffer.alloc(1 + valueBuf.length + 1);
      fieldBuf.write(type, 0, 1, "utf8");
      valueBuf.copy(fieldBuf, 1);
      fieldBuf.writeUInt8(0, 1 + valueBuf.length);
      fieldBuffers.push(fieldBuf);
      totalLength += fieldBuf.length;
    }

    // Add terminating null
    totalLength += 1;

    const buf = Buffer.alloc(totalLength);
    buf.writeUInt8(0x45, 0);
    buf.writeInt32BE(totalLength - 1, 1);

    let offset = 5;
    for (const fieldBuf of fieldBuffers) {
      fieldBuf.copy(buf, offset);
      offset += fieldBuf.length;
    }

    // Terminating null
    buf.writeUInt8(0, offset);

    return buf;
  }

  static encodeParseComplete() {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(0x31, 0);
    buf.writeInt32BE(4, 1);
    return buf;
  }

  static encodeBindComplete() {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(0x32, 0);
    buf.writeInt32BE(4, 1);
    return buf;
  }

  static encodeNoData() {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(0x6e, 0);
    buf.writeInt32BE(4, 1);
    return buf;
  }

  // ParameterDescription ('t'): we report zero typed parameters; clients that
  // care only need the message to be present and well-formed.
  static encodeParameterDescription() {
    const buf = Buffer.alloc(7);
    buf.writeUInt8(0x74, 0); // 't'
    buf.writeInt32BE(6, 1); // length
    buf.writeInt16BE(0, 5); // parameter count
    return buf;
  }

  static encodeCloseComplete() {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(0x33, 0);
    buf.writeInt32BE(4, 1);
    return buf;
  }

  static parseStartupMessage(data) {
    const length = data.readInt32BE(0);
    const protocolVersion = data.readInt32BE(4);
    const params = {};

    let offset = 8;
    while (offset < length - 1) {
      const keyEnd = data.indexOf(0, offset);
      if (keyEnd === -1) break;
      const key = data.toString("utf8", offset, keyEnd);
      offset = keyEnd + 1;

      const valueEnd = data.indexOf(0, offset);
      if (valueEnd === -1) break;
      const value = data.toString("utf8", offset, valueEnd);
      offset = valueEnd + 1;

      params[key] = value;
    }

    return { protocolVersion, params };
  }

  static parseQuery(data) {
    // data includes type byte (1) + length (4) + query string
    const length = data.readInt32BE(1);
    const query = data.toString("utf8", 5, length);
    return query.replace(/\0/g, "");
  }

  static parseParse(data) {
    const length = data.readInt32BE(0);
    let offset = 4;

    const nameEnd = data.indexOf(0, offset);
    const name = data.toString("utf8", offset, nameEnd);
    offset = nameEnd + 1;

    const queryEnd = data.indexOf(0, offset);
    const query = data.toString("utf8", offset, queryEnd);
    offset = queryEnd + 1;

    const paramCount = data.readInt16BE(offset);
    offset += 2;

    return { name, query, paramCount };
  }

  static parseBind(data) {
    let offset = 4; // skip length

    const portalEnd = data.indexOf(0, offset);
    const portal = data.toString("utf8", offset, portalEnd);
    offset = portalEnd + 1;

    const stmtEnd = data.indexOf(0, offset);
    const statement = data.toString("utf8", offset, stmtEnd);
    offset = stmtEnd + 1;

    // Parameter format codes.
    const formatCount = data.readInt16BE(offset);
    offset += 2;
    const formats = [];
    for (let i = 0; i < formatCount; i++) {
      formats.push(data.readInt16BE(offset));
      offset += 2;
    }

    // Parameter values.
    const paramCount = data.readInt16BE(offset);
    offset += 2;
    const params = [];
    for (let i = 0; i < paramCount; i++) {
      const len = data.readInt32BE(offset);
      offset += 4;
      if (len === -1) {
        params.push(null);
      } else {
        const fmt = formats.length === 1 ? formats[0] : formats[i] ?? 0;
        const slice = data.subarray(offset, offset + len);
        offset += len;
        // fmt 0 = text, 1 = binary. Real clients (e.g. psycopg) send integers
        // in *binary* by default: a big-endian fixed-width buffer. Decode those
        // to their numeric value so a stored "4200" reads back as "4200" rather
        // than the raw bytes 0x10 0x68. Text params pass through as utf8.
        params.push(fmt === 1 ? decodeBinaryParam(slice) : slice.toString("utf8"));
      }
    }

    return { portal, statement, formats, params };
  }

  static parseDescribe(data) {
    const length = data.readInt32BE(0);
    const type = data.toString("utf8", 4, 5);
    let offset = 5;
    const nameEnd = data.indexOf(0, offset);
    const name = data.toString("utf8", offset, nameEnd);
    return { type, name };
  }

  static parseExecute(data) {
    const length = data.readInt32BE(0);
    let offset = 4;
    const portalEnd = data.indexOf(0, offset);
    const portal = data.toString("utf8", offset, portalEnd);
    return { portal };
  }
}
