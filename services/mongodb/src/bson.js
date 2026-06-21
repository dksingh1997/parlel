// Minimal, dependency-free BSON encoder/decoder for the parlel mongodb fake.
// Supports the subset of BSON types the official `mongodb` driver emits/consumes.
//
// BSON element type bytes:
//   0x01 double          0x02 string        0x03 document
//   0x04 array           0x05 binary        0x06 undefined (deprecated)
//   0x07 ObjectId        0x08 boolean       0x09 UTC datetime
//   0x0A null            0x0B regex         0x0D javascript
//   0x10 int32           0x11 timestamp     0x12 int64
//   0x13 decimal128      0x7F maxkey        0xFF minkey

// ---- Value wrapper classes (so round-tripping preserves type) ----

let oidCounter = (Math.random() * 0xffffff) | 0;
const OID_MACHINE = Buffer.alloc(5);
for (let i = 0; i < 5; i++) OID_MACHINE[i] = (Math.random() * 256) | 0;

export class ObjectId {
  constructor(id) {
    if (id == null) {
      this.id = Buffer.alloc(12);
      const ts = Math.floor(Date.now() / 1000);
      this.id.writeUInt32BE(ts >>> 0, 0);
      OID_MACHINE.copy(this.id, 4);
      oidCounter = (oidCounter + 1) % 0xffffff;
      this.id.writeUIntBE(oidCounter, 9, 3);
    } else if (Buffer.isBuffer(id)) {
      this.id = Buffer.from(id);
    } else if (typeof id === "string" && id.length === 24) {
      this.id = Buffer.from(id, "hex");
    } else if (id instanceof ObjectId) {
      this.id = Buffer.from(id.id);
    } else {
      throw new Error("Invalid ObjectId");
    }
  }
  toHexString() {
    return this.id.toString("hex");
  }
  toString() {
    return this.toHexString();
  }
  equals(other) {
    return other instanceof ObjectId && this.id.equals(other.id);
  }
  static isValid(v) {
    if (v instanceof ObjectId) return true;
    if (Buffer.isBuffer(v)) return v.length === 12;
    if (typeof v === "string") return /^[0-9a-fA-F]{24}$/.test(v);
    return false;
  }
}

export class Long {
  constructor(value) {
    this.value = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
  }
  toNumber() {
    return Number(this.value);
  }
  toString() {
    return this.value.toString();
  }
}

export class Int32 {
  constructor(value) {
    this.value = value | 0;
  }
  valueOf() {
    return this.value;
  }
}

export class Double {
  constructor(value) {
    this.value = Number(value);
  }
  valueOf() {
    return this.value;
  }
}

export class Timestamp {
  constructor(low = 0, high = 0) {
    this.low = low >>> 0;
    this.high = high >>> 0;
  }
}

export class MinKey {}
export class MaxKey {}

export class Binary {
  constructor(buffer, subType = 0) {
    this.buffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.subType = subType;
  }
}

export class BSONRegExp {
  constructor(pattern, options = "") {
    this.pattern = pattern;
    this.options = options;
  }
}

// ---- Encoder ----

function ensure(buffers, totalRef, buf) {
  buffers.push(buf);
  totalRef.n += buf.length;
}

function encodeCString(str) {
  return Buffer.concat([Buffer.from(str, "utf8"), Buffer.from([0])]);
}

function encodeElement(name, value) {
  const parts = [];

  const writeHeader = (type) => {
    parts.push(Buffer.from([type]));
    parts.push(encodeCString(name));
  };

  if (value === null || value === undefined) {
    writeHeader(0x0a);
    return Buffer.concat(parts);
  }

  const t = typeof value;

  if (value instanceof ObjectId) {
    writeHeader(0x07);
    parts.push(Buffer.from(value.id));
    return Buffer.concat(parts);
  }
  if (value instanceof Long) {
    writeHeader(0x12);
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt.asIntN(64, value.value), 0);
    parts.push(b);
    return Buffer.concat(parts);
  }
  if (value instanceof Int32) {
    writeHeader(0x10);
    const b = Buffer.alloc(4);
    b.writeInt32LE(value.value, 0);
    parts.push(b);
    return Buffer.concat(parts);
  }
  if (value instanceof Double) {
    writeHeader(0x01);
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value.value, 0);
    parts.push(b);
    return Buffer.concat(parts);
  }
  if (value instanceof Timestamp) {
    writeHeader(0x11);
    const b = Buffer.alloc(8);
    b.writeUInt32LE(value.low, 0);
    b.writeUInt32LE(value.high, 4);
    parts.push(b);
    return Buffer.concat(parts);
  }
  if (value instanceof MinKey) {
    writeHeader(0xff);
    return Buffer.concat(parts);
  }
  if (value instanceof MaxKey) {
    writeHeader(0x7f);
    return Buffer.concat(parts);
  }
  if (value instanceof Binary) {
    writeHeader(0x05);
    const len = Buffer.alloc(4);
    len.writeInt32LE(value.buffer.length, 0);
    parts.push(len);
    parts.push(Buffer.from([value.subType]));
    parts.push(value.buffer);
    return Buffer.concat(parts);
  }
  if (value instanceof BSONRegExp) {
    writeHeader(0x0b);
    parts.push(encodeCString(value.pattern));
    parts.push(encodeCString(value.options));
    return Buffer.concat(parts);
  }
  if (value instanceof RegExp) {
    writeHeader(0x0b);
    let opts = "";
    if (value.flags.includes("i")) opts += "i";
    if (value.flags.includes("m")) opts += "m";
    if (value.flags.includes("s")) opts += "s";
    if (value.flags.includes("x")) opts += "x";
    parts.push(encodeCString(value.source));
    parts.push(encodeCString(opts));
    return Buffer.concat(parts);
  }
  if (value instanceof Date) {
    writeHeader(0x09);
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(value.getTime()), 0);
    parts.push(b);
    return Buffer.concat(parts);
  }
  if (Buffer.isBuffer(value)) {
    writeHeader(0x05);
    const len = Buffer.alloc(4);
    len.writeInt32LE(value.length, 0);
    parts.push(len);
    parts.push(Buffer.from([0]));
    parts.push(value);
    return Buffer.concat(parts);
  }
  if (Array.isArray(value)) {
    writeHeader(0x04);
    const doc = {};
    for (let i = 0; i < value.length; i++) doc[i] = value[i];
    parts.push(encodeBSON(doc));
    return Buffer.concat(parts);
  }
  if (t === "string") {
    writeHeader(0x02);
    const strBuf = Buffer.from(value, "utf8");
    const len = Buffer.alloc(4);
    len.writeInt32LE(strBuf.length + 1, 0);
    parts.push(len);
    parts.push(strBuf);
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
  }
  if (t === "boolean") {
    writeHeader(0x08);
    parts.push(Buffer.from([value ? 1 : 0]));
    return Buffer.concat(parts);
  }
  if (t === "number") {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      writeHeader(0x10);
      const b = Buffer.alloc(4);
      b.writeInt32LE(value, 0);
      parts.push(b);
      return Buffer.concat(parts);
    }
    writeHeader(0x01);
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value, 0);
    parts.push(b);
    return Buffer.concat(parts);
  }
  if (t === "bigint") {
    writeHeader(0x12);
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt.asIntN(64, value), 0);
    parts.push(b);
    return Buffer.concat(parts);
  }
  if (t === "object") {
    writeHeader(0x03);
    parts.push(encodeBSON(value));
    return Buffer.concat(parts);
  }

  // Fallback: null
  writeHeader(0x0a);
  return Buffer.concat(parts);
}

export function encodeBSON(doc) {
  const elements = [];
  if (doc && typeof doc === "object") {
    for (const key of Object.keys(doc)) {
      elements.push(encodeElement(key, doc[key]));
    }
  }
  const body = Buffer.concat(elements);
  const out = Buffer.alloc(4 + body.length + 1);
  out.writeInt32LE(out.length, 0);
  body.copy(out, 4);
  out[out.length - 1] = 0;
  return out;
}

// ---- Decoder ----

export function decodeBSON(buf, start = 0) {
  const size = buf.readInt32LE(start);
  const end = start + size;
  let offset = start + 4;
  const doc = {};

  while (offset < end - 1) {
    const type = buf[offset++];
    if (type === 0) break;

    // read cstring name
    let nameEnd = offset;
    while (buf[nameEnd] !== 0) nameEnd++;
    const name = buf.toString("utf8", offset, nameEnd);
    offset = nameEnd + 1;

    switch (type) {
      case 0x01: {
        doc[name] = buf.readDoubleLE(offset);
        offset += 8;
        break;
      }
      case 0x02: {
        const len = buf.readInt32LE(offset);
        offset += 4;
        doc[name] = buf.toString("utf8", offset, offset + len - 1);
        offset += len;
        break;
      }
      case 0x03: {
        const subSize = buf.readInt32LE(offset);
        doc[name] = decodeBSON(buf, offset);
        offset += subSize;
        break;
      }
      case 0x04: {
        const subSize = buf.readInt32LE(offset);
        const sub = decodeBSON(buf, offset);
        offset += subSize;
        const arr = [];
        for (const k of Object.keys(sub)) arr[Number(k)] = sub[k];
        doc[name] = arr;
        break;
      }
      case 0x05: {
        const len = buf.readInt32LE(offset);
        offset += 4;
        const subType = buf[offset++];
        const data = Buffer.from(buf.subarray(offset, offset + len));
        offset += len;
        doc[name] = new Binary(data, subType);
        break;
      }
      case 0x06: {
        doc[name] = undefined;
        break;
      }
      case 0x07: {
        doc[name] = new ObjectId(Buffer.from(buf.subarray(offset, offset + 12)));
        offset += 12;
        break;
      }
      case 0x08: {
        doc[name] = buf[offset] === 1;
        offset += 1;
        break;
      }
      case 0x09: {
        const millis = buf.readBigInt64LE(offset);
        offset += 8;
        doc[name] = new Date(Number(millis));
        break;
      }
      case 0x0a: {
        doc[name] = null;
        break;
      }
      case 0x0b: {
        let pEnd = offset;
        while (buf[pEnd] !== 0) pEnd++;
        const pattern = buf.toString("utf8", offset, pEnd);
        offset = pEnd + 1;
        let oEnd = offset;
        while (buf[oEnd] !== 0) oEnd++;
        const options = buf.toString("utf8", offset, oEnd);
        offset = oEnd + 1;
        doc[name] = new BSONRegExp(pattern, options);
        break;
      }
      case 0x0d: {
        const len = buf.readInt32LE(offset);
        offset += 4;
        doc[name] = buf.toString("utf8", offset, offset + len - 1);
        offset += len;
        break;
      }
      case 0x10: {
        doc[name] = buf.readInt32LE(offset);
        offset += 4;
        break;
      }
      case 0x11: {
        const low = buf.readUInt32LE(offset);
        const high = buf.readUInt32LE(offset + 4);
        offset += 8;
        doc[name] = new Timestamp(low, high);
        break;
      }
      case 0x12: {
        const v = buf.readBigInt64LE(offset);
        offset += 8;
        doc[name] = new Long(v);
        break;
      }
      case 0x13: {
        // decimal128 - keep raw 16 bytes as Binary
        doc[name] = new Binary(Buffer.from(buf.subarray(offset, offset + 16)), 0x13);
        offset += 16;
        break;
      }
      case 0x7f: {
        doc[name] = new MaxKey();
        break;
      }
      case 0xff: {
        doc[name] = new MinKey();
        break;
      }
      default: {
        throw new Error(`Unsupported BSON type 0x${type.toString(16)}`);
      }
    }
  }

  return doc;
}
