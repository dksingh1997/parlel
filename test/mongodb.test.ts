import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createConnection, Socket } from "node:net";
import { MongodbServer } from "../services/mongodb/src/server.js";
import {
  encodeBSON,
  decodeBSON,
  ObjectId,
  Long,
  Binary,
} from "../services/mongodb/src/bson.js";

const PORT = 47017;

// ---- Minimal in-test MongoDB wire-protocol client (OP_MSG) ----

let requestId = 1;

function encodeOpMsg(doc: Record<string, unknown>): Buffer {
  const body = encodeBSON(doc);
  const len = 16 + 4 + 1 + body.length;
  const out = Buffer.alloc(len);
  let o = 0;
  out.writeInt32LE(len, o); o += 4;
  out.writeInt32LE(requestId++, o); o += 4;
  out.writeInt32LE(0, o); o += 4;
  out.writeInt32LE(2013, o); o += 4; // OP_MSG
  out.writeUInt32LE(0, o); o += 4; // flags
  out[o++] = 0; // section kind body
  body.copy(out, o);
  return out;
}

function parseReply(buf: Buffer): Record<string, any> {
  // header(16) + flags(4) + kind(1) + bson
  const flags = buf.readUInt32LE(16);
  void flags;
  const kind = buf[20];
  expect(kind).toBe(0);
  return decodeBSON(buf, 21);
}

class WireClient {
  socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private resolvers: Array<(d: Record<string, any>) => void> = [];

  constructor(socket: Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const msgLen = this.buffer.readInt32LE(0);
        if (this.buffer.length < msgLen) break;
        const raw = Buffer.from(this.buffer.subarray(0, msgLen));
        this.buffer = this.buffer.subarray(msgLen);
        const resolve = this.resolvers.shift();
        if (resolve) resolve(parseReply(raw));
      }
    });
  }

  command(doc: Record<string, unknown>): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      this.resolvers.push(resolve);
      this.socket.write(encodeOpMsg(doc));
      setTimeout(() => reject(new Error("command timeout")), 5000);
    });
  }

  close() {
    this.socket.destroy();
  }
}

function connect(): Promise<WireClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port: PORT }, () => {
      resolve(new WireClient(socket));
    });
    socket.on("error", reject);
  });
}

const DB = "parlel";

describe("MongoDB Service", () => {
  let server: MongodbServer;
  let client: WireClient;

  beforeAll(async () => {
    server = new MongodbServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 300));
    client = await connect();
  }, 15000);

  afterAll(async () => {
    client.close();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  // ============ Server / lifecycle ============
  describe("Server", () => {
    it("should start on configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("should have empty databases initially", () => {
      expect(server.databases.size).toBe(0);
    });

    it("reset() clears state", () => {
      server.getCollection("x", "y");
      expect(server.databases.size).toBeGreaterThan(0);
      server.reset();
      expect(server.databases.size).toBe(0);
    });
  });

  // ============ Handshake / connection ============
  describe("Handshake", () => {
    it("hello returns isWritablePrimary", async () => {
      const r = await client.command({ hello: 1, $db: "admin" });
      expect(r.ok).toBe(1);
      expect(r.isWritablePrimary).toBe(true);
      expect(r.maxWireVersion).toBeGreaterThanOrEqual(7);
    });

    it("isMaster returns ismaster true", async () => {
      const r = await client.command({ isMaster: 1, $db: "admin" });
      expect(r.ok).toBe(1);
      expect(r.ismaster).toBe(true);
    });

    it("ping returns ok", async () => {
      const r = await client.command({ ping: 1, $db: "admin" });
      expect(r.ok).toBe(1);
    });

    it("buildInfo returns version", async () => {
      const r = await client.command({ buildInfo: 1, $db: "admin" });
      expect(r.ok).toBe(1);
      expect(r.version).toBe("7.0.0");
      expect(Array.isArray(r.versionArray)).toBe(true);
    });

    it("getParameter returns FCV", async () => {
      const r = await client.command({ getParameter: 1, featureCompatibilityVersion: 1, $db: "admin" });
      expect(r.ok).toBe(1);
    });

    it("whatsmyuri", async () => {
      const r = await client.command({ whatsmyuri: 1, $db: "admin" });
      expect(r.ok).toBe(1);
      expect(typeof r.you).toBe("string");
    });

    it("connectionStatus", async () => {
      const r = await client.command({ connectionStatus: 1, $db: "admin" });
      expect(r.ok).toBe(1);
      expect(r.authInfo).toBeDefined();
    });

    it("getLog", async () => {
      const r = await client.command({ getLog: "startupWarnings", $db: "admin" });
      expect(r.ok).toBe(1);
    });

    it("serverStatus", async () => {
      const r = await client.command({ serverStatus: 1, $db: "admin" });
      expect(r.ok).toBe(1);
      expect(r.connections).toBeDefined();
    });

    it("unknown command returns CommandNotFound", async () => {
      const r = await client.command({ totallyBogusCommand: 1, $db: DB });
      expect(r.ok).toBe(0);
      expect(r.code).toBe(59);
      expect(r.codeName).toBe("CommandNotFound");
    });
  });

  // ============ Insert ============
  describe("Insert", () => {
    it("inserts a single document and auto-generates _id", async () => {
      const r = await client.command({
        insert: "users",
        documents: [{ name: "alice", age: 30 }],
        $db: DB,
      });
      expect(r.ok).toBe(1);
      expect(r.n).toBe(1);
      const coll = server.getCollection(DB, "users");
      expect(coll.docs.length).toBe(1);
      expect(coll.docs[0]._id).toBeInstanceOf(ObjectId);
    });

    it("inserts multiple documents", async () => {
      const r = await client.command({
        insert: "users",
        documents: [{ name: "a" }, { name: "b" }, { name: "c" }],
        $db: DB,
      });
      expect(r.n).toBe(3);
    });

    it("preserves provided _id", async () => {
      const r = await client.command({
        insert: "users",
        documents: [{ _id: 42, name: "fixed" }],
        $db: DB,
      });
      expect(r.n).toBe(1);
      expect(server.getCollection(DB, "users").docs[0]._id).toBe(42);
    });

    it("returns duplicate key error (11000) on _id collision", async () => {
      await client.command({ insert: "users", documents: [{ _id: 1 }], $db: DB });
      const r = await client.command({ insert: "users", documents: [{ _id: 1 }], $db: DB });
      expect(r.n).toBe(0);
      expect(r.writeErrors[0].code).toBe(11000);
    });

    it("duplicate key writeError carries keyPattern + keyValue (MongoDB 4.2+ shape)", async () => {
      await client.command({ insert: "users", documents: [{ _id: 7 }], $db: DB });
      const r = await client.command({ insert: "users", documents: [{ _id: 7 }], $db: DB });
      const we = r.writeErrors[0];
      expect(we.index).toBe(0);
      expect(we.code).toBe(11000);
      expect(we.keyPattern).toEqual({ _id: 1 });
      expect(we.keyValue).toEqual({ _id: 7 });
      expect(we.errmsg).toContain("E11000 duplicate key error");
    });

    it("ordered insert stops at first error", async () => {
      await client.command({ insert: "users", documents: [{ _id: 1 }], $db: DB });
      const r = await client.command({
        insert: "users",
        documents: [{ _id: 2 }, { _id: 1 }, { _id: 3 }],
        $db: DB,
      });
      expect(r.n).toBe(1);
      expect(r.writeErrors.length).toBe(1);
    });
  });

  // ============ Find ============
  describe("Find", () => {
    beforeEach(async () => {
      await client.command({
        insert: "items",
        documents: [
          { _id: 1, name: "apple", price: 3, tags: ["fruit", "red"] },
          { _id: 2, name: "banana", price: 1, tags: ["fruit", "yellow"] },
          { _id: 3, name: "carrot", price: 2, tags: ["veg"] },
          { _id: 4, name: "date", price: 5, tags: ["fruit"] },
        ],
        $db: DB,
      });
    });

    it("finds all documents", async () => {
      const r = await client.command({ find: "items", filter: {}, $db: DB });
      expect(r.ok).toBe(1);
      expect(r.cursor.firstBatch.length).toBe(4);
    });

    it("finds by equality", async () => {
      const r = await client.command({ find: "items", filter: { name: "banana" }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(1);
      expect(r.cursor.firstBatch[0]._id).toBe(2);
    });

    it("$gt / $lt operators", async () => {
      const r = await client.command({ find: "items", filter: { price: { $gt: 2 } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$gte / $lte operators", async () => {
      const r = await client.command({ find: "items", filter: { price: { $gte: 2, $lte: 3 } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$in operator", async () => {
      const r = await client.command({ find: "items", filter: { name: { $in: ["apple", "date"] } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$nin operator", async () => {
      const r = await client.command({ find: "items", filter: { name: { $nin: ["apple", "date"] } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$ne operator", async () => {
      const r = await client.command({ find: "items", filter: { name: { $ne: "apple" } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(3);
    });

    it("array membership equality", async () => {
      const r = await client.command({ find: "items", filter: { tags: "fruit" }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(3);
    });

    it("$and operator", async () => {
      const r = await client.command({
        find: "items",
        filter: { $and: [{ price: { $gt: 1 } }, { tags: "fruit" }] },
        $db: DB,
      });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$or operator", async () => {
      const r = await client.command({
        find: "items",
        filter: { $or: [{ name: "apple" }, { name: "carrot" }] },
        $db: DB,
      });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$exists operator", async () => {
      const r = await client.command({ find: "items", filter: { price: { $exists: true } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(4);
      const r2 = await client.command({ find: "items", filter: { nope: { $exists: true } }, $db: DB });
      expect(r2.cursor.firstBatch.length).toBe(0);
    });

    it("$regex operator", async () => {
      const r = await client.command({ find: "items", filter: { name: { $regex: "^a" } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(1);
      expect(r.cursor.firstBatch[0].name).toBe("apple");
    });

    it("sort ascending and descending", async () => {
      const asc = await client.command({ find: "items", filter: {}, sort: { price: 1 }, $db: DB });
      expect(asc.cursor.firstBatch.map((d: any) => d.price)).toEqual([1, 2, 3, 5]);
      const desc = await client.command({ find: "items", filter: {}, sort: { price: -1 }, $db: DB });
      expect(desc.cursor.firstBatch.map((d: any) => d.price)).toEqual([5, 3, 2, 1]);
    });

    it("limit and skip", async () => {
      const r = await client.command({ find: "items", filter: {}, sort: { _id: 1 }, skip: 1, limit: 2, $db: DB });
      expect(r.cursor.firstBatch.map((d: any) => d._id)).toEqual([2, 3]);
    });

    it("projection include", async () => {
      const r = await client.command({ find: "items", filter: { _id: 1 }, projection: { name: 1 }, $db: DB });
      const doc = r.cursor.firstBatch[0];
      expect(doc.name).toBe("apple");
      expect(doc.price).toBeUndefined();
      expect(doc._id).toBe(1);
    });

    it("projection exclude", async () => {
      const r = await client.command({ find: "items", filter: { _id: 1 }, projection: { tags: 0, price: 0 }, $db: DB });
      const doc = r.cursor.firstBatch[0];
      expect(doc.name).toBe("apple");
      expect(doc.price).toBeUndefined();
      expect(doc.tags).toBeUndefined();
    });

    it("find on missing collection returns empty", async () => {
      const r = await client.command({ find: "ghost", filter: {}, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(0);
      // cursor id is a BSON int64 → decoded as Long; 0 means exhausted
      expect(Number(r.cursor.id.value ?? r.cursor.id)).toBe(0);
    });

    it("$elemMatch operator", async () => {
      await client.command({
        insert: "scores",
        documents: [{ _id: 1, results: [82, 85, 88] }, { _id: 2, results: [75, 88, 89] }],
        $db: DB,
      });
      const r = await client.command({
        find: "scores",
        filter: { results: { $elemMatch: { $gte: 80, $lt: 85 } } },
        $db: DB,
      });
      expect(r.cursor.firstBatch.length).toBe(1);
      expect(r.cursor.firstBatch[0]._id).toBe(1);
    });

    it("$all operator", async () => {
      const r = await client.command({ find: "items", filter: { tags: { $all: ["fruit", "red"] } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(1);
      expect(r.cursor.firstBatch[0].name).toBe("apple");
    });

    it("$size operator", async () => {
      const r = await client.command({ find: "items", filter: { tags: { $size: 2 } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$not operator", async () => {
      const r = await client.command({ find: "items", filter: { price: { $not: { $gt: 2 } } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$type operator", async () => {
      const r = await client.command({ find: "items", filter: { name: { $type: "string" } }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(4);
    });

    it("nested dotted-path query", async () => {
      await client.command({ insert: "nest", documents: [{ _id: 1, a: { b: { c: 5 } } }], $db: DB });
      const r = await client.command({ find: "nest", filter: { "a.b.c": 5 }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(1);
    });
  });

  // ============ Cursor / getMore ============
  describe("Cursor pagination", () => {
    beforeEach(async () => {
      const docs = [];
      for (let i = 0; i < 10; i++) docs.push({ _id: i, n: i });
      await client.command({ insert: "big", documents: docs, $db: DB });
    });

    it("returns a live cursor id when batch is incomplete", async () => {
      const r = await client.command({ find: "big", filter: {}, sort: { _id: 1 }, batchSize: 3, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(3);
      expect(r.cursor.id).not.toBe(0n);
    });

    it("getMore fetches subsequent batches", async () => {
      const r = await client.command({ find: "big", filter: {}, sort: { _id: 1 }, batchSize: 4, $db: DB });
      const cursorId = r.cursor.id;
      const r2 = await client.command({ getMore: cursorId, collection: "big", batchSize: 4, $db: DB });
      expect(r2.ok).toBe(1);
      expect(r2.cursor.nextBatch.length).toBe(4);
    });

    it("getMore exhausts the cursor (id becomes 0)", async () => {
      const r = await client.command({ find: "big", filter: {}, sort: { _id: 1 }, batchSize: 6, $db: DB });
      const r2 = await client.command({ getMore: r.cursor.id, collection: "big", batchSize: 100, $db: DB });
      expect(r2.cursor.nextBatch.length).toBe(4);
      expect(Number(r2.cursor.id.value ?? r2.cursor.id)).toBe(0);
    });

    it("getMore on unknown cursor returns CursorNotFound", async () => {
      const r = await client.command({ getMore: new Long(999999), collection: "big", $db: DB });
      expect(r.ok).toBe(0);
      expect(r.code).toBe(43);
      expect(r.codeName).toBe("CursorNotFound");
    });

    it("killCursors", async () => {
      const r = await client.command({ find: "big", filter: {}, batchSize: 2, $db: DB });
      const k = await client.command({ killCursors: "big", cursors: [r.cursor.id], $db: DB });
      expect(k.ok).toBe(1);
      expect(k.cursorsKilled.length).toBe(1);
    });
  });

  // ============ Update ============
  describe("Update", () => {
    beforeEach(async () => {
      await client.command({
        insert: "u",
        documents: [
          { _id: 1, name: "a", count: 1, tags: ["x"] },
          { _id: 2, name: "b", count: 2, tags: ["y"] },
        ],
        $db: DB,
      });
    });

    it("$set updates fields", async () => {
      const r = await client.command({
        update: "u",
        updates: [{ q: { _id: 1 }, u: { $set: { name: "AAA" } } }],
        $db: DB,
      });
      expect(r.n).toBe(1);
      expect(r.nModified).toBe(1);
      expect(server.getCollection(DB, "u").docs[0].name).toBe("AAA");
    });

    it("$inc increments", async () => {
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $inc: { count: 5 } } }], $db: DB });
      expect(server.getCollection(DB, "u").docs[0].count).toBe(6);
    });

    it("$unset removes a field", async () => {
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $unset: { name: "" } } }], $db: DB });
      expect(server.getCollection(DB, "u").docs[0].name).toBeUndefined();
    });

    it("$push appends to array", async () => {
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $push: { tags: "z" } } }], $db: DB });
      expect(server.getCollection(DB, "u").docs[0].tags).toEqual(["x", "z"]);
    });

    it("$addToSet avoids duplicates", async () => {
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $addToSet: { tags: "x" } } }], $db: DB });
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $addToSet: { tags: "w" } } }], $db: DB });
      expect(server.getCollection(DB, "u").docs[0].tags).toEqual(["x", "w"]);
    });

    it("$pull removes matching elements", async () => {
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $push: { tags: "y" } } }], $db: DB });
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $pull: { tags: "x" } } }], $db: DB });
      expect(server.getCollection(DB, "u").docs[0].tags).toEqual(["y"]);
    });

    it("multi update", async () => {
      const r = await client.command({
        update: "u",
        updates: [{ q: {}, u: { $set: { active: true } }, multi: true }],
        $db: DB,
      });
      expect(r.nModified).toBe(2);
    });

    it("upsert inserts when no match", async () => {
      const r = await client.command({
        update: "u",
        updates: [{ q: { _id: 99 }, u: { $set: { name: "new" } }, upsert: true }],
        $db: DB,
      });
      expect(r.upserted.length).toBe(1);
      expect(r.upserted[0]._id).toBe(99);
      expect(server.getCollection(DB, "u").docs.length).toBe(3);
    });

    it("full document replacement keeps _id", async () => {
      await client.command({
        update: "u",
        updates: [{ q: { _id: 1 }, u: { name: "replaced", brand: "new" } }],
        $db: DB,
      });
      const doc = server.getCollection(DB, "u").docs[0];
      expect(doc._id).toBe(1);
      expect(doc.name).toBe("replaced");
      expect(doc.count).toBeUndefined();
    });

    it("$mul multiplies", async () => {
      await client.command({ update: "u", updates: [{ q: { _id: 2 }, u: { $mul: { count: 3 } } }], $db: DB });
      expect(server.getCollection(DB, "u").docs[1].count).toBe(6);
    });

    it("$rename renames a field", async () => {
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $rename: { name: "label" } } }], $db: DB });
      const doc = server.getCollection(DB, "u").docs[0];
      expect(doc.label).toBe("a");
      expect(doc.name).toBeUndefined();
    });

    it("$min / $max", async () => {
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $max: { count: 10 } } }], $db: DB });
      expect(server.getCollection(DB, "u").docs[0].count).toBe(10);
      await client.command({ update: "u", updates: [{ q: { _id: 1 }, u: { $min: { count: 4 } } }], $db: DB });
      expect(server.getCollection(DB, "u").docs[0].count).toBe(4);
    });
  });

  // ============ Delete ============
  describe("Delete", () => {
    beforeEach(async () => {
      await client.command({
        insert: "d",
        documents: [{ _id: 1, g: "a" }, { _id: 2, g: "a" }, { _id: 3, g: "b" }],
        $db: DB,
      });
    });

    it("deletes one (limit 1)", async () => {
      const r = await client.command({ delete: "d", deletes: [{ q: { g: "a" }, limit: 1 }], $db: DB });
      expect(r.n).toBe(1);
      expect(server.getCollection(DB, "d").docs.length).toBe(2);
    });

    it("deletes many (limit 0)", async () => {
      const r = await client.command({ delete: "d", deletes: [{ q: { g: "a" }, limit: 0 }], $db: DB });
      expect(r.n).toBe(2);
      expect(server.getCollection(DB, "d").docs.length).toBe(1);
    });

    it("delete with empty filter removes all", async () => {
      const r = await client.command({ delete: "d", deletes: [{ q: {}, limit: 0 }], $db: DB });
      expect(r.n).toBe(3);
    });
  });

  // ============ findAndModify ============
  describe("findAndModify", () => {
    beforeEach(async () => {
      await client.command({
        insert: "fam",
        documents: [{ _id: 1, n: 1 }, { _id: 2, n: 2 }],
        $db: DB,
      });
    });

    it("updates and returns old doc by default", async () => {
      const r = await client.command({
        findAndModify: "fam",
        query: { _id: 1 },
        update: { $set: { n: 100 } },
        $db: DB,
      });
      expect(r.value._id).toBe(1);
      expect(r.value.n).toBe(1);
      expect(server.getCollection(DB, "fam").docs[0].n).toBe(100);
    });

    it("returns new doc with new:true", async () => {
      const r = await client.command({
        findAndModify: "fam",
        query: { _id: 1 },
        update: { $inc: { n: 10 } },
        new: true,
        $db: DB,
      });
      expect(r.value.n).toBe(11);
    });

    it("removes and returns the doc", async () => {
      const r = await client.command({
        findAndModify: "fam",
        query: { _id: 2 },
        remove: true,
        $db: DB,
      });
      expect(r.value._id).toBe(2);
      expect(server.getCollection(DB, "fam").docs.length).toBe(1);
    });

    it("upserts when missing", async () => {
      const r = await client.command({
        findAndModify: "fam",
        query: { _id: 5 },
        update: { $set: { n: 50 } },
        upsert: true,
        new: true,
        $db: DB,
      });
      expect(r.value._id).toBe(5);
      expect(r.value.n).toBe(50);
    });
  });

  // ============ Count / Distinct ============
  describe("Count and Distinct", () => {
    beforeEach(async () => {
      await client.command({
        insert: "c",
        documents: [
          { _id: 1, cat: "x", v: 1 },
          { _id: 2, cat: "x", v: 2 },
          { _id: 3, cat: "y", v: 2 },
        ],
        $db: DB,
      });
    });

    it("count all", async () => {
      const r = await client.command({ count: "c", $db: DB });
      expect(r.n).toBe(3);
    });

    it("count with query", async () => {
      const r = await client.command({ count: "c", query: { cat: "x" }, $db: DB });
      expect(r.n).toBe(2);
    });

    it("distinct values", async () => {
      const r = await client.command({ distinct: "c", key: "cat", $db: DB });
      expect(r.values.sort()).toEqual(["x", "y"]);
    });

    it("distinct with query", async () => {
      const r = await client.command({ distinct: "c", key: "v", query: { cat: "x" }, $db: DB });
      expect(r.values.sort()).toEqual([1, 2]);
    });
  });

  // ============ Aggregation ============
  describe("Aggregation", () => {
    beforeEach(async () => {
      await client.command({
        insert: "sales",
        documents: [
          { _id: 1, item: "a", qty: 2, price: 10 },
          { _id: 2, item: "b", qty: 1, price: 20 },
          { _id: 3, item: "a", qty: 5, price: 10 },
          { _id: 4, item: "c", qty: 3, price: 5 },
        ],
        $db: DB,
      });
    });

    it("$match stage", async () => {
      const r = await client.command({
        aggregate: "sales",
        pipeline: [{ $match: { item: "a" } }],
        cursor: {},
        $db: DB,
      });
      expect(r.cursor.firstBatch.length).toBe(2);
    });

    it("$group with $sum", async () => {
      const r = await client.command({
        aggregate: "sales",
        pipeline: [{ $group: { _id: "$item", total: { $sum: "$qty" } } }],
        cursor: {},
        $db: DB,
      });
      const byItem: Record<string, number> = {};
      for (const d of r.cursor.firstBatch) byItem[d._id] = d.total;
      expect(byItem.a).toBe(7);
      expect(byItem.b).toBe(1);
      expect(byItem.c).toBe(3);
    });

    it("$group with $avg and count", async () => {
      const r = await client.command({
        aggregate: "sales",
        pipeline: [{ $group: { _id: null, avgQty: { $avg: "$qty" }, count: { $sum: 1 } } }],
        cursor: {},
        $db: DB,
      });
      expect(r.cursor.firstBatch[0].count).toBe(4);
      expect(r.cursor.firstBatch[0].avgQty).toBeCloseTo(2.75);
    });

    it("$sort + $limit", async () => {
      const r = await client.command({
        aggregate: "sales",
        pipeline: [{ $sort: { qty: -1 } }, { $limit: 2 }],
        cursor: {},
        $db: DB,
      });
      expect(r.cursor.firstBatch.map((d: any) => d._id)).toEqual([3, 4]);
    });

    it("$project with computed field", async () => {
      const r = await client.command({
        aggregate: "sales",
        pipeline: [
          { $match: { _id: 1 } },
          { $project: { item: 1, revenue: { $multiply: ["$qty", "$price"] } } },
        ],
        cursor: {},
        $db: DB,
      });
      expect(r.cursor.firstBatch[0].revenue).toBe(20);
    });

    it("$count stage", async () => {
      const r = await client.command({
        aggregate: "sales",
        pipeline: [{ $match: { item: "a" } }, { $count: "total" }],
        cursor: {},
        $db: DB,
      });
      expect(r.cursor.firstBatch[0].total).toBe(2);
    });

    it("$unwind stage", async () => {
      await client.command({
        insert: "tagged",
        documents: [{ _id: 1, tags: ["p", "q", "r"] }],
        $db: DB,
      });
      const r = await client.command({
        aggregate: "tagged",
        pipeline: [{ $unwind: "$tags" }],
        cursor: {},
        $db: DB,
      });
      expect(r.cursor.firstBatch.length).toBe(3);
      expect(r.cursor.firstBatch.map((d: any) => d.tags)).toEqual(["p", "q", "r"]);
    });
  });

  // ============ Collection / DB admin ============
  describe("Collection & DB admin", () => {
    it("create + listCollections", async () => {
      await client.command({ create: "newcoll", $db: DB });
      const r = await client.command({ listCollections: 1, $db: DB });
      const names = r.cursor.firstBatch.map((c: any) => c.name);
      expect(names).toContain("newcoll");
    });

    it("drop collection", async () => {
      await client.command({ insert: "todrop", documents: [{ a: 1 }], $db: DB });
      const r = await client.command({ drop: "todrop", $db: DB });
      expect(r.ok).toBe(1);
      const list = await client.command({ listCollections: 1, $db: DB });
      expect(list.cursor.firstBatch.map((c: any) => c.name)).not.toContain("todrop");
    });

    it("drop missing collection returns NamespaceNotFound", async () => {
      const r = await client.command({ drop: "neverexisted", $db: DB });
      expect(r.ok).toBe(0);
      expect(r.code).toBe(26);
      expect(r.codeName).toBe("NamespaceNotFound");
    });

    it("renameCollection on missing source returns NamespaceNotFound", async () => {
      const r = await client.command({
        renameCollection: `${DB}.nope`,
        to: `${DB}.whatever`,
        $db: "admin",
      });
      expect(r.ok).toBe(0);
      expect(r.code).toBe(26);
      expect(r.codeName).toBe("NamespaceNotFound");
    });

    it("renameCollection onto existing target returns NamespaceExists", async () => {
      await client.command({ insert: "src", documents: [{ a: 1 }], $db: DB });
      await client.command({ insert: "dst", documents: [{ b: 2 }], $db: DB });
      const r = await client.command({
        renameCollection: `${DB}.src`,
        to: `${DB}.dst`,
        $db: "admin",
      });
      expect(r.ok).toBe(0);
      expect(r.code).toBe(48);
      expect(r.codeName).toBe("NamespaceExists");
    });

    it("listDatabases", async () => {
      await client.command({ insert: "x", documents: [{ a: 1 }], $db: DB });
      const r = await client.command({ listDatabases: 1, $db: "admin" });
      expect(r.ok).toBe(1);
      expect(r.databases.some((d: any) => d.name === DB)).toBe(true);
    });

    it("dropDatabase", async () => {
      await client.command({ insert: "x", documents: [{ a: 1 }], $db: "tempdb" });
      const r = await client.command({ dropDatabase: 1, $db: "tempdb" });
      expect(r.ok).toBe(1);
      expect(server.databases.has("tempdb")).toBe(false);
    });

    it("renameCollection", async () => {
      await client.command({ insert: "old", documents: [{ a: 1 }], $db: DB });
      const r = await client.command({
        renameCollection: `${DB}.old`,
        to: `${DB}.renamed`,
        $db: "admin",
      });
      expect(r.ok).toBe(1);
      expect(server.getCollection(DB, "renamed", false)?.docs.length).toBe(1);
      expect(server.getCollection(DB, "old", false)).toBeNull();
    });

    it("collStats", async () => {
      await client.command({ insert: "stats", documents: [{ a: 1 }, { a: 2 }], $db: DB });
      const r = await client.command({ collStats: "stats", $db: DB });
      expect(r.ok).toBe(1);
      expect(r.count).toBe(2);
    });

    it("dbStats", async () => {
      await client.command({ insert: "s", documents: [{ a: 1 }], $db: DB });
      const r = await client.command({ dbStats: 1, $db: DB });
      expect(r.ok).toBe(1);
      expect(r.objects).toBeGreaterThanOrEqual(1);
    });
  });

  // ============ Indexes ============
  describe("Indexes", () => {
    it("createIndexes + listIndexes", async () => {
      await client.command({ insert: "idx", documents: [{ a: 1 }], $db: DB });
      const c = await client.command({
        createIndexes: "idx",
        indexes: [{ key: { a: 1 }, name: "a_1" }],
        $db: DB,
      });
      expect(c.ok).toBe(1);
      expect(c.numIndexesAfter).toBe(2);
      const r = await client.command({ listIndexes: "idx", $db: DB });
      const names = r.cursor.firstBatch.map((i: any) => i.name);
      expect(names).toContain("_id_");
      expect(names).toContain("a_1");
    });

    it("dropIndexes", async () => {
      await client.command({ insert: "idx2", documents: [{ a: 1 }], $db: DB });
      await client.command({ createIndexes: "idx2", indexes: [{ key: { a: 1 }, name: "a_1" }], $db: DB });
      const r = await client.command({ dropIndexes: "idx2", index: "a_1", $db: DB });
      expect(r.ok).toBe(1);
      const list = await client.command({ listIndexes: "idx2", $db: DB });
      expect(list.cursor.firstBatch.map((i: any) => i.name)).not.toContain("a_1");
    });

    it("dropIndexes on missing collection returns NamespaceNotFound", async () => {
      const r = await client.command({ dropIndexes: "neverexisted", index: "x_1", $db: DB });
      expect(r.ok).toBe(0);
      expect(r.code).toBe(26);
      expect(r.codeName).toBe("NamespaceNotFound");
    });

    it("listIndexes on missing collection returns NamespaceNotFound", async () => {
      const r = await client.command({ listIndexes: "neverexisted", $db: DB });
      expect(r.ok).toBe(0);
      expect(r.code).toBe(26);
      expect(r.codeName).toBe("NamespaceNotFound");
    });
  });

  // ============ BSON round-trip types ============
  describe("BSON types", () => {
    it("round-trips ObjectId, Date, Long, Binary, nested docs, arrays", async () => {
      const oid = new ObjectId();
      const date = new Date("2024-01-15T10:00:00.000Z");
      await client.command({
        insert: "types",
        documents: [
          {
            _id: oid,
            d: date,
            big: new Long(9007199254740993n),
            bin: new Binary(Buffer.from("hello"), 0),
            nested: { a: { b: 1 } },
            arr: [1, "two", true, null],
            flt: 3.14,
            bool: false,
          },
        ],
        $db: DB,
      });
      const r = await client.command({ find: "types", filter: {}, $db: DB });
      const doc = r.cursor.firstBatch[0];
      expect(doc._id).toBeInstanceOf(ObjectId);
      expect(doc._id.toHexString()).toBe(oid.toHexString());
      expect(doc.d).toBeInstanceOf(Date);
      expect(doc.d.getTime()).toBe(date.getTime());
      expect(doc.big).toBeInstanceOf(Long);
      expect(doc.big.toString()).toBe("9007199254740993");
      expect(doc.bin).toBeInstanceOf(Binary);
      expect(doc.bin.buffer.toString()).toBe("hello");
      expect(doc.nested.a.b).toBe(1);
      expect(doc.arr).toEqual([1, "two", true, null]);
      expect(doc.flt).toBeCloseTo(3.14);
      expect(doc.bool).toBe(false);
    });

    it("ObjectId.isValid and equality", () => {
      const a = new ObjectId();
      const b = new ObjectId(a.toHexString());
      expect(a.equals(b)).toBe(true);
      expect(ObjectId.isValid(a.toHexString())).toBe(true);
      expect(ObjectId.isValid("nope")).toBe(false);
    });

    it("queries by ObjectId", async () => {
      const oid = new ObjectId();
      await client.command({ insert: "byid", documents: [{ _id: oid, v: 1 }], $db: DB });
      const r = await client.command({ find: "byid", filter: { _id: oid }, $db: DB });
      expect(r.cursor.firstBatch.length).toBe(1);
      expect(r.cursor.firstBatch[0].v).toBe(1);
    });
  });

  // ============ Direct BSON encode/decode unit checks ============
  describe("BSON encode/decode", () => {
    it("encodes and decodes a simple doc", () => {
      const doc = { name: "parlel", n: 42, ok: true };
      const buf = encodeBSON(doc);
      const back = decodeBSON(buf);
      expect(back.name).toBe("parlel");
      expect(back.n).toBe(42);
      expect(back.ok).toBe(true);
    });

    it("first 4 bytes are the document length", () => {
      const buf = encodeBSON({ a: 1 });
      expect(buf.readInt32LE(0)).toBe(buf.length);
    });
  });
});
