import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const VERSION = "1.12.0";

const DEFAULT_SETTINGS = {
  displayedAttributes: ["*"],
  searchableAttributes: ["*"],
  filterableAttributes: [],
  sortableAttributes: [],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  stopWords: [],
  synonyms: {},
  distinctAttribute: null,
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 5, twoTypos: 9 },
    disableOnWords: [],
    disableOnAttributes: [],
  },
  faceting: { maxValuesPerFacet: 100, sortFacetValuesBy: { "*": "alpha" } },
  pagination: { maxTotalHits: 1000 },
  proximityPrecision: "byWord",
  separatorTokens: [],
  nonSeparatorTokens: [],
  dictionary: [],
  embedders: {},
  searchCutoffMs: null,
  localizedAttributes: null,
  facetSearch: true,
  prefixSearch: "indexingTime",
  chat: { description: null, documentTemplate: null, documentTemplateMaxBytes: 400, searchParameters: {} },
};

const SETTING_ENDPOINTS = new Map([
  ["displayed-attributes", "displayedAttributes"],
  ["searchable-attributes", "searchableAttributes"],
  ["filterable-attributes", "filterableAttributes"],
  ["sortable-attributes", "sortableAttributes"],
  ["ranking-rules", "rankingRules"],
  ["stop-words", "stopWords"],
  ["synonyms", "synonyms"],
  ["distinct-attribute", "distinctAttribute"],
  ["typo-tolerance", "typoTolerance"],
  ["faceting", "faceting"],
  ["pagination", "pagination"],
  ["proximity-precision", "proximityPrecision"],
  ["separator-tokens", "separatorTokens"],
  ["non-separator-tokens", "nonSeparatorTokens"],
  ["dictionary", "dictionary"],
  ["embedders", "embedders"],
  ["search-cutoff-ms", "searchCutoffMs"],
  ["localized-attributes", "localizedAttributes"],
  ["facet-search", "facetSearch"],
  ["prefix-search", "prefixSearch"],
  ["chat", "chat"],
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function normalizeUid(uid) {
  return decodeURIComponent(uid || "");
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map(normalizeUid);
}

function errorBody(message, code, type = "invalid_request", link = `https://docs.meilisearch.com/errors#${code}`) {
  return { message, code, type, link };
}

function fieldValue(doc, field) {
  return String(field).split(".").reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

function inferPrimaryKey(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  for (const key of Object.keys(doc)) {
    const lower = key.toLowerCase();
    if (lower === "id" || lower.endsWith("_id") || lower.endsWith("id")) return key;
  }
  return null;
}

function matchesQuery(doc, query, searchableAttributes) {
  if (!query) return true;
  const needle = String(query).toLowerCase();
  const fields = Array.isArray(searchableAttributes) && !searchableAttributes.includes("*")
    ? searchableAttributes
    : Object.keys(doc || {});
  return fields.some((field) => JSON.stringify(fieldValue(doc, field) ?? "").toLowerCase().includes(needle));
}

function matchesFilter(doc, filter) {
  if (!filter) return true;
  if (Array.isArray(filter)) return filter.every((entry) => matchesFilter(doc, entry));
  const clauses = String(filter).split(/\s+AND\s+/i);
  return clauses.every((clause) => {
    const match = clause.trim().match(/^([\w.]+)\s*(=|!=|>=|<=|>|<)\s*(.+)$/);
    if (!match) return true;
    const [, field, operator, rawExpected] = match;
    const actual = fieldValue(doc, field);
    let expected = rawExpected.trim().replace(/^['"]|['"]$/g, "");
    if (/^-?\d+(\.\d+)?$/.test(expected)) expected = Number(expected);
    switch (operator) {
      case "=": return actual === expected || String(actual) === String(expected);
      case "!=": return actual !== expected && String(actual) !== String(expected);
      case ">": return Number(actual) > Number(expected);
      case ">=": return Number(actual) >= Number(expected);
      case "<": return Number(actual) < Number(expected);
      case "<=": return Number(actual) <= Number(expected);
      default: return true;
    }
  });
}

function sortHits(hits, sort) {
  if (!Array.isArray(sort) || sort.length === 0) return hits;
  return [...hits].sort((a, b) => {
    for (const rule of sort) {
      const [field, direction = "asc"] = String(rule).split(":");
      const av = fieldValue(a, field);
      const bv = fieldValue(b, field);
      if (av === bv) continue;
      const result = av > bv ? 1 : -1;
      return direction.toLowerCase() === "desc" ? -result : result;
    }
    return 0;
  });
}

function projectDocument(doc, fields) {
  if (!fields || fields.length === 0 || fields.includes("*")) return clone(doc);
  const projected = {};
  for (const field of fields) {
    const value = fieldValue(doc, field);
    if (value !== undefined) projected[field] = clone(value);
  }
  return projected;
}

function parseFields(params, body) {
  const raw = body?.attributesToRetrieve ?? body?.fields ?? params.get("fields") ?? params.get("attributesToRetrieve");
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  return String(raw).split(",").map((field) => field.trim()).filter(Boolean);
}

function taskSummary(task) {
  return {
    taskUid: task.uid,
    indexUid: task.indexUid ?? null,
    status: task.status,
    type: task.type,
    enqueuedAt: task.enqueuedAt,
  };
}

function indexResponse(index) {
  return {
    uid: index.uid,
    primaryKey: index.primaryKey,
    createdAt: index.createdAt,
    updatedAt: index.updatedAt,
  };
}

export class MeilisearchServer {
  constructor(port = 7700, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    this.indexes = new Map();
    this.tasks = [];
    this.batches = [];
    this.dumps = new Map();
    this.snapshots = [];
    this.experimentalFeatures = {
      vectorStore: false,
      metrics: false,
      logsRoute: false,
      editDocumentsByFunction: false,
      containsFilter: false,
      network: false,
    };
    this.dynamicSearchRules = new Map();
    this.webhooks = new Map();
    this.chatWorkspaces = new Map();
    this.network = { self: null, remotes: {}, shards: {} };
    this.keys = new Map();
    this.uidCounter = 0;
    const adminKey = this.makeKey({
      name: "Default Admin API Key",
      description: "Default key for the parlel Meilisearch fake",
      actions: ["*"],
      indexes: ["*"],
      expiresAt: null,
    }, "masterKey");
    this.keys.set(adminKey.key, adminKey);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, errorBody(error.message, "internal", "internal"));
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
    res.setHeader("X-Meilisearch-Version", VERSION);

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "available" });
    if (req.method === "GET" && parts[0] === "version") return this.send(res, 200, { commitSha: "parlel", commitDate: now(), pkgVersion: VERSION });
    if (req.method === "GET" && parts[0] === "stats") return this.send(res, 200, this.globalStats());
    if (parts[0] === "indexes") return this.handleIndexes(req, res, parts, url.searchParams, body);
    if (parts[0] === "tasks") return this.handleTasks(req, res, parts, url.searchParams);
    if (parts[0] === "batches") return this.handleBatches(req, res, parts, url.searchParams);
    if (parts[0] === "keys") return this.handleKeys(req, res, parts, url.searchParams, body);
    if (parts[0] === "multi-search" && req.method === "POST") return this.handleMultiSearch(res, body);
    if (parts[0] === "swap-indexes" && req.method === "POST") return this.handleSwapIndexes(res, body);
    if (parts[0] === "dumps") return this.handleDumps(req, res, parts);
    if (parts[0] === "snapshots" && req.method === "POST") return this.handleSnapshot(res);
    if (parts[0] === "experimental-features") return this.handleExperimental(req, res, body);
    if (parts[0] === "dynamic-search-rules") return this.handleDynamicSearchRules(req, res, parts, body);
    if (parts[0] === "webhooks") return this.handleWebhooks(req, res, parts, body);
    if (parts[0] === "network") return this.handleNetwork(req, res, body);
    if (parts[0] === "chats") return this.handleChats(req, res, parts, body);

    return this.notFound(res, url.pathname);
  }

  async readBody(req) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) return undefined;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) return undefined;
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("application/x-ndjson")) {
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }
    if (contentType.includes("text/csv")) return this.parseCsv(raw);
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  parseCsv(raw) {
    const [headerLine, ...lines] = raw.trim().split(/\r?\n/);
    if (!headerLine) return [];
    const headers = headerLine.split(",").map((header) => header.trim());
    return lines.filter(Boolean).map((line) => {
      const values = line.split(",").map((value) => value.trim());
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    });
  }

  send(res, status, payload) {
    res.writeHead(status);
    if (payload === null) res.end();
    else res.end(JSON.stringify(payload));
  }

  notFound(res, path) {
    return this.send(res, 404, errorBody(`The path ${path} could not be found.`, "not_found", "invalid_request"));
  }

  root() {
    return {
      status: "Meilisearch is running",
      version: { commitSha: "parlel", commitDate: now(), pkgVersion: VERSION },
    };
  }

  createTask(type, indexUid = null, details = {}) {
    const timestamp = now();
    const task = {
      uid: ++this.uidCounter,
      indexUid,
      status: "succeeded",
      type,
      details,
      error: null,
      canceledBy: null,
      duration: "PT0S",
      enqueuedAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
    };
    this.tasks.push(task);
    this.batches.push({ uid: task.uid, details: { receivedDocuments: details.receivedDocuments ?? 0 }, stats: { totalNbTasks: 1 }, startedAt: timestamp, finishedAt: timestamp, duration: "PT0S" });
    return task;
  }

  createIndex(uid, primaryKey = null) {
    const timestamp = now();
    const index = {
      uid,
      primaryKey,
      createdAt: timestamp,
      updatedAt: timestamp,
      documents: new Map(),
      settings: clone(DEFAULT_SETTINGS),
    };
    this.indexes.set(uid, index);
    return index;
  }

  getIndexOrError(res, uid) {
    const index = this.indexes.get(uid);
    if (!index) {
      this.send(res, 404, errorBody(`Index ${uid} not found.`, "index_not_found", "invalid_request"));
      return null;
    }
    return index;
  }

  handleIndexes(req, res, parts, params, body) {
    if (parts.length === 1 && req.method === "GET") {
      const offset = Number(params.get("offset") || 0);
      const limit = Number(params.get("limit") || 20);
      const all = [...this.indexes.values()].map(indexResponse);
      return this.send(res, 200, { results: all.slice(offset, offset + limit), offset, limit, total: all.length });
    }
    if (parts.length === 1 && req.method === "POST") {
      if (!body?.uid) return this.send(res, 400, errorBody("Missing required field `uid`.", "missing_index_uid", "invalid_request"));
      if (this.indexes.has(body.uid)) return this.send(res, 400, errorBody(`Index ${body.uid} already exists.`, "index_already_exists", "invalid_request"));
      this.createIndex(body.uid, body.primaryKey ?? null);
      return this.send(res, 202, taskSummary(this.createTask("indexCreation", body.uid, { primaryKey: body.primaryKey ?? null })));
    }

    const uid = parts[1];
    if (!uid) return this.notFound(res, "/indexes");
    if (parts.length === 2) return this.handleSingleIndex(req, res, uid, body);

    const section = parts[2];
    if (section === "documents") return this.handleDocuments(req, res, uid, parts.slice(3), params, body);
    if (section === "search") return this.handleSearch(req, res, uid, params, body);
    if (section === "facet-search") return this.handleFacetSearch(res, uid, body);
    if (section === "similar") return this.handleSimilar(res, uid, body);
    if (section === "settings") return this.handleSettings(req, res, uid, parts.slice(3), body);
    if (section === "stats" && req.method === "GET") return this.send(res, 200, this.indexStats(uid));
    if (section === "fields" && req.method === "POST") return this.handleFields(res, uid, body);

    return this.notFound(res, `/indexes/${uid}/${section}`);
  }

  handleSingleIndex(req, res, uid, body) {
    if (req.method === "GET") {
      const index = this.getIndexOrError(res, uid);
      if (!index) return;
      return this.send(res, 200, indexResponse(index));
    }
    if (req.method === "PATCH") {
      const index = this.getIndexOrError(res, uid);
      if (!index) return;
      if (Object.prototype.hasOwnProperty.call(body || {}, "primaryKey")) index.primaryKey = body.primaryKey;
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("indexUpdate", uid, { primaryKey: index.primaryKey })));
    }
    if (req.method === "DELETE") {
      if (!this.indexes.has(uid)) return this.send(res, 404, errorBody(`Index ${uid} not found.`, "index_not_found", "invalid_request"));
      this.indexes.delete(uid);
      return this.send(res, 202, taskSummary(this.createTask("indexDeletion", uid)));
    }
    return this.notFound(res, `/indexes/${uid}`);
  }

  handleDocuments(req, res, uid, tail, params, body) {
    const index = this.getIndexOrError(res, uid);
    if (!index) return;

    if (tail.length === 0 && ["POST", "PUT"].includes(req.method)) {
      const docs = Array.isArray(body) ? body : [body].filter(Boolean);
      const primaryKey = params.get("primaryKey") || index.primaryKey || inferPrimaryKey(docs[0]);
      if (!primaryKey) return this.send(res, 400, errorBody("The document identifier could not be inferred.", "index_primary_key_no_candidate_found", "invalid_request"));
      if (!index.primaryKey) index.primaryKey = primaryKey;
      for (const doc of docs) {
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) return this.send(res, 400, errorBody("Documents must be objects.", "invalid_document", "invalid_request"));
        if (doc[primaryKey] === undefined || doc[primaryKey] === null) return this.send(res, 400, errorBody(`Document is missing primary key ${primaryKey}.`, "missing_document_id", "invalid_request"));
        const id = String(doc[primaryKey]);
        const previous = index.documents.get(id) || {};
        index.documents.set(id, req.method === "PUT" ? { ...previous, ...clone(doc) } : clone(doc));
      }
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("documentAdditionOrUpdate", uid, { receivedDocuments: docs.length, indexedDocuments: docs.length })));
    }

    if (tail.length === 0 && req.method === "GET") {
      const offset = Number(params.get("offset") || 0);
      const limit = Number(params.get("limit") || 20);
      const fields = parseFields(params);
      const docs = [...index.documents.values()].map((doc) => projectDocument(doc, fields));
      return this.send(res, 200, { results: docs.slice(offset, offset + limit), offset, limit, total: docs.length });
    }

    if (tail[0] === "fetch" && req.method === "POST") {
      const offset = Number(body?.offset ?? 0);
      const limit = Number(body?.limit ?? 20);
      const fields = parseFields(params, body);
      const docs = [...index.documents.values()]
        .filter((doc) => matchesFilter(doc, body?.filter))
        .map((doc) => projectDocument(doc, fields));
      return this.send(res, 200, { results: docs.slice(offset, offset + limit), offset, limit, total: docs.length });
    }

    if (tail.length === 0 && req.method === "DELETE") {
      const count = index.documents.size;
      index.documents.clear();
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("documentDeletion", uid, { deletedDocuments: count })));
    }

    if (tail[0] === "delete-batch" && req.method === "POST") {
      const ids = Array.isArray(body) ? body : [];
      let deleted = 0;
      for (const id of ids) if (index.documents.delete(String(id))) deleted++;
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("documentDeletion", uid, { deletedDocuments: deleted })));
    }

    if (tail[0] === "delete" && req.method === "POST") {
      let deleted = 0;
      for (const [id, doc] of [...index.documents.entries()]) {
        if (matchesFilter(doc, body?.filter)) {
          index.documents.delete(id);
          deleted++;
        }
      }
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("documentDeletion", uid, { deletedDocuments: deleted })));
    }

    if (tail[0] === "edit" && req.method === "POST") {
      return this.send(res, 202, taskSummary(this.createTask("documentEdition", uid, { matchedDocuments: index.documents.size, editedDocuments: 0, function: body?.function ?? null })));
    }

    const id = tail[0];
    if (tail.length === 1 && req.method === "GET") {
      const doc = index.documents.get(String(id));
      if (!doc) return this.send(res, 404, errorBody(`Document ${id} not found.`, "document_not_found", "invalid_request"));
      return this.send(res, 200, projectDocument(doc, parseFields(params)));
    }
    if (tail.length === 1 && req.method === "DELETE") {
      const deleted = index.documents.delete(String(id));
      if (!deleted) return this.send(res, 404, errorBody(`Document ${id} not found.`, "document_not_found", "invalid_request"));
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("documentDeletion", uid, { deletedDocuments: 1 })));
    }

    return this.notFound(res, `/indexes/${uid}/documents/${tail.join("/")}`);
  }

  handleSearch(req, res, uid, params, body) {
    const index = this.getIndexOrError(res, uid);
    if (!index) return;
    if (!["GET", "POST"].includes(req.method)) return this.notFound(res, `/indexes/${uid}/search`);
    const query = body?.q ?? params.get("q") ?? "";
    const offset = Number(body?.offset ?? params.get("offset") ?? 0);
    const limit = Number(body?.limit ?? params.get("limit") ?? 20);
    const filter = body?.filter ?? params.get("filter");
    const sort = body?.sort ?? (params.get("sort") ? params.get("sort").split(",") : undefined);
    const fields = parseFields(params, body);
    const hits = sortHits([...index.documents.values()].filter((doc) => matchesQuery(doc, query, index.settings.searchableAttributes) && matchesFilter(doc, filter)), sort);
    const projected = hits.slice(offset, offset + limit).map((doc) => projectDocument(doc, fields));
    const facetDistribution = this.facetDistribution(hits, body?.facets ?? body?.facetsDistribution);
    return this.send(res, 200, {
      hits: projected,
      query,
      processingTimeMs: 0,
      limit,
      offset,
      estimatedTotalHits: hits.length,
      facetDistribution,
      facetStats: {},
    });
  }

  facetDistribution(hits, facets) {
    if (!Array.isArray(facets)) return {};
    const distribution = {};
    for (const facet of facets) {
      distribution[facet] = {};
      for (const doc of hits) {
        const values = Array.isArray(fieldValue(doc, facet)) ? fieldValue(doc, facet) : [fieldValue(doc, facet)];
        for (const value of values) {
          if (value === undefined || value === null) continue;
          distribution[facet][value] = (distribution[facet][value] || 0) + 1;
        }
      }
    }
    return distribution;
  }

  handleFacetSearch(res, uid, body) {
    const index = this.getIndexOrError(res, uid);
    if (!index) return;
    const facetName = body?.facetName;
    if (!facetName) return this.send(res, 400, errorBody("Missing required field `facetName`.", "missing_facet_name", "invalid_request"));
    const query = String(body?.facetQuery ?? "").toLowerCase();
    const counts = this.facetDistribution([...index.documents.values()], [facetName])[facetName] || {};
    const facetHits = Object.entries(counts)
      .filter(([value]) => String(value).toLowerCase().includes(query))
      .map(([value, count]) => ({ value, count }));
    return this.send(res, 200, { facetHits, processingTimeMs: 0 });
  }

  handleSimilar(res, uid, body) {
    const index = this.getIndexOrError(res, uid);
    if (!index) return;
    const id = String(body?.id ?? "");
    const hits = [...index.documents.entries()].filter(([docId]) => docId !== id).map(([, doc]) => clone(doc));
    const offset = Number(body?.offset ?? 0);
    const limit = Number(body?.limit ?? 20);
    return this.send(res, 200, { hits: hits.slice(offset, offset + limit), id, processingTimeMs: 0, limit, offset, estimatedTotalHits: hits.length });
  }

  handleSettings(req, res, uid, tail, body) {
    const index = this.getIndexOrError(res, uid);
    if (!index) return;
    if (tail.length === 0 && req.method === "GET") return this.send(res, 200, clone(index.settings));
    if (tail.length === 0 && ["PATCH", "PUT"].includes(req.method)) {
      index.settings = { ...index.settings, ...clone(body || {}) };
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("settingsUpdate", uid)));
    }
    if (tail.length === 0 && req.method === "DELETE") {
      index.settings = clone(DEFAULT_SETTINGS);
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("settingsUpdate", uid)));
    }
    const key = SETTING_ENDPOINTS.get(tail[0]);
    if (!key) return this.notFound(res, `/indexes/${uid}/settings/${tail[0]}`);
    if (req.method === "GET") return this.send(res, 200, clone(index.settings[key]));
    if (["PATCH", "PUT"].includes(req.method)) {
      index.settings[key] = clone(body);
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("settingsUpdate", uid)));
    }
    if (req.method === "DELETE") {
      index.settings[key] = clone(DEFAULT_SETTINGS[key]);
      index.updatedAt = now();
      return this.send(res, 202, taskSummary(this.createTask("settingsUpdate", uid)));
    }
    return this.notFound(res, `/indexes/${uid}/settings/${tail[0]}`);
  }

  handleMultiSearch(res, body) {
    const queries = Array.isArray(body?.queries) ? body.queries : [];
    const results = queries.map((query) => {
      const index = this.indexes.get(query.indexUid);
      if (!index) return { hits: [], query: query.q ?? "", processingTimeMs: 0, limit: query.limit ?? 20, offset: query.offset ?? 0, estimatedTotalHits: 0 };
      const hits = [...index.documents.values()].filter((doc) => matchesQuery(doc, query.q ?? "", index.settings.searchableAttributes) && matchesFilter(doc, query.filter));
      const offset = Number(query.offset ?? 0);
      const limit = Number(query.limit ?? 20);
      return { hits: hits.slice(offset, offset + limit).map((doc) => clone(doc)), query: query.q ?? "", processingTimeMs: 0, limit, offset, estimatedTotalHits: hits.length };
    });
    if (body?.federation) {
      const hits = results.flatMap((result, index) => result.hits.map((hit) => ({ ...hit, _federation: { indexUid: queries[index]?.indexUid ?? null, queriesPosition: index } })));
      return this.send(res, 200, { hits, processingTimeMs: 0, limit: body.federation.limit ?? hits.length, offset: body.federation.offset ?? 0, estimatedTotalHits: hits.length, remoteErrors: {} });
    }
    return this.send(res, 200, { results });
  }

  handleFields(res, uid, body) {
    const index = this.getIndexOrError(res, uid);
    if (!index) return;
    const fieldNames = new Set();
    for (const doc of index.documents.values()) for (const key of Object.keys(doc)) fieldNames.add(key);
    for (const key of [
      ...index.settings.searchableAttributes,
      ...index.settings.displayedAttributes,
      ...index.settings.filterableAttributes,
      ...index.settings.sortableAttributes,
    ]) if (key !== "*") fieldNames.add(key);
    const offset = Number(body?.offset ?? 0);
    const limit = Number(body?.limit ?? 20);
    const results = [...fieldNames].sort().map((field) => ({
      field,
      searchable: index.settings.searchableAttributes.includes("*") || index.settings.searchableAttributes.includes(field),
      displayed: index.settings.displayedAttributes.includes("*") || index.settings.displayedAttributes.includes(field),
      filterable: index.settings.filterableAttributes.includes(field),
      sortable: index.settings.sortableAttributes.includes(field),
      distinct: index.settings.distinctAttribute === field,
      rankingRule: index.settings.rankingRules.some((rule) => String(rule).includes(field)),
      localized: false,
    }));
    return this.send(res, 200, { results: results.slice(offset, offset + limit), offset, limit, total: results.length });
  }

  handleSwapIndexes(res, body) {
    const swaps = Array.isArray(body) ? body : [];
    for (const swap of swaps) {
      const indexes = swap.indexes || [];
      if (indexes.length !== 2 || !this.indexes.has(indexes[0]) || !this.indexes.has(indexes[1])) {
        return this.send(res, 400, errorBody("Swap indexes requires two existing indexes.", "invalid_swap_indexes", "invalid_request"));
      }
      const first = this.indexes.get(indexes[0]);
      const second = this.indexes.get(indexes[1]);
      first.uid = indexes[1];
      second.uid = indexes[0];
      this.indexes.set(indexes[0], second);
      this.indexes.set(indexes[1], first);
    }
    return this.send(res, 202, taskSummary(this.createTask("indexSwap")));
  }

  handleTasks(req, res, parts, params) {
    if (parts.length === 1 && req.method === "GET") {
      let tasks = [...this.tasks].reverse();
      if (params.get("indexUids")) {
        const allowed = params.get("indexUids").split(",");
        tasks = tasks.filter((task) => allowed.includes(task.indexUid));
      }
      if (params.get("statuses")) {
        const allowed = params.get("statuses").split(",");
        tasks = tasks.filter((task) => allowed.includes(task.status));
      }
      const limit = Number(params.get("limit") || 20);
      return this.send(res, 200, { results: tasks.slice(0, limit), limit, from: tasks[0]?.uid ?? null, next: tasks[limit]?.uid ?? null });
    }
    if (parts.length === 2 && parts[1] === "cancel" && req.method === "POST") {
      const task = this.createTask("taskCancelation");
      return this.send(res, 202, taskSummary(task));
    }
    if (parts.length === 1 && req.method === "DELETE") {
      const deleted = this.tasks.length;
      const task = this.createTask("taskDeletion", null, { deletedTasks: deleted });
      return this.send(res, 202, taskSummary(task));
    }
    if (parts.length === 2 && req.method === "GET") {
      const task = this.tasks.find((entry) => entry.uid === Number(parts[1]));
      if (!task) return this.send(res, 404, errorBody(`Task ${parts[1]} not found.`, "task_not_found", "invalid_request"));
      return this.send(res, 200, task);
    }
    return this.notFound(res, `/tasks/${parts.slice(1).join("/")}`);
  }

  handleBatches(req, res, parts, params) {
    if (parts.length === 1 && req.method === "GET") {
      const limit = Number(params.get("limit") || 20);
      const results = [...this.batches].reverse().slice(0, limit);
      return this.send(res, 200, { results, limit, from: results[0]?.uid ?? null, next: null });
    }
    if (parts.length === 2 && req.method === "GET") {
      const batch = this.batches.find((entry) => entry.uid === Number(parts[1]));
      if (!batch) return this.send(res, 404, errorBody(`Batch ${parts[1]} not found.`, "batch_not_found", "invalid_request"));
      return this.send(res, 200, batch);
    }
    return this.notFound(res, `/batches/${parts.slice(1).join("/")}`);
  }

  makeKey(body, keyValue = randomUUID().replaceAll("-", "")) {
    const timestamp = now();
    return {
      name: body.name,
      description: body.description ?? null,
      key: keyValue,
      uid: body.uid ?? randomUUID(),
      actions: body.actions ?? ["*"],
      indexes: body.indexes ?? ["*"],
      expiresAt: body.expiresAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  handleKeys(req, res, parts, params, body) {
    if (parts.length === 1 && req.method === "GET") {
      const offset = Number(params.get("offset") || 0);
      const limit = Number(params.get("limit") || 20);
      const keys = [...this.keys.values()];
      return this.send(res, 200, { results: keys.slice(offset, offset + limit), offset, limit, total: keys.length });
    }
    if (parts.length === 1 && req.method === "POST") {
      if (!body?.name) return this.send(res, 400, errorBody("Missing required field `name`.", "missing_api_key_name", "invalid_request"));
      const key = this.makeKey(body);
      this.keys.set(key.key, key);
      return this.send(res, 201, key);
    }
    const id = parts[1];
    const key = [...this.keys.values()].find((entry) => entry.key === id || entry.uid === id);
    if (!key) return this.send(res, 404, errorBody(`API key ${id} not found.`, "api_key_not_found", "invalid_request"));
    if (req.method === "GET") return this.send(res, 200, key);
    if (req.method === "PATCH") {
      Object.assign(key, clone(body || {}), { updatedAt: now() });
      return this.send(res, 200, key);
    }
    if (req.method === "DELETE") {
      this.keys.delete(key.key);
      return this.send(res, 204, null);
    }
    return this.notFound(res, `/keys/${id}`);
  }

  handleDumps(req, res, parts) {
    if (parts.length === 1 && req.method === "POST") {
      const uid = now().replace(/[-:.TZ]/g, "");
      const dump = { uid, status: "done", startedAt: now(), finishedAt: now() };
      this.dumps.set(uid, dump);
      return this.send(res, 202, { ...taskSummary(this.createTask("dumpCreation", null, { dumpUid: uid })), dumpUid: uid });
    }
    if (parts.length === 3 && parts[2] === "status" && req.method === "GET") {
      const dump = this.dumps.get(parts[1]);
      if (!dump) return this.send(res, 404, errorBody(`Dump ${parts[1]} not found.`, "dump_not_found", "invalid_request"));
      return this.send(res, 200, dump);
    }
    return this.notFound(res, `/dumps/${parts.slice(1).join("/")}`);
  }

  handleSnapshot(res) {
    const snapshot = { uid: randomUUID(), status: "done", createdAt: now() };
    this.snapshots.push(snapshot);
    return this.send(res, 202, { ...taskSummary(this.createTask("snapshotCreation", null, { snapshotUid: snapshot.uid })), snapshotUid: snapshot.uid });
  }

  handleExperimental(req, res, body) {
    if (req.method === "GET") return this.send(res, 200, clone(this.experimentalFeatures));
    if (req.method === "PATCH") {
      this.experimentalFeatures = { ...this.experimentalFeatures, ...clone(body || {}) };
      return this.send(res, 200, clone(this.experimentalFeatures));
    }
    return this.notFound(res, "/experimental-features");
  }

  handleDynamicSearchRules(req, res, parts, body) {
    if (parts.length === 1 && req.method === "POST") {
      const rules = [...this.dynamicSearchRules.values()];
      const offset = Number(body?.offset ?? 0);
      const limit = Number(body?.limit ?? 20);
      return this.send(res, 200, { results: rules.slice(offset, offset + limit), offset, limit, total: rules.length });
    }
    const uid = parts[1];
    if (parts.length === 2 && req.method === "GET") {
      const rule = this.dynamicSearchRules.get(uid);
      if (!rule) return this.send(res, 404, errorBody(`Dynamic search rule ${uid} not found.`, "dynamic_search_rule_not_found", "invalid_request"));
      return this.send(res, 200, rule);
    }
    if (parts.length === 2 && req.method === "PATCH") {
      const rule = { uid, ...(this.dynamicSearchRules.get(uid) || {}), ...clone(body || {}), updatedAt: now() };
      if (!rule.createdAt) rule.createdAt = rule.updatedAt;
      this.dynamicSearchRules.set(uid, rule);
      return this.send(res, 200, rule);
    }
    if (parts.length === 2 && req.method === "DELETE") {
      this.dynamicSearchRules.delete(uid);
      return this.send(res, 204, null);
    }
    return this.notFound(res, `/dynamic-search-rules/${parts.slice(1).join("/")}`);
  }

  handleWebhooks(req, res, parts, body) {
    if (parts.length === 1 && req.method === "GET") return this.send(res, 200, { results: [...this.webhooks.values()] });
    if (parts.length === 1 && req.method === "POST") {
      const webhook = { uuid: randomUUID(), ...clone(body || {}), createdAt: now(), updatedAt: now() };
      this.webhooks.set(webhook.uuid, webhook);
      return this.send(res, 201, webhook);
    }
    const uuid = parts[1];
    const webhook = this.webhooks.get(uuid);
    if (!webhook) return this.send(res, 404, errorBody(`Webhook ${uuid} not found.`, "webhook_not_found", "invalid_request"));
    if (req.method === "GET") return this.send(res, 200, webhook);
    if (req.method === "PATCH") {
      Object.assign(webhook, clone(body || {}), { updatedAt: now() });
      return this.send(res, 200, webhook);
    }
    if (req.method === "DELETE") {
      this.webhooks.delete(uuid);
      return this.send(res, 204, null);
    }
    return this.notFound(res, `/webhooks/${uuid}`);
  }

  handleNetwork(req, res, body) {
    if (req.method === "GET") return this.send(res, 200, clone(this.network));
    if (req.method === "PATCH") {
      if (body?.self !== undefined) this.network.self = body.self;
      if (body?.leader !== undefined) this.network.leader = body.leader;
      if (body?.remotes) {
        for (const [name, remote] of Object.entries(body.remotes)) {
          if (remote === null) delete this.network.remotes[name];
          else this.network.remotes[name] = clone(remote);
        }
      }
      if (body?.shards) this.network.shards = { ...this.network.shards, ...clone(body.shards) };
      return this.send(res, 202, taskSummary(this.createTask("networkUpdate")));
    }
    return this.notFound(res, "/network");
  }

  handleChats(req, res, parts, body) {
    if (parts.length === 1 && req.method === "GET") {
      return this.send(res, 200, { results: [...this.chatWorkspaces.keys()].map((uid) => ({ uid })), offset: 0, limit: 20, total: this.chatWorkspaces.size });
    }
    const workspace = parts[1];
    if (parts.length === 3 && parts[2] === "settings") {
      if (!this.chatWorkspaces.has(workspace)) this.chatWorkspaces.set(workspace, { source: "openAi", apiKey: null, prompts: {} });
      if (req.method === "GET") return this.send(res, 200, clone(this.chatWorkspaces.get(workspace)));
      if (req.method === "PATCH") {
        const settings = { ...this.chatWorkspaces.get(workspace), ...clone(body || {}) };
        this.chatWorkspaces.set(workspace, settings);
        return this.send(res, 200, settings);
      }
      if (req.method === "DELETE") {
        this.chatWorkspaces.delete(workspace);
        return this.send(res, 204, null);
      }
    }
    if (parts.length === 4 && parts[2] === "chat" && parts[3] === "completions" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    return this.notFound(res, `/chats/${parts.slice(1).join("/")}`);
  }

  indexStats(uid) {
    const index = this.indexes.get(uid);
    if (!index) return {};
    return {
      numberOfDocuments: index.documents.size,
      isIndexing: false,
      fieldDistribution: this.fieldDistribution(index),
    };
  }

  fieldDistribution(index) {
    const distribution = {};
    for (const doc of index.documents.values()) {
      for (const key of Object.keys(doc)) distribution[key] = (distribution[key] || 0) + 1;
    }
    return distribution;
  }

  globalStats() {
    const indexes = {};
    for (const uid of this.indexes.keys()) indexes[uid] = this.indexStats(uid);
    return {
      databaseSize: [...this.indexes.values()].reduce((total, index) => total + JSON.stringify([...index.documents.values()]).length, 0),
      usedDatabaseSize: 0,
      lastUpdate: now(),
      indexes,
    };
  }
}
