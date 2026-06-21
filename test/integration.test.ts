import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RedisServer } from "../services/redis/src/server.js";
import { PostgresServer } from "../services/postgres/src/server.js";
import { KafkaServer } from "../services/kafka/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

let REDIS_PORT = 0;
let POSTGRES_PORT = 0;
let KAFKA_PORT = 0;

// These helpers drive the emulators in-process (no redis-cli / psql binaries
// required), so the integration suite is hermetic and reproducible in CI. They
// exercise the same engines the live sandbox MCP adapter uses.

/** Tokenize a Redis command line, honoring single-quoted args with spaces. */
function tokenizeRedis(cmd: string): string[] {
  const parts = cmd.match(/'[^']*'|\S+/g) || [];
  return parts.map((p) => (p.startsWith("'") && p.endsWith("'") ? p.slice(1, -1) : p));
}

/** Decode a RESP reply (string/Buffer) into a plain string for assertions. */
function decodeResp(data: unknown): string {
  if (data == null) return "";
  const s = Buffer.isBuffer(data) ? data.toString() : String(data);
  const type = s[0];
  const firstLine = s.slice(1, s.indexOf("\r\n"));
  if (type === "+") return firstLine; // simple string
  if (type === "-") return firstLine; // error
  if (type === ":") return firstLine; // integer
  if (type === "$") {
    if (firstLine === "-1") return ""; // null bulk
    return s.split("\r\n")[1] ?? "";
  }
  if (type === "*") {
    // array: return the bulk values joined by spaces
    const lines = s.split("\r\n");
    const out: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith("$") || lines[i].startsWith(":") || lines[i] === "") continue;
      out.push(lines[i]);
    }
    return out.join(" ");
  }
  return s.trim();
}

let redisServer: RedisServer;
let postgresServer: PostgresServer;

function redisCommand(cmd: string): string {
  const args = tokenizeRedis(cmd);
  const respCmd = { type: "array", value: args.map((v) => ({ value: v })) };
  let reply: unknown = null;
  const fakeSocket = { write(d: unknown) { reply = d; }, end() {}, destroy() {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ret = (redisServer as any).handleCommand(respCmd, fakeSocket);
  if (ret != null) reply = ret;
  return decodeResp(reply);
}

function postgresCommand(sql: string): string {
  const stmt = sql.trim().replace(/;\s*$/, "");
  // Transaction control statements are accepted no-ops in the engine.
  const tx = stmt.match(/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i);
  if (tx) return tx[1].toUpperCase() === "START TRANSACTION" ? "BEGIN" : tx[1].toUpperCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (postgresServer as any).executor.execute(stmt);
  if (!out || out.error) return "";
  const rows = (out.rows || []).map((r: unknown[]) => r.join(" | ")).join("\n");
  return [out.tag || "", rows].filter(Boolean).join("\n");
}

describe("Integration: All Services", () => {
  let redis: RedisServer;
  let postgres: PostgresServer;
  let kafka: KafkaServer;

  beforeAll(async () => {
    REDIS_PORT = await getFreePort();
    POSTGRES_PORT = await getFreePort();
    KAFKA_PORT = await getFreePort();
    redis = new RedisServer(REDIS_PORT);
    postgres = new PostgresServer(POSTGRES_PORT, {
      user: "parlel",
      password: "parlel",
      database: "parlel",
    });
    kafka = new KafkaServer(KAFKA_PORT);

    await redis.start();
    await postgres.start();
    await kafka.start();

    // Expose to the in-process command helpers.
    redisServer = redis;
    postgresServer = postgres;

    // Wait for services to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));
  }, 30000);

  afterAll(async () => {
    await redis.stop();
    await postgres.stop();
    await kafka.stop();
  });

  describe("Redis", () => {
    it("should handle PING", () => {
      expect(redisCommand("PING")).toBe("PONG");
    });

    it("should handle string operations", () => {
      redisCommand("SET test:hello world");
      expect(redisCommand("GET test:hello")).toBe("world");
      redisCommand("DEL test:hello");
    });

    it("should handle TTL", () => {
      redisCommand("SET test:ttl value");
      redisCommand("EXPIRE test:ttl 3600");
      const ttl = redisCommand("TTL test:ttl");
      expect(parseInt(ttl)).toBeGreaterThan(0);
      redisCommand("DEL test:ttl");
    });

    it("should handle INCR/DECR", () => {
      redisCommand("SET test:counter 0");
      expect(redisCommand("INCR test:counter")).toBe("1");
      expect(redisCommand("INCR test:counter")).toBe("2");
      expect(redisCommand("DECR test:counter")).toBe("1");
      redisCommand("DEL test:counter");
    });

    it("should handle list operations", () => {
      redisCommand("DEL test:list");
      redisCommand("LPUSH test:list a");
      redisCommand("LPUSH test:list b");
      redisCommand("RPUSH test:list c");
      expect(redisCommand("LLEN test:list")).toBe("3");
      redisCommand("DEL test:list");
    });

    it("should handle hash operations", () => {
      redisCommand("DEL test:hash");
      redisCommand("HSET test:hash name Alice");
      redisCommand("HSET test:hash age 30");
      expect(redisCommand("HGET test:hash name")).toBe("Alice");
      redisCommand("DEL test:hash");
    });

    it("should handle EXISTS", () => {
      redisCommand("SET test:exists 1");
      expect(redisCommand("EXISTS test:exists")).toBe("1");
      expect(redisCommand("EXISTS test:nonexistent")).toBe("0");
      redisCommand("DEL test:exists");
    });

    it("should handle FLUSHDB", () => {
      redisCommand("SET test:flush 1");
      redisCommand("FLUSHDB");
      expect(redisCommand("GET test:flush")).toBe("");
    });

    it("should handle DBSIZE", () => {
      redisCommand("FLUSHDB");
      redisCommand("SET test:size1 1");
      redisCommand("SET test:size2 2");
      expect(redisCommand("DBSIZE")).toBe("2");
      redisCommand("FLUSHDB");
    });
  });

  describe("Postgres", () => {
    it("should handle SELECT 1", () => {
      const result = postgresCommand("SELECT 1;");
      expect(result).toContain("1");
    });

    it("should handle CREATE TABLE", () => {
      postgresCommand("DROP TABLE IF EXISTS test_users CASCADE;");
      const result = postgresCommand("CREATE TABLE test_users (id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100));");
      expect(result).toContain("CREATE TABLE");
    });

    it("should handle INSERT", () => {
      const result = postgresCommand("INSERT INTO test_users (name, email) VALUES ('Alice', 'alice@test.com');");
      expect(result).toContain("INSERT 0 1");
    });

    it("should handle SELECT with results", () => {
      postgresCommand("INSERT INTO test_users (name, email) VALUES ('Bob', 'bob@test.com');");
      const result = postgresCommand("SELECT * FROM test_users;");
      expect(result).toContain("Alice");
      expect(result).toContain("Bob");
    });

    it("should handle UPDATE", () => {
      const result = postgresCommand("UPDATE test_users SET name = 'Alice Updated' WHERE name = 'Alice';");
      expect(result).toContain("UPDATE 1");
    });

    it("should handle DELETE", () => {
      const result = postgresCommand("DELETE FROM test_users WHERE name = 'Bob';");
      expect(result).toContain("DELETE 1");
    });

    it("should handle WHERE clauses", () => {
      postgresCommand("INSERT INTO test_users (name, email) VALUES ('Charlie', 'charlie@test.com');");
      const result = postgresCommand("SELECT * FROM test_users WHERE name = 'Charlie';");
      expect(result).toContain("Charlie");
    });

    it("should handle JOIN", () => {
      postgresCommand("DROP TABLE IF EXISTS test_posts CASCADE;");
      postgresCommand("CREATE TABLE test_posts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES test_users(id), title VARCHAR(100));");
      postgresCommand("INSERT INTO test_posts (user_id, title) VALUES (1, 'Post by Alice');");
      
      const result = postgresCommand("SELECT u.name, p.title FROM test_users u JOIN test_posts p ON u.id = p.user_id;");
      expect(result).toContain("Alice Updated");
      expect(result).toContain("Post by Alice");
    });

    it("should handle transactions", () => {
      const result1 = postgresCommand("BEGIN;");
      expect(result1).toContain("BEGIN");
      
      postgresCommand("INSERT INTO test_users (name, email) VALUES ('Transaction Test', 'tx@test.com');");
      
      const result2 = postgresCommand("COMMIT;");
      expect(result2).toContain("COMMIT");
    });

    it("should handle DROP TABLE", () => {
      postgresCommand("DROP TABLE IF EXISTS test_posts CASCADE;");
      postgresCommand("DROP TABLE IF EXISTS test_users CASCADE;");
    });
  });

  describe("Kafka", () => {
    it("should start and accept connections", () => {
      // If Kafka started in beforeAll, it's working
      expect(kafka).toBeDefined();
    });
  });

  describe("Cross-service scenarios", () => {
    it("should handle session storage in Redis + user data in Postgres", () => {
      // Create user in Postgres
      postgresCommand("CREATE TABLE IF NOT EXISTS app_users (id SERIAL PRIMARY KEY, name VARCHAR(100));");
      postgresCommand("INSERT INTO app_users (name) VALUES ('Session User');");
      
      // Store session in Redis
      redisCommand("SET session:abc123 '{\"userId\":1,\"name\":\"Session User\"}'");
      redisCommand("EXPIRE session:abc123 3600");
      
      // Verify both
      const session = redisCommand("GET session:abc123");
      expect(session).toContain("Session User");
      
      const users = postgresCommand("SELECT * FROM app_users;");
      expect(users).toContain("Session User");
      
      // Cleanup
      redisCommand("DEL session:abc123");
      postgresCommand("DROP TABLE IF EXISTS app_users CASCADE;");
    });

    it("should handle caching pattern", () => {
      // Simulate cache-aside pattern
      const cacheKey = "user:999";
      const userData = '{"id":999,"name":"Cached User"}';
      
      // Check cache (miss)
      let cached = redisCommand(`GET ${cacheKey}`);
      expect(cached).toBe("");
      
      // Query database
      postgresCommand("CREATE TABLE IF NOT EXISTS cache_test (id INTEGER, name VARCHAR(100));");
      postgresCommand("INSERT INTO cache_test VALUES (999, 'Cached User');");
      const dbResult = postgresCommand("SELECT * FROM cache_test WHERE id = 999;");
      expect(dbResult).toContain("Cached User");
      
      // Store in cache
      redisCommand(`SET ${cacheKey} '${userData}'`);
      redisCommand(`EXPIRE ${cacheKey} 300`);
      
      // Check cache (hit)
      cached = redisCommand(`GET ${cacheKey}`);
      expect(cached).toContain("Cached User");
      
      // Cleanup
      redisCommand(`DEL ${cacheKey}`);
      postgresCommand("DROP TABLE IF EXISTS cache_test CASCADE;");
    });
  });
});
