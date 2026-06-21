# Redis

Lightweight in-memory Redis implementation speaking the real RESP protocol.

| Key | Value |
|-----|-------|
| Port | 6379 |
| Protocol | RESP (TCP) |
| Size | ~50 KB |
| Startup | < 500ms |

## Default Connection

```
redis://localhost:6379
```

No auth required. All commands accepted. `AUTH` is accepted as a no-op (the dev
pool does not enforce credentials).

Replies are framed in the real **RESP** protocol: nested arrays (`SCAN`,
`SSCAN`/`HSCAN`/`ZSCAN`, `MGET`, `HMGET`, `GEOPOS`, `XRANGE`) are encoded as RESP
arrays, missing entries come back as nil bulk (`$-1`), and typed errors use the
real error code (`-WRONGTYPE …`, `-ERR value is not an integer or out of range`,
`-ERR no such key`, `-ERR unknown command …`), so `ioredis`, `node-redis`, and
`redis-py` parse them unmodified.

## Supported Commands

### Connection

| Command | Notes |
|---------|-------|
| `PING` | Returns `PONG` |
| `ECHO` | Returns the message |
| `AUTH` | Accepted (no-op) |
| `SELECT` | Accepted (single DB) |
| `QUIT` | Closes connection |

### Strings

| Command | Notes |
|---------|-------|
| `SET key value [EX seconds]` | Set with optional expiry |
| `GET key` | Get value |
| `DEL key [key ...]` | Delete keys |
| `UNLINK key [key ...]` | Async delete (same as DEL) |
| `EXISTS key [key ...]` | Check existence |
| `EXPIRE key seconds` | Set TTL in seconds |
| `EXPIREAT key timestamp` | Set expiry as Unix timestamp |
| `PEXPIRE key ms` | Set TTL in milliseconds |
| `PEXPIREAT key ms-timestamp` | Set expiry as ms timestamp |
| `TTL key` | Get remaining TTL (seconds) |
| `PTTL key` | Get remaining TTL (ms) |
| `PERSIST key` | Remove expiry |
| `TYPE key` | Returns type of value |
| `RENAME key newkey` | Rename a key |
| `RENAMENX key newkey` | Rename only if newkey doesn't exist |
| `APPEND key value` | Append to string |
| `STRLEN key` | Get string length |
| `GETRANGE key start end` | Get substring |
| `SETRANGE key offset value` | Overwrite substring |
| `GETSET key value` | Set and return old value |
| `GETDEL key` | Get and delete |
| `SETNX key value` | Set only if not exists |
| `MSET key value [key value ...]` | Set multiple |
| `MGET key [key ...]` | Get multiple |
| `MSETNX key value [key value ...]` | Set multiple if none exist |
| `COPY src dst` | Copy a key |

### Counters

| Command | Notes |
|---------|-------|
| `INCR key` | Increment by 1 |
| `DECR key` | Decrement by 1 |
| `INCRBY key amount` | Increment by amount |
| `DECRBY key amount` | Decrement by amount |
| `INCRBYFLOAT key amount` | Increment by float |

### Lists

| Command | Notes |
|---------|-------|
| `LPUSH key value [value ...]` | Push to head |
| `RPUSH key value [value ...]` | Push to tail |
| `LPOP key` | Pop from head |
| `RPOP key` | Pop from tail |
| `LLEN key` | Get length |
| `LINDEX key index` | Get by index |
| `LSET key index value` | Set by index |
| `LRANGE key start stop` | Get range |
| `LREM key count value` | Remove elements |
| `LINSERT key BEFORE\|AFTER pivot value` | Insert relative to pivot |
| `LPOS key value` | Find position |
| `LMOVE src dst srcpos dstpos` | Move element between lists |

### Sets

| Command | Notes |
|---------|-------|
| `SADD key member [member ...]` | Add members |
| `SREM key member [member ...]` | Remove members |
| `SMEMBERS key` | Get all members |
| `SISMEMBER key member` | Check membership |
| `SCARD key` | Get cardinality |
| `SPOP key` | Remove and return random member |
| `SRANDMEMBER key [count]` | Get random members |
| `SDIFF key [key ...]` | Difference |
| `SINTER key [key ...]` | Intersection |
| `SUNION key [key ...]` | Union |
| `SORT key` | Sort elements |

### Hashes

| Command | Notes |
|---------|-------|
| `HSET key field value [field value ...]` | Set fields |
| `HSETNX key field value` | Set field if not exists |
| `HGET key field` | Get field |
| `HMGET key field [field ...]` | Get multiple fields |
| `HMSET key field value [field value ...]` | Set multiple fields |
| `HGETALL key` | Get all fields and values |
| `HDEL key field [field ...]` | Delete fields |
| `HEXISTS key field` | Check field existence |
| `HKEYS key` | Get all field names |
| `HVALS key` | Get all values |
| `HLEN key` | Get number of fields |
| `HINCRBY key field amount` | Increment field by integer |
| `HINCRBYFLOAT key field amount` | Increment field by float |

### Sorted Sets

| Command | Notes |
|---------|-------|
| `ZADD key score member [score member ...]` | Add with scores |
| `ZREM key member [member ...]` | Remove members |
| `ZRANGE key start stop` | Get range by index |
| `ZREVRANGE key start stop` | Reverse range |
| `ZRANGEBYSCORE key min max` | Range by score |
| `ZRANK key member` | Get rank |
| `ZREVRANK key member` | Get reverse rank |
| `ZSCORE key member` | Get score |
| `ZCARD key` | Get cardinality |
| `ZINCRBY key amount member` | Increment score |

### HyperLogLog

| Command | Notes |
|---------|-------|
| `PFADD key element [element ...]` | Add elements |
| `PFCOUNT key [key ...]` | Get approximate count |
| `PFMERGE dest source [source ...]` | Merge sketches |

### Streams

| Command | Notes |
|---------|-------|
| `XADD key ID field value` | Append to stream |
| `XLEN key` | Get stream length |
| `XRANGE key start stop` | Read range |
| `XREVRANGE key stop start` | Reverse range |
| `XREAD COUNT count STREAMS key ID` | Read from streams |
| `XDEL key ID [ID ...]` | Delete entries |

### Geo

| Command | Notes |
|---------|-------|
| `GEOADD key longitude latitude member` | Add geo entry |
| `GEODIST key member1 member2` | Distance between members |
| `GEOPOS key member` | Get position |
| `GEORADIUS key longitude latitude radius` | Search by radius |

### Pub/Sub

| Command | Notes |
|---------|-------|
| `SUBSCRIBE channel [channel ...]` | Subscribe to channels |
| `UNSUBSCRIBE [channel ...]` | Unsubscribe |
| `PUBLISH channel message` | Publish message |

### Transactions

| Command | Notes |
|---------|-------|
| `MULTI` | Start transaction |
| `EXEC` | Execute transaction |
| `DISCARD` | Discard transaction |
| `WATCH key [key ...]` | Watch keys for changes |
| `UNWATCH` | Unwatch all keys |

### Server

| Command | Notes |
|---------|-------|
| `DBSIZE` | Number of keys |
| `FLUSHDB` | Clear current database |
| `FLUSHALL` | Clear all databases |
| `KEYS pattern` | Find keys by pattern |
| `SCAN cursor [MATCH pattern]` | Incremental key scan |
| `RANDOMKEY` | Return a random key |
| `INFO` | Server information |
| `TIME` | Server time |
| `SAVE` | Synchronous save |
| `BGSAVE` | Background save |
| `BGREWRITEAOF` | Rewrite AOF |
| `LASTSAVE` | Last save timestamp |
| `SHUTDOWN` | Stop server |
| `DEBUG` | Debug commands |
| `MEMORY` | Memory diagnostics |
| `LATENCY` | Latency diagnostics |
| `SLOWLOG` | Slow query log |
| `ACL` | Access control |
| `CLIENT` | Client commands |
| `CLUSTER` | Cluster commands |
| `COMMAND` | Command info |
| `CONFIG` | Configuration |
| `SWAPDB` | Swap databases |
| `WAIT` | Wait for replication |
| `OBJECT` | Key internals |
| `MIGRATE` | Migrate keys |
| `RESTORE` | Restore key |
| `DUMP` | Serialize key |
| `MODULE` | Load modules |
| `REPLICAOF` | Set replication |
| `SLAVEOF` | Set replication (legacy) |
| `MONITOR` | Stream commands |
| `BITCOUNT` | Count set bits |
| `BITOP` | Bitwise operations |
| `BITPOS` | Find first bit |
| `GETBIT` | Get bit |
| `SETBIT` | Set bit |
| `SETRANGE` | Set range |
| `EVAL` | Lua scripting |
| `EVALSHA` | Lua by SHA |
| `SORT` | Sort list/set/sorted set |
| `PFADD` | HyperLogLog add |
| `PFCOUNT` | HyperLogLog count |
| `PFMERGE` | HyperLogLog merge |

## Surface coverage

Legend: ✅ supported · ◐ accepted-not-enforced · ✓ by design · ⟳ roadmap

| Area | Status | Notes |
|------|--------|-------|
| RESP framing (nested arrays, nil bulk, integer replies) | ✅ | `SCAN`/`SSCAN`/`HSCAN`/`ZSCAN` return `[cursor, [items]]`; `MGET`/`HMGET` return nil for misses |
| Strings: `SET` `GET` `APPEND` `STRLEN` `GETRANGE` `SETRANGE` `GETSET` `GETDEL` `SETNX` `MSET` `MGET` `MSETNX` | ✅ | exercised over the wire |
| Counters: `INCR` `DECR` `INCRBY` `DECRBY` | ✅ | non-integer values return `-ERR value is not an integer or out of range` |
| `INCRBYFLOAT` | ◐ | returns bulk string; no overflow checks |
| Keys: `DEL` `UNLINK` `EXISTS` `EXPIRE`/`PEXPIRE`/`EXPIREAT`/`PEXPIREAT` `TTL`/`PTTL` `PERSIST` `TYPE` `RENAME` `RENAMENX` `KEYS` `SCAN` `RANDOMKEY` `COPY` | ✅ | `TTL` returns `-2` (missing) / `-1` (no expiry) |
| `KEYS` glob | ◐ | supports `*` prefix/suffix/contains, not full glob (`[a-z]`, `?`) |
| Lists: `LPUSH` `RPUSH` `LPOP` `RPOP` `LLEN` `LINDEX` `LSET` `LRANGE` `LREM` `LINSERT` `LPOS` `LMOVE` | ✅ | `LSET`/`RENAME` on missing key return `-ERR no such key` |
| `BLPOP`/`BRPOP` | ◐ | non-blocking — pop if available, else nil (no wait) |
| Sets: `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SCARD` `SUNION` `SINTER` `SDIFF` `SPOP` `SRANDMEMBER` `SSCAN` `SORT` | ✅ | |
| Hashes: `HSET` `HSETNX` `HGET` `HMGET` `HMSET` `HGETALL` `HDEL` `HEXISTS` `HKEYS` `HVALS` `HLEN` `HINCRBY` `HINCRBYFLOAT` `HSCAN` | ✅ | `HSET` returns the count of genuinely new fields |
| Sorted sets: `ZADD` `ZREM` `ZRANGE` `ZREVRANGE` `ZRANGEBYSCORE` `ZRANK` `ZREVRANK` `ZSCORE` `ZCARD` `ZINCRBY` `ZSCAN` | ✅ | base path |
| `ZADD` flags (`NX`/`XX`/`GT`/`LT`/`CH`/`INCR`) | ⟳ | not parsed |
| Pub/Sub: `SUBSCRIBE` `UNSUBSCRIBE` `PUBLISH` | ◐ | messages are delivered to subscribers; single + multi channel; no `PSUBSCRIBE`/pattern matching |
| Transactions: `MULTI` `EXEC` `DISCARD` `WATCH` `UNWATCH` | ◐ | accepted; commands are not queued/isolated |
| Bitmaps: `SETBIT` `GETBIT` `BITCOUNT` `BITPOS` `BITOP` | ◐ | `BITOP`/`BITPOS` simplified |
| HyperLogLog: `PFADD` `PFCOUNT` `PFMERGE` | ◐ | exact-set approximation (not probabilistic) |
| Streams: `XADD` `XLEN` `XRANGE` `XREVRANGE` `XREAD` `XDEL` | ◐ | simplified IDs (not strictly monotonic per ms) |
| Geo: `GEOADD` `GEOPOS` `GEODIST` `GEORADIUS` | ◐ | Euclidean approximation, not haversine |
| Scripting: `EVAL` `EVALSHA` | ✓ | accepted, return nil (no Lua VM by design) |
| Auth / ACL credential enforcement | ✓ | accepted, not enforced (ephemeral in-memory dev pool) |
| Persistence (`SAVE`/`BGSAVE`/AOF) | ✓ | no-op — state is ephemeral by design |
| Clustering / replication | ✓ | single-node by design |

## Error codes & shapes

RESP errors carry the real error code as the first token, so client libraries
that branch on it behave the same as against production Redis:

| Scenario | Reply |
|----------|-------|
| Type mismatch (e.g. `GET` on a list) | `-WRONGTYPE Operation against a key holding the wrong kind of value` |
| `INCR`/`DECR`/`INCRBY`/`DECRBY` on a non-integer value | `-ERR value is not an integer or out of range` |
| `LSET`/`RENAME`/`RENAMENX` on a missing key | `-ERR no such key` |
| Unknown command | `-ERR unknown command '<NAME>'` |
| Wrong argument count | `-ERR wrong number of arguments for '<CMD>' command` |
| Missing key (read) | nil bulk (`$-1`) — e.g. `GET`, `HGET`, `LPOP`, `ZSCORE` |

## Usage

code in your app.

Run it:

```bash

```

Then connect with your normal client. Python:

```python
import redis

r.set("user:1", "alice")
print(r.get("user:1"))
r.incr("counter")
r.expire("counter", 3600)
```

Node:

```javascript
import Redis from "ioredis";

await redis.set("key", "value");
await redis.get("key");
```

### Via MCP (Parlel Sandbox)

When Redis runs inside a Parlel sandbox, drive it through the sandbox's MCP
endpoint with `parlel_execute`. Pass a raw Redis command string as `command`:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "parlel_execute",
    "arguments": { "service": "redis", "command": "SET hello world" }
  }
}
```

The decoded RESP reply is returned as `{ reply: ... }`.

## Seed Data

```bash
# cache-seed.txt
SET user:1 '{"id":1,"name":"Alice","email":"alice@test.com"}'
SET user:2 '{"id":2,"name":"Bob","email":"bob@test.com"}'
SET session:abc '{"userId":1,"role":"admin"}'
EXPIRE session:abc 3600
SET config:theme "dark"
SET config:lang "en"
```

Seed via MCP `parlel_execute`, or run these against the bridge with your normal client.

## Access via Parlel Sandbox

`localhost:6379`. It tunnels the raw RESP protocol as TCP over the sandbox's

by default in a new sandbox.
