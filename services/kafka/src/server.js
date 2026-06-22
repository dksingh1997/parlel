import { createServer } from "node:net";
import {
  KafkaProtocol,
  Writer,
  Reader,
  decodeRecordBatch,
  encodeRecordBatch,
} from "./protocol.js";

const K = KafkaProtocol.API_KEYS;

// A single-broker Kafka emulator that speaks fixed, non-flexible API versions
// (see protocol.js) — enough for a real kafkajs producer and consumer-group
// consumer to create topics, produce, and fetch. The broker advertises
// host="localhost", port=this.port in Metadata/FindCoordinator; the Parlel
// bridge pins the client-side listener to that same port so the client's
// metadata-driven reconnect lands back on the bridge.

export class KafkaServer {
  constructor(port = 9092) {
    this.port = port;
    this.server = null;
    this.brokerId = 1;
    this.host = "localhost";
    this.reset();
  }

  // Clears all in-memory state back to empty. Used for per-test isolation
  // and by the Parlel control plane. Idempotent, no I/O.
  reset() {
    // name -> { partitions: [{ records: [{offset, key, value}], offset }] }
    this.topics = new Map();
    this.groups = new Map(); // groupId -> { members, assignments }
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data]);
          while (buffer.length >= 4) {
            const size = buffer.readInt32BE(0);
            if (buffer.length < size + 4) break;
            const message = buffer.subarray(4, size + 4);
            buffer = buffer.subarray(size + 4);
            this.handleRequest(socket, message);
          }
        });
        socket.on("error", () => {});
      });
      this.server.listen(this.port, () => {
        console.log(`Kafka server running on port ${this.port}`);
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

  _ensureTopic(name, numPartitions = 1) {
    if (!this.topics.has(name)) {
      const partitions = [];
      for (let i = 0; i < numPartitions; i++) partitions.push({ records: [], offset: 0 });
      this.topics.set(name, { partitions });
    }
    return this.topics.get(name);
  }

  handleRequest(socket, data) {
    const req = KafkaProtocol.parseRequest(data);
    if (!req) return;
    const { apiKey, correlationId, offset } = req;
    const r = new Reader(data, offset);

    let body;
    switch (apiKey) {
      case K.ApiVersions: body = this._apiVersions(); break;
      case K.Metadata: body = this._metadata(r); break;
      case K.CreateTopics: body = this._createTopics(r); break;
      case K.DeleteTopics: body = this._deleteTopics(r); break;
      case K.InitProducerId: body = this._initProducerId(); break;
      case K.Produce: body = this._produce(r); break;
      case K.Fetch: body = this._fetch(r); break;
      case K.ListOffsets: body = this._listOffsets(r); break;
      case K.FindCoordinator: body = this._findCoordinator(r); break;
      case K.JoinGroup: body = this._joinGroup(r); break;
      case K.SyncGroup: body = this._syncGroup(r); break;
      case K.Heartbeat: body = this._empty16(); break;
      case K.LeaveGroup: body = this._empty16(); break;
      case K.OffsetCommit: body = this._offsetCommit(r); break;
      case K.OffsetFetch: body = this._offsetFetch(r); break;
      default: body = Buffer.alloc(0);
    }

    const header = KafkaProtocol.header(correlationId);
    const payload = Buffer.concat([header, body]);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeInt32BE(payload.length, 0);
    socket.write(Buffer.concat([sizeBuf, payload]));
  }

  // ApiVersions: error(2) + array[apiKey(2) min(2) max(2)] + throttle(4).
  // kafkajs probes with v2 before it knows our versions; the v1/v2 response
  // appends throttle_time_ms, and the v0 parser simply ignores the trailing
  // bytes — so including it is safe for every non-flexible version.
  _apiVersions() {
    const w = new Writer();
    w.i16(0); // error
    w.i32(KafkaProtocol.API_VERSIONS.length);
    for (const v of KafkaProtocol.API_VERSIONS) {
      w.i16(v.apiKey).i16(v.minVersion).i16(v.maxVersion);
    }
    w.i32(0); // throttle_time_ms (v1+)
    return w.buffer();
  }

  // Metadata v1: brokers[node_id host port rack] controller_id topics[err name internal partitions[...]]
  _metadata(r) {
    // request v1: topics array (nullable). Parse names to know what to report.
    let requested = [];
    const count = r.i32();
    if (count > 0) {
      for (let i = 0; i < count; i++) requested.push(r.str());
    }
    // If specific topics requested, auto-create them (kafkajs producer relies
    // on this for auto-topic-creation behavior).
    const names = (requested.length ? requested : [...this.topics.keys()]).filter(Boolean);
    for (const n of names) this._ensureTopic(n, 1);

    const w = new Writer();
    // brokers
    w.i32(1);
    w.i32(this.brokerId).str(this.host).i32(this.port).nstr(null); // node, host, port, rack
    // controller id
    w.i32(this.brokerId);
    // topics
    w.i32(names.length);
    for (const name of names) {
      const topic = this.topics.get(name);
      w.i16(0); // error
      w.str(name);
      w.bool(false); // is_internal
      w.i32(topic.partitions.length);
      topic.partitions.forEach((_p, idx) => {
        w.i16(0); // error
        w.i32(idx); // partition index
        w.i32(this.brokerId); // leader
        w.i32(1).i32(this.brokerId); // replicas [1]
        w.i32(1).i32(this.brokerId); // isr [1]
      });
    }
    return w.buffer();
  }

  // CreateTopics v0: topics[name num_partitions replication assignments configs] timeout
  _createTopics(r) {
    const n = r.i32();
    const created = [];
    for (let i = 0; i < n; i++) {
      const name = r.str();
      const numPartitions = r.i32();
      r.i16(); // replication factor
      const assignCount = r.i32();
      for (let a = 0; a < assignCount; a++) { r.i32(); const rc = r.i32(); for (let x = 0; x < rc; x++) r.i32(); }
      const cfgCount = r.i32();
      for (let c = 0; c < cfgCount; c++) { r.str(); r.str(); }
      this._ensureTopic(name, numPartitions > 0 ? numPartitions : 1);
      created.push(name);
    }
    const w = new Writer();
    w.i32(created.length);
    for (const name of created) w.str(name).i16(0); // name, error
    return w.buffer();
  }

  _deleteTopics(r) {
    const n = r.i32();
    const names = [];
    for (let i = 0; i < n; i++) names.push(r.str());
    r.i32(); // timeout
    for (const name of names) this.topics.delete(name);
    const w = new Writer();
    w.i32(names.length);
    for (const name of names) w.str(name).i16(0);
    return w.buffer();
  }

  // InitProducerId v0: throttle(4) error(2) producerId(8) producerEpoch(2)
  _initProducerId() {
    const w = new Writer();
    w.i32(0).i16(0).i64(1).i16(0);
    return w.buffer();
  }

  // Produce v3: transactional_id(nstr) acks(2) timeout(4) topics[name partitions[index records(bytes)]]
  _produce(r) {
    r.str(); // transactional id (nullable)
    r.i16(); // acks
    r.i32(); // timeout
    const topicCount = r.i32();
    const results = [];
    for (let i = 0; i < topicCount; i++) {
      const name = r.str();
      const partCount = r.i32();
      const parts = [];
      for (let j = 0; j < partCount; j++) {
        const index = r.i32();
        const recordsBuf = r.bytes();
        const topic = this._ensureTopic(name, Math.max(index + 1, 1));
        const partition = topic.partitions[index] || topic.partitions[0];
        const baseOffset = partition.offset;
        const recs = decodeRecordBatch(recordsBuf);
        for (const rec of recs) {
          partition.records.push({ offset: partition.offset, key: rec.key, value: rec.value });
          partition.offset++;
        }
        parts.push({ index, baseOffset });
      }
      results.push({ name, parts });
    }
    // Produce v3 response: throttle? No — v3 layout: topics[name partitions[index error baseOffset logAppendTime]] throttle
    const w = new Writer();
    w.i32(results.length);
    for (const t of results) {
      w.str(t.name);
      w.i32(t.parts.length);
      for (const p of t.parts) {
        w.i32(p.index); // partition
        w.i16(0); // error
        w.i64(p.baseOffset); // base offset
        w.i64(-1); // log append time
      }
    }
    w.i32(0); // throttle time (end, for v3)
    return w.buffer();
  }

  // Fetch v4: replica(4) maxWait(4) minBytes(4) maxBytes(4) isolation(1)
  //   topics[name partitions[partition fetchOffset logStartOffset maxBytes]]
  _fetch(r) {
    r.i32(); // replica id
    r.i32(); // max wait
    r.i32(); // min bytes
    r.i32(); // max bytes
    r.i8(); // isolation level
    const topicCount = r.i32();
    const out = [];
    for (let i = 0; i < topicCount; i++) {
      const name = r.str();
      const partCount = r.i32();
      const parts = [];
      for (let j = 0; j < partCount; j++) {
        const partition = r.i32();
        const fetchOffset = Number(r.i64());
        // Fetch v4 partition has NO log_start_offset (added in v5).
        r.i32(); // partition max bytes
        const topic = this.topics.get(name);
        let recordsBuf = null;
        let highWatermark = 0;
        if (topic && topic.partitions[partition]) {
          const p = topic.partitions[partition];
          highWatermark = p.offset;
          const slice = p.records.filter((rec) => rec.offset >= fetchOffset);
          if (slice.length > 0) {
            recordsBuf = encodeRecordBatch(slice, slice[0].offset);
          }
        }
        parts.push({ partition, highWatermark, recordsBuf });
      }
      out.push({ name, parts });
    }
    // Fetch v4 response: throttle(4) topics[name partitions[partition error highWM lastStable abortedTxns records]]
    const w = new Writer();
    w.i32(0); // throttle
    w.i32(out.length);
    for (const t of out) {
      w.str(t.name);
      w.i32(t.parts.length);
      for (const p of t.parts) {
        w.i32(p.partition);
        w.i16(0); // error
        w.i64(p.highWatermark); // high watermark
        w.i64(p.highWatermark); // last stable offset
        w.i32(0); // aborted transactions count
        w.bytes(p.recordsBuf); // records (nullable bytes)
      }
    }
    return w.buffer();
  }

  // ListOffsets v1: replica(4) topics[name partitions[partition timestamp]]
  _listOffsets(r) {
    r.i32(); // replica id
    const topicCount = r.i32();
    const out = [];
    for (let i = 0; i < topicCount; i++) {
      const name = r.str();
      const partCount = r.i32();
      const parts = [];
      for (let j = 0; j < partCount; j++) {
        const partition = r.i32();
        const timestamp = Number(r.i64());
        const topic = this.topics.get(name);
        const p = topic && topic.partitions[partition];
        // timestamp -2 = earliest, -1 = latest
        let offset = 0;
        if (p) offset = timestamp === -2 ? 0 : p.offset;
        parts.push({ partition, timestamp: -1, offset });
      }
      out.push({ name, parts });
    }
    const w = new Writer();
    w.i32(out.length);
    for (const t of out) {
      w.str(t.name);
      w.i32(t.parts.length);
      for (const p of t.parts) {
        w.i32(p.partition).i16(0).i64(p.timestamp).i64(p.offset);
      }
    }
    return w.buffer();
  }

  // FindCoordinator v0: error(2) node_id(4) host(str) port(4)
  _findCoordinator(r) {
    r.str(); // group/coordinator key
    const w = new Writer();
    w.i16(0).i32(this.brokerId).str(this.host).i32(this.port);
    return w.buffer();
  }

  // JoinGroup v0: error(2) genId(4) protocol(str) leader(str) memberId(str) members[memberId metadata]
  _joinGroup(r) {
    const groupId = r.str();
    r.i32(); // session timeout
    r.str(); // member id (empty on first join)
    r.str(); // protocol type
    const protoCount = r.i32();
    let protocolName = "range";
    let metadata = Buffer.alloc(0);
    for (let i = 0; i < protoCount; i++) {
      protocolName = r.str();
      metadata = r.bytes() || Buffer.alloc(0);
    }
    const memberId = `member-${Math.random().toString(36).slice(2, 10)}`;
    this.groups.set(groupId, { memberId, protocolName, metadata });
    const w = new Writer();
    w.i16(0); // error
    w.i32(1); // generation id
    w.str(protocolName);
    w.str(memberId); // leader id (we are the only member)
    w.str(memberId); // member id
    w.i32(1); // members count
    w.str(memberId).bytes(metadata);
    return w.buffer();
  }

  // SyncGroup v0: error(2) assignment(bytes)
  _syncGroup(r) {
    r.str(); // group id
    r.i32(); // generation
    r.str(); // member id
    const assignCount = r.i32();
    let myAssignment = Buffer.alloc(0);
    for (let i = 0; i < assignCount; i++) {
      r.str(); // member id
      myAssignment = r.bytes() || Buffer.alloc(0); // single member -> our assignment
    }
    const w = new Writer();
    w.i16(0).bytes(myAssignment);
    return w.buffer();
  }

  // OffsetCommit v2: group(str) gen(4) member(str) retention(8) topics[name partitions[partition offset metadata]]
  _offsetCommit(r) {
    const groupId = r.str();
    r.i32(); r.str(); r.i64();
    const topicCount = r.i32();
    const out = [];
    const g = this.groups.get(groupId) || {};
    g.offsets = g.offsets || {};
    for (let i = 0; i < topicCount; i++) {
      const name = r.str();
      const partCount = r.i32();
      const parts = [];
      for (let j = 0; j < partCount; j++) {
        const partition = r.i32();
        const offset = Number(r.i64());
        r.str(); // metadata
        g.offsets[`${name}:${partition}`] = offset;
        parts.push(partition);
      }
      out.push({ name, parts });
    }
    this.groups.set(groupId, g);
    const w = new Writer();
    w.i32(out.length);
    for (const t of out) {
      w.str(t.name).i32(t.parts.length);
      for (const p of t.parts) w.i32(p).i16(0);
    }
    return w.buffer();
  }

  // OffsetFetch v1: group(str) topics[name partitions[partition]]
  _offsetFetch(r) {
    const groupId = r.str();
    const topicCount = r.i32();
    const out = [];
    const g = this.groups.get(groupId) || {};
    const offsets = g.offsets || {};
    for (let i = 0; i < topicCount; i++) {
      const name = r.str();
      const partCount = r.i32();
      const parts = [];
      for (let j = 0; j < partCount; j++) {
        const partition = r.i32();
        const committed = offsets[`${name}:${partition}`];
        parts.push({ partition, offset: committed == null ? -1 : committed });
      }
      out.push({ name, parts });
    }
    const w = new Writer();
    w.i32(out.length);
    for (const t of out) {
      w.str(t.name).i32(t.parts.length);
      for (const p of t.parts) {
        w.i32(p.partition).i64(p.offset).nstr("").i16(0); // partition, offset, metadata, error
      }
    }
    return w.buffer();
  }

  _empty16() {
    const w = new Writer();
    w.i16(0); // error code only (Heartbeat v0 / LeaveGroup v0)
    return w.buffer();
  }
}
