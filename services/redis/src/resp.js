export class RESPParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  feed(data) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
    return this.parse();
  }

  parse() {
    const results = [];
    while (this.buffer.length > 0) {
      const result = this.parseOne();
      if (result === null) break;
      results.push(result);
    }
    return results;
  }

  parseOne() {
    if (this.buffer.length === 0) return null;

    const type = this.buffer[0];
    const crlfIndex = this.findCRLF();
    if (crlfIndex === -1) return null;

    switch (type) {
      case 0x2b: { // '+'
        const value = this.buffer.slice(1, crlfIndex).toString("utf8");
        this.buffer = this.buffer.slice(crlfIndex + 2);
        return { type: "simple", value };
      }
      case 0x2d: { // '-'
        const value = this.buffer.slice(1, crlfIndex).toString("utf8");
        this.buffer = this.buffer.slice(crlfIndex + 2);
        return { type: "error", value };
      }
      case 0x3a: { // ':'
        const value = parseInt(this.buffer.slice(1, crlfIndex).toString("utf8"));
        this.buffer = this.buffer.slice(crlfIndex + 2);
        return { type: "integer", value };
      }
      case 0x24: { // '$'
        const length = parseInt(this.buffer.slice(1, crlfIndex).toString("utf8"));
        if (length === -1) {
          this.buffer = this.buffer.slice(crlfIndex + 2);
          return { type: "bulk", value: null };
        }
        const totalLength = crlfIndex + 2 + length + 2;
        if (this.buffer.length < totalLength) return null;
        const value = this.buffer.slice(crlfIndex + 2, crlfIndex + 2 + length).toString("utf8");
        this.buffer = this.buffer.slice(totalLength);
        return { type: "bulk", value };
      }
      case 0x2a: { // '*'
        const count = parseInt(this.buffer.slice(1, crlfIndex).toString("utf8"));
        if (count === -1) {
          this.buffer = this.buffer.slice(crlfIndex + 2);
          return { type: "array", value: null };
        }
        this.buffer = this.buffer.slice(crlfIndex + 2);
        const items = [];
        for (let i = 0; i < count; i++) {
          const item = this.parseOne();
          if (item === null) return null;
          items.push(item);
        }
        return { type: "array", value: items };
      }
      default:
        return null;
    }
  }

  findCRLF() {
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) {
        return i;
      }
    }
    return -1;
  }
}

export function encodeSimple(value) {
  return Buffer.from(`+${value}\r\n`);
}

export function encodeError(message) {
  // Real Redis errors are framed as `-<CODE> <message>\r\n` where the first
  // token is the error code (ERR, WRONGTYPE, NOSCRIPT, ...). Callers pass the
  // full message; if it does not already begin with an uppercase error-code
  // token, default to the generic ERR prefix to match `redis-cli`.
  const startsWithCode = /^[A-Z][A-Z0-9_]*\s/.test(message) || /^[A-Z][A-Z0-9_]*$/.test(message);
  const body = startsWithCode ? message : `ERR ${message}`;
  return Buffer.from(`-${body}\r\n`);
}

export function encodeInteger(value) {
  return Buffer.from(`:${value}\r\n`);
}

export function encodeBulk(value) {
  if (value === null) return Buffer.from("$-1\r\n");
  const str = String(value);
  return Buffer.from(`$${Buffer.byteLength(str)}\r\n${str}\r\n`);
}

// Encode a single RESP value. Recurses into nested arrays so replies like
// SCAN's `[cursor, [keys...]]` or GEOPOS's `[[lng, lat], nil]` frame correctly
// instead of being flattened/stringified.
export function encodeValue(item) {
  if (item === null || item === undefined) {
    return Buffer.from("$-1\r\n");
  }
  if (Array.isArray(item)) {
    return encodeArray(item);
  }
  if (typeof item === "number" && Number.isInteger(item)) {
    return Buffer.from(`:${item}\r\n`);
  }
  // Pre-encoded buffers (e.g. an item already serialized) pass through.
  if (Buffer.isBuffer(item)) {
    return item;
  }
  const str = String(item);
  return Buffer.from(`$${Buffer.byteLength(str)}\r\n${str}\r\n`);
}

export function encodeArray(items) {
  if (items === null) return Buffer.from("*-1\r\n");
  const parts = [Buffer.from(`*${items.length}\r\n`)];
  for (const item of items) {
    parts.push(encodeValue(item));
  }
  return Buffer.concat(parts);
}
