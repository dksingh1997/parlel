// MongoDB wire protocol framing for the parlel mongodb fake.
// Implements message header parsing plus OP_MSG (2013) and the legacy
// OP_QUERY (2004) used by some drivers for the initial isMaster handshake.

import { encodeBSON, decodeBSON } from "./bson.js";

export const OP_REPLY = 1;
export const OP_QUERY = 2004;
export const OP_MSG = 2013;

// A streaming framer that accumulates bytes and yields complete messages.
export class MessageFramer {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    while (this.buffer.length >= 4) {
      const messageLength = this.buffer.readInt32LE(0);
      if (messageLength <= 0 || messageLength > 48 * 1024 * 1024) {
        // Corrupt frame; drop everything to avoid lockup.
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < messageLength) break;

      const raw = this.buffer.subarray(0, messageLength);
      this.buffer = this.buffer.subarray(messageLength);
      messages.push(this.parse(Buffer.from(raw)));
    }

    return messages;
  }

  parse(buf) {
    const messageLength = buf.readInt32LE(0);
    const requestID = buf.readInt32LE(4);
    const responseTo = buf.readInt32LE(8);
    const opCode = buf.readInt32LE(12);

    if (opCode === OP_MSG) {
      return this.parseOpMsg(buf, requestID);
    }
    if (opCode === OP_QUERY) {
      return this.parseOpQuery(buf, requestID);
    }
    return { opCode, requestID, responseTo, messageLength, unsupported: true };
  }

  parseOpMsg(buf, requestID) {
    let offset = 16;
    const flagBits = buf.readUInt32LE(offset);
    offset += 4;

    let body = null;
    const sequences = {};

    while (offset < buf.length) {
      const kind = buf[offset++];
      if (kind === 0) {
        body = decodeBSON(buf, offset);
        offset += buf.readInt32LE(offset);
      } else if (kind === 1) {
        const sectionSize = buf.readInt32LE(offset);
        const sectionEnd = offset + sectionSize;
        let p = offset + 4;
        let idEnd = p;
        while (buf[idEnd] !== 0) idEnd++;
        const seqId = buf.toString("utf8", p, idEnd);
        p = idEnd + 1;
        const docs = [];
        while (p < sectionEnd) {
          const docSize = buf.readInt32LE(p);
          docs.push(decodeBSON(buf, p));
          p += docSize;
        }
        sequences[seqId] = docs;
        offset = sectionEnd;
      } else {
        break;
      }
    }

    return { opCode: OP_MSG, requestID, flagBits, body: body || {}, sequences };
  }

  parseOpQuery(buf, requestID) {
    let offset = 16;
    offset += 4; // flags
    let nsEnd = offset;
    while (buf[nsEnd] !== 0) nsEnd++;
    const fullCollectionName = buf.toString("utf8", offset, nsEnd);
    offset = nsEnd + 1;
    offset += 4; // numberToSkip
    offset += 4; // numberToReturn
    const query = decodeBSON(buf, offset);
    return { opCode: OP_QUERY, requestID, fullCollectionName, body: query };
  }
}

let responseIdCounter = 1;

export function encodeOpMsg(responseTo, doc) {
  const bsonBody = encodeBSON(doc);
  const messageLength = 16 + 4 + 1 + bsonBody.length;
  const out = Buffer.alloc(messageLength);
  let offset = 0;
  out.writeInt32LE(messageLength, offset);
  offset += 4;
  out.writeInt32LE(responseIdCounter++, offset);
  offset += 4;
  out.writeInt32LE(responseTo, offset);
  offset += 4;
  out.writeInt32LE(OP_MSG, offset);
  offset += 4;
  out.writeUInt32LE(0, offset); // flagBits
  offset += 4;
  out[offset++] = 0; // section kind: body
  bsonBody.copy(out, offset);
  return out;
}

export function encodeOpReply(responseTo, doc) {
  const bsonBody = encodeBSON(doc);
  const messageLength = 16 + 4 + 8 + 4 + 4 + bsonBody.length;
  const out = Buffer.alloc(messageLength);
  let offset = 0;
  out.writeInt32LE(messageLength, offset);
  offset += 4;
  out.writeInt32LE(responseIdCounter++, offset);
  offset += 4;
  out.writeInt32LE(responseTo, offset);
  offset += 4;
  out.writeInt32LE(OP_REPLY, offset);
  offset += 4;
  out.writeInt32LE(0, offset); // responseFlags
  offset += 4;
  out.writeBigInt64LE(0n, offset); // cursorID
  offset += 8;
  out.writeInt32LE(0, offset); // startingFrom
  offset += 4;
  out.writeInt32LE(1, offset); // numberReturned
  offset += 4;
  bsonBody.copy(out, offset);
  return out;
}
