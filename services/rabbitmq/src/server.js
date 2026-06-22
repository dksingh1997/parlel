import { createServer } from "node:net";

// Minimal but real AMQP 0-9-1 broker emulator — enough for the standard
// amqplib client to complete a connection, declare exchanges/queues, publish,
// and consume (via Basic.Consume push delivery and Basic.Get pull). Frames are
// encoded to spec (method frames carry class+method ids; content is a method
// frame + a content header frame + body frames). Field tables are encoded as
// proper (empty) tables so amqplib's strict parser accepts the handshake.

const FRAME_METHOD = 1;
const FRAME_HEADER = 2;
const FRAME_BODY = 3;
const FRAME_HEARTBEAT = 8;
const FRAME_END = 0xce;

// (class, method) ids used below.
const C = {
  CONNECTION: 10,
  CHANNEL: 20,
  EXCHANGE: 40,
  QUEUE: 50,
  BASIC: 60,
  TX: 90,
};

export class RabbitMQServer {
  constructor(port = 5672) {
    this.port = port;
    this.server = null;
    // Per-socket consumer registrations: socket -> Map<consumerTag, {queue, channel}>
    // This is live-connection state, not data fixtures, so reset() leaves it alone.
    this._consumers = new Map();
    this.reset();
  }

  // Clears all in-memory data state (queues, exchanges, bindings) back to empty.
  // Used for per-test isolation and by the Parlel control plane. Idempotent, no I/O.
  // Live per-socket consumer registrations are intentionally preserved.
  reset() {
    this.queues = new Map(); // name -> Array<{ body, props }>
    this.exchanges = new Map(); // name -> { type, bindings: [{ queue, key }] }
    this.bindings = new Map();
    this._deliveryTag = 0;
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer((socket) => this._handleSocket(socket));
      this.server.listen(this.port, () => {
        console.log(`RabbitMQ server running on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve);
      else resolve();
    });
  }

  _handleSocket(socket) {
    let buffer = Buffer.alloc(0);
    // Pending content: when a Basic.Publish method frame arrives, the next
    // header + body frames belong to it.
    let pending = null; // { exchange, routingKey, props, body, remaining }

    this._consumers.set(socket, new Map());

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);

      // Protocol header: "AMQP" + 0,0,9,1 -> respond with Connection.Start.
      if (buffer.length >= 8 && buffer.toString("ascii", 0, 4) === "AMQP") {
        socket.write(this._connectionStart());
        buffer = buffer.subarray(8);
      }

      while (buffer.length >= 7) {
        const frameType = buffer.readUInt8(0);
        const channel = buffer.readUInt16BE(1);
        const length = buffer.readUInt32BE(3);
        if (buffer.length < 7 + length + 1) break;
        const payload = buffer.subarray(7, 7 + length);
        const frameEnd = buffer.readUInt8(7 + length);
        buffer = buffer.subarray(8 + length);
        if (frameEnd !== FRAME_END) continue;

        if (frameType === FRAME_METHOD) {
          const classId = payload.readUInt16BE(0);
          const methodId = payload.readUInt16BE(2);
          const args = payload.subarray(4);
          pending = this._handleMethod(socket, channel, classId, methodId, args, pending);
        } else if (frameType === FRAME_HEADER && pending) {
          // Content header: class(2) weight(2) bodySize(8) flags(2) [props...]
          const bodySize = Number(payload.readBigUInt64BE(4));
          pending.remaining = bodySize;
          pending.body = Buffer.alloc(0);
          if (bodySize === 0) {
            this._deliverPublish(socket, pending);
            pending = null;
          }
        } else if (frameType === FRAME_BODY && pending) {
          pending.body = Buffer.concat([pending.body, payload]);
          pending.remaining -= payload.length;
          if (pending.remaining <= 0) {
            this._deliverPublish(socket, pending);
            pending = null;
          }
        } else if (frameType === FRAME_HEARTBEAT) {
          socket.write(Buffer.from([FRAME_HEARTBEAT, 0, 0, 0, 0, 0, 0, FRAME_END]));
        }
      }
    });

    socket.on("close", () => this._consumers.delete(socket));
    socket.on("error", () => this._consumers.delete(socket));
  }

  _handleMethod(socket, channel, classId, methodId, args, pending) {
    if (classId === C.CONNECTION) {
      if (methodId === 11) {
        // Connection.Start-Ok -> Tune
        socket.write(this._method(0, C.CONNECTION, 30, (b) => {
          b.u16(2047); // channel-max
          b.u32(131072); // frame-max
          b.u16(0); // heartbeat
        }));
      } else if (methodId === 31) {
        // Connection.Tune-Ok: nothing (await Open)
      } else if (methodId === 40) {
        // Connection.Open -> Open-Ok (reserved shortstr)
        socket.write(this._method(0, C.CONNECTION, 41, (b) => b.shortstr("")));
      } else if (methodId === 50) {
        // Connection.Close -> Close-Ok
        socket.write(this._method(0, C.CONNECTION, 51, () => {}));
      } else if (methodId === 51) {
        // Connection.Close-Ok: peer ack, ignore
      }
      return pending;
    }

    if (classId === C.CHANNEL) {
      if (methodId === 10) {
        // Channel.Open -> Open-Ok (reserved longstr)
        socket.write(this._method(channel, C.CHANNEL, 11, (b) => b.longstr("")));
      } else if (methodId === 40) {
        // Channel.Close -> Close-Ok
        socket.write(this._method(channel, C.CHANNEL, 41, () => {}));
      } else if (methodId === 41) {
        // Channel.Close-Ok
      }
      return pending;
    }

    if (classId === C.EXCHANGE) {
      if (methodId === 10) {
        // Exchange.Declare: reserved(2) exchange(shortstr) type(shortstr) ...
        const p = new Reader(args);
        p.u16();
        const name = p.shortstr();
        const type = p.shortstr();
        if (!this.exchanges.has(name)) this.exchanges.set(name, { type, bindings: [] });
        socket.write(this._method(channel, C.EXCHANGE, 11, () => {}));
      } else if (methodId === 20) {
        socket.write(this._method(channel, C.EXCHANGE, 21, () => {})); // Delete-Ok
      }
      return pending;
    }

    if (classId === C.QUEUE) {
      if (methodId === 10) {
        // Queue.Declare: reserved(2) queue(shortstr) ...
        const p = new Reader(args);
        p.u16();
        const name = p.shortstr();
        if (!this.queues.has(name)) this.queues.set(name, []);
        const q = this.queues.get(name);
        socket.write(this._method(channel, C.QUEUE, 11, (b) => {
          b.shortstr(name);
          b.u32(q.length); // message count
          b.u32(0); // consumer count
        }));
      } else if (methodId === 20) {
        // Queue.Bind: reserved(2) queue type? -> for simplicity parse queue+exchange+key
        const p = new Reader(args);
        p.u16();
        const queue = p.shortstr();
        const exchange = p.shortstr();
        const key = p.shortstr();
        const ex = this.exchanges.get(exchange);
        if (ex) ex.bindings.push({ queue, key });
        socket.write(this._method(channel, C.QUEUE, 21, () => {})); // Bind-Ok
      } else if (methodId === 50) {
        socket.write(this._method(channel, C.QUEUE, 51, () => {})); // Unbind-Ok
      } else if (methodId === 30) {
        // Queue.Purge
        const p = new Reader(args);
        p.u16();
        const name = p.shortstr();
        const q = this.queues.get(name);
        const count = q ? q.length : 0;
        if (q) q.length = 0;
        socket.write(this._method(channel, C.QUEUE, 31, (b) => b.u32(count)));
      } else if (methodId === 40) {
        // Queue.Delete
        const p = new Reader(args);
        p.u16();
        const name = p.shortstr();
        const q = this.queues.get(name);
        const count = q ? q.length : 0;
        this.queues.delete(name);
        socket.write(this._method(channel, C.QUEUE, 41, (b) => b.u32(count)));
      }
      return pending;
    }

    if (classId === C.BASIC) {
      if (methodId === 10) {
        // Basic.Qos -> Qos-Ok
        socket.write(this._method(channel, C.BASIC, 11, () => {}));
      } else if (methodId === 20) {
        // Basic.Consume: reserved(2) queue(shortstr) consumer-tag(shortstr) bits(1)
        const p = new Reader(args);
        p.u16();
        const queue = p.shortstr();
        let tag = p.shortstr();
        if (!tag) tag = `ctag-${Math.random().toString(36).slice(2, 10)}`;
        this._consumers.get(socket).set(tag, { queue, channel });
        // Consume-Ok(consumer-tag)
        socket.write(this._method(channel, C.BASIC, 21, (b) => b.shortstr(tag)));
        // Flush any messages already waiting in the queue to this consumer.
        this._flushQueueToConsumers(queue);
      } else if (methodId === 30) {
        // Basic.Cancel -> Cancel-Ok(consumer-tag)
        const p = new Reader(args);
        const tag = p.shortstr();
        this._consumers.get(socket).delete(tag);
        socket.write(this._method(channel, C.BASIC, 31, (b) => b.shortstr(tag)));
      } else if (methodId === 40) {
        // Basic.Publish: reserved(2) exchange(shortstr) routing-key(shortstr) bits(1)
        const p = new Reader(args);
        p.u16();
        const exchange = p.shortstr();
        const routingKey = p.shortstr();
        return { exchange, routingKey, body: Buffer.alloc(0), remaining: 0 };
      } else if (methodId === 70) {
        // Basic.Get: reserved(2) queue(shortstr) no-ack(1)
        const p = new Reader(args);
        p.u16();
        const queue = p.shortstr();
        const q = this.queues.get(queue) || [];
        if (q.length === 0) {
          // Get-Empty(reserved shortstr)
          socket.write(this._method(channel, C.BASIC, 72, (b) => b.shortstr("")));
        } else {
          const msg = q.shift();
          const tag = ++this._deliveryTag;
          // Get-Ok(delivery-tag u64, redelivered bit, exchange, routing-key, message-count u32)
          socket.write(this._method(channel, C.BASIC, 71, (b) => {
            b.u64(tag);
            b.u8(0);
            b.shortstr(msg.exchange || "");
            b.shortstr(msg.routingKey || queue);
            b.u32(q.length);
          }));
          this._writeContent(socket, channel, msg.body);
        }
      } else if (methodId === 80) {
        // Basic.Ack: no reply needed
      } else if (methodId === 90 || methodId === 120) {
        // Basic.Reject / Basic.Nack: ignore (no requeue handling)
      }
      return pending;
    }

    if (classId === C.TX) {
      // Tx.Select/Commit/Rollback -> *-Ok
      const okMap = { 10: 11, 20: 21, 30: 31 };
      if (okMap[methodId]) socket.write(this._method(channel, C.TX, okMap[methodId], () => {}));
      return pending;
    }

    return pending;
  }

  _deliverPublish(socket, msg) {
    // Route into bound queues; if published directly to the default exchange,
    // the routing key is the queue name.
    const targets = new Set();
    if (!msg.exchange) {
      targets.add(msg.routingKey);
    } else {
      const ex = this.exchanges.get(msg.exchange);
      if (ex) {
        for (const b of ex.bindings) {
          if (ex.type === "fanout" || b.key === msg.routingKey) targets.add(b.queue);
        }
      }
    }
    for (const name of targets) {
      if (!this.queues.has(name)) this.queues.set(name, []);
      this.queues.get(name).push({
        body: msg.body,
        exchange: msg.exchange,
        routingKey: msg.routingKey,
      });
      this._flushQueueToConsumers(name);
    }
  }

  // Push any queued messages to a registered consumer (Basic.Deliver).
  _flushQueueToConsumers(queueName) {
    const q = this.queues.get(queueName);
    if (!q || q.length === 0) return;
    for (const [socket, consumers] of this._consumers) {
      for (const [tag, c] of consumers) {
        if (c.queue !== queueName) continue;
        while (q.length > 0) {
          const msg = q.shift();
          const deliveryTag = ++this._deliveryTag;
          socket.write(this._method(c.channel, C.BASIC, 60, (b) => {
            b.shortstr(tag);
            b.u64(deliveryTag);
            b.u8(0); // redelivered
            b.shortstr(msg.exchange || "");
            b.shortstr(msg.routingKey || queueName);
          }));
          this._writeContent(socket, c.channel, msg.body);
        }
        return;
      }
    }
  }

  _writeContent(socket, channel, body) {
    // Content header frame: class(2) weight(2) body-size(8) property-flags(2)
    const header = Buffer.alloc(7 + 14 + 1);
    let pos = 0;
    header.writeUInt8(FRAME_HEADER, pos); pos++;
    header.writeUInt16BE(channel, pos); pos += 2;
    header.writeUInt32BE(14, pos); pos += 4;
    header.writeUInt16BE(C.BASIC, pos); pos += 2;
    header.writeUInt16BE(0, pos); pos += 2; // weight
    header.writeBigUInt64BE(BigInt(body.length), pos); pos += 8;
    header.writeUInt16BE(0, pos); pos += 2; // property flags (none)
    header.writeUInt8(FRAME_END, pos); pos++;
    socket.write(header);
    if (body.length > 0) {
      const frame = Buffer.alloc(7 + body.length + 1);
      let p = 0;
      frame.writeUInt8(FRAME_BODY, p); p++;
      frame.writeUInt16BE(channel, p); p += 2;
      frame.writeUInt32BE(body.length, p); p += 4;
      body.copy(frame, p); p += body.length;
      frame.writeUInt8(FRAME_END, p);
      socket.write(frame);
    }
  }

  // Build a method frame from a class+method id and a body builder.
  _method(channel, classId, methodId, build) {
    const b = new Writer();
    b.u16(classId);
    b.u16(methodId);
    build(b);
    const body = b.buffer();
    const frame = Buffer.alloc(7 + body.length + 1);
    let pos = 0;
    frame.writeUInt8(FRAME_METHOD, pos); pos++;
    frame.writeUInt16BE(channel, pos); pos += 2;
    frame.writeUInt32BE(body.length, pos); pos += 4;
    body.copy(frame, pos); pos += body.length;
    frame.writeUInt8(FRAME_END, pos);
    return frame;
  }

  _connectionStart() {
    return this._method(0, C.CONNECTION, 10, (b) => {
      b.u8(0); // version-major
      b.u8(9); // version-minor
      b.table({}); // server-properties (empty field table)
      b.longstr("PLAIN AMQPLAIN"); // mechanisms
      b.longstr("en_US"); // locales
    });
  }
}

// --- AMQP wire writers/readers -------------------------------------------

class Writer {
  constructor() {
    this._parts = [];
  }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v); this._parts.push(b); }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v); this._parts.push(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this._parts.push(b); }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); this._parts.push(b); }
  shortstr(s) {
    const sb = Buffer.from(s, "utf8");
    this.u8(sb.length);
    this._parts.push(sb);
  }
  longstr(s) {
    const sb = Buffer.from(s, "utf8");
    this.u32(sb.length);
    this._parts.push(sb);
  }
  table(_obj) {
    // Empty field table: just a 0 length. (We don't advertise capabilities.)
    this.u32(0);
  }
  buffer() { return Buffer.concat(this._parts); }
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  u8() { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  u16() { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  u32() { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  shortstr() {
    const len = this.u8();
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}
