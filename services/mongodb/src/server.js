// Lightweight, dependency-free fake of the mongodb service for parlel-pool.
// Speaks the MongoDB wire protocol (OP_MSG + BSON) so the official `mongodb`
// driver can connect with zero cost and zero side effects.

import { createServer } from "node:net";
import {
  MessageFramer, encodeOpMsg, encodeOpReply, OP_MSG, OP_QUERY,
} from "./wire.js";
import { ObjectId } from "./bson.js";
import {
  matchDocument, applyProjection, applySort, applyUpdate, deepClone, getPath,
} from "./query.js";
import { runPipeline } from "./aggregate.js";

const OK = { ok: 1 };

// Canonical code → codeName map (subset the emulator can produce).
// Real MongoDB always returns codeName alongside code for command errors.
// Source: https://www.mongodb.com/docs/manual/reference/error-codes/
const CODE_NAMES = {
  1: "InternalError",
  2: "BadValue",
  26: "NamespaceNotFound",
  43: "CursorNotFound",
  48: "NamespaceExists",
  59: "CommandNotFound",
  11000: "DuplicateKey",
};

// Build a command-level error reply with a real codeName.
function err(code, errmsg) {
  return { ok: 0, errmsg, code, codeName: CODE_NAMES[code] || "Location" + code };
}

export class MongodbServer {
  constructor(port = 27017, options = {}) {
    this.port = port;
    this.options = options;
    this.server = null;
    // databases: Map<dbName, Map<collName, { docs: [], indexes: [] }>>
    this.databases = new Map();
    this.cursors = new Map();
    this.cursorCounter = 1;
    this.sockets = new Set();
  }

  // ---- lifecycle ----

  start() {
    return new Promise((resolve) => {
      this.server = createServer((socket) => {
        this.sockets.add(socket);
        const framer = new MessageFramer();
        socket.on("data", (data) => {
          let messages;
          try {
            messages = framer.feed(data);
          } catch {
            return;
          }
          for (const msg of messages) {
            const response = this.handleMessage(msg);
            if (response) socket.write(response);
          }
        });
        socket.on("error", () => {});
        socket.on("close", () => this.sockets.delete(socket));
      });
      this.server.listen(this.port, () => resolve());
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const s of this.sockets) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      this.sockets.clear();
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  // Resets all in-memory state. Ephemeral by design.
  reset() {
    this.databases.clear();
    this.cursors.clear();
    this.cursorCounter = 1;
  }

  // ---- storage helpers ----

  getDb(name) {
    if (!this.databases.has(name)) this.databases.set(name, new Map());
    return this.databases.get(name);
  }

  getCollection(dbName, collName, create = true) {
    const db = this.getDb(dbName);
    if (!db.has(collName)) {
      if (!create) return null;
      db.set(collName, { docs: [], indexes: [{ name: "_id_", key: { _id: 1 }, unique: true }] });
    }
    return db.get(collName);
  }

  // ---- message dispatch ----

  handleMessage(msg) {
    if (msg.unsupported) {
      return encodeOpMsg(msg.requestID, err(59, "unsupported opcode"));
    }

    const command = msg.body || {};
    // Merge document sequences (OP_MSG kind 1) back into the command.
    if (msg.sequences) {
      for (const [key, docs] of Object.entries(msg.sequences)) {
        command[key] = docs;
      }
    }

    const cmdName = Object.keys(command)[0];
    const dbName = command.$db || (msg.fullCollectionName ? msg.fullCollectionName.split(".")[0] : "admin");

    let result;
    try {
      result = this.dispatch(cmdName, command, dbName);
    } catch (e) {
      result = err(1, e.message);
    }

    if (msg.opCode === OP_QUERY) {
      return encodeOpReply(msg.requestID, result);
    }
    return encodeOpMsg(msg.requestID, result);
  }

  dispatch(cmdName, command, dbName) {
    const name = (cmdName || "").toLowerCase();
    switch (name) {
      // --- handshake / connection ---
      case "ismaster":
      case "hello":
        return this.cmdHello();
      case "ping":
        return OK;
      case "hostinfo":
        return { ...OK, system: { hostname: "parlel-mongodb", numCores: 1 }, os: { type: "Linux" } };
      case "buildinfo":
        return this.cmdBuildInfo();
      case "getparameter":
        return { ...OK, featureCompatibilityVersion: { version: "7.0" } };
      case "whatsmyuri":
        return { ...OK, you: "127.0.0.1:0" };
      case "connectionstatus":
        return { ...OK, authInfo: { authenticatedUsers: [], authenticatedUserRoles: [] } };
      case "saslstart":
      case "saslcontinue":
      case "authenticate":
      case "logout":
        return { ...OK, done: true, conversationId: 1, payload: Buffer.alloc(0) };
      case "getlog":
        return { ...OK, totalLinesWritten: 0, log: [] };
      case "endsessions":
      case "refreshsessions":
        return OK;
      case "killcursors":
        return this.cmdKillCursors(command);
      case "killallsessions":
      case "killallsessionsbypattern":
        return OK;

      // --- writes ---
      case "insert":
        return this.cmdInsert(command, dbName);
      case "update":
        return this.cmdUpdate(command, dbName);
      case "delete":
        return this.cmdDelete(command, dbName);
      case "findandmodify":
        return this.cmdFindAndModify(command, dbName);

      // --- reads ---
      case "find":
        return this.cmdFind(command, dbName);
      case "getmore":
        return this.cmdGetMore(command, dbName);
      case "count":
        return this.cmdCount(command, dbName);
      case "distinct":
        return this.cmdDistinct(command, dbName);
      case "aggregate":
        return this.cmdAggregate(command, dbName);

      // --- collection / db admin ---
      case "create":
        return this.cmdCreate(command, dbName);
      case "drop":
        return this.cmdDrop(command, dbName);
      case "dropdatabase":
        return this.cmdDropDatabase(dbName);
      case "listcollections":
        return this.cmdListCollections(command, dbName);
      case "listdatabases":
        return this.cmdListDatabases();
      case "listindexes":
        return this.cmdListIndexes(command, dbName);
      case "createindexes":
        return this.cmdCreateIndexes(command, dbName);
      case "dropindexes":
        return this.cmdDropIndexes(command, dbName);
      case "renamecollection":
        return this.cmdRenameCollection(command);
      case "collstats":
      case "collstat":
        return this.cmdCollStats(command, dbName);
      case "dbstats":
        return this.cmdDbStats(dbName);
      case "count_documents":
        return this.cmdCount(command, dbName);
      case "validate":
        return { ...OK, valid: true, ns: `${dbName}.${command.validate}` };
      case "serverstatus":
        return this.cmdServerStatus();
      case "serverinfo":
        return this.cmdBuildInfo();
      case "geterror":
      case "getlasterror":
        return { ...OK, err: null, n: 0 };
      case "reseterror":
        return OK;
      case "explain":
        return this.cmdExplain(command, dbName);

      default:
        return err(59, `no such command: '${cmdName}'`);
    }
  }

  // ---- handshake commands ----

  cmdHello() {
    return {
      ...OK,
      ismaster: true,
      isWritablePrimary: true,
      maxBsonObjectSize: 16777216,
      maxMessageSizeBytes: 48000000,
      maxWriteBatchSize: 100000,
      localTime: new Date(),
      logicalSessionTimeoutMinutes: 30,
      connectionId: 1,
      minWireVersion: 0,
      maxWireVersion: 21,
      readOnly: false,
      helloOk: true,
    };
  }

  cmdBuildInfo() {
    return {
      ...OK,
      version: "7.0.0",
      gitVersion: "parlel-fake",
      versionArray: [7, 0, 0, 0],
      maxBsonObjectSize: 16777216,
      bits: 64,
      debug: false,
      storageEngines: ["parlel"],
    };
  }

  cmdServerStatus() {
    return {
      ...OK,
      host: "parlel-mongodb",
      version: "7.0.0",
      process: "mongod",
      uptime: 1,
      connections: { current: this.sockets.size, available: 1000 },
    };
  }

  // ---- write commands ----

  cmdInsert(command, dbName) {
    const coll = this.getCollection(dbName, command.insert);
    const docs = command.documents || [];
    const ordered = command.ordered !== false;
    let n = 0;
    const writeErrors = [];

    for (let i = 0; i < docs.length; i++) {
      const doc = deepClone(docs[i]);
      if (!("_id" in doc) || doc._id === undefined) doc._id = new ObjectId();
      const dup = coll.docs.find((d) => this.idEquals(d._id, doc._id));
      if (dup) {
        writeErrors.push(this.dupKeyError(i, dbName, command.insert, doc._id));
        if (ordered) break;
        continue;
      }
      coll.docs.push(doc);
      n++;
    }

    const res = { ...OK, n };
    if (writeErrors.length) res.writeErrors = writeErrors;
    return res;
  }

  cmdUpdate(command, dbName) {
    const coll = this.getCollection(dbName, command.update);
    const updates = command.updates || [];
    let nMatched = 0;
    let nModified = 0;
    const upserted = [];
    const writeErrors = [];

    for (let u = 0; u < updates.length; u++) {
      const spec = updates[u];
      const filter = spec.q || {};
      const update = spec.u || {};
      const multi = !!spec.multi;
      const upsert = !!spec.upsert;

      const matches = coll.docs.filter((d) => matchDocument(d, filter));

      if (matches.length === 0) {
        if (upsert) {
          const newDoc = this.buildUpsertDoc(filter, update);
          const dup = coll.docs.find((d) => this.idEquals(d._id, newDoc._id));
          if (dup) {
            writeErrors.push(this.dupKeyError(u, dbName, command.update, newDoc._id));
            continue;
          }
          coll.docs.push(newDoc);
          upserted.push({ index: u, _id: newDoc._id });
        }
        continue;
      }

      const targets = multi ? matches : [matches[0]];
      for (const doc of targets) {
        nMatched++;
        const before = JSON.stringify(this.plain(doc));
        applyUpdate(doc, update, false);
        if (JSON.stringify(this.plain(doc)) !== before) nModified++;
      }
    }

    const res = { ...OK, n: nMatched + upserted.length, nModified };
    if (upserted.length) res.upserted = upserted;
    if (writeErrors.length) res.writeErrors = writeErrors;
    return res;
  }

  cmdDelete(command, dbName) {
    const coll = this.getCollection(dbName, command.delete);
    const deletes = command.deletes || [];
    let n = 0;

    for (const spec of deletes) {
      const filter = spec.q || {};
      const limit = spec.limit;
      const matchIdx = [];
      for (let i = 0; i < coll.docs.length; i++) {
        if (matchDocument(coll.docs[i], filter)) matchIdx.push(i);
      }
      const toDelete = limit === 1 ? matchIdx.slice(0, 1) : matchIdx;
      for (let i = toDelete.length - 1; i >= 0; i--) {
        coll.docs.splice(toDelete[i], 1);
        n++;
      }
    }
    return { ...OK, n };
  }

  cmdFindAndModify(command, dbName) {
    const coll = this.getCollection(dbName, command.findAndModify || command.findandmodify);
    const filter = command.query || {};
    const sort = command.sort;
    const remove = !!command.remove;
    const update = command.update;
    const upsert = !!command.upsert;
    const returnNew = !!command.new;
    const fields = command.fields;

    let candidates = coll.docs.filter((d) => matchDocument(d, filter));
    if (sort) candidates = applySort(candidates, sort);
    let target = candidates[0];

    let value = null;

    if (remove) {
      if (target) {
        value = deepClone(target);
        const idx = coll.docs.indexOf(target);
        coll.docs.splice(idx, 1);
      }
    } else if (target) {
      const before = returnNew ? null : deepClone(target);
      applyUpdate(target, update, false);
      value = returnNew ? deepClone(target) : before;
    } else if (upsert) {
      const newDoc = this.buildUpsertDoc(filter, update);
      coll.docs.push(newDoc);
      value = returnNew ? deepClone(newDoc) : null;
    }

    if (value && fields) value = applyProjection(value, fields);

    return {
      ...OK,
      value,
      lastErrorObject: {
        n: target || (upsert && value) ? 1 : 0,
        updatedExisting: !!target && !remove,
      },
    };
  }

  // ---- read commands ----

  cmdFind(command, dbName) {
    const coll = this.getCollection(dbName, command.find, false);
    const ns = `${dbName}.${command.find}`;
    let docs = coll ? coll.docs.slice() : [];

    if (command.filter) docs = docs.filter((d) => matchDocument(d, command.filter));
    if (command.sort) docs = applySort(docs, command.sort);
    if (command.skip) docs = docs.slice(command.skip);
    if (command.limit && command.limit > 0) docs = docs.slice(0, command.limit);

    let projected = docs.map((d) => deepClone(d));
    if (command.projection) projected = projected.map((d) => applyProjection(d, command.projection));

    const batchSize = command.batchSize != null ? command.batchSize : 101;
    return this.makeCursorReply(ns, projected, batchSize, "firstBatch");
  }

  cmdGetMore(command, dbName) {
    const cursorId = command.getMore;
    const ns = `${dbName}.${command.collection}`;
    const cursor = this.cursors.get(String(cursorId));
    if (!cursor) {
      return err(43, `cursor id ${cursorId} not found`);
    }
    const batchSize = command.batchSize != null ? command.batchSize : cursor.remaining.length;
    const batch = cursor.remaining.splice(0, batchSize);
    const id = cursor.remaining.length > 0 ? cursorId : 0;
    if (id === 0) this.cursors.delete(String(cursorId));
    return {
      ...OK,
      cursor: { id: id === 0 ? 0n : BigInt(cursorId), ns, nextBatch: batch },
    };
  }

  makeCursorReply(ns, docs, batchSize, batchField) {
    const effectiveBatch = batchSize === 0 ? docs.length : batchSize;
    const firstBatch = docs.slice(0, effectiveBatch);
    const remaining = docs.slice(effectiveBatch);
    let cursorId = 0n;
    if (remaining.length > 0) {
      const id = this.cursorCounter++;
      this.cursors.set(String(id), { remaining, ns });
      cursorId = BigInt(id);
    }
    return { ...OK, cursor: { id: cursorId, ns, [batchField]: firstBatch } };
  }

  cmdKillCursors(command) {
    const ids = command.cursors || [];
    const killed = [];
    for (const id of ids) {
      this.cursors.delete(String(typeof id === "bigint" ? id : id));
      killed.push(id);
    }
    return { ...OK, cursorsKilled: killed, cursorsNotFound: [], cursorsAlive: [], cursorsUnknown: [] };
  }

  cmdCount(command, dbName) {
    const coll = this.getCollection(dbName, command.count, false);
    let docs = coll ? coll.docs.slice() : [];
    if (command.query) docs = docs.filter((d) => matchDocument(d, command.query));
    if (command.skip) docs = docs.slice(command.skip);
    if (command.limit) docs = docs.slice(0, command.limit);
    return { ...OK, n: docs.length };
  }

  cmdDistinct(command, dbName) {
    const coll = this.getCollection(dbName, command.distinct, false);
    let docs = coll ? coll.docs.slice() : [];
    if (command.query) docs = docs.filter((d) => matchDocument(d, command.query));
    const seen = [];
    for (const d of docs) {
      const vals = getPath(d, command.key);
      for (const v of vals) {
        const flat = Array.isArray(v) ? v : [v];
        for (const item of flat) {
          if (!seen.some((s) => JSON.stringify(this.plain(s)) === JSON.stringify(this.plain(item)))) {
            seen.push(item);
          }
        }
      }
    }
    return { ...OK, values: seen };
  }

  cmdAggregate(command, dbName) {
    const ns = `${dbName}.${command.aggregate}`;
    const pipeline = command.pipeline || [];
    const coll = this.getCollection(dbName, command.aggregate, false);
    const source = coll ? coll.docs : [];
    const result = runPipeline(source, pipeline);
    const batchSize = command.cursor && command.cursor.batchSize != null ? command.cursor.batchSize : 101;
    return this.makeCursorReply(ns, result, batchSize, "firstBatch");
  }

  cmdExplain(command, dbName) {
    const inner = command.explain;
    const innerName = Object.keys(inner)[0];
    return {
      ...OK,
      queryPlanner: {
        namespace: `${dbName}.${inner[innerName]}`,
        winningPlan: { stage: "COLLSCAN" },
      },
      executionStats: { nReturned: 0, executionTimeMillis: 0 },
    };
  }

  // ---- admin commands ----

  cmdCreate(command, dbName) {
    this.getCollection(dbName, command.create, true);
    return OK;
  }

  cmdDrop(command, dbName) {
    const db = this.getDb(dbName);
    const existed = db.delete(command.drop);
    if (!existed) return err(26, "ns not found");
    return { ...OK, nIndexesWas: 1, ns: `${dbName}.${command.drop}` };
  }

  cmdDropDatabase(dbName) {
    this.databases.delete(dbName);
    return { ...OK, dropped: dbName };
  }

  cmdListCollections(command, dbName) {
    const db = this.getDb(dbName);
    const ns = `${dbName}.$cmd.listCollections`;
    const colls = [];
    for (const collName of db.keys()) {
      colls.push({
        name: collName,
        type: "collection",
        options: {},
        info: { readOnly: false },
        idIndex: { key: { _id: 1 }, name: "_id_" },
      });
    }
    let filtered = colls;
    if (command.filter && command.filter.name) {
      filtered = colls.filter((c) => c.name === command.filter.name);
    }
    return this.makeCursorReply(ns, filtered, 0, "firstBatch");
  }

  cmdListDatabases() {
    const databases = [];
    for (const [name, db] of this.databases.entries()) {
      let sizeOnDisk = 0;
      for (const coll of db.values()) sizeOnDisk += coll.docs.length * 64;
      databases.push({ name, sizeOnDisk, empty: db.size === 0 });
    }
    const totalSize = databases.reduce((s, d) => s + d.sizeOnDisk, 0);
    return { ...OK, databases, totalSize, totalSizeMb: Math.ceil(totalSize / 1048576) };
  }

  cmdListIndexes(command, dbName) {
    const coll = this.getCollection(dbName, command.listIndexes, false);
    const ns = `${dbName}.${command.listIndexes}`;
    if (!coll) {
      return err(26, "ns does not exist");
    }
    const indexes = coll.indexes.map((idx) => ({ v: 2, key: idx.key, name: idx.name, ...(idx.unique ? { unique: true } : {}) }));
    return this.makeCursorReply(ns, indexes, 0, "firstBatch");
  }

  cmdCreateIndexes(command, dbName) {
    const coll = this.getCollection(dbName, command.createIndexes, true);
    const before = coll.indexes.length;
    for (const spec of command.indexes || []) {
      const name = spec.name || Object.keys(spec.key).map((k) => `${k}_${spec.key[k]}`).join("_");
      if (!coll.indexes.some((i) => i.name === name)) {
        coll.indexes.push({ name, key: spec.key, unique: !!spec.unique });
      }
    }
    return {
      ...OK,
      createdCollectionAutomatically: false,
      numIndexesBefore: before,
      numIndexesAfter: coll.indexes.length,
    };
  }

  cmdDropIndexes(command, dbName) {
    const coll = this.getCollection(dbName, command.dropIndexes, false);
    if (!coll) return err(26, "ns not found");
    const before = coll.indexes.length;
    if (command.index === "*") {
      coll.indexes = coll.indexes.filter((i) => i.name === "_id_");
    } else {
      coll.indexes = coll.indexes.filter((i) => i.name !== command.index);
    }
    return { ...OK, nIndexesWas: before };
  }

  cmdRenameCollection(command) {
    const [srcDb, srcColl] = command.renameCollection.split(/\.(.*)/s);
    const [dstDb, dstColl] = command.to.split(/\.(.*)/s);
    const sourceDb = this.getDb(srcDb);
    if (!sourceDb.has(srcColl)) {
      return err(26, "source namespace does not exist");
    }
    const destDb = this.getDb(dstDb);
    if (destDb.has(dstColl) && !command.dropTarget) {
      return err(48, "target namespace exists");
    }
    destDb.set(dstColl, sourceDb.get(srcColl));
    sourceDb.delete(srcColl);
    return OK;
  }

  cmdCollStats(command, dbName) {
    const coll = this.getCollection(dbName, command.collStats, false);
    const count = coll ? coll.docs.length : 0;
    return {
      ...OK,
      ns: `${dbName}.${command.collStats}`,
      count,
      size: count * 64,
      avgObjSize: count ? 64 : 0,
      storageSize: count * 64,
      nindexes: coll ? coll.indexes.length : 0,
      totalIndexSize: 0,
    };
  }

  cmdDbStats(dbName) {
    const db = this.getDb(dbName);
    let objects = 0;
    for (const coll of db.values()) objects += coll.docs.length;
    return {
      ...OK,
      db: dbName,
      collections: db.size,
      objects,
      dataSize: objects * 64,
      storageSize: objects * 64,
      indexes: db.size,
    };
  }

  // ---- helpers ----

  buildUpsertDoc(filter, update) {
    const base = {};
    // Seed equality conditions from the filter.
    for (const k of Object.keys(filter)) {
      if (k.startsWith("$")) continue;
      const v = filter[k];
      if (v === null || typeof v !== "object" || v instanceof ObjectId || v instanceof Date || Array.isArray(v)) {
        base[k] = deepClone(v);
      }
    }
    const hasOperators = Object.keys(update).some((key) => key.startsWith("$"));
    if (hasOperators) {
      applyUpdate(base, update, true);
    } else {
      for (const k of Object.keys(base)) delete base[k];
      Object.assign(base, deepClone(update));
    }
    if (!("_id" in base) || base._id === undefined) base._id = new ObjectId();
    return base;
  }

  idEquals(a, b) {
    if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
    if (a instanceof ObjectId || b instanceof ObjectId) return false;
    return JSON.stringify(this.plain(a)) === JSON.stringify(this.plain(b));
  }

  idStr(id) {
    if (id instanceof ObjectId) return `ObjectId('${id.toHexString()}')`;
    return JSON.stringify(id);
  }

  // Real MongoDB (4.2+) duplicate-key write error includes keyPattern + keyValue
  // so drivers/ODMs (e.g. Mongoose's err.keyValue/err.keyPattern) can read them.
  // Source: https://www.mongodb.com/docs/manual/reference/command/insert/
  dupKeyError(index, dbName, collName, id) {
    return {
      index,
      code: 11000,
      keyPattern: { _id: 1 },
      keyValue: { _id: id },
      errmsg: `E11000 duplicate key error collection: ${dbName}.${collName} index: _id_ dup key: { _id: ${this.idStr(id)} }`,
    };
  }

  plain(v) {
    if (v instanceof ObjectId) return { $oid: v.toHexString() };
    if (v instanceof Date) return { $date: v.getTime() };
    if (Array.isArray(v)) return v.map((x) => this.plain(x));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = this.plain(v[k]);
      return out;
    }
    return v;
  }
}
