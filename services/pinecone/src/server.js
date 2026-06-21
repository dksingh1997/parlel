import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const API_VERSION = "2025-01";
const DEFAULT_DIMENSION = 8;
const DEFAULT_NAMESPACE = "";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function normalizeNamespace(namespace) {
  return namespace == null ? DEFAULT_NAMESPACE : String(namespace);
}

function metricName(metric) {
  return metric || "cosine";
}

function errorBody(status, code, message) {
  return { error: { code, message }, status };
}

function hashText(text, dimension = DEFAULT_DIMENSION) {
  const values = Array.from({ length: dimension }, () => 0);
  const source = String(text || "");
  for (let i = 0; i < source.length; i += 1) {
    values[i % dimension] += ((source.charCodeAt(i) % 29) + 1) / 29;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => Number((value / norm).toFixed(6)));
}

function dot(a = [], b = []) {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i += 1) total += Number(a[i] || 0) * Number(b[i] || 0);
  return total;
}

function magnitude(values = []) {
  return Math.sqrt(values.reduce((sum, value) => sum + Number(value || 0) ** 2, 0));
}

function sparseDot(a, b) {
  if (!a?.indices || !b?.indices) return 0;
  const right = new Map(b.indices.map((index, i) => [index, Number(b.values?.[i] || 0)]));
  return a.indices.reduce((sum, index, i) => sum + Number(a.values?.[i] || 0) * Number(right.get(index) || 0), 0);
}

function scoreVector(metric, queryValues, querySparse, vector) {
  const denseScore = metric === "euclidean"
    ? -Math.sqrt(queryValues.reduce((sum, value, i) => sum + (Number(value || 0) - Number(vector.values?.[i] || 0)) ** 2, 0))
    : metric === "dotproduct"
      ? dot(queryValues, vector.values)
      : dot(queryValues, vector.values) / ((magnitude(queryValues) * magnitude(vector.values)) || 1);
  return denseScore + sparseDot(querySparse, vector.sparseValues);
}

function compareValue(actual, operator, expected) {
  switch (operator) {
    case "$eq": return actual === expected;
    case "$ne": return actual !== expected;
    case "$gt": return actual > expected;
    case "$gte": return actual >= expected;
    case "$lt": return actual < expected;
    case "$lte": return actual <= expected;
    case "$in": return Array.isArray(expected) && expected.includes(actual);
    case "$nin": return Array.isArray(expected) && !expected.includes(actual);
    case "$exists": return Boolean(expected) === (actual !== undefined);
    default: return actual === expected;
  }
}

function matchesFilter(metadata = {}, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (Array.isArray(filter.$and)) return filter.$and.every((entry) => matchesFilter(metadata, entry));
  if (Array.isArray(filter.$or)) return filter.$or.some((entry) => matchesFilter(metadata, entry));
  return Object.entries(filter).every(([field, condition]) => {
    if (field.startsWith("$")) return true;
    const actual = metadata[field];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      return Object.entries(condition).every(([operator, expected]) => compareValue(actual, operator, expected));
    }
    return actual === condition;
  });
}

function projectFields(vector, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return clone(vector.metadata || {});
  const projected = {};
  for (const field of fields) {
    if (vector.metadata && Object.hasOwn(vector.metadata, field)) projected[field] = clone(vector.metadata[field]);
  }
  return projected;
}

export class PineconeServer {
  constructor(port = 5081, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.indexes = new Map();
    this.collections = new Map();
    this.backups = new Map();
    this.imports = new Map();
    this.restoreJobs = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, errorBody(500, "INTERNAL", error.message));
        });
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
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Pinecone-API-Version", API_VERSION);

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "actions" && parts[1] === "whoami" && req.method === "GET") return this.send(res, 200, this.whoami());
    if (parts[0] === "indexes") return this.handleIndexes(req, res, parts, url.searchParams, body);
    if (parts[0] === "collections") return this.handleCollections(req, res, parts, body);
    if (parts[0] === "backups") return this.handleBackups(req, res, parts);
    if (parts[0] === "restore-jobs") return this.handleRestoreJobs(req, res, parts);
    if (parts[0] === "embed" || parts[0] === "rerank" || parts[0] === "models" || parts[0] === "inference") return this.handleInference(req, res, parts, url.searchParams, body);

    const indexName = this.firstIndexName();
    if (indexName) return this.handleDataPlane(req, res, indexName, parts, url.searchParams, body);
    return this.send(res, 404, errorBody(404, "NOT_FOUND", "No index selected"));
  }

  handleIndexes(req, res, parts, params, body) {
    if (parts.length === 1 && req.method === "GET") {
      return this.send(res, 200, { indexes: Array.from(this.indexes.values()).map((index) => clone(index.config)) });
    }
    if (parts.length === 1 && req.method === "POST") return this.createIndex(res, body);
    if (parts.length === 2 && parts[1] === "create-for-model" && req.method === "POST") return this.createIndexForModel(res, body);
    if (parts.length === 2 && req.method === "GET") return this.describeIndex(res, parts[1]);
    if (parts.length === 2 && req.method === "DELETE") return this.deleteIndex(res, parts[1]);
    if (parts.length === 2 && req.method === "PATCH") return this.configureIndex(res, parts[1], body);
    if (parts.length === 2 && req.method === "POST" && parts[1] === "create-index-from-backup") return this.createIndexFromBackup(res, body);
    if (parts.length >= 3 && parts[2] === "backups" && req.method === "POST") return this.createBackup(res, parts[1], body);
    if (parts.length >= 3 && parts[2] === "backups" && req.method === "GET") return this.listBackups(res, parts[1]);
    if (parts.length >= 3) return this.handleDataPlane(req, res, parts[1], parts.slice(2), params, body);
    return this.send(res, 405, errorBody(405, "METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  createIndex(res, body = {}) {
    const name = body.name;
    if (!name) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "Index name is required"));
    if (this.indexes.has(name)) return this.send(res, 409, errorBody(409, "ALREADY_EXISTS", `Index ${name} already exists`));
    const dimension = body.dimension ?? body.embed?.dimension ?? DEFAULT_DIMENSION;
    const config = {
      name,
      dimension,
      metric: metricName(body.metric),
      vector_type: body.vector_type || body.vectorType || "dense",
      spec: body.spec || { serverless: { cloud: body.cloud || "aws", region: body.region || "us-east-1" } },
      status: { ready: true, state: "Ready" },
      host: `http://${this.host}:${this.port}/indexes/${encodeURIComponent(name)}`,
      deletion_protection: body.deletion_protection || body.deletionProtection || "disabled",
      tags: body.tags || {},
    };
    if (body.embed) config.embed = clone(body.embed);
    this.indexes.set(name, { config, namespaces: new Map() });
    return this.send(res, 201, clone(config));
  }

  createIndexForModel(res, body = {}) {
    return this.createIndex(res, {
      ...body,
      dimension: body.dimension || body.embed?.dimension || DEFAULT_DIMENSION,
      spec: body.spec || { serverless: { cloud: body.cloud || "aws", region: body.region || "us-east-1" } },
    });
  }

  describeIndex(res, name) {
    const index = this.indexes.get(name);
    if (!index) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Index ${name} not found`));
    return this.send(res, 200, clone(index.config));
  }

  deleteIndex(res, name) {
    const index = this.indexes.get(name);
    if (!index) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Index ${name} not found`));
    if (index.config.deletion_protection === "enabled") {
      return this.send(res, 400, errorBody(400, "FAILED_PRECONDITION", "Deletion protection is enabled"));
    }
    this.indexes.delete(name);
    return this.send(res, 202, {});
  }

  configureIndex(res, name, body = {}) {
    const index = this.indexes.get(name);
    if (!index) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Index ${name} not found`));
    if (body.deletion_protection || body.deletionProtection) index.config.deletion_protection = body.deletion_protection || body.deletionProtection;
    if (body.tags) index.config.tags = clone(body.tags);
    if (body.spec) index.config.spec = clone(body.spec);
    return this.send(res, 200, clone(index.config));
  }

  handleCollections(req, res, parts, body) {
    if (parts.length === 1 && req.method === "GET") return this.send(res, 200, { collections: Array.from(this.collections.values()).map(clone) });
    if (parts.length === 1 && req.method === "POST") {
      const name = body?.name;
      const source = body?.source || body?.source_index;
      if (!name || !source) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "Collection name and source are required"));
      if (!this.indexes.has(source)) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Index ${source} not found`));
      if (this.collections.has(name)) return this.send(res, 409, errorBody(409, "ALREADY_EXISTS", `Collection ${name} already exists`));
      const collection = { name, source, status: "Ready", size: this.totalVectorCount(source), dimension: this.indexes.get(source).config.dimension, created_at: now() };
      this.collections.set(name, collection);
      return this.send(res, 201, clone(collection));
    }
    const collection = this.collections.get(parts[1]);
    if (!collection) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Collection ${parts[1]} not found`));
    if (parts.length === 2 && req.method === "GET") return this.send(res, 200, clone(collection));
    if (parts.length === 2 && req.method === "DELETE") {
      this.collections.delete(parts[1]);
      return this.send(res, 202, {});
    }
    return this.send(res, 405, errorBody(405, "METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  handleBackups(req, res, parts) {
    if (parts.length === 1 && req.method === "GET") return this.send(res, 200, { backups: Array.from(this.backups.values()).map(clone) });
    if (parts.length === 3 && parts[2] === "create-index" && req.method === "POST") return this.createIndexFromBackup(res, { backup_id: parts[1] });
    const backup = this.backups.get(parts[1]);
    if (!backup) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Backup ${parts[1]} not found`));
    if (parts.length === 2 && req.method === "GET") return this.send(res, 200, clone(backup));
    if (parts.length === 2 && req.method === "DELETE") {
      this.backups.delete(parts[1]);
      return this.send(res, 202, {});
    }
    return this.send(res, 405, errorBody(405, "METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  createBackup(res, indexName, body = {}) {
    const index = this.indexes.get(indexName);
    if (!index) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Index ${indexName} not found`));
    const backup = {
      backup_id: `backup-${randomUUID()}`,
      name: body.name || `${indexName}-backup`,
      source_index_name: indexName,
      description: body.description || "",
      status: "Ready",
      dimension: index.config.dimension,
      metric: index.config.metric,
      record_count: this.totalVectorCount(indexName),
      created_at: now(),
    };
    this.backups.set(backup.backup_id, backup);
    return this.send(res, 201, clone(backup));
  }

  listBackups(res, indexName) {
    if (!this.indexes.has(indexName)) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Index ${indexName} not found`));
    const backups = Array.from(this.backups.values()).filter((backup) => backup.source_index_name === indexName).map(clone);
    return this.send(res, 200, { backups });
  }

  createIndexFromBackup(res, body = {}) {
    const backup = this.backups.get(body.backup_id || body.backupId);
    if (!backup) return this.send(res, 404, errorBody(404, "NOT_FOUND", "Backup not found"));
    const indexName = body.name || body.indexName || `${backup.name}-restored`;
    if (this.indexes.has(indexName)) return this.send(res, 409, errorBody(409, "ALREADY_EXISTS", `Index ${indexName} already exists`));
    const config = {
      name: indexName,
      dimension: backup.dimension,
      metric: backup.metric,
      vector_type: "dense",
      spec: { serverless: { cloud: "aws", region: "us-east-1" } },
      status: { ready: true, state: "Ready" },
      host: `http://${this.host}:${this.port}/indexes/${encodeURIComponent(indexName)}`,
      deletion_protection: "disabled",
      tags: {},
    };
    this.indexes.set(indexName, { config, namespaces: new Map() });
    const restoreJob = {
      restore_job_id: `restore-${randomUUID()}`,
      backup_id: backup.backup_id,
      target_index_name: indexName,
      target_index_id: indexName,
      status: "Completed",
      created_at: now(),
      completed_at: now(),
      percent_complete: 100,
    };
    this.restoreJobs.set(restoreJob.restore_job_id, restoreJob);
    return this.send(res, 202, { restore_job_id: restoreJob.restore_job_id, index_id: indexName });
  }

  handleRestoreJobs(req, res, parts) {
    if (parts.length === 1 && req.method === "GET") return this.send(res, 200, { restore_jobs: Array.from(this.restoreJobs.values()).map(clone) });
    const restoreJob = this.restoreJobs.get(parts[1]);
    if (!restoreJob) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Restore job ${parts[1]} not found`));
    if (parts.length === 2 && req.method === "GET") return this.send(res, 200, clone(restoreJob));
    return this.send(res, 405, errorBody(405, "METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  handleDataPlane(req, res, indexName, parts, params, body) {
    const index = this.indexes.get(indexName);
    if (!index) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Index ${indexName} not found`));
    if (parts[0] === "vectors") return this.handleVectors(req, res, index, parts, params, body);
    if (parts[0] === "query" && req.method === "POST") return this.query(res, index, body);
    if (parts[0] === "describe_index_stats" && req.method === "POST") return this.describeIndexStats(res, index, body);
    if (parts[0] === "records") return this.handleRecords(req, res, index, parts, body);
    if (parts[0] === "namespaces") return this.handleNamespaces(req, res, index, parts, body);
    if (parts[0] === "bulk") return this.handleBulk(req, res, parts, body);
    return this.send(res, 404, errorBody(404, "NOT_FOUND", "Route not found"));
  }

  handleVectors(req, res, index, parts, params, body) {
    if (parts[1] === "upsert" && req.method === "POST") return this.upsert(res, index, body);
    if (parts[1] === "fetch" && req.method === "POST") return this.fetchVectors(res, index, body?.ids || [], body?.namespace);
    if (parts[1] === "fetch" && req.method === "GET") return this.fetchVectors(res, index, params.getAll("ids"), params.get("namespace"));
    if (parts[1] === "fetch_by_metadata" && req.method === "POST") return this.fetchVectorsByMetadata(res, index, body);
    if (parts[1] === "update" && req.method === "POST") return this.updateVector(res, index, body);
    if (parts[1] === "delete" && req.method === "POST") return this.deleteVectors(res, index, body);
    if (parts[1] === "list" && req.method === "GET") return this.listVectors(res, index, params);
    if ((parts[1] === "upsert_records" || parts[1] === "upsertRecords") && req.method === "POST") return this.upsertRecords(res, index, body?.namespace, body?.records || []);
    return this.send(res, 404, errorBody(404, "NOT_FOUND", "Vector route not found"));
  }

  upsert(res, index, body = {}) {
    const vectors = body.vectors;
    if (!Array.isArray(vectors)) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "vectors must be an array"));
    const namespace = this.namespace(index, body.namespace);
    for (const vector of vectors) {
      if (!vector.id) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "Vector id is required"));
      if (index.config.vector_type !== "sparse" && vector.values && vector.values.length !== index.config.dimension) {
        return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", `Vector dimension ${vector.values.length} does not match index dimension ${index.config.dimension}`));
      }
      namespace.set(String(vector.id), {
        id: String(vector.id),
        values: Array.isArray(vector.values) ? vector.values.map(Number) : [],
        sparseValues: clone(vector.sparseValues || vector.sparse_values),
        metadata: clone(vector.metadata || {}),
      });
    }
    return this.send(res, 200, { upsertedCount: vectors.length });
  }

  fetchVectors(res, index, ids, namespaceName) {
    const namespace = this.namespace(index, namespaceName, false);
    const vectors = {};
    for (const id of ids || []) {
      const vector = namespace?.get(String(id));
      if (vector) vectors[String(id)] = this.vectorResponse(vector, true, true);
    }
    return this.send(res, 200, { vectors, namespace: normalizeNamespace(namespaceName) });
  }

  fetchVectorsByMetadata(res, index, body = {}) {
    const namespace = this.namespace(index, body.namespace, false);
    const limit = Math.max(1, Number(body.limit || 100));
    const start = Math.max(0, Number(body.paginationToken || body.pagination_token || 0));
    const matches = Array.from(namespace?.values() || []).filter((vector) => matchesFilter(vector.metadata, body.filter));
    const vectors = {};
    for (const vector of matches.slice(start, start + limit)) vectors[vector.id] = this.vectorResponse(vector, true, true);
    const response = { vectors, namespace: normalizeNamespace(body.namespace), usage: { readUnits: 1 } };
    if (start + limit < matches.length) response.pagination = { next: String(start + limit) };
    return this.send(res, 200, response);
  }

  updateVector(res, index, body = {}) {
    if (!body.id) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "Vector id is required"));
    const namespace = this.namespace(index, body.namespace);
    const existing = namespace.get(String(body.id));
    if (!existing) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Vector ${body.id} not found`));
    if (body.values) existing.values = body.values.map(Number);
    if (body.sparseValues || body.sparse_values) existing.sparseValues = clone(body.sparseValues || body.sparse_values);
    if (body.setMetadata || body.set_metadata) existing.metadata = { ...existing.metadata, ...clone(body.setMetadata || body.set_metadata) };
    if (body.metadata) existing.metadata = clone(body.metadata);
    return this.send(res, 200, {});
  }

  deleteVectors(res, index, body = {}) {
    const namespace = this.namespace(index, body.namespace);
    if (body.deleteAll || body.delete_all) {
      const count = namespace.size;
      namespace.clear();
      return this.send(res, 200, { deletedCount: count });
    }
    let deletedCount = 0;
    if (Array.isArray(body.ids)) {
      for (const id of body.ids) {
        if (namespace.delete(String(id))) deletedCount += 1;
      }
    } else if (body.filter) {
      for (const [id, vector] of namespace) {
        if (matchesFilter(vector.metadata, body.filter)) {
          namespace.delete(id);
          deletedCount += 1;
        }
      }
    } else {
      return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "ids, filter, or deleteAll is required"));
    }
    return this.send(res, 200, { deletedCount });
  }

  query(res, index, body = {}) {
    const topK = Number(body.topK || body.top_k || 10);
    let queryValues = body.vector || body.values || [];
    if (body.id) {
      const source = this.namespace(index, body.namespace, false)?.get(String(body.id));
      if (!source) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Vector ${body.id} not found`));
      queryValues = source.values;
    }
    if (!Array.isArray(queryValues)) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "Query vector is required"));
    const namespace = this.namespace(index, body.namespace, false);
    const matches = Array.from(namespace?.values() || [])
      .filter((vector) => matchesFilter(vector.metadata, body.filter))
      .map((vector) => ({ vector, score: scoreVector(index.config.metric, queryValues, body.sparseVector || body.sparse_vector, vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ vector, score }) => ({ ...this.vectorResponse(vector, Boolean(body.includeValues), Boolean(body.includeMetadata)), score }));
    return this.send(res, 200, { matches, namespace: normalizeNamespace(body.namespace), usage: { readUnits: 1 } });
  }

  listVectors(res, index, params) {
    const namespaceName = params.get("namespace");
    const prefix = params.get("prefix") || "";
    const limit = Math.max(1, Number(params.get("limit") || 100));
    const start = Math.max(0, Number(params.get("paginationToken") || params.get("pagination_token") || 0));
    const ids = Array.from(this.namespace(index, namespaceName, false)?.keys() || []).filter((id) => id.startsWith(prefix)).sort();
    const page = ids.slice(start, start + limit).map((id) => ({ id }));
    const next = start + limit < ids.length ? String(start + limit) : undefined;
    const response = { vectors: page, namespace: normalizeNamespace(namespaceName) };
    if (next) response.pagination = { next };
    return this.send(res, 200, response);
  }

  describeIndexStats(res, index, body = {}) {
    const namespaces = {};
    let total = 0;
    for (const [name, vectors] of index.namespaces) {
      const count = Array.from(vectors.values()).filter((vector) => matchesFilter(vector.metadata, body.filter)).length;
      if (count > 0 || !body.filter) namespaces[name] = { vectorCount: count };
      total += count;
    }
    return this.send(res, 200, {
      dimension: index.config.dimension,
      indexFullness: 0,
      totalVectorCount: total,
      namespaces,
    });
  }

  handleRecords(req, res, index, parts, body = {}) {
    if (parts[1] === "namespaces" && parts[3] === "upsert" && req.method === "POST") return this.upsertRecords(res, index, parts[2], body.records || []);
    if (parts[1] === "namespaces" && parts[3] === "search" && req.method === "POST") return this.searchRecords(res, index, parts[2], body);
    return this.send(res, 404, errorBody(404, "NOT_FOUND", "Record route not found"));
  }

  upsertRecords(res, index, namespaceName, records) {
    if (!Array.isArray(records)) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "records must be an array"));
    const namespace = this.namespace(index, namespaceName);
    for (const record of records) {
      const id = record._id || record.id;
      if (!id) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "Record _id is required"));
      const text = record.chunk_text || record.text || Object.values(record).join(" ");
      const metadata = { ...clone(record) };
      delete metadata.id;
      delete metadata._id;
      delete metadata.values;
      namespace.set(String(id), { id: String(id), values: record.values || hashText(text, index.config.dimension), metadata, sparseValues: clone(record.sparseValues) });
    }
    return this.send(res, 200, { upsertedCount: records.length });
  }

  searchRecords(res, index, namespaceName, body = {}) {
    const query = body.query || {};
    const topK = Number(query.topK || query.top_k || body.topK || 10);
    const queryValues = query.vector?.values || query.vector || body.vector || hashText(query.inputs?.text || body.inputs?.text || body.query?.text || "", index.config.dimension);
    const namespace = this.namespace(index, namespaceName, false);
    const hits = Array.from(namespace?.values() || [])
      .filter((vector) => matchesFilter(vector.metadata, query.filter || body.filter))
      .map((vector) => ({ _id: vector.id, _score: scoreVector(index.config.metric, queryValues, query.sparseVector, vector), fields: projectFields(vector, body.fields) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, topK);
    return this.send(res, 200, { result: { hits }, usage: { readUnits: 1 } });
  }

  handleNamespaces(req, res, index, parts, body = {}) {
    if (parts.length === 1 && req.method === "POST") {
      if (!body?.name) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "Namespace name is required"));
      const namespace = this.namespace(index, body.name);
      return this.send(res, 201, { name: body.name, record_count: namespace.size, schema: clone(body.schema) });
    }
    if (parts.length === 1 && req.method === "GET") {
      return this.send(res, 200, { namespaces: Array.from(index.namespaces.entries()).map(([name, vectors]) => ({ name, record_count: vectors.size })) });
    }
    const namespaceName = normalizeNamespace(parts[1]);
    const namespace = this.namespace(index, namespaceName, false);
    if (!namespace) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Namespace ${namespaceName} not found`));
    if (parts.length === 2 && req.method === "GET") return this.send(res, 200, { name: namespaceName, record_count: namespace.size });
    if (parts.length === 2 && req.method === "DELETE") {
      index.namespaces.delete(namespaceName);
      return this.send(res, 202, {});
    }
    return this.send(res, 405, errorBody(405, "METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  handleBulk(req, res, parts, body = {}) {
    if (parts[1] !== "imports") return this.send(res, 404, errorBody(404, "NOT_FOUND", "Bulk route not found"));
    if (parts.length === 2 && req.method === "POST") {
      if (!body.uri) return this.send(res, 400, errorBody(400, "INVALID_ARGUMENT", "Import uri is required"));
      const id = `import-${randomUUID()}`;
      this.imports.set(id, { id, uri: body.uri, status: "Completed", created_at: now(), finished_at: now(), percent_complete: 100, records_imported: 0 });
      return this.send(res, 201, { id });
    }
    if (parts.length === 2 && req.method === "GET") return this.send(res, 200, { imports: Array.from(this.imports.values()).map(clone) });
    const importJob = this.imports.get(parts[2]);
    if (!importJob) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Import ${parts[2]} not found`));
    if (parts.length === 3 && req.method === "GET") return this.send(res, 200, clone(importJob));
    if (parts.length === 3 && req.method === "DELETE") {
      importJob.status = "Cancelled";
      importJob.finished_at = now();
      return this.send(res, 200, {});
    }
    return this.send(res, 405, errorBody(405, "METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  handleInference(req, res, parts, params, body = {}) {
    const operation = parts[0] === "inference" ? parts[1] : parts[0];
    if (operation === "models" && req.method === "GET" && parts.length === 1) {
      const models = this.models().filter((model) => (!params.get("type") || model.type === params.get("type")) && (!params.get("vector_type") || model.vector_type === params.get("vector_type")));
      return this.send(res, 200, { models });
    }
    if (parts[0] === "models" && parts.length === 2 && req.method === "GET") {
      const model = this.models().find((entry) => entry.model === parts[1]);
      if (!model) return this.send(res, 404, errorBody(404, "NOT_FOUND", `Model ${parts[1]} not found`));
      return this.send(res, 200, model);
    }
    if (operation === "embed" && req.method === "POST") {
      const inputs = Array.isArray(body.inputs) ? body.inputs : [];
      const dimension = Number(body.parameters?.dimension || body.dimension || DEFAULT_DIMENSION);
      return this.send(res, 200, {
        model: body.model || "multilingual-e5-large",
        vector_type: "dense",
        data: inputs.map((input) => ({ values: hashText(typeof input === "string" ? input : input.text, dimension) })),
        usage: { total_tokens: inputs.reduce((sum, input) => sum + String(typeof input === "string" ? input : input.text || "").split(/\s+/).filter(Boolean).length, 0) },
      });
    }
    if (operation === "rerank" && req.method === "POST") {
      const documents = Array.isArray(body.documents) ? body.documents : [];
      const queryWords = new Set(String(body.query || "").toLowerCase().split(/\W+/).filter(Boolean));
      const ranked = documents.map((document, index) => {
        const text = typeof document === "string" ? document : Object.values(document || {}).join(" ");
        const words = String(text).toLowerCase().split(/\W+/).filter(Boolean);
        const score = words.filter((word) => queryWords.has(word)).length / Math.max(1, words.length);
        const entry = { index, score };
        if (body.return_documents !== false && body.returnDocuments !== false) entry.document = clone(document);
        return entry;
      }).sort((a, b) => b.score - a.score).slice(0, body.top_n || body.topN || documents.length);
      return this.send(res, 200, { model: body.model || "bge-reranker-v2-m3", data: ranked, usage: { rerank_units: documents.length ? 1 : 0 } });
    }
    return this.send(res, 404, errorBody(404, "NOT_FOUND", "Inference route not found"));
  }

  models() {
    return [
      {
        model: "multilingual-e5-large",
        short_description: "Deterministic parlel dense embedding fake",
        type: "embed",
        vector_type: "dense",
        default_dimension: DEFAULT_DIMENSION,
        modality: "text",
        max_sequence_length: 512,
        max_batch_size: 96,
        provider_name: "parlel",
        supported_dimensions: [DEFAULT_DIMENSION, 384, 768, 1024],
        supported_metrics: ["cosine", "dotproduct"],
        supported_parameters: [],
      },
      {
        model: "bge-reranker-v2-m3",
        short_description: "Deterministic parlel reranker fake",
        type: "rerank",
        modality: "text",
        max_sequence_length: 512,
        max_batch_size: 100,
        provider_name: "parlel",
        supported_parameters: [],
      },
    ];
  }

  namespace(index, namespaceName, create = true) {
    const name = normalizeNamespace(namespaceName);
    if (!index.namespaces.has(name) && create) index.namespaces.set(name, new Map());
    return index.namespaces.get(name);
  }

  vectorResponse(vector, includeValues, includeMetadata) {
    const response = { id: vector.id };
    if (includeValues) response.values = clone(vector.values);
    if (vector.sparseValues) response.sparseValues = clone(vector.sparseValues);
    if (includeMetadata) response.metadata = clone(vector.metadata || {});
    return response;
  }

  totalVectorCount(indexName) {
    const index = this.indexes.get(indexName);
    if (!index) return 0;
    let count = 0;
    for (const namespace of index.namespaces.values()) count += namespace.size;
    return count;
  }

  firstIndexName() {
    return this.indexes.keys().next().value;
  }

  root() {
    return { name: "pinecone", version: API_VERSION, tagline: "parlel lightweight Pinecone-compatible service" };
  }

  whoami() {
    return { project_name: "parlel", project_id: "parlel-local", user_label: "parlel", user_id: "parlel-local-user" };
  }

  async readBody(req) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) return {};
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  send(res, status, body) {
    res.writeHead(status);
    if (status === 204 || body === null) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
