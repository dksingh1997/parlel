import { createServer } from "node:http";

const VERSION = "1.18.0";
const DEFAULT_VECTOR_SIZE = 4;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowSeconds(start) {
  return Number(((Date.now() - start) / 1000).toFixed(6));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function normalizeId(id) {
  return typeof id === "number" ? id : String(id);
}

function idKey(id) {
  return String(normalizeId(id));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function vectorSize(vectors) {
  if (Array.isArray(vectors)) return vectors.length;
  if (isObject(vectors) && Number.isFinite(vectors.size)) return vectors.size;
  if (isObject(vectors)) {
    const first = Object.values(vectors)[0];
    if (isObject(first) && Number.isFinite(first.size)) return first.size;
  }
  return DEFAULT_VECTOR_SIZE;
}

function collectionDistance(collection, using) {
  const vectors = collection.config.vectors;
  if (isObject(vectors) && using && isObject(vectors[using])) return vectors[using].distance || "Cosine";
  if (isObject(vectors) && Number.isFinite(vectors.size)) return vectors.distance || "Cosine";
  if (isObject(vectors)) {
    const first = Object.values(vectors)[0];
    if (isObject(first)) return first.distance || "Cosine";
  }
  return "Cosine";
}

function getPathValue(payload = {}, key) {
  return String(key).split(".").reduce((value, part) => (value == null ? undefined : value[part]), payload);
}

function setPathValue(payload, key, value) {
  const parts = String(key).split(".").filter(Boolean);
  if (parts.length === 0) return;
  let target = payload;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(target[part])) target[part] = {};
    target = target[part];
  }
  target[parts[parts.length - 1]] = clone(value);
}

function deletePathValue(payload, key) {
  const parts = String(key).split(".").filter(Boolean);
  if (parts.length === 0) return;
  let target = payload;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(target[part])) return;
    target = target[part];
  }
  delete target[parts[parts.length - 1]];
}

function asVector(value, using) {
  if (Array.isArray(value)) return value.map(Number);
  if (isObject(value) && Array.isArray(value.vector)) return value.vector.map(Number);
  if (isObject(value) && using && Array.isArray(value[using])) return value[using].map(Number);
  if (isObject(value)) {
    const first = Object.values(value).find(Array.isArray);
    if (first) return first.map(Number);
  }
  return [];
}

function dot(a, b) {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i += 1) total += Number(a[i] || 0) * Number(b[i] || 0);
  return total;
}

function magnitude(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + Number(value || 0) ** 2, 0));
}

function scoreVectors(distance, query, candidate) {
  const name = String(distance || "Cosine").toLowerCase();
  if (name === "euclid" || name === "euclidean") {
    return -Math.sqrt(query.reduce((sum, value, index) => sum + (Number(value || 0) - Number(candidate[index] || 0)) ** 2, 0));
  }
  if (name === "dot") return dot(query, candidate);
  return dot(query, candidate) / ((magnitude(query) * magnitude(candidate)) || 1);
}

function averageVectors(vectors) {
  if (vectors.length === 0) return [];
  const length = Math.max(...vectors.map((vector) => vector.length));
  return Array.from({ length }, (_, index) => vectors.reduce((sum, vector) => sum + Number(vector[index] || 0), 0) / vectors.length);
}

function pointResponse(point, withPayload = true, withVector = false) {
  const response = { id: clone(point.id) };
  if (withPayload !== false) response.payload = selectPayload(point.payload, withPayload);
  if (withVector) response.vector = selectVector(point.vector, withVector);
  return response;
}

function selectPayload(payload = {}, selector = true) {
  if (selector === false) return undefined;
  if (selector === true || selector == null) return clone(payload);
  const keys = Array.isArray(selector) ? selector : selector.include || selector.fields || [];
  const excluded = selector.exclude || [];
  if (keys.length === 0) {
    const copy = clone(payload);
    for (const key of excluded) deletePathValue(copy, key);
    return copy;
  }
  const result = {};
  for (const key of keys) {
    const value = getPathValue(payload, key);
    if (value !== undefined) setPathValue(result, key, value);
  }
  return result;
}

function selectVector(vector, selector = false) {
  if (selector === false || selector == null) return undefined;
  if (selector === true) return clone(vector);
  if (Array.isArray(selector) && isObject(vector)) {
    const result = {};
    for (const name of selector) if (vector[name] !== undefined) result[name] = clone(vector[name]);
    return result;
  }
  return clone(vector);
}

function compareMatch(actual, match) {
  if (match == null) return true;
  if (Object.hasOwn(match, "value")) return actual === match.value;
  if (Array.isArray(match.any)) return Array.isArray(actual) ? actual.some((value) => match.any.includes(value)) : match.any.includes(actual);
  if (Array.isArray(match.except)) return Array.isArray(actual) ? actual.every((value) => !match.except.includes(value)) : !match.except.includes(actual);
  if (Object.hasOwn(match, "text")) return String(actual ?? "").toLowerCase().includes(String(match.text).toLowerCase());
  return actual === match;
}

function compareRange(actual, range) {
  const value = Number(actual);
  if (Number.isNaN(value)) return false;
  if (range.gt !== undefined && !(value > range.gt)) return false;
  if (range.gte !== undefined && !(value >= range.gte)) return false;
  if (range.lt !== undefined && !(value < range.lt)) return false;
  if (range.lte !== undefined && !(value <= range.lte)) return false;
  return true;
}

function matchesCondition(point, condition) {
  if (!condition || !isObject(condition)) return true;
  if (condition.has_id) return (condition.has_id || []).map(idKey).includes(idKey(point.id));
  if (condition.is_empty) return getPathValue(point.payload, condition.is_empty.key) === undefined;
  if (condition.is_null) return getPathValue(point.payload, condition.is_null.key) === null;
  if (condition.nested?.filter) return matchesFilter(point, condition.nested.filter);
  if (!condition.key) return true;
  const actual = getPathValue(point.payload, condition.key);
  if (condition.match !== undefined && !compareMatch(actual, condition.match)) return false;
  if (condition.range !== undefined && !compareRange(actual, condition.range)) return false;
  if (condition.values_count !== undefined) {
    const count = Array.isArray(actual) ? actual.length : actual === undefined ? 0 : 1;
    if (!compareRange(count, condition.values_count)) return false;
  }
  if (condition.geo_bounding_box || condition.geo_radius || condition.geo_polygon || condition.datetime_range) return true;
  return condition.match !== undefined || condition.range !== undefined || condition.values_count !== undefined;
}

function normalizeConditions(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesFilter(point, filter) {
  if (!filter) return true;
  const must = normalizeConditions(filter.must);
  const should = normalizeConditions(filter.should);
  const mustNot = normalizeConditions(filter.must_not);
  if (!must.every((condition) => matchesCondition(point, condition))) return false;
  if (should.length > 0 && !should.some((condition) => matchesCondition(point, condition))) return false;
  if (mustNot.some((condition) => matchesCondition(point, condition))) return false;
  if (filter.min_should) {
    const conditions = normalizeConditions(filter.min_should.conditions);
    const min = filter.min_should.min_count || 1;
    if (conditions.filter((condition) => matchesCondition(point, condition)).length < min) return false;
  }
  return true;
}

function usage() {
  return { cpu: 1, payload_io_read: 0, payload_io_write: 0, payload_index_io_read: 0, payload_index_io_write: 0, vector_io_read: 0, vector_io_write: 0 };
}

function operationResult(id = 0) {
  return { operation_id: id, status: "completed" };
}

export class QdrantServer {
  constructor(port = 6333, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.collections = new Map();
    this.aliases = new Map();
    this.fullSnapshots = [];
    this.issues = [];
    this.operationId = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => this.sendError(res, 500, error.message));
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,api-key");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

    if (req.method === "OPTIONS") return this.sendRaw(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.sendResult(res, 200, this.root(), started);
    if (req.method === "GET" && ["healthz", "livez", "readyz"].includes(parts[0])) return this.sendRaw(res, 200, { title: "qdrant - vector search engine", status: "ok" });
    if (req.method === "GET" && parts[0] === "metrics") return this.sendText(res, 200, "qdrant_up 1\n");
    if (req.method === "GET" && parts[0] === "telemetry") return this.sendResult(res, 200, this.telemetry(), started);
    if (parts[0] === "issues") return this.handleIssues(req, res, started);
    if (parts[0] === "cluster") return this.handleCluster(req, res, parts, started);
    if (parts[0] === "aliases" && req.method === "GET") return this.sendResult(res, 200, this.aliasList(), started);
    if (parts[0] === "collections") return this.handleCollections(req, res, parts, url.searchParams, body, started);
    if (parts[0] === "snapshots") return this.handleFullSnapshots(req, res, parts, started);

    return this.sendError(res, 404, `Not found: ${req.method} ${url.pathname}`, started);
  }

  handleIssues(req, res, started) {
    if (req.method === "GET") return this.sendResult(res, 200, { issues: clone(this.issues) }, started);
    if (req.method === "DELETE") {
      this.issues = [];
      return this.sendResult(res, 200, true, started);
    }
    return this.sendError(res, 405, "Method not allowed", started);
  }

  handleCluster(req, res, parts, started) {
    if (req.method === "GET" && parts.length === 1) return this.sendResult(res, 200, { status: "disabled", peer_id: null, peers: {}, raft_info: null, consensus_thread_status: null }, started);
    if (req.method === "GET" && parts[1] === "telemetry") return this.sendResult(res, 200, { enabled: false, peers: {}, transfers: [] }, started);
    if (req.method === "POST" && parts[1] === "recover") return this.sendResult(res, 200, true, started);
    if (req.method === "DELETE" && parts[1] === "peer") return this.sendResult(res, 200, true, started);
    return this.sendError(res, 404, "Cluster endpoint not found", started);
  }

  handleCollections(req, res, parts, params, body, started) {
    if (parts.length === 1 && req.method === "GET") return this.sendResult(res, 200, { collections: this.collectionNames() }, started);
    if (parts.length === 2 && parts[1] === "aliases" && req.method === "POST") return this.updateAliases(res, body, started);
    if (parts.length < 2) return this.sendError(res, 405, "Method not allowed", started);

    const name = this.resolveCollectionName(parts[1]);
    if (parts.length === 2 && req.method === "PUT") return this.createCollection(res, name, body, started);
    if (parts.length === 2 && req.method === "DELETE") return this.deleteCollection(res, name, started);
    if (parts.length === 2 && req.method === "GET") return this.getCollection(res, name, started);
    if (parts.length === 2 && req.method === "PATCH") return this.updateCollection(res, name, body, started);
    if (parts.length === 3 && parts[2] === "exists" && req.method === "GET") return this.sendResult(res, 200, { exists: this.collections.has(name) }, started);

    const collection = this.collections.get(name);
    if (!collection) return this.sendError(res, 404, `Collection ${name} not found`, started);

    if (parts[2] === "points") return this.handlePoints(req, res, collection, parts.slice(3), params, body, started);
    if (parts[2] === "index") return this.handleIndexes(req, res, collection, parts.slice(3), body, started);
    if (parts[2] === "vectors") return this.handleVectorNames(req, res, collection, parts.slice(3), body, started);
    if (parts[2] === "aliases" && req.method === "GET") return this.sendResult(res, 200, this.aliasList(name), started);
    if (parts[2] === "cluster") return this.handleCollectionCluster(req, res, collection, started);
    if (parts[2] === "optimizations" && req.method === "GET") return this.sendResult(res, 200, { status: "ok", optimizer_status: "ok", segments: [] }, started);
    if (parts[2] === "snapshots") return this.handleCollectionSnapshots(req, res, collection, parts.slice(3), body, started);
    if (parts[2] === "shards") return this.handleShards(req, res, collection, parts.slice(3), body, started);
    if (parts[2] === "facet" && req.method === "POST") return this.sendResult(res, 200, this.facet(collection, body), started, true);

    return this.sendError(res, 404, "Collection endpoint not found", started);
  }

  handlePoints(req, res, collection, parts, params, body, started) {
    if (parts.length === 0 && req.method === "PUT") return this.upsertPoints(res, collection, body, started);
    if (parts.length === 0 && req.method === "POST") return this.retrievePoints(res, collection, body, started);
    if (parts.length === 1 && req.method === "GET") return this.getPoint(res, collection, parts[0], started);
    if (parts[0] === "delete" && req.method === "POST") return this.deletePoints(res, collection, body, started);
    if (parts[0] === "vectors" && req.method === "PUT") return this.updateVectors(res, collection, body, started);
    if (parts[0] === "vectors" && parts[1] === "delete" && req.method === "POST") return this.deleteVectors(res, collection, body, started);
    if (parts[0] === "payload" && parts[1] === "delete" && req.method === "POST") return this.deletePayload(res, collection, body, started);
    if (parts[0] === "payload" && parts[1] === "clear" && req.method === "POST") return this.clearPayload(res, collection, body, started);
    if (parts[0] === "payload" && req.method === "PUT") return this.overwritePayload(res, collection, body, started);
    if (parts[0] === "payload" && req.method === "POST") return this.setPayload(res, collection, body, started);
    if (parts[0] === "batch" && req.method === "POST") return this.batchUpdate(res, collection, body, started);
    if (parts[0] === "scroll" && req.method === "POST") return this.sendResult(res, 200, this.scroll(collection, body), started, true);
    if (parts[0] === "search" && parts.length === 1 && req.method === "POST") return this.sendResult(res, 200, this.search(collection, body), started, true);
    if (parts[0] === "search" && parts[1] === "batch" && req.method === "POST") return this.sendResult(res, 200, (body.searches || []).map((search) => this.search(collection, search)), started, true);
    if (parts[0] === "search" && parts[1] === "groups" && req.method === "POST") return this.sendResult(res, 200, this.groups(collection, this.search(collection, body), body), started, true);
    if (parts[0] === "search" && parts[1] === "matrix" && parts[2] === "pairs" && req.method === "POST") return this.sendResult(res, 200, this.matrix(collection, body, "pairs"), started, true);
    if (parts[0] === "search" && parts[1] === "matrix" && parts[2] === "offsets" && req.method === "POST") return this.sendResult(res, 200, this.matrix(collection, body, "offsets"), started, true);
    if (parts[0] === "recommend" && parts.length === 1 && req.method === "POST") return this.sendResult(res, 200, this.recommend(collection, body), started, true);
    if (parts[0] === "recommend" && parts[1] === "batch" && req.method === "POST") return this.sendResult(res, 200, (body.searches || []).map((search) => this.recommend(collection, search)), started, true);
    if (parts[0] === "recommend" && parts[1] === "groups" && req.method === "POST") return this.sendResult(res, 200, this.groups(collection, this.recommend(collection, body), body), started, true);
    if (parts[0] === "discover" && parts.length === 1 && req.method === "POST") return this.sendResult(res, 200, this.discover(collection, body), started, true);
    if (parts[0] === "discover" && parts[1] === "batch" && req.method === "POST") return this.sendResult(res, 200, (body.searches || []).map((search) => this.discover(collection, search)), started, true);
    if (parts[0] === "count" && req.method === "POST") return this.sendResult(res, 200, { count: this.filteredPoints(collection, body.filter).length }, started, true);
    if (parts[0] === "query" && parts.length === 1 && req.method === "POST") return this.sendResult(res, 200, { points: this.query(collection, body) }, started, true);
    if (parts[0] === "query" && parts[1] === "batch" && req.method === "POST") return this.sendResult(res, 200, (body.searches || []).map((search) => ({ points: this.query(collection, search) })), started, true);
    if (parts[0] === "query" && parts[1] === "groups" && req.method === "POST") return this.sendResult(res, 200, this.groups(collection, this.query(collection, body), body), started, true);
    return this.sendError(res, 404, "Points endpoint not found", started);
  }

  createCollection(res, name, body = {}, started) {
    if (this.collections.has(name)) return this.sendError(res, 409, `Collection ${name} already exists`, started);
    const config = {
      vectors: body.vectors || { size: DEFAULT_VECTOR_SIZE, distance: "Cosine" },
      hnsw_config: body.hnsw_config || null,
      optimizer_config: body.optimizers_config || null,
      wal_config: body.wal_config || null,
      quantization_config: body.quantization_config || null,
      strict_mode_config: body.strict_mode_config || null,
      params: {
        vectors: body.vectors || { size: DEFAULT_VECTOR_SIZE, distance: "Cosine" },
        shard_number: body.shard_number || 1,
        sharding_method: body.sharding_method || null,
        replication_factor: body.replication_factor || 1,
        write_consistency_factor: body.write_consistency_factor || 1,
        on_disk_payload: body.on_disk_payload || false,
        sparse_vectors: body.sparse_vectors || {},
      },
    };
    this.collections.set(name, {
      name,
      config,
      points: new Map(),
      payloadIndexes: new Map(),
      vectors: new Set(),
      snapshots: [],
      shardSnapshots: new Map(),
      shardKeys: [],
      operationId: 0,
    });
    return this.sendResult(res, 200, true, started);
  }

  deleteCollection(res, name, started) {
    if (!this.collections.has(name)) return this.sendError(res, 404, `Collection ${name} not found`, started);
    this.collections.delete(name);
    for (const [alias, target] of this.aliases) if (target === name) this.aliases.delete(alias);
    return this.sendResult(res, 200, true, started);
  }

  updateCollection(res, name, body = {}, started) {
    const collection = this.collections.get(name);
    if (!collection) return this.sendError(res, 404, `Collection ${name} not found`, started);
    collection.config = { ...collection.config, ...clone(body) };
    return this.sendResult(res, 200, true, started);
  }

  getCollection(res, name, started) {
    const collection = this.collections.get(name);
    if (!collection) return this.sendError(res, 404, `Collection ${name} not found`, started);
    const points = Array.from(collection.points.values());
    return this.sendResult(res, 200, {
      status: "green",
      optimizer_status: "ok",
      vectors_count: points.length,
      indexed_vectors_count: points.length,
      points_count: points.length,
      segments_count: 1,
      config: clone(collection.config),
      payload_schema: Object.fromEntries(collection.payloadIndexes),
    }, started);
  }

  collectionNames() {
    return Array.from(this.collections.keys()).map((name) => ({ name }));
  }

  resolveCollectionName(name) {
    return this.aliases.get(name) || name;
  }

  aliasList(collectionName) {
    const aliases = Array.from(this.aliases.entries())
      .filter(([, target]) => !collectionName || target === collectionName)
      .map(([alias_name, collection_name]) => ({ alias_name, collection_name }));
    return { aliases };
  }

  updateAliases(res, body = {}, started) {
    for (const action of body.actions || []) {
      if (action.create_alias) this.aliases.set(action.create_alias.alias_name, action.create_alias.collection_name);
      if (action.delete_alias) this.aliases.delete(action.delete_alias.alias_name);
      if (action.rename_alias) {
        const target = this.aliases.get(action.rename_alias.old_alias_name);
        this.aliases.delete(action.rename_alias.old_alias_name);
        if (target) this.aliases.set(action.rename_alias.new_alias_name, target);
      }
    }
    return this.sendResult(res, 200, true, started);
  }

  handleIndexes(req, res, collection, parts, body, started) {
    if (parts.length === 0 && req.method === "PUT") {
      if (!body.field_name) return this.sendError(res, 400, "field_name is required", started);
      collection.payloadIndexes.set(body.field_name, body.field_schema || "keyword");
      return this.sendResult(res, 200, operationResult(++collection.operationId), started);
    }
    if (parts.length === 1 && req.method === "DELETE") {
      collection.payloadIndexes.delete(parts[0]);
      return this.sendResult(res, 200, operationResult(++collection.operationId), started);
    }
    return this.sendError(res, 404, "Index endpoint not found", started);
  }

  handleVectorNames(req, res, collection, parts, body, started) {
    if (parts.length !== 1) return this.sendError(res, 404, "Vector endpoint not found", started);
    if (req.method === "PUT") {
      collection.vectors.add(parts[0]);
      if (!isObject(collection.config.params.vectors) || Number.isFinite(collection.config.params.vectors.size)) collection.config.params.vectors = {};
      collection.config.params.vectors[parts[0]] = clone(body || { size: DEFAULT_VECTOR_SIZE, distance: "Cosine" });
      collection.config.vectors = collection.config.params.vectors;
      return this.sendResult(res, 200, operationResult(++collection.operationId), started);
    }
    if (req.method === "DELETE") {
      collection.vectors.delete(parts[0]);
      if (isObject(collection.config.params.vectors)) delete collection.config.params.vectors[parts[0]];
      for (const point of collection.points.values()) if (isObject(point.vector)) delete point.vector[parts[0]];
      return this.sendResult(res, 200, operationResult(++collection.operationId), started);
    }
    return this.sendError(res, 405, "Method not allowed", started);
  }

  handleCollectionCluster(req, res, collection, started) {
    if (req.method === "GET") return this.sendResult(res, 200, { peer_id: 0, shard_count: 1, local_shards: [{ shard_id: 0, points_count: collection.points.size, state: "Active" }], remote_shards: [], shard_transfers: [] }, started);
    if (req.method === "POST") return this.sendResult(res, 200, true, started);
    return this.sendError(res, 405, "Method not allowed", started);
  }

  handleCollectionSnapshots(req, res, collection, parts, body, started) {
    if (parts.length === 0 && req.method === "GET") return this.sendResult(res, 200, clone(collection.snapshots), started);
    if (parts.length === 0 && req.method === "POST") {
      const snapshot = this.makeSnapshot(`${collection.name}-${collection.snapshots.length + 1}.snapshot`);
      collection.snapshots.push(snapshot);
      return this.sendResult(res, 200, snapshot, started);
    }
    if (parts.length === 1 && parts[0] === "recover" && req.method === "PUT") return this.sendResult(res, 200, true, started);
    if (parts.length === 1 && parts[0] === "upload" && req.method === "POST") return this.sendResult(res, 200, true, started);
    if (parts.length === 1 && req.method === "GET") return this.sendText(res, 200, `snapshot:${parts[0]}\n`, "application/octet-stream");
    if (parts.length === 1 && req.method === "DELETE") {
      collection.snapshots = collection.snapshots.filter((snapshot) => snapshot.name !== parts[0]);
      return this.sendResult(res, 200, true, started);
    }
    return this.sendError(res, 404, "Snapshot endpoint not found", started);
  }

  handleFullSnapshots(req, res, parts, started) {
    if (parts.length === 1 && req.method === "GET") return this.sendResult(res, 200, clone(this.fullSnapshots), started);
    if (parts.length === 1 && req.method === "POST") {
      const snapshot = this.makeSnapshot(`full-${this.fullSnapshots.length + 1}.snapshot`);
      this.fullSnapshots.push(snapshot);
      return this.sendResult(res, 200, snapshot, started);
    }
    if (parts.length === 2 && req.method === "GET") return this.sendText(res, 200, `snapshot:${parts[1]}\n`, "application/octet-stream");
    if (parts.length === 2 && req.method === "DELETE") {
      this.fullSnapshots = this.fullSnapshots.filter((snapshot) => snapshot.name !== parts[1]);
      return this.sendResult(res, 200, true, started);
    }
    return this.sendError(res, 404, "Snapshot endpoint not found", started);
  }

  handleShards(req, res, collection, parts, body, started) {
    if (parts.length === 0 && req.method === "GET") return this.sendResult(res, 200, { shard_keys: clone(collection.shardKeys) }, started);
    if (parts.length === 0 && req.method === "PUT") {
      if (!collection.shardKeys.includes(body.shard_key)) collection.shardKeys.push(body.shard_key);
      return this.sendResult(res, 200, true, started);
    }
    if (parts.length === 1 && parts[0] === "delete" && req.method === "POST") {
      collection.shardKeys = collection.shardKeys.filter((key) => key !== body.shard_key);
      return this.sendResult(res, 200, true, started);
    }
    const shardId = parts[0];
    if (parts.length === 2 && parts[1] === "snapshot" && req.method === "GET") return this.sendText(res, 200, `shard-snapshot:${shardId}\n`, "application/octet-stream");
    if (parts[1] === "snapshots") return this.handleShardSnapshots(req, res, collection, shardId, parts.slice(2), started);
    return this.sendError(res, 404, "Shard endpoint not found", started);
  }

  handleShardSnapshots(req, res, collection, shardId, parts, started) {
    if (!collection.shardSnapshots.has(shardId)) collection.shardSnapshots.set(shardId, []);
    let snapshots = collection.shardSnapshots.get(shardId);
    if (parts.length === 0 && req.method === "GET") return this.sendResult(res, 200, clone(snapshots), started);
    if (parts.length === 0 && req.method === "POST") {
      const snapshot = this.makeSnapshot(`${collection.name}-${shardId}-${snapshots.length + 1}.snapshot`);
      snapshots.push(snapshot);
      return this.sendResult(res, 200, snapshot, started);
    }
    if (parts.length === 1 && ["recover", "upload"].includes(parts[0])) return this.sendResult(res, 200, true, started);
    if (parts.length === 1 && req.method === "GET") return this.sendText(res, 200, `shard-snapshot:${parts[0]}\n`, "application/octet-stream");
    if (parts.length === 1 && req.method === "DELETE") {
      snapshots = snapshots.filter((snapshot) => snapshot.name !== parts[0]);
      collection.shardSnapshots.set(shardId, snapshots);
      return this.sendResult(res, 200, true, started);
    }
    return this.sendError(res, 404, "Shard snapshot endpoint not found", started);
  }

  makeSnapshot(name) {
    return { name, creation_time: new Date().toISOString(), size: 0, checksum: "parlel" };
  }

  upsertPoints(res, collection, body = {}, started) {
    const points = this.normalizePoints(body);
    for (const point of points) {
      if (point.id === undefined || point.id === null) return this.sendError(res, 400, "Point id is required", started);
      collection.points.set(idKey(point.id), { id: normalizeId(point.id), vector: clone(point.vector || []), payload: clone(point.payload || {}) });
    }
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  normalizePoints(body = {}) {
    if (Array.isArray(body.points)) return body.points;
    if (body.batch) {
      return (body.batch.ids || []).map((id, index) => ({ id, vector: body.batch.vectors?.[index], payload: body.batch.payloads?.[index] || {} }));
    }
    return [];
  }

  getPoint(res, collection, id, started) {
    const point = collection.points.get(idKey(id));
    if (!point) return this.sendError(res, 404, `Point ${id} not found`, started);
    return this.sendResult(res, 200, pointResponse(point, true, true), started, true);
  }

  retrievePoints(res, collection, body = {}, started) {
    const result = (body.ids || [])
      .map((id) => collection.points.get(idKey(id)))
      .filter(Boolean)
      .map((point) => pointResponse(point, body.with_payload ?? true, body.with_vector ?? false));
    return this.sendResult(res, 200, result, started, true);
  }

  deletePoints(res, collection, body = {}, started) {
    for (const point of this.selectedPoints(collection, body)) collection.points.delete(idKey(point.id));
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  updateVectors(res, collection, body = {}, started) {
    for (const update of body.points || []) {
      const point = collection.points.get(idKey(update.id));
      if (!point) continue;
      if (isObject(point.vector) && isObject(update.vector)) point.vector = { ...point.vector, ...clone(update.vector) };
      else if (Array.isArray(point.vector) && isObject(update.vector)) point.vector = { default: clone(point.vector), ...clone(update.vector) };
      else point.vector = clone(update.vector);
    }
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  deleteVectors(res, collection, body = {}, started) {
    const names = Array.isArray(body.vector) ? body.vector : [body.vector].filter(Boolean);
    for (const point of this.selectedPoints(collection, body)) {
      if (isObject(point.vector)) for (const name of names) delete point.vector[name];
      else if (names.length > 0) point.vector = [];
    }
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  setPayload(res, collection, body = {}, started) {
    for (const point of this.selectedPoints(collection, body)) {
      if (body.key) setPathValue(point.payload, body.key, body.payload);
      else point.payload = { ...point.payload, ...clone(body.payload || {}) };
    }
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  overwritePayload(res, collection, body = {}, started) {
    for (const point of this.selectedPoints(collection, body)) {
      if (body.key) setPathValue(point.payload, body.key, body.payload);
      else point.payload = clone(body.payload || {});
    }
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  deletePayload(res, collection, body = {}, started) {
    for (const point of this.selectedPoints(collection, body)) for (const key of body.keys || []) deletePathValue(point.payload, key);
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  clearPayload(res, collection, body = {}, started) {
    for (const point of this.selectedPoints(collection, body)) point.payload = {};
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  batchUpdate(res, collection, body = {}, started) {
    for (const op of body.operations || []) {
      if (op.upsert) for (const point of this.normalizePoints(op.upsert)) collection.points.set(idKey(point.id), { id: normalizeId(point.id), vector: clone(point.vector || []), payload: clone(point.payload || {}) });
      if (op.delete) for (const point of this.selectedPoints(collection, op.delete)) collection.points.delete(idKey(point.id));
      if (op.set_payload) for (const point of this.selectedPoints(collection, op.set_payload)) point.payload = { ...point.payload, ...clone(op.set_payload.payload || {}) };
      if (op.overwrite_payload) for (const point of this.selectedPoints(collection, op.overwrite_payload)) point.payload = clone(op.overwrite_payload.payload || {});
      if (op.delete_payload) for (const point of this.selectedPoints(collection, op.delete_payload)) for (const key of op.delete_payload.keys || []) deletePathValue(point.payload, key);
      if (op.clear_payload) for (const point of this.selectedPoints(collection, op.clear_payload)) point.payload = {};
      if (op.update_vectors) for (const update of op.update_vectors.points || []) {
        const point = collection.points.get(idKey(update.id));
        if (point) {
          if (isObject(point.vector) && isObject(update.vector)) point.vector = { ...point.vector, ...clone(update.vector) };
          else if (Array.isArray(point.vector) && isObject(update.vector)) point.vector = { default: clone(point.vector), ...clone(update.vector) };
          else point.vector = clone(update.vector);
        }
      }
      if (op.delete_vectors) for (const point of this.selectedPoints(collection, op.delete_vectors)) if (isObject(point.vector)) for (const name of op.delete_vectors.vector || []) delete point.vector[name];
    }
    return this.sendResult(res, 200, operationResult(++collection.operationId), started);
  }

  selectedPoints(collection, selector = {}) {
    if (selector.points) return selector.points.map((id) => collection.points.get(idKey(id))).filter(Boolean);
    if (selector.ids) return selector.ids.map((id) => collection.points.get(idKey(id))).filter(Boolean);
    if (selector.filter) return this.filteredPoints(collection, selector.filter);
    return Array.from(collection.points.values());
  }

  filteredPoints(collection, filter) {
    return Array.from(collection.points.values()).filter((point) => matchesFilter(point, filter));
  }

  scroll(collection, body = {}) {
    const limit = body.limit ?? 10;
    const points = this.filteredPoints(collection, body.filter).sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    const offsetKey = body.offset === undefined || body.offset === null ? null : idKey(body.offset);
    const start = offsetKey === null ? 0 : Math.max(0, points.findIndex((point) => idKey(point.id) === offsetKey) + 1);
    const page = points.slice(start, start + limit);
    const next = start + limit < points.length ? page[page.length - 1]?.id ?? null : null;
    return { points: page.map((point) => pointResponse(point, body.with_payload ?? true, body.with_vector ?? false)), next_page_offset: next };
  }

  search(collection, body = {}) {
    const query = asVector(body.vector, body.using);
    return this.rank(collection, query, body);
  }

  recommend(collection, body = {}) {
    const positives = (body.positive || []).map((item) => this.resolveVector(collection, item, body.using)).filter((vector) => vector.length > 0);
    const negatives = (body.negative || []).map((item) => this.resolveVector(collection, item, body.using)).filter((vector) => vector.length > 0);
    let query = averageVectors(positives);
    if (negatives.length > 0) {
      const negative = averageVectors(negatives);
      query = query.map((value, index) => value - Number(negative[index] || 0));
    }
    return this.rank(collection, query, body);
  }

  discover(collection, body = {}) {
    const query = this.resolveVector(collection, body.target ?? body.query ?? [], body.using);
    return this.rank(collection, query, body);
  }

  query(collection, body = {}) {
    if (body.query === undefined || body.query === null) return this.rank(collection, [], body);
    if (Array.isArray(body.query)) return this.rank(collection, body.query, body);
    if (isObject(body.query) && body.query.nearest) return this.rank(collection, this.resolveVector(collection, body.query.nearest, body.using), body);
    if (isObject(body.query) && body.query.recommend) return this.recommend(collection, { ...body, ...body.query.recommend });
    if (isObject(body.query) && body.query.discover) return this.discover(collection, { ...body, ...body.query.discover });
    return this.rank(collection, this.resolveVector(collection, body.query, body.using), body);
  }

  rank(collection, query, body = {}) {
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 10;
    const distance = collectionDistance(collection, body.using);
    const points = this.filteredPoints(collection, body.filter || body.query_filter)
      .map((point) => {
        const vector = asVector(point.vector, body.using);
        const score = query.length === 0 ? 1 : scoreVectors(distance, query, vector);
        return { ...pointResponse(point, body.with_payload ?? true, body.with_vector ?? false), score, version: 0 };
      })
      .filter((point) => body.score_threshold === undefined || point.score >= body.score_threshold)
      .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    return points.slice(offset, offset + limit);
  }

  resolveVector(collection, item, using) {
    if (Array.isArray(item) || isObject(item)) return asVector(item, using);
    const point = collection.points.get(idKey(item));
    return point ? asVector(point.vector, using) : [];
  }

  groups(collection, points, body = {}) {
    const groupBy = body.group_by;
    const groupSize = body.group_size ?? 3;
    const limit = body.limit ?? 10;
    const map = new Map();
    for (const point of points) {
      const value = getPathValue(point.payload || {}, groupBy);
      const key = Array.isArray(value) ? value[0] : value;
      if (key === undefined) continue;
      if (!map.has(key)) map.set(key, []);
      if (map.get(key).length < groupSize) map.get(key).push(point);
    }
    return { groups: Array.from(map.entries()).slice(0, limit).map(([id, hits]) => ({ id, hits })) };
  }

  facet(collection, body = {}) {
    const counts = new Map();
    for (const point of this.filteredPoints(collection, body.filter)) {
      const value = getPathValue(point.payload, body.key);
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) if (item !== undefined) counts.set(item, (counts.get(item) || 0) + 1);
    }
    const hits = Array.from(counts.entries()).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, body.limit ?? 10);
    return { hits };
  }

  matrix(collection, body = {}, format) {
    const sample = this.filteredPoints(collection, body.filter).slice(0, body.sample || body.limit || 10);
    if (format === "offsets") {
      const offsets = [];
      const scores = [];
      for (let i = 0; i < sample.length; i += 1) {
        for (let j = 0; j < sample.length; j += 1) {
          if (i === j) continue;
          offsets.push([i, j]);
          scores.push(scoreVectors(collectionDistance(collection, body.using), asVector(sample[i].vector, body.using), asVector(sample[j].vector, body.using)));
        }
      }
      return { ids: sample.map((point) => point.id), offsets, scores };
    }
    const pairs = [];
    for (let i = 0; i < sample.length; i += 1) {
      for (let j = i + 1; j < sample.length; j += 1) {
        pairs.push({ a: sample[i].id, b: sample[j].id, score: scoreVectors(collectionDistance(collection, body.using), asVector(sample[i].vector, body.using), asVector(sample[j].vector, body.using)) });
      }
    }
    return { pairs };
  }

  root() {
    return { title: "qdrant - vector search engine", version: VERSION, commit: "parlel" };
  }

  telemetry() {
    return { app: { name: "qdrant", version: VERSION, commit: "parlel" }, collections: { number_of_collections: this.collections.size }, cluster: { enabled: false } };
  }

  async readBody(req) {
    if (["GET", "HEAD"].includes(req.method || "")) return {};
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (error) {
      return {};
    }
  }

  sendResult(res, statusCode, result, started = Date.now(), includeUsage = false) {
    const body = includeUsage ? { result, status: "ok", time: nowSeconds(started), usage: usage() } : { result, status: "ok", time: nowSeconds(started) };
    return this.sendRaw(res, statusCode, body);
  }

  sendError(res, statusCode, message, started = Date.now()) {
    return this.sendRaw(res, statusCode, { status: { error: String(message) }, time: nowSeconds(started) });
  }

  sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", contentType);
    res.end(text);
  }

  sendRaw(res, statusCode, body) {
    res.statusCode = statusCode;
    if (body === null) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}

export default QdrantServer;
