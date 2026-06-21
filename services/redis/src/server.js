import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { RESPParser, encodeSimple, encodeError, encodeInteger, encodeBulk, encodeArray } from "./resp.js";

export class RedisServer {
  constructor(port = 6379) {
    this.port = port;
    this.store = new Map();
    this.expires = new Map();
    this.subscribers = new Map();
    this.server = null;
    this.socket = null;
    // Track every open client connection so stop() can tear them down. Without
    // this, server.close() blocks indefinitely on lingering keep-alive sockets.
    this.sockets = new Set();
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer((socket) => {
        this.socket = socket;
        this.sockets.add(socket);
        const parser = new RESPParser();

        socket.on("data", (data) => {
          const commands = parser.feed(data.toString());
          for (const cmd of commands) {
            const response = this.handleCommand(cmd, socket);
            if (response !== null) {
              socket.write(response);
            }
          }
        });

        socket.on("close", () => {
          this.sockets.delete(socket);
          // Drop this connection from any channels it was subscribed to.
          for (const [channel, subs] of this.subscribers) {
            subs.delete(socket);
            if (subs.size === 0) this.subscribers.delete(channel);
          }
        });
        socket.on("error", () => {});
      });

      this.server.listen(this.port, () => {
        console.log(`Redis server running on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        // Destroy lingering client connections so close() can complete.
        for (const socket of this.sockets) {
          socket.destroy();
        }
        this.sockets.clear();
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }

  // Restore the server to a clean slate between test runs / sandbox resets.
  // The pool agent loader calls this if it exists (see src/agent/index.ts).
  reset() {
    this.store.clear();
    this.expires.clear();
    this.subscribers.clear();
  }

  handleCommand(cmd, socket) {
    if (cmd.type !== "array" || !cmd.value || cmd.value.length === 0) {
      return encodeError("invalid command");
    }

    const args = cmd.value.map((v) => v.value);
    const command = args[0].toUpperCase();

    switch (command) {
      // Connection
      case "PING":
        return args.length > 1 ? encodeBulk(args[1]) : encodeSimple("PONG");
      case "ECHO":
        return args.length > 1 ? encodeBulk(args[1]) : encodeBulk("");
      case "AUTH":
        return encodeSimple("OK");
      case "SELECT":
        return encodeSimple("OK");
      case "QUIT":
        return encodeSimple("OK");

      // String operations
      case "SET":
        return this.handleSet(args);
      case "GET":
        return this.handleGet(args);
      case "DEL":
        return this.handleDel(args);
      case "UNLINK":
        return this.handleDel(args);
      case "EXISTS":
        return this.handleExists(args);
      case "EXPIRE":
        return this.handleExpire(args);
      case "EXPIREAT":
        return this.handleExpireAt(args);
      case "PEXPIRE":
        return this.handlePexpire(args);
      case "PEXPIREAT":
        return this.handlePexpireAt(args);
      case "TTL":
        return this.handleTtl(args);
      case "PTTL":
        return this.handlePttl(args);
      case "PERSIST":
        return this.handlePersist(args);
      case "KEYS":
        return this.handleKeys(args);
      case "SCAN":
        return this.handleScan(args);
      case "TYPE":
        return this.handleType(args);
      case "RENAME":
        return this.handleRename(args);
      case "RENAMENX":
        return this.handleRenamenx(args);
      case "APPEND":
        return this.handleAppend(args);
      case "STRLEN":
        return this.handleStrlen(args);
      case "GETRANGE":
        return this.handleGetrange(args);
      case "SETRANGE":
        return this.handleSetrange(args);
      case "INCR":
        return this.handleIncr(args);
      case "DECR":
        return this.handleDecr(args);
      case "INCRBY":
        return this.handleIncrby(args);
      case "DECRBY":
        return this.handleDecrby(args);
      case "INCRBYFLOAT":
        return this.handleIncrbyfloat(args);
      case "SETNX":
        return this.handleSetnx(args);
      case "MSET":
        return this.handleMset(args);
      case "MGET":
        return this.handleMget(args);
      case "MSETNX":
        return this.handleMsetnx(args);
      case "GETSET":
        return this.handleGetset(args);
      case "GETDEL":
        return this.handleGetdel(args);

      // List operations
      case "LPUSH":
        return this.handleLpush(args);
      case "RPUSH":
        return this.handleRpush(args);
      case "LPOP":
        return this.handleLpop(args);
      case "RPOP":
        return this.handleRpop(args);
      case "LLEN":
        return this.handleLlen(args);
      case "LINDEX":
        return this.handleLindex(args);
      case "LSET":
        return this.handleLset(args);
      case "LRANGE":
        return this.handleLrange(args);
      case "LREM":
        return this.handleLrem(args);
      case "LINSERT":
        return this.handleLinsert(args);
      case "LPOS":
        return this.handleLpos(args);
      case "LMOVE":
        return this.handleLmove(args);

      // Set operations
      case "SADD":
        return this.handleSadd(args);
      case "SREM":
        return this.handleSrem(args);
      case "SMEMBERS":
        return this.handleSmembers(args);
      case "SISMEMBER":
        return this.handleSismember(args);
      case "SCARD":
        return this.handleScard(args);
      case "SUNION":
        return this.handleSunion(args);
      case "SINTER":
        return this.handleSinter(args);
      case "SDIFF":
        return this.handleSdiff(args);
      case "SRANDMEMBER":
        return this.handleSrandmember(args);
      case "SPOP":
        return this.handleSpop(args);

      // Sorted set operations
      case "ZADD":
        return this.handleZadd(args);
      case "ZREM":
        return this.handleZrem(args);
      case "ZRANGE":
        return this.handleZrange(args);
      case "ZREVRANGE":
        return this.handleZrevrange(args);
      case "ZRANGEBYSCORE":
        return this.handleZrangebyscore(args);
      case "ZSCORE":
        return this.handleZscore(args);
      case "ZCARD":
        return this.handleZcard(args);
      case "ZINCRBY":
        return this.handleZincrby(args);
      case "ZRANK":
        return this.handleZrank(args);
      case "ZREVRANK":
        return this.handleZrevrank(args);

      // Hash operations
      case "HSET":
        return this.handleHset(args);
      case "HGET":
        return this.handleHget(args);
      case "HGETALL":
        return this.handleHgetall(args);
      case "HMSET":
        return this.handleHmset(args);
      case "HMGET":
        return this.handleHmget(args);
      case "HDEL":
        return this.handleHdel(args);
      case "HEXISTS":
        return this.handleHexists(args);
      case "HLEN":
        return this.handleHlen(args);
      case "HINCRBY":
        return this.handleHincrby(args);
      case "HINCRBYFLOAT":
        return this.handleHincrbyfloat(args);
      case "HKEYS":
        return this.handleHkeys(args);
      case "HVALS":
        return this.handleHvals(args);
      case "HSETNX":
        return this.handleHsetnx(args);

      // Pub/Sub
      case "PUBLISH":
        return this.handlePublish(args);
      case "SUBSCRIBE":
        return this.handleSubscribe(args, socket);
      case "UNSUBSCRIBE":
        return this.handleUnsubscribe(args, socket);

      // Server
      case "FLUSHDB":
        this.store.clear();
        this.expires.clear();
        return encodeSimple("OK");
      case "FLUSHALL":
        this.store.clear();
        this.expires.clear();
        return encodeSimple("OK");
      case "DBSIZE":
        return encodeInteger(this.store.size);
      case "INFO":
        return encodeBulk(this.getInfo());
      case "COMMAND":
        return encodeArray([]);
      case "TIME":
        return this.handleTime();
      case "RANDOMKEY":
        return this.handleRandomkey();
      case "COPY":
        return this.handleCopy(args);

      // Client management
      case "CLIENT":
        return this.handleClient(args);

      // HELLO (RESP3)
      case "HELLO":
        return this.handleHello(args);

      // ACL
      case "ACL":
        return this.handleAcl(args);

      // MEMORY
      case "MEMORY":
        return this.handleMemory(args);

      // LATENCY
      case "LATENCY":
        return this.handleLatency(args);

      // MODULE
      case "MODULE":
        return this.handleModule(args);

      // SWAPDB
      case "SWAPDB":
        return encodeSimple("OK");

      // WAIT
      case "WAIT":
        return encodeInteger(0);

      // LASTSAVE
      case "LASTSAVE":
        return encodeInteger(Math.floor(Date.now() / 1000));

      // SAVE
      case "SAVE":
        return encodeSimple("OK");

      // BGSAVE
      case "BGSAVE":
        return encodeSimple("Background saving started");

      // BGREWRITEAOF
      case "BGREWRITEAOF":
        return encodeSimple("Background append only file rewriting started");

      // SLAVEOF
      case "SLAVEOF":
        return encodeSimple("OK");

      // REPLICAOF
      case "REPLICAOF":
        return encodeSimple("OK");

      // MONITOR
      case "MONITOR":
        return encodeSimple("OK");

      // SLOWLOG
      case "SLOWLOG":
        return encodeArray([]);

      // OBJECT HELP
      case "OBJECT":
        return this.handleObject(args);

      // DEBUG
      case "DEBUG":
        return this.handleDebug(args);

      // List operations (blocking)
      case "BLPOP":
        return this.handleBlpop(args);
      case "BRPOP":
        return this.handleBrpop(args);

      // Object operations
      case "OBJECT":
        return this.handleObject(args);

      // Sort
      case "SORT":
        return this.handleSort(args);

      // HyperLogLog
      case "PFADD":
        return this.handlePfadd(args);
      case "PFCOUNT":
        return this.handlePfcount(args);
      case "PFMERGE":
        return this.handlePfmerge(args);

      // Bitmap
      case "SETBIT":
        return this.handleSetbit(args);
      case "GETBIT":
        return this.handleGetbit(args);
      case "BITCOUNT":
        return this.handleBitcount(args);
      case "BITOP":
        return this.handleBitop(args);
      case "BITPOS":
        return this.handleBitpos(args);

      // Stream
      case "XADD":
        return this.handleXadd(args);
      case "XLEN":
        return this.handleXlen(args);
      case "XRANGE":
        return this.handleXrange(args);
      case "XREVRANGE":
        return this.handleXrevrange(args);
      case "XREAD":
        return this.handleXread(args);
      case "XDEL":
        return this.handleXdel(args);

      // Geo
      case "GEOADD":
        return this.handleGeoadd(args);
      case "GEOPOS":
        return this.handleGeopos(args);
      case "GEODIST":
        return this.handleGeodist(args);
      case "GEORADIUS":
        return this.handleGeoradius(args);

      // Script
      case "EVAL":
        return this.handleEval(args);
      case "EVALSHA":
        return this.handleEvalsha(args);

      // Transaction
      case "MULTI":
        return encodeSimple("OK");
      case "EXEC":
        return encodeArray([]);
      case "DISCARD":
        return encodeSimple("OK");
      case "WATCH":
        return encodeSimple("OK");
      case "UNWATCH":
        return encodeSimple("OK");

      // Cluster
      case "CLUSTER":
        return encodeArray([]);

      // Config
      case "CONFIG":
        return encodeArray([]);

      // Debug
      case "DEBUG":
        return encodeSimple("OK");

      // Shutdown
      case "SHUTDOWN":
        return encodeSimple("OK");

      // Wait
      case "WAIT":
        return encodeInteger(0);

      // Dump/Restore
      case "DUMP":
        return encodeBulk(null);
      case "RESTORE":
        return encodeSimple("OK");

      // Migrate
      case "MIGRATE":
        return encodeSimple("OK");

      // Scan
      case "SSCAN":
        return this.handleSscan(args);
      case "HSCAN":
        return this.handleHscan(args);
      case "ZSCAN":
        return this.handleZscan(args);

      default:
        return encodeError(`unknown command '${command}'`);
    }
  }

  // String operations
  handleSet(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'SET' command");

    const key = args[1];
    const value = args[2];
    let ttl = null;
    let nx = false;
    let xx = false;

    for (let i = 3; i < args.length; i++) {
      const opt = args[i].toUpperCase();
      if (opt === "EX" && i + 1 < args.length) {
        ttl = parseInt(args[++i]) * 1000;
      } else if (opt === "PX" && i + 1 < args.length) {
        ttl = parseInt(args[++i]);
      } else if (opt === "EXAT" && i + 1 < args.length) {
        ttl = (parseInt(args[++i]) * 1000) - Date.now();
      } else if (opt === "PXAT" && i + 1 < args.length) {
        ttl = parseInt(args[++i]) - Date.now();
      } else if (opt === "NX") {
        nx = true;
      } else if (opt === "XX") {
        xx = true;
      }
    }

    if (nx && this.store.has(key)) return encodeBulk(null);
    if (xx && !this.store.has(key)) return encodeBulk(null);

    this.store.set(key, { type: "string", value });
    this.expires.delete(key);

    if (ttl && ttl > 0) {
      this.expires.set(key, Date.now() + ttl);
      setTimeout(() => {
        if (this.expires.get(key) <= Date.now()) {
          this.store.delete(key);
          this.expires.delete(key);
        }
      }, ttl);
    }

    return encodeSimple("OK");
  }

  handleGet(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'GET' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);

    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeBulk(entry.value);
  }

  handleDel(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'DEL' command");

    let count = 0;
    for (let i = 1; i < args.length; i++) {
      if (this.store.delete(args[i])) {
        this.expires.delete(args[i]);
        count++;
      }
    }
    return encodeInteger(count);
  }

  handleExists(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'EXISTS' command");

    let count = 0;
    for (let i = 1; i < args.length; i++) {
      this.cleanupExpired(args[i]);
      if (this.store.has(args[i])) count++;
    }
    return encodeInteger(count);
  }

  handleExpire(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'EXPIRE' command");

    const key = args[1];
    const seconds = parseInt(args[2]);

    if (!this.store.has(key)) return encodeInteger(0);

    this.expires.set(key, Date.now() + seconds * 1000);
    setTimeout(() => {
      if (this.expires.get(key) <= Date.now()) {
        this.store.delete(key);
        this.expires.delete(key);
      }
    }, seconds * 1000);

    return encodeInteger(1);
  }

  handleExpireAt(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'EXPIREAT' command");

    const key = args[1];
    const timestamp = parseInt(args[2]) * 1000;

    if (!this.store.has(key)) return encodeInteger(0);

    const ttl = timestamp - Date.now();
    if (ttl <= 0) {
      this.store.delete(key);
      this.expires.delete(key);
      return encodeInteger(1);
    }

    this.expires.set(key, timestamp);
    setTimeout(() => {
      if (this.expires.get(key) <= Date.now()) {
        this.store.delete(key);
        this.expires.delete(key);
      }
    }, ttl);

    return encodeInteger(1);
  }

  handlePexpire(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'PEXPIRE' command");

    const key = args[1];
    const ms = parseInt(args[2]);

    if (!this.store.has(key)) return encodeInteger(0);

    this.expires.set(key, Date.now() + ms);
    setTimeout(() => {
      if (this.expires.get(key) <= Date.now()) {
        this.store.delete(key);
        this.expires.delete(key);
      }
    }, ms);

    return encodeInteger(1);
  }

  handlePexpireAt(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'PEXPIREAT' command");

    const key = args[1];
    const timestamp = parseInt(args[2]);

    if (!this.store.has(key)) return encodeInteger(0);

    const ttl = timestamp - Date.now();
    if (ttl <= 0) {
      this.store.delete(key);
      this.expires.delete(key);
      return encodeInteger(1);
    }

    this.expires.set(key, timestamp);
    setTimeout(() => {
      if (this.expires.get(key) <= Date.now()) {
        this.store.delete(key);
        this.expires.delete(key);
      }
    }, ttl);

    return encodeInteger(1);
  }

  handleTtl(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'TTL' command");

    const key = args[1];
    this.cleanupExpired(key);

    if (!this.store.has(key)) return encodeInteger(-2);

    const expiry = this.expires.get(key);
    if (!expiry) return encodeInteger(-1);

    return encodeInteger(Math.ceil((expiry - Date.now()) / 1000));
  }

  handlePttl(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'PTTL' command");

    const key = args[1];
    this.cleanupExpired(key);

    if (!this.store.has(key)) return encodeInteger(-2);

    const expiry = this.expires.get(key);
    if (!expiry) return encodeInteger(-1);

    return encodeInteger(expiry - Date.now());
  }

  handlePersist(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'PERSIST' command");

    const key = args[1];
    this.cleanupExpired(key);

    if (!this.store.has(key)) return encodeInteger(0);
    if (!this.expires.has(key)) return encodeInteger(0);

    this.expires.delete(key);
    return encodeInteger(1);
  }

  handleKeys(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'KEYS' command");

    const pattern = args[1];
    const keys = Array.from(this.store.keys()).filter((key) => {
      if (pattern === "*") return true;
      if (pattern.startsWith("*") && pattern.endsWith("*")) {
        return key.includes(pattern.slice(1, -1));
      }
      if (pattern.startsWith("*")) {
        return key.endsWith(pattern.slice(1));
      }
      if (pattern.endsWith("*")) {
        return key.startsWith(pattern.slice(0, -1));
      }
      return key === pattern;
    });

    return encodeArray(keys);
  }

  handleScan(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SCAN' command");

    const cursor = parseInt(args[1]) || 0;
    const count = 10;
    const keys = Array.from(this.store.keys());
    const start = cursor;
    const end = Math.min(start + count, keys.length);
    const result = keys.slice(start, end);
    const newCursor = end >= keys.length ? 0 : end;

    // SCAN returns a two-element array: [cursor, [keys...]].
    return encodeArray([String(newCursor), result]);
  }

  handleType(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'TYPE' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeSimple("none");

    return encodeSimple(entry.type);
  }

  handleRename(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'RENAME' command");

    const key = args[1];
    const newKey = args[2];

    this.cleanupExpired(key);

    if (!this.store.has(key)) return encodeError("no such key");

    const entry = this.store.get(key);
    this.store.set(newKey, entry);
    this.store.delete(key);

    if (this.expires.has(key)) {
      this.expires.set(newKey, this.expires.get(key));
      this.expires.delete(key);
    }

    return encodeSimple("OK");
  }

  handleRenamenx(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'RENAMENX' command");

    const key = args[1];
    const newKey = args[2];

    this.cleanupExpired(key);

    if (!this.store.has(key)) return encodeError("no such key");
    if (this.store.has(newKey)) return encodeInteger(0);

    const entry = this.store.get(key);
    this.store.set(newKey, entry);
    this.store.delete(key);

    if (this.expires.has(key)) {
      this.expires.set(newKey, this.expires.get(key));
      this.expires.delete(key);
    }

    return encodeInteger(1);
  }

  handleAppend(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'APPEND' command");

    const key = args[1];
    const value = args[2];

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "string", value: "" };
      this.store.set(key, entry);
    }

    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    entry.value += value;
    return encodeInteger(Buffer.byteLength(entry.value));
  }

  handleStrlen(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'STRLEN' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeInteger(Buffer.byteLength(entry.value));
  }

  handleGetrange(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'GETRANGE' command");

    const key = args[1];
    let start = parseInt(args[2]);
    let end = parseInt(args[3]);

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk("");
    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const str = entry.value;
    if (start < 0) start = str.length + start;
    if (end < 0) end = str.length + end;
    start = Math.max(0, start);
    end = Math.min(str.length - 1, end);

    if (start > end) return encodeBulk("");

    return encodeBulk(str.slice(start, end + 1));
  }

  handleSetrange(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'SETRANGE' command");

    const key = args[1];
    const offset = parseInt(args[2]);
    const value = args[3];

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "string", value: "" };
      this.store.set(key, entry);
    }

    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const str = entry.value;
    if (offset > str.length) {
      entry.value = str + "\0".repeat(offset - str.length) + value;
    } else {
      entry.value = str.slice(0, offset) + value + str.slice(offset + value.length);
    }

    return encodeInteger(Buffer.byteLength(entry.value));
  }

  handleIncr(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'INCR' command");

    const key = args[1];
    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "string", value: "0" };
      this.store.set(key, entry);
    }

    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (!isInteger(entry.value)) return encodeError("value is not an integer or out of range");
    const value = parseInt(entry.value, 10);
    entry.value = String(value + 1);
    return encodeInteger(value + 1);
  }

  handleDecr(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'DECR' command");

    const key = args[1];
    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "string", value: "0" };
      this.store.set(key, entry);
    }

    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (!isInteger(entry.value)) return encodeError("value is not an integer or out of range");
    const value = parseInt(entry.value, 10);
    entry.value = String(value - 1);
    return encodeInteger(value - 1);
  }

  handleIncrby(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'INCRBY' command");

    const key = args[1];
    if (!isInteger(args[2])) return encodeError("value is not an integer or out of range");
    const increment = parseInt(args[2], 10);

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "string", value: "0" };
      this.store.set(key, entry);
    }

    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (!isInteger(entry.value)) return encodeError("value is not an integer or out of range");
    const value = parseInt(entry.value, 10);
    entry.value = String(value + increment);
    return encodeInteger(value + increment);
  }

  handleDecrby(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'DECRBY' command");

    const key = args[1];
    if (!isInteger(args[2])) return encodeError("value is not an integer or out of range");
    const decrement = parseInt(args[2], 10);

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "string", value: "0" };
      this.store.set(key, entry);
    }

    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (!isInteger(entry.value)) return encodeError("value is not an integer or out of range");
    const value = parseInt(entry.value, 10);
    entry.value = String(value - decrement);
    return encodeInteger(value - decrement);
  }

  handleIncrbyfloat(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'INCRBYFLOAT' command");

    const key = args[1];
    const increment = parseFloat(args[2]);

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "string", value: "0" };
      this.store.set(key, entry);
    }

    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const value = parseFloat(entry.value) || 0;
    entry.value = String(value + increment);
    return encodeBulk(entry.value);
  }

  handleSetnx(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'SETNX' command");

    const key = args[1];
    const value = args[2];

    if (this.store.has(key)) return encodeInteger(0);

    this.store.set(key, { type: "string", value });
    return encodeInteger(1);
  }

  handleMset(args) {
    if (args.length < 3 || args.length % 2 === 0) return encodeError("wrong number of arguments for 'MSET' command");

    for (let i = 1; i < args.length; i += 2) {
      this.store.set(args[i], { type: "string", value: args[i + 1] });
    }
    return encodeSimple("OK");
  }

  handleMget(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'MGET' command");

    const values = [];
    for (let i = 1; i < args.length; i++) {
      this.cleanupExpired(args[i]);
      const entry = this.store.get(args[i]);
      values.push(entry && entry.type === "string" ? entry.value : null);
    }
    return encodeArray(values.map(v => v === null ? null : v));
  }

  handleMsetnx(args) {
    if (args.length < 3 || args.length % 2 === 0) return encodeError("wrong number of arguments for 'MSETNX' command");

    // Check if any key exists
    for (let i = 1; i < args.length; i += 2) {
      if (this.store.has(args[i])) return encodeInteger(0);
    }

    for (let i = 1; i < args.length; i += 2) {
      this.store.set(args[i], { type: "string", value: args[i + 1] });
    }
    return encodeInteger(1);
  }

  handleGetset(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'GETSET' command");

    const key = args[1];
    const value = args[2];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    const oldValue = entry && entry.type === "string" ? entry.value : null;

    this.store.set(key, { type: "string", value });
    this.expires.delete(key);

    return encodeBulk(oldValue);
  }

  handleGetdel(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'GETDEL' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "string") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const value = entry.value;
    this.store.delete(key);
    this.expires.delete(key);

    return encodeBulk(value);
  }

  // List operations
  handleLpush(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'LPUSH' command");

    const key = args[1];
    let entry = this.store.get(key);

    if (!entry) {
      entry = { type: "list", value: [] };
      this.store.set(key, entry);
    }

    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    for (let i = 2; i < args.length; i++) {
      entry.value.unshift(args[i]);
    }
    return encodeInteger(entry.value.length);
  }

  handleRpush(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'RPUSH' command");

    const key = args[1];
    let entry = this.store.get(key);

    if (!entry) {
      entry = { type: "list", value: [] };
      this.store.set(key, entry);
    }

    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    for (let i = 2; i < args.length; i++) {
      entry.value.push(args[i]);
    }
    return encodeInteger(entry.value.length);
  }

  handleLpop(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'LPOP' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (entry.value.length === 0) return encodeBulk(null);

    const count = args.length > 2 ? parseInt(args[2]) : 1;
    if (count === 1) {
      return encodeBulk(entry.value.shift());
    }

    const items = entry.value.splice(0, count);
    return encodeArray(items);
  }

  handleRpop(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'RPOP' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (entry.value.length === 0) return encodeBulk(null);

    const count = args.length > 2 ? parseInt(args[2]) : 1;
    if (count === 1) {
      return encodeBulk(entry.value.pop());
    }

    const items = entry.value.splice(-count);
    return encodeArray(items.reverse());
  }

  handleLlen(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'LLEN' command");

    const entry = this.store.get(args[1]);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeInteger(entry.value.length);
  }

  handleLindex(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'LINDEX' command");

    const key = args[1];
    let index = parseInt(args[2]);

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (index < 0) index = entry.value.length + index;
    if (index < 0 || index >= entry.value.length) return encodeBulk(null);

    return encodeBulk(entry.value[index]);
  }

  handleLset(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'LSET' command");

    const key = args[1];
    let index = parseInt(args[2]);
    const value = args[3];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeError("no such key");
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (index < 0) index = entry.value.length + index;
    if (index < 0 || index >= entry.value.length) return encodeError("index out of range");

    entry.value[index] = value;
    return encodeSimple("OK");
  }

  handleLrange(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'LRANGE' command");

    const key = args[1];
    let start = parseInt(args[2]);
    let stop = parseInt(args[3]);

    const entry = this.store.get(key);
    if (!entry) return encodeArray([]);
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const list = entry.value;
    if (start < 0) start = list.length + start;
    if (stop < 0) stop = list.length + stop;
    start = Math.max(0, start);
    stop = Math.min(list.length - 1, stop);

    if (start > stop) return encodeArray([]);

    return encodeArray(list.slice(start, stop + 1));
  }

  handleLrem(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'LREM' command");

    const key = args[1];
    let count = parseInt(args[2]);
    const value = args[3];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    let removed = 0;
    if (count === 0) {
      // Remove all occurrences
      const newList = entry.value.filter(v => v !== value);
      removed = entry.value.length - newList.length;
      entry.value = newList;
    } else if (count > 0) {
      // Remove from head
      let remaining = count;
      for (let i = 0; i < entry.value.length && remaining > 0; i++) {
        if (entry.value[i] === value) {
          entry.value.splice(i, 1);
          removed++;
          remaining--;
          i--;
        }
      }
    } else {
      // Remove from tail
      let remaining = -count;
      for (let i = entry.value.length - 1; i >= 0 && remaining > 0; i--) {
        if (entry.value[i] === value) {
          entry.value.splice(i, 1);
          removed++;
          remaining--;
        }
      }
    }

    return encodeInteger(removed);
  }

  handleLinsert(args) {
    if (args.length < 5) return encodeError("wrong number of arguments for 'LINSERT' command");

    const key = args[1];
    const position = args[2].toUpperCase();
    const pivot = args[3];
    const value = args[4];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const index = entry.value.indexOf(pivot);
    if (index === -1) return encodeInteger(0);

    if (position === "BEFORE") {
      entry.value.splice(index, 0, value);
    } else if (position === "AFTER") {
      entry.value.splice(index + 1, 0, value);
    } else {
      return encodeError("syntax error");
    }

    return encodeInteger(entry.value.length);
  }

  handleLpos(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'LPOS' command");

    const key = args[1];
    const value = args[2];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const index = entry.value.indexOf(value);
    if (index === -1) return encodeBulk(null);

    return encodeInteger(index);
  }

  handleLmove(args) {
    if (args.length < 5) return encodeError("wrong number of arguments for 'LMOVE' command");

    const source = args[1];
    const destination = args[2];
    const srcPos = args[3].toUpperCase();
    const destPos = args[4].toUpperCase();

    this.cleanupExpired(source);
    this.cleanupExpired(destination);

    const srcEntry = this.store.get(source);
    if (!srcEntry) return encodeBulk(null);
    if (srcEntry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    let destEntry = this.store.get(destination);
    if (!destEntry) {
      destEntry = { type: "list", value: [] };
      this.store.set(destination, destEntry);
    }
    if (destEntry.type !== "list") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (srcEntry.value.length === 0) return encodeBulk(null);

    let element;
    if (srcPos === "LEFT") {
      element = srcEntry.value.shift();
    } else {
      element = srcEntry.value.pop();
    }

    if (destPos === "LEFT") {
      destEntry.value.unshift(element);
    } else {
      destEntry.value.push(element);
    }

    return encodeBulk(element);
  }

  // Set operations
  handleSadd(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'SADD' command");

    const key = args[1];
    let entry = this.store.get(key);

    if (!entry) {
      entry = { type: "set", value: new Set() };
      this.store.set(key, entry);
    }

    if (entry.type !== "set") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    let added = 0;
    for (let i = 2; i < args.length; i++) {
      if (!entry.value.has(args[i])) {
        entry.value.add(args[i]);
        added++;
      }
    }
    return encodeInteger(added);
  }

  handleSrem(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'SREM' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "set") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    let removed = 0;
    for (let i = 2; i < args.length; i++) {
      if (entry.value.has(args[i])) {
        entry.value.delete(args[i]);
        removed++;
      }
    }
    return encodeInteger(removed);
  }

  handleSmembers(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SMEMBERS' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeArray([]);
    if (entry.type !== "set") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeArray(Array.from(entry.value));
  }

  handleSismember(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'SISMEMBER' command");

    const key = args[1];
    const member = args[2];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "set") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeInteger(entry.value.has(member) ? 1 : 0);
  }

  handleScard(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SCARD' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "set") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeInteger(entry.value.size);
  }

  handleSunion(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SUNION' command");

    const result = new Set();
    for (let i = 1; i < args.length; i++) {
      this.cleanupExpired(args[i]);
      const entry = this.store.get(args[i]);
      if (entry && entry.type === "set") {
        for (const member of entry.value) {
          result.add(member);
        }
      }
    }

    return encodeArray(Array.from(result));
  }

  handleSinter(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SINTER' command");

    const sets = [];
    for (let i = 1; i < args.length; i++) {
      this.cleanupExpired(args[i]);
      const entry = this.store.get(args[i]);
      if (!entry || entry.type !== "set") return encodeArray([]);
      sets.push(entry.value);
    }

    const result = new Set(sets[0]);
    for (let i = 1; i < sets.length; i++) {
      for (const member of result) {
        if (!sets[i].has(member)) {
          result.delete(member);
        }
      }
    }

    return encodeArray(Array.from(result));
  }

  handleSdiff(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SDIFF' command");

    const firstKey = args[1];
    this.cleanupExpired(firstKey);

    const firstEntry = this.store.get(firstKey);
    if (!firstEntry || firstEntry.type !== "set") return encodeArray([]);

    const result = new Set(firstEntry.value);
    for (let i = 2; i < args.length; i++) {
      this.cleanupExpired(args[i]);
      const entry = this.store.get(args[i]);
      if (entry && entry.type === "set") {
        for (const member of entry.value) {
          result.delete(member);
        }
      }
    }

    return encodeArray(Array.from(result));
  }

  handleSrandmember(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SRANDMEMBER' command");

    const key = args[1];
    const count = args.length > 2 ? parseInt(args[2]) : 1;

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "set") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const members = Array.from(entry.value);
    if (members.length === 0) return encodeBulk(null);

    if (count === 1) {
      const index = Math.floor(Math.random() * members.length);
      return encodeBulk(members[index]);
    }

    const result = [];
    const absCount = Math.abs(count);
    for (let i = 0; i < absCount && i < members.length; i++) {
      const index = Math.floor(Math.random() * members.length);
      result.push(members[index]);
    }

    return encodeArray(result);
  }

  handleSpop(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SPOP' command");

    const key = args[1];
    const count = args.length > 2 ? parseInt(args[2]) : 1;

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "set") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const members = Array.from(entry.value);
    if (members.length === 0) return encodeBulk(null);

    if (count === 1) {
      const index = Math.floor(Math.random() * members.length);
      const member = members[index];
      entry.value.delete(member);
      return encodeBulk(member);
    }

    const result = [];
    for (let i = 0; i < count && members.length > 0; i++) {
      const index = Math.floor(Math.random() * members.length);
      const member = members[index];
      entry.value.delete(member);
      members.splice(index, 1);
      result.push(member);
    }

    return encodeArray(result);
  }

  // Sorted set operations
  handleZadd(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'ZADD' command");

    const key = args[1];
    let entry = this.store.get(key);

    if (!entry) {
      entry = { type: "zset", value: new Map() };
      this.store.set(key, entry);
    }

    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    let added = 0;
    for (let i = 2; i < args.length; i += 2) {
      const score = parseFloat(args[i]);
      const member = args[i + 1];

      if (!entry.value.has(member)) {
        added++;
      }
      entry.value.set(member, score);
    }

    return encodeInteger(added);
  }

  handleZrem(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'ZREM' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    let removed = 0;
    for (let i = 2; i < args.length; i++) {
      if (entry.value.has(args[i])) {
        entry.value.delete(args[i]);
        removed++;
      }
    }

    return encodeInteger(removed);
  }

  handleZrange(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'ZRANGE' command");

    const key = args[1];
    let start = parseInt(args[2]);
    let stop = parseInt(args[3]);

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeArray([]);
    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const members = Array.from(entry.value.entries())
      .sort((a, b) => a[1] - b[1]);

    if (start < 0) start = members.length + start;
    if (stop < 0) stop = members.length + stop;
    start = Math.max(0, start);
    stop = Math.min(members.length - 1, stop);

    if (start > stop) return encodeArray([]);

    const result = members.slice(start, stop + 1).map(([member]) => member);
    return encodeArray(result);
  }

  handleZrevrange(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'ZREVRANGE' command");

    const key = args[1];
    let start = parseInt(args[2]);
    let stop = parseInt(args[3]);

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeArray([]);
    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const members = Array.from(entry.value.entries())
      .sort((a, b) => b[1] - a[1]);

    if (start < 0) start = members.length + start;
    if (stop < 0) stop = members.length + stop;
    start = Math.max(0, start);
    stop = Math.min(members.length - 1, stop);

    if (start > stop) return encodeArray([]);

    const result = members.slice(start, stop + 1).map(([member]) => member);
    return encodeArray(result);
  }

  handleZrangebyscore(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'ZRANGEBYSCORE' command");

    const key = args[1];
    const min = parseFloat(args[2]);
    const max = parseFloat(args[3]);

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeArray([]);
    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const members = Array.from(entry.value.entries())
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);

    return encodeArray(members);
  }

  handleZscore(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'ZSCORE' command");

    const key = args[1];
    const member = args[2];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const score = entry.value.get(member);
    if (score === undefined) return encodeBulk(null);

    return encodeBulk(String(score));
  }

  handleZcard(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'ZCARD' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeInteger(entry.value.size);
  }

  handleZincrby(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'ZINCRBY' command");

    const key = args[1];
    const increment = parseFloat(args[2]);
    const member = args[3];

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "zset", value: new Map() };
      this.store.set(key, entry);
    }

    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const current = entry.value.get(member) || 0;
    const newScore = current + increment;
    entry.value.set(member, newScore);

    return encodeBulk(String(newScore));
  }

  handleZrank(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'ZRANK' command");

    const key = args[1];
    const member = args[2];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (!entry.value.has(member)) return encodeBulk(null);

    const members = Array.from(entry.value.entries())
      .sort((a, b) => a[1] - b[1]);

    const index = members.findIndex(([m]) => m === member);
    return encodeInteger(index);
  }

  handleZrevrank(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'ZREVRANK' command");

    const key = args[1];
    const member = args[2];

    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "zset") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (!entry.value.has(member)) return encodeBulk(null);

    const members = Array.from(entry.value.entries())
      .sort((a, b) => b[1] - a[1]);

    const index = members.findIndex(([m]) => m === member);
    return encodeInteger(index);
  }

  // Hash operations
  handleHset(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'HSET' command");

    const key = args[1];
    let entry = this.store.get(key);

    if (!entry) {
      entry = { type: "hash", value: {} };
      this.store.set(key, entry);
    }

    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    let added = 0;
    for (let i = 2; i < args.length; i += 2) {
      const field = args[i];
      const value = args[i + 1];

      // Count only genuinely new fields — a falsy check miscounts "" and "0".
      if (!Object.prototype.hasOwnProperty.call(entry.value, field)) {
        added++;
      }
      entry.value[field] = value;
    }

    return encodeInteger(added);
  }

  handleHget(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'HGET' command");

    const entry = this.store.get(args[1]);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeBulk(entry.value[args[2]] || null);
  }

  handleHgetall(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'HGETALL' command");

    const entry = this.store.get(args[1]);
    if (!entry) return encodeArray([]);
    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const items = [];
    for (const [key, value] of Object.entries(entry.value)) {
      items.push(key);
      items.push(value);
    }
    return encodeArray(items);
  }

  handleHmset(args) {
    if (args.length < 4 || args.length % 2 !== 0) return encodeError("wrong number of arguments for 'HMSET' command");

    const key = args[1];
    let entry = this.store.get(key);

    if (!entry) {
      entry = { type: "hash", value: {} };
      this.store.set(key, entry);
    }

    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    for (let i = 2; i < args.length; i += 2) {
      entry.value[args[i]] = args[i + 1];
    }

    return encodeSimple("OK");
  }

  handleHmget(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'HMGET' command");

    const entry = this.store.get(args[1]);
    const result = [];

    for (let i = 2; i < args.length; i++) {
      if (entry && entry.type === "hash") {
        result.push(entry.value[args[i]] || null);
      } else {
        result.push(null);
      }
    }

    return encodeArray(result);
  }

  handleHdel(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'HDEL' command");

    const key = args[1];
    this.cleanupExpired(key);

    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    let deleted = 0;
    for (let i = 2; i < args.length; i++) {
      if (entry.value[args[i]] !== undefined) {
        delete entry.value[args[i]];
        deleted++;
      }
    }

    return encodeInteger(deleted);
  }

  handleHexists(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'HEXISTS' command");

    const entry = this.store.get(args[1]);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeInteger(entry.value[args[2]] !== undefined ? 1 : 0);
  }

  handleHlen(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'HLEN' command");

    const entry = this.store.get(args[1]);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeInteger(Object.keys(entry.value).length);
  }

  handleHincrby(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'HINCRBY' command");

    const key = args[1];
    const field = args[2];
    const increment = parseInt(args[3]);

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "hash", value: {} };
      this.store.set(key, entry);
    }

    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const current = parseInt(entry.value[field]) || 0;
    entry.value[field] = String(current + increment);

    return encodeInteger(current + increment);
  }

  handleHincrbyfloat(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'HINCRBYFLOAT' command");

    const key = args[1];
    const field = args[2];
    const increment = parseFloat(args[3]);

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "hash", value: {} };
      this.store.set(key, entry);
    }

    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    const current = parseFloat(entry.value[field]) || 0;
    entry.value[field] = String(current + increment);

    return encodeBulk(entry.value[field]);
  }

  handleHkeys(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'HKEYS' command");

    const entry = this.store.get(args[1]);
    if (!entry) return encodeArray([]);
    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeArray(Object.keys(entry.value));
  }

  handleHvals(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'HVALS' command");

    const entry = this.store.get(args[1]);
    if (!entry) return encodeArray([]);
    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    return encodeArray(Object.values(entry.value));
  }

  handleHsetnx(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'HSETNX' command");

    const key = args[1];
    const field = args[2];
    const value = args[3];

    this.cleanupExpired(key);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "hash", value: {} };
      this.store.set(key, entry);
    }

    if (entry.type !== "hash") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");

    if (entry.value[field] !== undefined) return encodeInteger(0);

    entry.value[field] = value;
    return encodeInteger(1);
  }

  // Pub/Sub operations
  handlePublish(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'PUBLISH' command");

    const channel = args[1];
    const message = args[2];
    let count = 0;

    const subs = this.subscribers.get(channel);
    if (subs) {
      for (const socket of subs) {
        socket.write(encodeArray(["message", channel, message]));
        count++;
      }
    }

    return encodeInteger(count);
  }

  handleSubscribe(args, socket) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SUBSCRIBE' command");

    // Subscribe to every requested channel; real Redis emits one `subscribe`
    // confirmation per channel with the running subscription count.
    const parts = [];
    let count = this.countSubscriptions(socket);
    for (let i = 1; i < args.length; i++) {
      const channel = args[i];
      if (!this.subscribers.has(channel)) {
        this.subscribers.set(channel, new Set());
      }
      // Register THIS connection so PUBLISH can actually deliver to it.
      if (socket) this.subscribers.get(channel).add(socket);
      count++;
      parts.push(encodeArray(["subscribe", channel, count]));
    }

    return Buffer.concat(parts);
  }

  handleUnsubscribe(args, socket) {
    const channels = args.length > 1
      ? args.slice(1)
      : Array.from(this.subscribers.keys());

    if (channels.length === 0) {
      return encodeArray(["unsubscribe", null, 0]);
    }

    const parts = [];
    for (const channel of channels) {
      const subs = this.subscribers.get(channel);
      if (subs && socket) {
        subs.delete(socket);
        if (subs.size === 0) this.subscribers.delete(channel);
      }
      parts.push(encodeArray(["unsubscribe", channel, this.countSubscriptions(socket)]));
    }

    return Buffer.concat(parts);
  }

  countSubscriptions(socket) {
    if (!socket) return 0;
    let n = 0;
    for (const subs of this.subscribers.values()) {
      if (subs.has(socket)) n++;
    }
    return n;
  }

  // Server operations
  handleTime() {
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    const microseconds = (now % 1000) * 1000;
    return encodeArray([String(seconds), String(microseconds)]);
  }

  handleRandomkey() {
    const keys = Array.from(this.store.keys());
    if (keys.length === 0) return encodeBulk(null);

    const index = Math.floor(Math.random() * keys.length);
    return encodeBulk(keys[index]);
  }

  handleCopy(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'COPY' command");

    const source = args[1];
    const destination = args[2];

    this.cleanupExpired(source);

    const entry = this.store.get(source);
    if (!entry) return encodeInteger(0);

    this.store.set(destination, { ...entry, value: typeof entry.value === 'object' ? { ...entry.value } : entry.value });
    return encodeInteger(1);
  }

  // Blocking list operations (simplified - returns null immediately)
  handleBlpop(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'BLPOP' command");
    const key = args[1];
    this.cleanupExpired(key);
    const entry = this.store.get(key);
    if (entry && entry.type === "list" && entry.value.length > 0) {
      return encodeArray([key, entry.value.shift()]);
    }
    return encodeBulk(null);
  }

  handleBrpop(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'BRPOP' command");
    const key = args[1];
    this.cleanupExpired(key);
    const entry = this.store.get(key);
    if (entry && entry.type === "list" && entry.value.length > 0) {
      return encodeArray([key, entry.value.pop()]);
    }
    return encodeBulk(null);
  }

  // Object operations
  handleObject(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'OBJECT' command");
    const subcommand = args[1].toUpperCase();
    const key = args[2];

    if (subcommand === "REFCOUNT") {
      return encodeInteger(1);
    }
    if (subcommand === "ENCODING") {
      return encodeBulk("embstr");
    }
    if (subcommand === "IDLETIME") {
      return encodeInteger(0);
    }
    if (subcommand === "FREQ") {
      return encodeInteger(0);
    }
    if (subcommand === "HELP") {
      return encodeArray([
        "OBJECT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
        "ENCODING <key> -- Return the kind of internal representation used in order to store the value associated with a key.",
        "FREQ <key> -- Return the access frequency index of the key.",
        "HELP -- Print this help.",
        "IDLETIME <key> -- Return the idle time of the key, that is the time since the last access to it.",
        "REFCOUNT <key> -- Return the number of references of the value associated with the specified key.",
      ]);
    }
    return encodeBulk(null);
  }

  // Client management
  handleClient(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'CLIENT' command");
    const subcommand = args[1].toUpperCase();

    if (subcommand === "ID") {
      return encodeInteger(Math.floor(Math.random() * 1000000));
    }
    if (subcommand === "SETNAME") {
      return encodeSimple("OK");
    }
    if (subcommand === "GETNAME") {
      return encodeBulk(null);
    }
    if (subcommand === "LIST") {
      return encodeBulk("id=1 addr=127.0.0.1:6379 fd=5 name= idle=0 db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=32768 obl=0 oll=0 omem=0 events=r cmd=client");
    }
    if (subcommand === "KILL") {
      return encodeSimple("OK");
    }
    if (subcommand === "PAUSE") {
      return encodeSimple("OK");
    }
    if (subcommand === "UNPAUSE") {
      return encodeSimple("OK");
    }
    if (subcommand === "INFO") {
      return encodeBulk("id=1 addr=127.0.0.1:6379 fd=5 name= idle=0 db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=32768 obl=0 oll=0 omem=0 events=r cmd=client");
    }
    if (subcommand === "NO-EVICT") {
      return encodeSimple("OK");
    }
    return encodeError(`Unknown CLIENT subcommand '${args[1]}'`);
  }

  // HELLO (RESP3)
  handleHello(args) {
    return encodeArray(["server", "redis", "version", "7.0.0", "proto", 2, "id", 1, "mode", "standalone", "role", "master", "modules", []]);
  }

  // ACL
  handleAcl(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'ACL' command");
    const subcommand = args[1].toUpperCase();

    if (subcommand === "WHOAMI") {
      return encodeBulk("default");
    }
    if (subcommand === "LIST") {
      return encodeArray(["user default on ~* &* +@all"]);
    }
    if (subcommand === "GETUSER") {
      return encodeArray(["flags", "on", "passwords", "~*", "keys", "&*", "channels", "+@all"]);
    }
    if (subcommand === "SETUSER") {
      return encodeSimple("OK");
    }
    if (subcommand === "DELUSER") {
      return encodeInteger(0);
    }
    if (subcommand === "CAT") {
      return encodeArray(["keyspace", "read", "write", "set", "sortedset", "list", "hash", "string", "bitmap", "hyperloglog", "geo", "stream", "pubsub", "admin", "fast", "slow", "blocking", "dangerous", "connection", "transaction", "scripting", "other"]);
    }
    if (subcommand === "GENPASS") {
      return encodeBulk(randomBytes(20).toString("hex"));
    }
    if (subcommand === "LOG") {
      return encodeArray([]);
    }
    if (subcommand === "LOAD") {
      return encodeSimple("OK");
    }
    if (subcommand === "SAVE") {
      return encodeSimple("OK");
    }
    if (subcommand === "HELP") {
      return encodeArray([
        "ACL <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
        "CAT [<category>] -- List available commands and categories.",
        "DELUSER <username> [<username> ...] -- Delete a list of users.",
        "GENPASS [<bits>] -- Generate a secure random password.",
        "GETUSER <username> -- Get the ACL for a user.",
        "HELP -- Print this help.",
        "LIST -- List all users and their ACL rules.",
        "LOAD -- Reload users from the ACL file.",
        "LOG [<count>] -- Show the ACL log.",
        "SAVE -- Save the current ACL rules to the ACL file.",
        "SETUSER <username> [<acl rule> ...] -- Modify or create a user.",
        "WHOAMI -- Return the current user.",
      ]);
    }
    return encodeError(`Unknown ACL subcommand '${args[1]}'`);
  }

  // MEMORY
  handleMemory(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'MEMORY' command");
    const subcommand = args[1].toUpperCase();

    if (subcommand === "USAGE") {
      return encodeInteger(100);
    }
    if (subcommand === "DOCTOR") {
      return encodeBulk("Memory is fine.");
    }
    if (subcommand === "MALLOC-STATS") {
      return encodeBulk("");
    }
    if (subcommand === "STATS") {
      return encodeBulk("peak.allocated:1000000\nallocated:500000");
    }
    if (subcommand === "PURGE") {
      return encodeSimple("OK");
    }
    if (subcommand === "HELP") {
      return encodeArray([
        "MEMORY <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
        "DOCTOR -- Output memory problems report.",
        "HELP -- Print this help.",
        "MALLOC-STATS -- Show allocator internal stats.",
        "PURGE -- Attempt to purge dirty pages for reinterpret by the allocator.",
        "STATS -- Show memory usage details.",
        "USAGE <key> [SAMPLES <count>] -- Estimate memory usage of key.",
      ]);
    }
    return encodeError(`Unknown MEMORY subcommand '${args[1]}'`);
  }

  // LATENCY
  handleLatency(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'LATENCY' command");
    const subcommand = args[1].toUpperCase();

    if (subcommand === "LATEST") {
      return encodeArray([]);
    }
    if (subcommand === "HISTORY") {
      return encodeArray([]);
    }
    if (subcommand === "RESET") {
      return encodeInteger(0);
    }
    if (subcommand === "GRAPH") {
      return encodeBulk("");
    }
    if (subcommand === "DOCTOR") {
      return encodeBulk("No latency problems detected.");
    }
    if (subcommand === "HELP") {
      return encodeArray([
        "LATENCY <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
        "DOCTOR -- Return a human readable latency analysis report.",
        "GRAPH <event> -- Return an ASCII latency graph for an event.",
        "HELP -- Print this help.",
        "HISTORY <event> -- Return time-latency pairs for an event.",
        "LATEST -- Return the latest latency events.",
        "RESET [<event> ...] -- Reset latency data of one or more events.",
      ]);
    }
    return encodeError(`Unknown LATENCY subcommand '${args[1]}'`);
  }

  // MODULE
  handleModule(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'MODULE' command");
    const subcommand = args[1].toUpperCase();

    if (subcommand === "LIST") {
      return encodeArray([]);
    }
    if (subcommand === "LOAD") {
      return encodeSimple("OK");
    }
    if (subcommand === "UNLOAD") {
      return encodeSimple("OK");
    }
    if (subcommand === "HELP") {
      return encodeArray([
        "MODULE <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
        "HELP -- Print this help.",
        "LIST -- List all modules loaded by the server.",
        "LOAD <path> [<arg> ...] -- Load a module from a dynamic library.",
        "UNLOAD <name> -- Unload a module.",
      ]);
    }
    return encodeError(`Unknown MODULE subcommand '${args[1]}'`);
  }

  // DEBUG
  handleDebug(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'DEBUG' command");
    const subcommand = args[1].toUpperCase();

    if (subcommand === "SLEEP") {
      // DEBUG SLEEP <seconds>
      return encodeSimple("OK");
    }
    if (subcommand === "OBJECT") {
      return encodeBulk("key at:0x7f8b8c0d0e0f refcount:1 encoding:embstr serializedlength:10 lru:0 lru_seconds_idle:0");
    }
    if (subcommand === "SEGFAULT") {
      return encodeSimple("OK");
    }
    if (subcommand === "HELP") {
      return encodeArray([
        "DEBUG <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
        "OBJECT <key> -- Show low-level info about a key.",
        "HELP -- Print this help.",
        "SLEEP <seconds> -- Stop the server for <seconds> seconds.",
        "SEGFAULT -- Crash the server with SIGSEGV.",
      ]);
    }
    return encodeError(`Unknown DEBUG subcommand '${args[1]}'`);
  }

  // Sort
  handleSort(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'SORT' command");
    const key = args[1];
    this.cleanupExpired(key);
    const entry = this.store.get(key);
    if (!entry) return encodeArray([]);
    if (entry.type !== "list" && entry.type !== "set") {
      return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    }
    const values = Array.from(entry.value).sort();
    return encodeArray(values);
  }

  // HyperLogLog
  handlePfadd(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'PFADD' command");
    const key = args[1];
    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "hll", value: new Set() };
      this.store.set(key, entry);
    }
    if (entry.type !== "hll") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    let added = 0;
    for (let i = 2; i < args.length; i++) {
      if (!entry.value.has(args[i])) {
        entry.value.add(args[i]);
        added++;
      }
    }
    return encodeInteger(added > 0 ? 1 : 0);
  }

  handlePfcount(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'PFCOUNT' command");
    let count = 0;
    for (let i = 1; i < args.length; i++) {
      const entry = this.store.get(args[i]);
      if (entry && entry.type === "hll") {
        count += entry.value.size;
      }
    }
    return encodeInteger(count);
  }

  handlePfmerge(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'PFMERGE' command");
    const dest = args[1];
    let destEntry = this.store.get(dest);
    if (!destEntry) {
      destEntry = { type: "hll", value: new Set() };
      this.store.set(dest, destEntry);
    }
    for (let i = 2; i < args.length; i++) {
      const entry = this.store.get(args[i]);
      if (entry && entry.type === "hll") {
        for (const val of entry.value) {
          destEntry.value.add(val);
        }
      }
    }
    return encodeSimple("OK");
  }

  // Bitmap operations
  handleSetbit(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'SETBIT' command");
    const key = args[1];
    const offset = parseInt(args[2]);
    const value = parseInt(args[3]);
    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "string", value: "\0".repeat(Math.ceil(offset / 8) + 1) };
      this.store.set(key, entry);
    }
    const byteIndex = Math.floor(offset / 8);
    const bitIndex = 7 - (offset % 8);
    const bytes = Buffer.from(entry.value, "binary");
    if (value) {
      bytes[byteIndex] |= (1 << bitIndex);
    } else {
      bytes[byteIndex] &= ~(1 << bitIndex);
    }
    entry.value = bytes.toString("binary");
    return encodeInteger(value);
  }

  handleGetbit(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'GETBIT' command");
    const key = args[1];
    const offset = parseInt(args[2]);
    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    const bytes = Buffer.from(entry.value, "binary");
    const byteIndex = Math.floor(offset / 8);
    const bitIndex = 7 - (offset % 8);
    if (byteIndex >= bytes.length) return encodeInteger(0);
    return encodeInteger((bytes[byteIndex] >> bitIndex) & 1);
  }

  handleBitcount(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'BITCOUNT' command");
    const key = args[1];
    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    const bytes = Buffer.from(entry.value, "binary");
    let count = 0;
    for (const byte of bytes) {
      count += byte.toString(2).split("1").length - 1;
    }
    return encodeInteger(count);
  }

  handleBitop(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'BITOP' command");
    const op = args[1].toUpperCase();
    const dest = args[2];
    const sources = args.slice(3);
    // Simplified - just copy first source
    if (sources.length > 0) {
      const entry = this.store.get(sources[0]);
      if (entry) {
        this.store.set(dest, { ...entry });
      }
    }
    return encodeInteger(0);
  }

  handleBitpos(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'BITPOS' command");
    const key = args[1];
    const bit = parseInt(args[2]);
    const entry = this.store.get(key);
    if (!entry) return encodeInteger(-1);
    const bytes = Buffer.from(entry.value, "binary");
    for (let i = 0; i < bytes.length * 8; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      if (((bytes[byteIndex] >> bitIndex) & 1) === bit) {
        return encodeInteger(i);
      }
    }
    return encodeInteger(-1);
  }

  // Stream operations
  handleXadd(args) {
    if (args.length < 5) return encodeError("wrong number of arguments for 'XADD' command");
    const key = args[1];
    const id = args[2] === "*" ? `${Date.now()}-0` : args[2];
    const fields = {};
    for (let i = 3; i < args.length; i += 2) {
      if (i + 1 < args.length) {
        fields[args[i]] = args[i + 1];
      }
    }
    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "stream", value: [] };
      this.store.set(key, entry);
    }
    if (entry.type !== "stream") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    entry.value.push({ id, fields, timestamp: Date.now() });
    return encodeBulk(id);
  }

  handleXlen(args) {
    if (args.length < 2) return encodeError("wrong number of arguments for 'XLEN' command");
    const entry = this.store.get(args[1]);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "stream") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    return encodeInteger(entry.value.length);
  }

  handleXrange(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'XRANGE' command");
    const entry = this.store.get(args[1]);
    if (!entry) return encodeArray([]);
    if (entry.type !== "stream") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    const start = args[2];
    const end = args[3];
    const results = entry.value.filter((e) => {
      if (start !== "-" && e.id < start) return false;
      if (end !== "+" && e.id > end) return false;
      return true;
    });
    return encodeArray(results.map((e) => [e.id, Object.entries(e.fields).flat()]));
  }

  handleXrevrange(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'XREVRANGE' command");
    const entry = this.store.get(args[1]);
    if (!entry) return encodeArray([]);
    if (entry.type !== "stream") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    const results = [...entry.value].reverse();
    return encodeArray(results.map((e) => [e.id, Object.entries(e.fields).flat()]));
  }

  handleXread(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'XREAD' command");
    const key = args[args.length - 1];
    const entry = this.store.get(key);
    if (!entry) return encodeArray([]);
    if (entry.type !== "stream") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    return encodeArray([[key, entry.value.map((e) => [e.id, Object.entries(e.fields).flat()])]]);
  }

  handleXdel(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'XDEL' command");
    const key = args[1];
    const entry = this.store.get(key);
    if (!entry) return encodeInteger(0);
    if (entry.type !== "stream") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    const ids = args.slice(2);
    let deleted = 0;
    entry.value = entry.value.filter((e) => {
      if (ids.includes(e.id)) {
        deleted++;
        return false;
      }
      return true;
    });
    return encodeInteger(deleted);
  }

  // Geo operations
  handleGeoadd(args) {
    if (args.length < 5) return encodeError("wrong number of arguments for 'GEOADD' command");
    const key = args[1];
    const lng = parseFloat(args[2]);
    const lat = parseFloat(args[3]);
    const member = args[4];
    let entry = this.store.get(key);
    if (!entry) {
      entry = { type: "geo", value: new Map() };
      this.store.set(key, entry);
    }
    if (entry.type !== "geo") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    entry.value.set(member, { lng, lat });
    return encodeInteger(1);
  }

  handleGeopos(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'GEOPOS' command");
    const entry = this.store.get(args[1]);
    if (!entry) return encodeArray([]);
    if (entry.type !== "geo") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    const results = [];
    for (let i = 2; i < args.length; i++) {
      const pos = entry.value.get(args[i]);
      results.push(pos ? [String(pos.lng), String(pos.lat)] : null);
    }
    return encodeArray(results);
  }

  handleGeodist(args) {
    if (args.length < 4) return encodeError("wrong number of arguments for 'GEODIST' command");
    const entry = this.store.get(args[1]);
    if (!entry) return encodeBulk(null);
    if (entry.type !== "geo") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    const pos1 = entry.value.get(args[2]);
    const pos2 = entry.value.get(args[3]);
    if (!pos1 || !pos2) return encodeBulk(null);
    // Simplified distance calculation
    const dist = Math.sqrt(Math.pow(pos2.lng - pos1.lng, 2) + Math.pow(pos2.lat - pos1.lat, 2)) * 111;
    return encodeBulk(String(Math.round(dist * 1000)));
  }

  handleGeoradius(args) {
    if (args.length < 5) return encodeError("wrong number of arguments for 'GEORADIUS' command");
    const entry = this.store.get(args[1]);
    if (!entry) return encodeArray([]);
    if (entry.type !== "geo") return encodeError("WRONGTYPE Operation against a key holding the wrong kind of value");
    const lng = parseFloat(args[2]);
    const lat = parseFloat(args[3]);
    const radius = parseFloat(args[4]);
    const results = [];
    for (const [member, pos] of entry.value) {
      const dist = Math.sqrt(Math.pow(pos.lng - lng, 2) + Math.pow(pos.lat - lat, 2)) * 111;
      if (dist <= radius) {
        results.push(member);
      }
    }
    return encodeArray(results);
  }

  // Script operations
  handleEval(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'EVAL' command");
    // Simplified - return nil
    return encodeBulk(null);
  }

  handleEvalsha(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'EVALSHA' command");
    return encodeBulk(null);
  }

  // Scan operations
  handleSscan(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'SSCAN' command");
    const key = args[1];
    const cursor = parseInt(args[2]) || 0;
    const entry = this.store.get(key);
    if (!entry || entry.type !== "set") return encodeArray(["0", []]);
    const members = Array.from(entry.value);
    const start = cursor;
    const end = Math.min(start + 10, members.length);
    const result = members.slice(start, end);
    const newCursor = end >= members.length ? 0 : end;
    return encodeArray([String(newCursor), result]);
  }

  handleHscan(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'HSCAN' command");
    const key = args[1];
    const cursor = parseInt(args[2]) || 0;
    const entry = this.store.get(key);
    if (!entry || entry.type !== "hash") return encodeArray(["0", []]);
    const entries = Object.entries(entry.value);
    const start = cursor;
    const end = Math.min(start + 10, entries.length);
    const result = entries.slice(start, end).flat();
    const newCursor = end >= entries.length ? 0 : end;
    return encodeArray([String(newCursor), result]);
  }

  handleZscan(args) {
    if (args.length < 3) return encodeError("wrong number of arguments for 'ZSCAN' command");
    const key = args[1];
    const cursor = parseInt(args[2]) || 0;
    const entry = this.store.get(key);
    if (!entry || entry.type !== "zset") return encodeArray(["0", []]);
    const members = Array.from(entry.value.entries());
    const start = cursor;
    const end = Math.min(start + 10, members.length);
    const result = members.slice(start, end).map(([m, s]) => [m, String(s)]).flat();
    const newCursor = end >= members.length ? 0 : end;
    return encodeArray([String(newCursor), result]);
  }

  cleanupExpired(key) {
    const expiry = this.expires.get(key);
    if (expiry && expiry <= Date.now()) {
      this.store.delete(key);
      this.expires.delete(key);
    }
  }

  getInfo() {
    return `# Server
redis_version:7.0.0
redis_mode:standalone
os:Linux
tcp_port:${this.port}

# Clients
connected_clients:1

# Memory
used_memory:1000000

# Stats
total_connections_received:1
total_commands_processed:0

# Keyspace
db0:keys=${this.store.size},expires=${this.expires.size}
`;
  }
}

// True only for canonical base-10 integer strings, matching Redis's
// "value is not an integer or out of range" gate for INCR/DECR/INCRBY/DECRBY.
function isInteger(value) {
  return typeof value === "string" && /^[+-]?\d+$/.test(value);
}
