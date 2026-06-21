import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createConnection } from "node:net";
import Redis from "ioredis";
import { RedisServer } from "../services/redis/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

let PORT = 0;
let server: RedisServer;
let client: Redis;

// Raw-protocol helper: send one command, return the exact RESP reply bytes as a
// string. Used to assert error envelopes byte-for-byte (the real-client path
// hides the wire framing). Encodes the command as a RESP array of bulk strings.
function raw(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = createConnection({ port: PORT }, () => {
      let payload = `*${args.length}\r\n`;
      for (const a of args) payload += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
      conn.write(payload);
    });
    let data = "";
    conn.on("data", (chunk) => {
      data += chunk.toString();
      // Replies we assert on are single-line framed (+ - : $ for simple/err/int).
      // Give a tick for the full frame, then resolve.
      setTimeout(() => {
        conn.end();
        resolve(data);
      }, 20);
    });
    conn.on("error", reject);
    setTimeout(() => {
      conn.destroy();
      reject(new Error("timeout"));
    }, 4000);
  });
}

describe("Redis Service (wire fidelity)", () => {
  beforeAll(async () => {
    PORT = await getFreePort();
    server = new RedisServer(PORT);
    await server.start();
    client = new Redis({ port: PORT, host: "127.0.0.1", lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
  }, 15000);

  afterAll(async () => {
    client.disconnect();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Connection", () => {
    it("PING returns PONG", async () => {
      expect(await client.ping()).toBe("PONG");
    });

    it("ECHO returns the message", async () => {
      expect(await client.echo("hi")).toBe("hi");
    });

    it("reset() clears all state", () => {
      server.store.set("x", { type: "string", value: "1" } as any);
      server.expires.set("x", Date.now() + 1000);
      server.reset();
      expect(server.store.size).toBe(0);
      expect(server.expires.size).toBe(0);
    });
  });

  describe("Strings", () => {
    it("SET / GET round-trips through a real client", async () => {
      expect(await client.set("user:1", "alice")).toBe("OK");
      expect(await client.get("user:1")).toBe("alice");
    });

    it("GET on a missing key returns null (nil bulk)", async () => {
      expect(await client.get("missing")).toBeNull();
    });

    it("APPEND returns the new length", async () => {
      await client.set("s", "hello");
      expect(await client.append("s", "world")).toBe(10);
      expect(await client.get("s")).toBe("helloworld");
    });

    it("SETNX only sets when absent", async () => {
      expect(await client.setnx("k", "a")).toBe(1);
      expect(await client.setnx("k", "b")).toBe(0);
      expect(await client.get("k")).toBe("a");
    });

    it("MGET returns nulls for missing keys in correct positions", async () => {
      await client.set("a", "1");
      await client.set("c", "3");
      expect(await client.mget("a", "b", "c")).toEqual(["1", null, "3"]);
    });
  });

  describe("Counters", () => {
    it("INCR / DECR / INCRBY", async () => {
      expect(await client.incr("n")).toBe(1);
      expect(await client.incr("n")).toBe(2);
      expect(await client.incrby("n", 5)).toBe(7);
      expect(await client.decr("n")).toBe(6);
      expect(await client.decrby("n", 4)).toBe(2);
    });

    it("INCR on a non-integer value errors like real Redis", async () => {
      await client.set("nan", "abc");
      await expect(client.incr("nan")).rejects.toThrow(
        /value is not an integer or out of range/,
      );
    });
  });

  describe("Lists", () => {
    it("RPUSH / LPUSH / LRANGE / LLEN", async () => {
      await client.rpush("l", "a", "b", "c");
      await client.lpush("l", "z");
      expect(await client.llen("l")).toBe(4);
      expect(await client.lrange("l", 0, -1)).toEqual(["z", "a", "b", "c"]);
    });

    it("LPOP / RPOP", async () => {
      await client.rpush("l", "a", "b", "c");
      expect(await client.lpop("l")).toBe("a");
      expect(await client.rpop("l")).toBe("c");
    });

    it("LSET on a missing key errors with 'no such key'", async () => {
      await expect(client.lset("nope", 0, "x")).rejects.toThrow(/no such key/);
    });
  });

  describe("Sets", () => {
    it("SADD / SMEMBERS / SISMEMBER / SCARD", async () => {
      expect(await client.sadd("s", "a", "b", "c")).toBe(3);
      expect(await client.sadd("s", "a")).toBe(0);
      expect(await client.scard("s")).toBe(3);
      expect(await client.sismember("s", "b")).toBe(1);
      expect(await client.sismember("s", "x")).toBe(0);
      expect((await client.smembers("s")).sort()).toEqual(["a", "b", "c"]);
    });

    it("SSCAN returns [cursor, members] (nested array shape)", async () => {
      await client.sadd("s", "a", "b", "c");
      const [cursor, members] = await client.sscan("s", 0);
      expect(typeof cursor).toBe("string");
      expect(members.sort()).toEqual(["a", "b", "c"]);
    });
  });

  describe("Hashes", () => {
    it("HSET counts only new fields, HGET / HGETALL", async () => {
      expect(await client.hset("h", "name", "alice", "age", "30")).toBe(2);
      // Overwriting existing fields adds zero new fields.
      expect(await client.hset("h", "name", "bob")).toBe(0);
      expect(await client.hget("h", "name")).toBe("bob");
      expect(await client.hgetall("h")).toEqual({ name: "bob", age: "30" });
    });

    it("HSET counts a re-set of an empty-string field as not-new", async () => {
      expect(await client.hset("h", "f", "")).toBe(1);
      expect(await client.hset("h", "f", "x")).toBe(0);
    });

    it("HMGET returns nulls for missing fields", async () => {
      await client.hset("h", "a", "1");
      expect(await client.hmget("h", "a", "b")).toEqual(["1", null]);
    });
  });

  describe("Sorted sets", () => {
    it("ZADD / ZSCORE / ZRANGE / ZCARD", async () => {
      expect(await client.zadd("z", 1, "a", 2, "b", 3, "c")).toBe(3);
      expect(await client.zscore("z", "b")).toBe("2");
      expect(await client.zcard("z")).toBe(3);
      expect(await client.zrange("z", 0, -1)).toEqual(["a", "b", "c"]);
    });
  });

  describe("Keys & expiry", () => {
    it("EXISTS / DEL / TYPE", async () => {
      await client.set("k", "v");
      expect(await client.exists("k")).toBe(1);
      expect(await client.type("k")).toBe("string");
      expect(await client.del("k")).toBe(1);
      expect(await client.exists("k")).toBe(0);
    });

    it("EXPIRE / TTL", async () => {
      await client.set("k", "v");
      expect(await client.expire("k", 100)).toBe(1);
      const ttl = await client.ttl("k");
      expect(ttl).toBeGreaterThan(90);
      expect(ttl).toBeLessThanOrEqual(100);
    });

    it("TTL on a key with no expiry is -1, missing is -2", async () => {
      await client.set("k", "v");
      expect(await client.ttl("k")).toBe(-1);
      expect(await client.ttl("ghost")).toBe(-2);
    });

    it("SCAN returns [cursor, keys] nested shape", async () => {
      await client.set("a", "1");
      await client.set("b", "2");
      const [cursor, keys] = await client.scan(0);
      expect(typeof cursor).toBe("string");
      expect(keys.sort()).toEqual(["a", "b"]);
    });
  });

  describe("Pub/Sub", () => {
    it("PUBLISH delivers to a SUBSCRIBE'd client", async () => {
      const sub = new Redis({ port: PORT, host: "127.0.0.1" });
      const received = new Promise<{ channel: string; message: string }>((resolve) => {
        sub.on("message", (channel, message) => resolve({ channel, message }));
      });
      await sub.subscribe("news");
      // Give the subscription a moment to register, then publish.
      await new Promise((r) => setTimeout(r, 50));
      const count = await client.publish("news", "hello");
      expect(count).toBeGreaterThanOrEqual(1);
      const msg = await received;
      expect(msg).toEqual({ channel: "news", message: "hello" });
      sub.disconnect();
    });
  });

  describe("Failure-scenario parity (error envelopes)", () => {
    it("WRONGTYPE is framed as -WRONGTYPE, not -ERR WRONGTYPE", async () => {
      await client.rpush("list", "a");
      const reply = await raw(["GET", "list"]);
      expect(reply.startsWith("-WRONGTYPE ")).toBe(true);
      expect(reply).toContain("Operation against a key holding the wrong kind of value");
    });

    it("unknown command returns -ERR unknown command", async () => {
      const reply = await raw(["NOTACOMMAND", "x"]);
      expect(reply.startsWith("-ERR unknown command")).toBe(true);
    });

    it("no such key (RENAME) returns -ERR no such key", async () => {
      const reply = await raw(["RENAME", "ghost", "x"]);
      expect(reply).toBe("-ERR no such key\r\n");
    });

    it("INCR on non-integer returns the canonical integer error", async () => {
      await client.set("nan", "abc");
      const reply = await raw(["INCR", "nan"]);
      expect(reply).toBe("-ERR value is not an integer or out of range\r\n");
    });
  });

  describe("Server", () => {
    it("INFO contains version and keyspace", async () => {
      const info = await client.info();
      expect(info).toContain("redis_version");
      expect(info).toContain("tcp_port");
    });

    it("DBSIZE / FLUSHDB", async () => {
      await client.set("a", "1");
      await client.set("b", "2");
      expect(await client.dbsize()).toBe(2);
      await client.flushdb();
      expect(await client.dbsize()).toBe(0);
    });

    it("ACL GENPASS does not crash (randomBytes imported)", async () => {
      const reply = await raw(["ACL", "GENPASS"]);
      expect(reply.startsWith("$")).toBe(true);
      expect(reply).toMatch(/[0-9a-f]{40}/);
    });
  });
});
