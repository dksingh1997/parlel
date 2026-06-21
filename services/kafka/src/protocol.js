// Kafka wire protocol — pinned to fixed, NON-FLEXIBLE API versions so the
// encoding stays simple and consistent (no tagged fields, no compact
// strings/arrays, no varints). We advertise exactly these versions in
// ApiVersions, which forces kafkajs to speak them. This is enough for a real
// kafkajs producer/consumer to create topics, produce, and fetch.
//
// Pinned versions:
//   ApiVersions     v0   (response header v0: just correlationId)
//   Metadata        v1
//   Produce         v3   (uses RecordBatch v2 payloads)
//   Fetch           v4
//   ListOffsets     v1
//   FindCoordinator v0
//   JoinGroup       v0
//   SyncGroup       v0
//   Heartbeat       v0
//   LeaveGroup      v0
//   OffsetCommit    v2
//   OffsetFetch     v1
//   CreateTopics    v0
//   DeleteTopics    v0
//   InitProducerId  v0
//
// All response headers here are v0 (4-byte correlationId only) because none of
// the pinned versions are flexible.

export class KafkaProtocol {
  static API_KEYS = {
    Produce: 0,
    Fetch: 1,
    ListOffsets: 2,
    Metadata: 3,
    OffsetCommit: 8,
    OffsetFetch: 9,
    FindCoordinator: 10,
    JoinGroup: 11,
    Heartbeat: 12,
    LeaveGroup: 13,
    SyncGroup: 14,
    ApiVersions: 18,
    CreateTopics: 19,
    DeleteTopics: 20,
    InitProducerId: 22,
  };

  // Versions we advertise (and only these).
  static API_VERSIONS = [
    { apiKey: 0, minVersion: 3, maxVersion: 3 }, // Produce
    { apiKey: 1, minVersion: 4, maxVersion: 4 }, // Fetch
    { apiKey: 2, minVersion: 1, maxVersion: 1 }, // ListOffsets
    { apiKey: 3, minVersion: 1, maxVersion: 1 }, // Metadata
    { apiKey: 8, minVersion: 2, maxVersion: 2 }, // OffsetCommit
    { apiKey: 9, minVersion: 1, maxVersion: 1 }, // OffsetFetch
    { apiKey: 10, minVersion: 0, maxVersion: 0 }, // FindCoordinator
    { apiKey: 11, minVersion: 0, maxVersion: 0 }, // JoinGroup
    { apiKey: 12, minVersion: 0, maxVersion: 0 }, // Heartbeat
    { apiKey: 13, minVersion: 0, maxVersion: 0 }, // LeaveGroup
    { apiKey: 14, minVersion: 0, maxVersion: 0 }, // SyncGroup
    { apiKey: 18, minVersion: 0, maxVersion: 0 }, // ApiVersions
    { apiKey: 19, minVersion: 0, maxVersion: 0 }, // CreateTopics
    { apiKey: 20, minVersion: 0, maxVersion: 0 }, // DeleteTopics
    { apiKey: 22, minVersion: 0, maxVersion: 0 }, // InitProducerId
  ];

  // Response header v0: correlation id only.
  static header(correlationId) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(correlationId, 0);
    return b;
  }

  static parseRequest(data) {
    if (data.length < 8) return null;
    const apiKey = data.readInt16BE(0);
    const apiVersion = data.readInt16BE(2);
    const correlationId = data.readInt32BE(4);
    let offset = 8;
    // client id (nullable string, int16 length)
    const clientIdLen = data.readInt16BE(offset);
    offset += 2;
    if (clientIdLen > 0) offset += clientIdLen;
    return { apiKey, apiVersion, correlationId, offset };
  }
}

// --- writers / readers ----------------------------------------------------

export class Writer {
  constructor() {
    this._parts = [];
  }
  i8(v) { const b = Buffer.alloc(1); b.writeInt8(v); this._parts.push(b); return this; }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); this._parts.push(b); return this; }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this._parts.push(b); return this; }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this._parts.push(b); return this; }
  bool(v) { return this.i8(v ? 1 : 0); }
  // STRING: int16 length + utf8 bytes (non-nullable).
  str(s) {
    const sb = Buffer.from(s ?? "", "utf8");
    this.i16(sb.length);
    this._parts.push(sb);
    return this;
  }
  // NULLABLE_STRING: -1 for null.
  nstr(s) {
    if (s == null) return this.i16(-1);
    return this.str(s);
  }
  // BYTES: int32 length + bytes (nullable with -1).
  bytes(buf) {
    if (buf == null) return this.i32(-1);
    this.i32(buf.length);
    this._parts.push(buf);
    return this;
  }
  raw(buf) { this._parts.push(buf); return this; }
  buffer() { return Buffer.concat(this._parts); }
}

export class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }
  i8() { const v = this.buf.readInt8(this.pos); this.pos += 1; return v; }
  i16() { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  str() {
    const len = this.i16();
    if (len < 0) return null;
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  bytes() {
    const len = this.i32();
    if (len < 0) return null;
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }
  remaining() { return this.buf.subarray(this.pos); }
}

// --- RecordBatch v2 (used by Produce v3 / Fetch v4) -----------------------
// We only need to (a) extract record values from a produced batch and (b)
// build a batch when serving Fetch. Records use zigzag varints.

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  for (;;) {
    const byte = buf[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  // zigzag decode
  const val = (result >> 1n) ^ -(result & 1n);
  return [Number(val), p];
}

function writeVarint(value) {
  // zigzag encode
  let v = (BigInt(value) << 1n) ^ (BigInt(value) >> 63n);
  v = BigInt.asUintN(64, v);
  const out = [];
  for (;;) {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
    if (v === 0n) break;
  }
  return Buffer.from(out);
}

// Extract record {key, value} list from a RecordBatch v2 buffer.
export function decodeRecordBatch(buf) {
  const records = [];
  if (!buf || buf.length < 61) return records;
  let pos = 0;
  // Iterate possibly-multiple batches.
  while (pos + 61 <= buf.length) {
    // baseOffset(8) batchLength(4)
    const batchLength = buf.readInt32BE(pos + 8);
    const batchEnd = pos + 12 + batchLength;
    // records count is at offset 57 within the batch header
    const recordCount = buf.readInt32BE(pos + 57);
    let rp = pos + 61;
    for (let i = 0; i < recordCount && rp < batchEnd; i++) {
      let len;
      [len, rp] = readVarint(buf, rp); // length
      const recEnd = rp + len;
      rp += 1; // attributes (int8)
      let td;
      [td, rp] = readVarint(buf, rp); // timestampDelta
      let od;
      [od, rp] = readVarint(buf, rp); // offsetDelta
      let keyLen;
      [keyLen, rp] = readVarint(buf, rp);
      let key = null;
      if (keyLen >= 0) { key = buf.subarray(rp, rp + keyLen); rp += keyLen; }
      let valLen;
      [valLen, rp] = readVarint(buf, rp);
      let value = null;
      if (valLen >= 0) { value = buf.subarray(rp, rp + valLen); rp += valLen; }
      records.push({ key, value });
      rp = recEnd; // skip headers
    }
    pos = batchEnd;
  }
  return records;
}

// Build a RecordBatch v2 from stored records starting at baseOffset.
export function encodeRecordBatch(records, baseOffset) {
  const recBufs = [];
  records.forEach((rec, i) => {
    const inner = new Writer();
    inner.i8(0); // attributes
    inner.raw(writeVarint(0)); // timestampDelta
    inner.raw(writeVarint(i)); // offsetDelta
    const key = rec.key ?? null;
    if (key == null) inner.raw(writeVarint(-1));
    else { inner.raw(writeVarint(key.length)); inner.raw(key); }
    const val = rec.value ?? Buffer.alloc(0);
    inner.raw(writeVarint(val.length));
    inner.raw(val);
    inner.raw(writeVarint(0)); // header count
    const body = inner.buffer();
    const framed = Buffer.concat([writeVarint(body.length), body]);
    recBufs.push(framed);
  });
  const recordsBuf = Buffer.concat(recBufs);

  const header = Buffer.alloc(61);
  let p = 0;
  header.writeBigInt64BE(BigInt(baseOffset), p); p += 8; // baseOffset
  const batchLengthPos = p;
  p += 4; // batchLength placeholder
  header.writeInt32BE(0, p); p += 4; // partitionLeaderEpoch
  header.writeInt8(2, p); p += 1; // magic = 2
  const crcPos = p;
  p += 4; // crc placeholder (clients seldom verify against emulator)
  header.writeInt16BE(0, p); p += 2; // attributes
  header.writeInt32BE(records.length - 1 < 0 ? 0 : records.length - 1, p); p += 4; // lastOffsetDelta
  header.writeBigInt64BE(0n, p); p += 8; // firstTimestamp
  header.writeBigInt64BE(0n, p); p += 8; // maxTimestamp
  header.writeBigInt64BE(-1n, p); p += 8; // producerId
  header.writeInt16BE(-1, p); p += 2; // producerEpoch
  header.writeInt32BE(-1, p); p += 4; // baseSequence
  header.writeInt32BE(records.length, p); p += 4; // record count

  const full = Buffer.concat([header, recordsBuf]);
  // batchLength = everything after batchLength field
  full.writeInt32BE(full.length - 12, batchLengthPos);
  // crc over bytes after the crc field
  const crc = crc32c(full.subarray(crcPos + 4));
  full.writeUInt32BE(crc >>> 0, crcPos);
  return full;
}

// CRC32C (Castagnoli) — Kafka RecordBatch checksum.
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32c(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32C_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
