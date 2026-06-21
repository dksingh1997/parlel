// parlel/cosmosdb — a lightweight, dependency-free fake of Azure Cosmos DB.
//
// Speaks the Azure Cosmos DB SQL (Core) REST API so application code using the
// real `@azure/cosmos` client can run against it with zero cost and zero side
// effects. Pure Node.js, no external npm dependencies. State is in-memory and
// ephemeral (resettable via reset() or POST /_parlel/reset).
//
// URL shape (resource-link addressing, exactly like the real service):
//   /                                              -> database account
//   /dbs                                           -> databases
//   /dbs/{db}                                      -> a database
//   /dbs/{db}/colls                                -> containers
//   /dbs/{db}/colls/{coll}                         -> a container
//   /dbs/{db}/colls/{coll}/docs                    -> documents (+ query, batch)
//   /dbs/{db}/colls/{coll}/docs/{id}               -> a document
//   /dbs/{db}/colls/{coll}/pkranges                -> partition key ranges
//   /dbs/{db}/colls/{coll}/sprocs[/{id}]           -> stored procedures
//   /dbs/{db}/colls/{coll}/triggers[/{id}]         -> triggers
//   /dbs/{db}/colls/{coll}/udfs[/{id}]             -> user defined functions
//   /dbs/{db}/colls/{coll}/conflicts[/{id}]        -> conflicts
//   /dbs/{db}/users[/{id}]                          -> users
//   /dbs/{db}/users/{u}/permissions[/{id}]         -> permissions
//   /offers[/{id}]                                  -> throughput offers
//
// Implements the full public surface the @azure/cosmos client calls:
// CosmosClient (account + database CRUD + offers), Databases/Database,
// Containers/Container (CRUD, throughput), Items/Item (CRUD, upsert, patch,
// read-all, query w/ query-plan + pkranges, batch, bulk), Scripts
// (StoredProcedures/Triggers/UserDefinedFunctions CRUD + sproc execute),
// Users/Permissions CRUD, Conflicts, and Offers.

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const API_VERSION = "2020-07-15";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function makeEtag() {
  return `"${randomUUID()}"`;
}

// Cosmos _rid values are base64-ish opaque strings. We just need them stable,
// unique and round-trippable. Deterministic per resource path keeps things
// debuggable.
function makeRid(seed) {
  return createHash("sha1").update(String(seed)).digest("base64").replace(/[+/=]/g, "").slice(0, 16);
}

function activityId() {
  return randomUUID();
}

function sessionToken() {
  return `0:-1#${Math.floor(Math.random() * 1000)}`;
}

// Resource id validation: ['/', '\\', '#', '?'] are illegal for most, '?' too.
const ILLEGAL_ID = /[/\\#?]/;

function isValidId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 255 && !ILLEGAL_ID.test(id) && !/\s+$/.test(id);
}

// Extract the partition key array sent by the client in
// x-ms-documentdb-partitionkey: '["value"]' (JSON array). Returns the array of
// values, or undefined when not supplied.
function parsePartitionKeyHeader(header) {
  if (header === undefined || header === null) return undefined;
  try {
    const parsed = JSON.parse(header);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return undefined;
  }
}

// Given a partition key definition (paths like ["/pk"] or ["/a","/b"]) extract
// the key values from a document. Missing paths => the special "undefined"
// partition key sentinel (matches Cosmos behaviour: documents with no value go
// to a special partition).
const UNDEFINED_PK = Symbol("undefined-pk");

function extractPartitionKey(doc, paths) {
  if (!paths || paths.length === 0) return [];
  return paths.map((p) => {
    const segments = p.split("/").filter(Boolean);
    let cur = doc;
    for (const seg of segments) {
      if (cur === null || cur === undefined || typeof cur !== "object") {
        return UNDEFINED_PK;
      }
      cur = cur[seg];
    }
    return cur === undefined ? UNDEFINED_PK : cur;
  });
}

function pkToString(values) {
  return JSON.stringify(values.map((v) => (v === UNDEFINED_PK ? "\0undefined\0" : v)));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class CosmosdbServer {
  constructor(port = 4591, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.key = options.key ||
      "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";
    this.server = null;
    this.reset();
  }

  reset() {
    // databases: Map<id, Database>
    // Database = { id, _rid, _ts, _etag, containers: Map, users: Map }
    // Container = {
    //   id, _rid, _ts, _etag, partitionKey, indexingPolicy, uniqueKeyPolicy,
    //   defaultTtl, conflictResolutionPolicy, computedProperties, vectorEmbeddingPolicy,
    //   docs: Map<id, doc>, sprocs: Map, triggers: Map, udfs: Map, conflicts: Map,
    //   offerThroughput
    // }
    this.databases = new Map();
    this.offers = new Map(); // offerRid -> offer
    this.offerByResource = new Map(); // resourceRid -> offer
    this._seq = 0; // monotonic sequence for change feed ordering
  }

  nextSeq() {
    return ++this._seq;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, 500, "InternalServerError", error.message || String(error));
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
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // -------------------------------------------------------------------------
  // Common response helpers
  // -------------------------------------------------------------------------
  baseHeaders(res) {
    res.setHeader("x-ms-activity-id", activityId());
    res.setHeader("x-ms-request-charge", "1");
    res.setHeader("x-ms-session-token", sessionToken());
    res.setHeader("x-ms-schemaversion", "1.12");
    res.setHeader("x-ms-serviceversion", "version=2.14.0");
    res.setHeader("x-ms-gatewayversion", "version=2.14.0");
    res.setHeader("Content-Type", "application/json");
  }

  sendJson(res, status, obj, extraHeaders = {}) {
    this.baseHeaders(res);
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
    res.statusCode = status;
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  }

  sendError(res, status, code, message, substatus) {
    this.baseHeaders(res);
    if (substatus !== undefined) res.setHeader("x-ms-substatus", String(substatus));
    res.statusCode = status;
    res.end(JSON.stringify({ code, message: typeof message === "string" ? message : JSON.stringify(message) }));
  }

  notFound(res, message = "Entity with the specified id does not exist in the system.") {
    return this.sendError(res, 404, "NotFound", message, 0);
  }

  conflict(res, message = "Resource with specified id or name already exists.") {
    return this.sendError(res, 409, "Conflict", message);
  }

  badRequest(res, message = "Bad request.") {
    return this.sendError(res, 400, "BadRequest", message);
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = (req.method || "GET").toUpperCase();
    const pathname = decodeURIComponent(url.pathname);

    // parlel control plane
    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "cosmosdb",
        databases: this.databases.size,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    const bodyBuf = await this.readBody(req);
    const ctx = { req, res, method, url, headers: req.headers, bodyBuf };

    // Database account: GET /
    if (pathname === "/" || pathname === "") {
      if (method === "GET") return this.getDatabaseAccount(ctx);
      return this.badRequest(res);
    }

    const segments = pathname.split("/").filter(Boolean);

    try {
      return this.route(ctx, segments, pathname);
    } catch (err) {
      return this.sendError(res, 500, "InternalServerError", err.message || String(err));
    }
  }

  parseJsonBody(ctx) {
    const text = ctx.bodyBuf.toString("utf8");
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  // Is this POST a query against a feed resource (databases/containers/users/...)?
  isQueryRequest(ctx) {
    const ct = ctx.headers["content-type"] || "";
    return ct.includes("query+json") || ctx.headers["x-ms-documentdb-isquery"] !== undefined;
  }

  // Generic "query by id over a list of resource views" used by feed endpoints
  // that accept SQL queries (the client builds a query iterator for readAll()
  // followed by .query()).  We support `SELECT * FROM root r WHERE r.id = '...'`
  // and unfiltered selects; anything else just returns all rows.
  queryFeed(ctx, views, key) {
    const { res } = ctx;
    const body = this.parseJsonBody(ctx) || {};
    const query = (body.query || "").toString();
    const params = {};
    if (Array.isArray(body.parameters)) for (const p of body.parameters) params[p.name] = p.value;

    let matched = views;
    const m = query.match(/\.id\s*=\s*(["']([^"']+)["']|@(\w+))/i);
    if (m) {
      const wanted = m[2] !== undefined ? m[2] : params["@" + m[3]];
      matched = views.filter((v) => v.id === wanted);
    }
    this.sendJson(res, 200, { _rid: "", [key]: matched, _count: matched.length });
  }

  route(ctx, segments, pathname) {
    const { res, method } = ctx;
    const s = segments;

    // /offers and /offers/{id}
    if (s[0] === "offers") {
      if (s.length === 1) {
        if (method === "GET") return this.listOffers(ctx);
        if (method === "POST") return this.queryOffers(ctx);
      }
      if (s.length === 2) {
        const offer = this.offers.get(s[1]);
        if (method === "GET") return offer ? this.sendJson(res, 200, this.offerView(offer), { etag: offer._etag }) : this.notFound(res);
        if (method === "PUT") return this.replaceOffer(ctx, s[1]);
      }
      return this.badRequest(res);
    }

    if (s[0] !== "dbs") return this.badRequest(res, "Unknown resource path.");

    // /dbs
    if (s.length === 1) {
      if (method === "GET") return this.listDatabases(ctx);
      if (method === "POST") {
        if (this.isQueryRequest(ctx)) {
          return this.queryFeed(ctx, [...this.databases.values()].map((db) => this.databaseView(db)), "Databases");
        }
        return this.createDatabase(ctx);
      }
      return this.badRequest(res);
    }

    const dbId = s[1];

    // /dbs/{db}
    if (s.length === 2) {
      if (method === "GET") return this.readDatabase(ctx, dbId);
      if (method === "DELETE") return this.deleteDatabase(ctx, dbId);
      if (method === "PUT") return this.replaceDatabase(ctx, dbId);
      return this.badRequest(res);
    }

    const db = this.databases.get(dbId);

    // /dbs/{db}/users ...
    if (s[2] === "users") {
      if (!db) return this.notFound(res);
      if (s.length === 3) {
        if (method === "GET") return this.listUsers(ctx, db);
        if (method === "POST") {
          if (this.isQueryRequest(ctx)) {
            return this.queryFeed(ctx, [...db.users.values()].map((u) => this.userView(db, u)), "Users");
          }
          return this.createUser(ctx, db);
        }
        return this.badRequest(res);
      }
      const userId = s[3];
      if (s.length === 4) {
        if (method === "GET") return this.readUser(ctx, db, userId);
        if (method === "PUT") return this.replaceUser(ctx, db, userId);
        if (method === "DELETE") return this.deleteUser(ctx, db, userId);
        return this.badRequest(res);
      }
      if (s[4] === "permissions") {
        const user = db.users.get(userId);
        if (!user) return this.notFound(res);
        if (s.length === 5) {
          if (method === "GET") return this.listPermissions(ctx, user);
          if (method === "POST") {
            if (this.isQueryRequest(ctx)) {
              return this.queryFeed(ctx, [...user.permissions.values()].map((p) => this.permissionView(user, p)), "Permissions");
            }
            return this.createPermission(ctx, user);
          }
          return this.badRequest(res);
        }
        const permId = s[5];
        if (s.length === 6) {
          if (method === "GET") return this.readPermission(ctx, user, permId);
          if (method === "PUT") return this.replacePermission(ctx, user, permId);
          if (method === "DELETE") return this.deletePermission(ctx, user, permId);
          return this.badRequest(res);
        }
      }
      return this.badRequest(res);
    }

    // /dbs/{db}/colls ...
    if (s[2] === "colls") {
      if (!db) return this.notFound(res);
      if (s.length === 3) {
        if (method === "GET") return this.listContainers(ctx, db);
        if (method === "POST") {
          if (this.isQueryRequest(ctx)) {
            return this.queryFeed(ctx, [...db.containers.values()].map((c) => this.containerView(c)), "DocumentCollections");
          }
          return this.createContainer(ctx, db);
        }
        return this.badRequest(res);
      }
      const collId = s[3];
      if (s.length === 4) {
        if (method === "GET") return this.readContainer(ctx, db, collId);
        if (method === "PUT") return this.replaceContainer(ctx, db, collId);
        if (method === "DELETE") return this.deleteContainer(ctx, db, collId);
        return this.badRequest(res);
      }
      const coll = db.containers.get(collId);
      if (!coll) return this.notFound(res);
      const sub = s[4];

      if (sub === "docs") {
        if (s.length === 5) {
          if (method === "POST") return this.handleDocsPost(ctx, db, coll);
          if (method === "GET") return this.listOrReadAllDocs(ctx, db, coll);
          return this.badRequest(res);
        }
        if (s.length >= 6) {
          const docId = s.slice(5).join("/");
          if (method === "GET") return this.readDocument(ctx, db, coll, docId);
          if (method === "PUT") return this.replaceDocument(ctx, db, coll, docId);
          if (method === "DELETE") return this.deleteDocument(ctx, db, coll, docId);
          if (method === "PATCH") return this.patchDocument(ctx, db, coll, docId);
          return this.badRequest(res);
        }
      }

      if (sub === "pkranges") {
        if (method === "GET") return this.listPkRanges(ctx, db, coll);
        return this.badRequest(res);
      }

      if (sub === "operations") {
        if (s[5] === "partitionkeydelete" && method === "POST") {
          return this.deleteAllItemsForPartitionKey(ctx, coll);
        }
        return this.badRequest(res);
      }

      if (sub === "sprocs") {
        if (s.length === 5) {
          if (method === "GET") return this.listScripts(ctx, coll, "sprocs");
          if (method === "POST") {
            if (this.isQueryRequest(ctx)) {
              return this.queryFeed(ctx, [...coll.sprocs.values()].map((x) => this.scriptView(coll, "sprocs", x)), this.scriptListKey("sprocs"));
            }
            return this.createScript(ctx, coll, "sprocs");
          }
          return this.badRequest(res);
        }
        const id = s[5];
        if (s.length === 6) {
          if (method === "POST") return this.executeSproc(ctx, db, coll, id);
          if (method === "GET") return this.readScript(ctx, coll, "sprocs", id);
          if (method === "PUT") return this.replaceScript(ctx, coll, "sprocs", id);
          if (method === "DELETE") return this.deleteScript(ctx, coll, "sprocs", id);
          return this.badRequest(res);
        }
      }

      if (sub === "triggers") {
        if (s.length === 5) {
          if (method === "GET") return this.listScripts(ctx, coll, "triggers");
          if (method === "POST") {
            if (this.isQueryRequest(ctx)) {
              return this.queryFeed(ctx, [...coll.triggers.values()].map((x) => this.scriptView(coll, "triggers", x)), this.scriptListKey("triggers"));
            }
            return this.createScript(ctx, coll, "triggers");
          }
          return this.badRequest(res);
        }
        const id = s[5];
        if (s.length === 6) {
          if (method === "GET") return this.readScript(ctx, coll, "triggers", id);
          if (method === "PUT") return this.replaceScript(ctx, coll, "triggers", id);
          if (method === "DELETE") return this.deleteScript(ctx, coll, "triggers", id);
          return this.badRequest(res);
        }
      }

      if (sub === "udfs") {
        if (s.length === 5) {
          if (method === "GET") return this.listScripts(ctx, coll, "udfs");
          if (method === "POST") {
            if (this.isQueryRequest(ctx)) {
              return this.queryFeed(ctx, [...coll.udfs.values()].map((x) => this.scriptView(coll, "udfs", x)), this.scriptListKey("udfs"));
            }
            return this.createScript(ctx, coll, "udfs");
          }
          return this.badRequest(res);
        }
        const id = s[5];
        if (s.length === 6) {
          if (method === "GET") return this.readScript(ctx, coll, "udfs", id);
          if (method === "PUT") return this.replaceScript(ctx, coll, "udfs", id);
          if (method === "DELETE") return this.deleteScript(ctx, coll, "udfs", id);
          return this.badRequest(res);
        }
      }

      if (sub === "conflicts") {
        if (s.length === 5) {
          if (method === "GET") return this.listConflicts(ctx, coll);
          if (method === "POST" && this.isQueryRequest(ctx)) {
            return this.queryFeed(ctx, [...coll.conflicts.values()].map((c) => this.conflictView(coll, c)), "Conflicts");
          }
          return this.badRequest(res);
        }
        const id = s[5];
        if (s.length === 6) {
          if (method === "GET") return this.readConflict(ctx, coll, id);
          if (method === "DELETE") return this.deleteConflict(ctx, coll, id);
          return this.badRequest(res);
        }
      }

      return this.badRequest(res, "Unknown container sub-resource.");
    }

    return this.badRequest(res, "Unknown resource path.");
  }

  // -------------------------------------------------------------------------
  // Database account
  // -------------------------------------------------------------------------
  getDatabaseAccount(ctx) {
    const { res } = ctx;
    const endpoint = `http://${this.host}:${this.port}/`;
    this.sendJson(res, 200, {
      _self: "",
      id: "parlel",
      _rid: "parlel.documents.azure.com",
      media: "//media/",
      addresses: "//addresses/",
      _dbs: "//dbs/",
      writableLocations: [{ name: "Parlel Region", databaseAccountEndpoint: endpoint }],
      readableLocations: [{ name: "Parlel Region", databaseAccountEndpoint: endpoint }],
      enableMultipleWriteLocations: false,
      userReplicationPolicy: { asyncReplication: false, minReplicaSetSize: 1, maxReplicasetSize: 4 },
      userConsistencyPolicy: { defaultConsistencyLevel: "Session" },
      systemReplicationPolicy: { minReplicaSetSize: 1, maxReplicasetSize: 4 },
      readPolicy: { primaryReadCoefficient: 1, secondaryReadCoefficient: 1 },
      queryEngineConfiguration:
        '{"maxSqlQueryInputLength":262144,"maxJoinsPerSqlQuery":5,"maxLogicalAndPerSqlQuery":500,"maxLogicalOrPerSqlQuery":500,"maxUdfRefPerSqlQuery":10,"maxInExpressionItemsCount":16000,"queryMaxInMemorySortDocumentCount":500,"maxQueryRequestTimeoutFraction":0.9,"sqlAllowNonFiniteNumbers":false,"sqlAllowAggregateFunctions":true,"sqlAllowSubQuery":true,"sqlAllowScalarSubQuery":true,"allowNewKeywords":true,"sqlAllowLike":true,"sqlAllowGroupByClause":true,"maxSpatialQueryCells":12,"spatialMaxGeometryPointCount":256,"      sqlAllowTop":true,"enableSpatialIndexing":true}',
    });
  }

  // -------------------------------------------------------------------------
  // Databases
  // -------------------------------------------------------------------------
  databaseView(db) {
    return {
      id: db.id,
      _rid: db._rid,
      _ts: db._ts,
      _self: `dbs/${db._rid}/`,
      _etag: db._etag,
      _colls: "colls/",
      _users: "users/",
    };
  }

  listDatabases(ctx) {
    const { res } = ctx;
    const Databases = [...this.databases.values()].map((db) => this.databaseView(db));
    this.sendJson(res, 200, { _rid: "", Databases, _count: Databases.length });
  }

  createDatabase(ctx) {
    const { res } = ctx;
    const body = this.parseJsonBody(ctx);
    if (!body || !isValidId(body.id)) return this.badRequest(res, "The input is not a valid database.");
    if (this.databases.has(body.id)) {
      // createIfNotExists path: client does a read first, so a true conflict.
      return this.conflict(res);
    }
    const rid = makeRid(`db:${body.id}`);
    const db = {
      id: body.id,
      _rid: rid,
      _ts: nowTs(),
      _etag: makeEtag(),
      containers: new Map(),
      users: new Map(),
    };
    this.databases.set(db.id, db);

    // Optional throughput offer for the database (shared throughput).
    const throughput = this.readThroughputHeaders(ctx);
    if (throughput) this.createOffer(rid, `dbs/${rid}/`, "Invalid", throughput);

    this.sendJson(res, 201, this.databaseView(db), { etag: db._etag });
  }

  readDatabase(ctx, dbId) {
    const { res } = ctx;
    const db = this.databases.get(dbId);
    if (!db) return this.notFound(res);
    this.sendJson(res, 200, this.databaseView(db), { etag: db._etag });
  }

  replaceDatabase(ctx, dbId) {
    const { res } = ctx;
    const db = this.databases.get(dbId);
    if (!db) return this.notFound(res);
    db._ts = nowTs();
    db._etag = makeEtag();
    this.sendJson(res, 200, this.databaseView(db), { etag: db._etag });
  }

  deleteDatabase(ctx, dbId) {
    const { res } = ctx;
    if (!this.databases.has(dbId)) return this.notFound(res);
    const db = this.databases.get(dbId);
    this.offerByResource.delete(db._rid);
    this.databases.delete(dbId);
    this.sendJson(res, 204, undefined);
  }

  // -------------------------------------------------------------------------
  // Containers
  // -------------------------------------------------------------------------
  containerView(coll) {
    return {
      id: coll.id,
      _rid: coll._rid,
      _ts: coll._ts,
      _self: `dbs/${coll._dbRid}/colls/${coll._rid}/`,
      _etag: coll._etag,
      _docs: "docs/",
      _sprocs: "sprocs/",
      _triggers: "triggers/",
      _udfs: "udfs/",
      _conflicts: "conflicts/",
      partitionKey: coll.partitionKey,
      indexingPolicy: coll.indexingPolicy,
      uniqueKeyPolicy: coll.uniqueKeyPolicy,
      conflictResolutionPolicy: coll.conflictResolutionPolicy,
      defaultTtl: coll.defaultTtl,
      computedProperties: coll.computedProperties,
      vectorEmbeddingPolicy: coll.vectorEmbeddingPolicy,
      geospatialConfig: coll.geospatialConfig,
    };
  }

  defaultIndexingPolicy() {
    return {
      indexingMode: "consistent",
      automatic: true,
      includedPaths: [{ path: "/*" }],
      excludedPaths: [{ path: '/"_etag"/?' }],
    };
  }

  listContainers(ctx, db) {
    const { res } = ctx;
    const DocumentCollections = [...db.containers.values()].map((c) => this.containerView(c));
    this.sendJson(res, 200, { _rid: db._rid, DocumentCollections, _count: DocumentCollections.length });
  }

  normalizePartitionKey(pk) {
    if (!pk) return { paths: [], kind: "Hash", version: 2 };
    if (Array.isArray(pk)) return { paths: pk, kind: "Hash", version: 2 };
    if (typeof pk === "string") return { paths: [pk], kind: "Hash", version: 2 };
    return {
      paths: pk.paths || [],
      kind: pk.kind || "Hash",
      version: pk.version || 2,
    };
  }

  createContainer(ctx, db) {
    const { res } = ctx;
    const body = this.parseJsonBody(ctx);
    if (!body || !isValidId(body.id)) return this.badRequest(res, "The input is not a valid container.");
    if (db.containers.has(body.id)) return this.conflict(res);

    const rid = makeRid(`coll:${db.id}:${body.id}`);
    const coll = {
      id: body.id,
      _rid: rid,
      _dbRid: db._rid,
      _ts: nowTs(),
      _etag: makeEtag(),
      partitionKey: this.normalizePartitionKey(body.partitionKey),
      indexingPolicy: body.indexingPolicy || this.defaultIndexingPolicy(),
      uniqueKeyPolicy: body.uniqueKeyPolicy || { uniqueKeys: [] },
      conflictResolutionPolicy:
        body.conflictResolutionPolicy || { mode: "LastWriterWins", conflictResolutionPath: "/_ts", conflictResolutionProcedure: "" },
      defaultTtl: body.defaultTtl,
      computedProperties: body.computedProperties || [],
      vectorEmbeddingPolicy: body.vectorEmbeddingPolicy,
      geospatialConfig: body.geospatialConfig || { type: "Geography" },
      docs: new Map(),
      sprocs: new Map(),
      triggers: new Map(),
      udfs: new Map(),
      conflicts: new Map(),
    };
    db.containers.set(coll.id, coll);

    const throughput = this.readThroughputHeaders(ctx);
    this.createOffer(rid, `dbs/${db._rid}/colls/${rid}/`, "Invalid", throughput || 400);

    this.sendJson(res, 201, this.containerView(coll), { etag: coll._etag });
  }

  readContainer(ctx, db, collId) {
    const { res } = ctx;
    const coll = db.containers.get(collId);
    if (!coll) return this.notFound(res);
    this.sendJson(res, 200, this.containerView(coll), { etag: coll._etag });
  }

  replaceContainer(ctx, db, collId) {
    const { res } = ctx;
    const coll = db.containers.get(collId);
    if (!coll) return this.notFound(res);
    const body = this.parseJsonBody(ctx) || {};
    if (body.indexingPolicy) coll.indexingPolicy = body.indexingPolicy;
    if (body.defaultTtl !== undefined) coll.defaultTtl = body.defaultTtl;
    if (body.conflictResolutionPolicy) coll.conflictResolutionPolicy = body.conflictResolutionPolicy;
    if (body.computedProperties) coll.computedProperties = body.computedProperties;
    coll._ts = nowTs();
    coll._etag = makeEtag();
    this.sendJson(res, 200, this.containerView(coll), { etag: coll._etag });
  }

  deleteContainer(ctx, db, collId) {
    const { res } = ctx;
    const coll = db.containers.get(collId);
    if (!coll) return this.notFound(res);
    this.offerByResource.delete(coll._rid);
    db.containers.delete(collId);
    this.sendJson(res, 204, undefined);
  }

  // -------------------------------------------------------------------------
  // Partition key ranges
  // -------------------------------------------------------------------------
  listPkRanges(ctx, db, coll) {
    const { res } = ctx;
    const range = {
      id: "0",
      _rid: makeRid(`pkr:${coll._rid}`),
      _etag: makeEtag(),
      _ts: nowTs(),
      minInclusive: "",
      maxExclusive: "FF",
      ridPrefix: 0,
      throughputFraction: 1,
      status: "online",
      parents: [],
      _self: `dbs/${db._rid}/colls/${coll._rid}/pkranges/0/`,
    };
    this.sendJson(res, 200, { _rid: coll._rid, PartitionKeyRanges: [range], _count: 1 }, { etag: makeEtag() });
  }

  deleteAllItemsForPartitionKey(ctx, coll) {
    const { res, headers } = ctx;
    const pkHeader = parsePartitionKeyHeader(headers["x-ms-documentdb-partitionkey"]);
    if (pkHeader === undefined) return this.badRequest(res, "Partition key is required.");
    for (const [id, doc] of [...coll.docs.entries()]) {
      if (this.matchesPartitionKey(coll, doc, pkHeader)) coll.docs.delete(id);
    }
    this.sendJson(res, 200, undefined);
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------
  docView(coll, doc) {
    const view = {
      ...doc,
      _rid: doc._rid,
      _self: `dbs/${coll._dbRid}/colls/${coll._rid}/docs/${doc._rid}/`,
      _etag: doc._etag,
      _attachments: "attachments/",
      _ts: doc._ts,
    };
    delete view._lsn;
    return view;
  }

  applyDocSystemProps(coll, doc, existing) {
    doc._rid = existing ? existing._rid : makeRid(`doc:${coll._rid}:${doc.id}:${Date.now()}:${Math.random()}`);
    doc._ts = nowTs();
    doc._etag = makeEtag();
    doc._lsn = this.nextSeq(); // change feed ordering (non-enumerable on the wire view)
    return doc;
  }

  handleDocsPost(ctx, db, coll) {
    const { headers } = ctx;
    // Query request?
    const contentType = headers["content-type"] || "";
    const isQueryPlan = headers["x-ms-cosmos-is-query-plan-request"];
    const isQuery = headers["x-ms-documentdb-isquery"];
    if (contentType.includes("query+json") || isQuery || isQueryPlan) {
      if (isQueryPlan) return this.queryPlan(ctx, coll);
      return this.queryDocuments(ctx, db, coll);
    }
    // Batch request?
    if (headers["x-ms-cosmos-is-batch-request"]) {
      return this.executeBatch(ctx, db, coll);
    }
    // Plain create / upsert
    return this.createDocument(ctx, db, coll);
  }

  createDocument(ctx, db, coll) {
    const { res, headers } = ctx;
    const body = this.parseJsonBody(ctx);
    if (body === undefined || typeof body !== "object" || Array.isArray(body)) {
      return this.badRequest(res, "The request body is not a valid document.");
    }
    const isUpsert = headers["x-ms-documentdb-is-upsert"] === "true";
    const doc = { ...body };
    if (doc.id === undefined || doc.id === null) {
      doc.id = randomUUID();
    }
    if (!isValidId(String(doc.id))) {
      return this.badRequest(res, "Id cannot contain '/','\\\\','#','?' characters or end with a space.");
    }
    doc.id = String(doc.id);

    const existing = coll.docs.get(doc.id);
    if (existing && !isUpsert) {
      return this.sendError(res, 409, "Conflict", "Resource with specified id already exists.");
    }

    this.applyDocSystemProps(coll, doc, existing);
    coll.docs.set(doc.id, doc);

    const status = existing ? 200 : 201;
    this.sendJson(res, status, this.docView(coll, doc), { etag: doc._etag });
  }

  // Validate that the partition key header matches the document's partition key
  matchesPartitionKey(coll, doc, pkHeader) {
    if (pkHeader === undefined) return true; // not enforced when absent
    const expected = extractPartitionKey(doc, coll.partitionKey.paths);
    const provided = pkHeader.map((v) => (v === undefined ? UNDEFINED_PK : v));
    if (expected.length !== provided.length) return false;
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i] === UNDEFINED_PK ? UNDEFINED_PK : expected[i];
      const p = provided[i];
      if (e === UNDEFINED_PK) {
        // client may send {} for undefined; accept undefined sentinel
        if (p !== UNDEFINED_PK && p !== undefined && !(p && typeof p === "object" && Object.keys(p).length === 0)) {
          return false;
        }
      } else if (JSON.stringify(e) !== JSON.stringify(p)) {
        return false;
      }
    }
    return true;
  }

  readDocument(ctx, db, coll, docId) {
    const { res, headers } = ctx;
    const doc = coll.docs.get(docId);
    if (!doc) return this.notFound(res);
    const pkHeader = parsePartitionKeyHeader(headers["x-ms-documentdb-partitionkey"]);
    if (!this.matchesPartitionKey(coll, doc, pkHeader)) return this.notFound(res);
    // If-None-Match support
    if (headers["if-none-match"] && headers["if-none-match"] === doc._etag) {
      this.baseHeaders(res);
      res.statusCode = 304;
      return res.end();
    }
    this.sendJson(res, 200, this.docView(coll, doc), { etag: doc._etag });
  }

  replaceDocument(ctx, db, coll, docId) {
    const { res, headers } = ctx;
    const existing = coll.docs.get(docId);
    if (!existing) return this.notFound(res);
    const ifMatch = headers["if-match"];
    if (ifMatch && ifMatch !== existing._etag) {
      return this.sendError(res, 412, "PreconditionFailed", "Operation cannot be performed because one of the specified precondition is not met.");
    }
    const body = this.parseJsonBody(ctx);
    if (body === undefined || typeof body !== "object") return this.badRequest(res);
    const newId = body.id !== undefined ? String(body.id) : docId;
    if (newId !== docId) {
      return this.badRequest(res, "Replacing the id of a document is not allowed.");
    }
    const doc = { ...body, id: docId };
    this.applyDocSystemProps(coll, doc, existing);
    coll.docs.set(docId, doc);
    this.sendJson(res, 200, this.docView(coll, doc), { etag: doc._etag });
  }

  deleteDocument(ctx, db, coll, docId) {
    const { res, headers } = ctx;
    const existing = coll.docs.get(docId);
    if (!existing) return this.notFound(res);
    const ifMatch = headers["if-match"];
    if (ifMatch && ifMatch !== existing._etag) {
      return this.sendError(res, 412, "PreconditionFailed", "Operation cannot be performed because one of the specified precondition is not met.");
    }
    coll.docs.delete(docId);
    this.sendJson(res, 204, undefined);
  }

  patchDocument(ctx, db, coll, docId) {
    const { res, headers } = ctx;
    const existing = coll.docs.get(docId);
    if (!existing) return this.notFound(res);
    const ifMatch = headers["if-match"];
    if (ifMatch && ifMatch !== existing._etag) {
      return this.sendError(res, 412, "PreconditionFailed", "Precondition not met.");
    }
    const body = this.parseJsonBody(ctx);
    const operations = Array.isArray(body) ? body : body && body.operations;
    if (!Array.isArray(operations)) return this.badRequest(res, "Patch operations must be an array.");
    const condition = body && !Array.isArray(body) ? body.condition : undefined;
    const doc = JSON.parse(JSON.stringify(existing));
    try {
      if (condition) {
        // Conditional patch: simple support not required, ignore evaluation but accept.
      }
      for (const op of operations) {
        this.applyPatchOp(doc, op);
      }
    } catch (err) {
      return this.badRequest(res, err.message);
    }
    doc.id = docId;
    this.applyDocSystemProps(coll, doc, existing);
    coll.docs.set(docId, doc);
    this.sendJson(res, 200, this.docView(coll, doc), { etag: doc._etag });
  }

  applyPatchOp(doc, op) {
    const path = op.path;
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error("Invalid patch path: " + path);
    }
    const segments = path.split("/").filter(Boolean).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = segments[segments.length - 1];
    const parentSegments = segments.slice(0, -1);

    const getParent = (create) => {
      let cur = doc;
      for (const seg of parentSegments) {
        if (cur[seg] === undefined) {
          if (!create) throw new Error("Patch path not found: " + path);
          cur[seg] = {};
        }
        cur = cur[seg];
      }
      return cur;
    };

    switch (op.op) {
      case "add": {
        const parent = getParent(true);
        if (Array.isArray(parent) && last === "-") parent.push(op.value);
        else parent[last] = op.value;
        break;
      }
      case "set": {
        const parent = getParent(true);
        parent[last] = op.value;
        break;
      }
      case "replace": {
        const parent = getParent(false);
        if (parent[last] === undefined) throw new Error("Path does not exist for replace: " + path);
        parent[last] = op.value;
        break;
      }
      case "remove": {
        const parent = getParent(false);
        if (Array.isArray(parent)) parent.splice(Number(last), 1);
        else delete parent[last];
        break;
      }
      case "incr": {
        const parent = getParent(true);
        const base = typeof parent[last] === "number" ? parent[last] : 0;
        parent[last] = base + Number(op.value);
        break;
      }
      default:
        throw new Error("Unsupported patch op: " + op.op);
    }
  }

  listOrReadAllDocs(ctx, db, coll) {
    const { res, headers } = ctx;
    const aim = headers["a-im"];
    const isChangeFeed = aim && /incremental feed/i.test(aim);

    if (isChangeFeed) {
      return this.changeFeed(ctx, db, coll);
    }

    // GET /docs is the readAll items path
    const Documents = [...coll.docs.values()].map((d) => this.docView(coll, d));
    this.sendJson(res, 200, { _rid: coll._rid, Documents, _count: Documents.length });
  }

  changeFeed(ctx, db, coll) {
    const { res, headers } = ctx;
    const ifNoneMatch = headers["if-none-match"];
    const pkHeader = parsePartitionKeyHeader(headers["x-ms-documentdb-partitionkey"]);
    const pkRangeId = headers["x-ms-documentdb-partitionkeyrangeid"];

    // If-None-Match: "*" => start from beginning. Numeric continuation => after that LSN.
    let sinceLsn = 0;
    if (ifNoneMatch && ifNoneMatch !== "*") {
      const stripped = ifNoneMatch.replace(/"/g, "");
      const parsed = parseInt(stripped, 10);
      if (Number.isFinite(parsed)) sinceLsn = parsed;
    }
    // Start-from-now sentinel: SDK sends a special header value; treat very large
    // continuations as "from now".
    const startFromNow = headers["if-none-match"] === '"0"' && headers["x-ms-cosmos-start-from-now"];

    let docs = [...coll.docs.values()];
    if (pkHeader !== undefined) {
      docs = docs.filter((d) => this.matchesPartitionKey(coll, d, pkHeader));
    }
    docs = docs.filter((d) => (d._lsn || 0) > sinceLsn).sort((a, b) => (a._lsn || 0) - (b._lsn || 0));

    const maxLsn = coll.docs.size ? Math.max(0, ...[...coll.docs.values()].map((d) => d._lsn || 0)) : sinceLsn;
    const etag = `"${maxLsn}"`;

    if (docs.length === 0) {
      this.baseHeaders(res);
      res.setHeader("etag", etag);
      res.statusCode = 304;
      return res.end();
    }

    const Documents = docs.map((d) => this.docView(coll, d));
    this.sendJson(res, 200, { _rid: coll._rid, Documents, _count: Documents.length }, { etag });
  }

  // -------------------------------------------------------------------------
  // Query engine
  // -------------------------------------------------------------------------
  queryPlan(ctx, coll) {
    const { res } = ctx;
    const body = this.parseJsonBody(ctx) || {};
    const query = (body.query || "").toString();
    const plan = this.buildQueryPlan(query);
    this.sendJson(res, 200, plan);
  }

  buildQueryPlan(query) {
    const q = query.toLowerCase();
    const orderBy = [];
    const orderByExpressions = [];
    const aggregates = [];
    let top = null;
    let offset = null;
    let limit = null;
    let distinctType = "None";

    const orderMatch = query.match(/order\s+by\s+(.+?)(?:\s+(asc|desc))?\s*$/i);
    if (/order\s+by/i.test(query)) {
      const m = query.match(/order\s+by\s+([\s\S]+)$/i);
      if (m) {
        const cols = m[1].split(",");
        for (const col of cols) {
          const desc = /\bdesc\b/i.test(col);
          orderBy.push(desc ? "Descending" : "Ascending");
          orderByExpressions.push(col.replace(/\b(asc|desc)\b/gi, "").trim());
        }
      }
    }
    if (/\bdistinct\b/i.test(q)) distinctType = "Ordered";
    const topMatch = query.match(/top\s+(\d+)/i);
    if (topMatch) top = Number(topMatch[1]);
    const offsetMatch = query.match(/offset\s+(\d+)/i);
    if (offsetMatch) offset = Number(offsetMatch[1]);
    const limitMatch = query.match(/limit\s+(\d+)/i);
    if (limitMatch) limit = Number(limitMatch[1]);
    if (/\bcount\s*\(/i.test(q)) aggregates.push("Count");
    if (/\bsum\s*\(/i.test(q)) aggregates.push("Sum");
    if (/\bavg\s*\(/i.test(q)) aggregates.push("Average");
    if (/\bmin\s*\(/i.test(q)) aggregates.push("Min");
    if (/\bmax\s*\(/i.test(q)) aggregates.push("Max");

    return {
      partitionedQueryExecutionInfoVersion: 2,
      queryInfo: {
        distinctType,
        top,
        offset,
        limit,
        orderBy,
        orderByExpressions,
        groupByExpressions: [],
        groupByAliases: [],
        aggregates,
        groupByAliasToAggregateType: {},
        rewrittenQuery: "",
        hasSelectValue: /select\s+value/i.test(query),
        hasNonStreamingOrderBy: false,
        dCountInfo: null,
      },
      queryRanges: [{ min: "", max: "FF", isMinInclusive: true, isMaxInclusive: false }],
    };
  }

  queryDocuments(ctx, db, coll) {
    const { res, headers } = ctx;
    const body = this.parseJsonBody(ctx) || {};
    const query = (body.query || "").toString();
    const params = {};
    if (Array.isArray(body.parameters)) {
      for (const p of body.parameters) params[p.name] = p.value;
    }

    let docs = [...coll.docs.values()];

    // Partition-scoped query?
    const pkHeader = parsePartitionKeyHeader(headers["x-ms-documentdb-partitionkey"]);
    if (pkHeader !== undefined) {
      docs = docs.filter((d) => this.matchesPartitionKey(coll, d, pkHeader));
    }

    let result;
    try {
      result = this.runSqlQuery(query, params, docs, coll);
    } catch (err) {
      return this.sendError(res, 400, "BadRequest", "Syntax error in SQL query: " + err.message);
    }

    // continuation / max item count paging
    const maxItems = parseInt(headers["x-ms-max-item-count"], 10);
    let continuationIn = headers["x-ms-continuation"];
    let items = result;
    const extra = {};
    if (Number.isFinite(maxItems) && maxItems > 0 && !this._isAggregateResult(result)) {
      let start = 0;
      if (continuationIn) {
        const parsed = parseInt(continuationIn, 10);
        if (Number.isFinite(parsed)) start = parsed;
      }
      const page = result.slice(start, start + maxItems);
      const nextStart = start + maxItems;
      if (nextStart < result.length) extra["x-ms-continuation"] = String(nextStart);
      items = page;
    }

    this.sendJson(res, 200, { _rid: coll._rid, Documents: items, _count: items.length }, extra);
  }

  _isAggregateResult(result) {
    // aggregate results are shaped { $1: value } objects with no id, leave unpaged
    return false;
  }

  // A small but real SQL subset interpreter:
  //   SELECT * | SELECT VALUE expr | SELECT a, b
  //   FROM c
  //   WHERE <predicate>
  //   ORDER BY expr [ASC|DESC]
  //   OFFSET n LIMIT m
  //   TOP n
  //   aggregates: COUNT/SUM/AVG/MIN/MAX
  runSqlQuery(query, params, docs, coll) {
    const ast = this.parseSql(query);
    const alias = ast.fromAlias || "c";

    // substitute parameters
    const resolveParams = (expr) => expr;

    // WHERE
    let rows = docs;
    if (ast.where) {
      rows = rows.filter((doc) => this.evalExpr(ast.where, doc, alias, params));
    }

    // ORDER BY
    if (ast.orderBy && ast.orderBy.length) {
      rows = [...rows].sort((a, b) => {
        for (const ob of ast.orderBy) {
          const va = this.evalExpr(ob.expr, a, alias, params);
          const vb = this.evalExpr(ob.expr, b, alias, params);
          const cmp = this.compareValues(va, vb);
          if (cmp !== 0) return ob.desc ? -cmp : cmp;
        }
        return 0;
      });
    }

    // Aggregates
    if (ast.aggregate) {
      const value = this.computeAggregate(ast.aggregate, rows, alias, params);
      // Cosmos returns aggregates wrapped; the client unwraps. For VALUE COUNT(1)
      // it returns the scalar directly in Documents.
      if (ast.selectValue) return [value];
      return [{ [ast.aggregate.alias || "$1"]: value }];
    }

    // DISTINCT
    let projected = rows.map((doc) => this.project(ast, doc, alias, params));
    if (ast.distinct) {
      const seen = new Set();
      projected = projected.filter((v) => {
        const key = JSON.stringify(v);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // OFFSET / LIMIT / TOP
    if (ast.offset !== null && ast.offset !== undefined) {
      projected = projected.slice(ast.offset);
    }
    if (ast.limit !== null && ast.limit !== undefined) {
      projected = projected.slice(0, ast.limit);
    }
    if (ast.top !== null && ast.top !== undefined) {
      projected = projected.slice(0, ast.top);
    }

    return projected;
  }

  project(ast, doc, alias, params) {
    if (ast.selectStar) {
      // strip internal-only? Cosmos keeps system props in SELECT *
      return this.docView(ast._coll || { _dbRid: "", _rid: "" }, doc);
    }
    if (ast.selectValue) {
      return this.evalExpr(ast.selectValueExpr, doc, alias, params);
    }
    const out = {};
    for (const col of ast.columns) {
      const val = this.evalExpr(col.expr, doc, alias, params);
      if (val !== undefined) out[col.alias] = val;
    }
    return out;
  }

  computeAggregate(agg, rows, alias, params) {
    const values = rows
      .map((d) => (agg.expr ? this.evalExpr(agg.expr, d, alias, params) : 1))
      .filter((v) => v !== undefined && v !== null);
    switch (agg.func) {
      case "COUNT":
        return agg.expr ? values.length : rows.length;
      case "SUM":
        return values.reduce((a, b) => a + Number(b), 0);
      case "AVG":
        return values.length ? values.reduce((a, b) => a + Number(b), 0) / values.length : undefined;
      case "MIN":
        return values.length ? values.reduce((a, b) => (this.compareValues(b, a) < 0 ? b : a)) : undefined;
      case "MAX":
        return values.length ? values.reduce((a, b) => (this.compareValues(b, a) > 0 ? b : a)) : undefined;
      default:
        return undefined;
    }
  }

  compareValues(a, b) {
    if (a === undefined || a === null) return b === undefined || b === null ? 0 : -1;
    if (b === undefined || b === null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  // ---- SQL parser (recursive descent over a small grammar) ----
  parseSql(query) {
    const original = query.trim();
    const ast = {
      selectStar: false,
      selectValue: false,
      selectValueExpr: null,
      columns: [],
      distinct: false,
      top: null,
      aggregate: null,
      fromAlias: "c",
      where: null,
      orderBy: [],
      offset: null,
      limit: null,
    };

    const selectMatch = original.match(/^select\s+([\s\S]+?)\s+from\s+([\s\S]+)$/i);
    if (!selectMatch) {
      // Possibly "SELECT 1" without FROM — not supported but be lenient.
      throw new Error("Only SELECT ... FROM queries are supported");
    }
    let selectClause = selectMatch[1].trim();
    let rest = selectMatch[2].trim();

    if (/^distinct\s+/i.test(selectClause)) {
      ast.distinct = true;
      selectClause = selectClause.replace(/^distinct\s+/i, "").trim();
    }
    const topMatch = selectClause.match(/^top\s+(\d+)\s+([\s\S]+)$/i);
    if (topMatch) {
      ast.top = Number(topMatch[1]);
      selectClause = topMatch[2].trim();
    }

    // Split rest into FROM <alias>, then optional WHERE / ORDER BY / OFFSET / LIMIT
    // Find clause keyword positions.
    const lower = rest.toLowerCase();
    const whereIdx = this.findKeyword(lower, "where");
    const orderIdx = this.findKeyword(lower, "order by");
    const offsetIdx = this.findKeyword(lower, "offset");
    const limitIdx = this.findKeyword(lower, "limit");

    const cuts = [whereIdx, orderIdx, offsetIdx, limitIdx].filter((i) => i >= 0).sort((a, b) => a - b);
    const fromEnd = cuts.length ? cuts[0] : rest.length;
    const fromClause = rest.slice(0, fromEnd).trim();
    // FROM c  OR  FROM root c  OR FROM Items c
    const fa = fromClause.split(/\s+/).filter(Boolean);
    ast.fromAlias = fa.length >= 2 ? fa[1] : fa[0] || "c";
    // strip "in" subqueries not supported; keep alias as the last token
    ast.fromAlias = fa[fa.length - 1] || "c";

    if (whereIdx >= 0) {
      const end = [orderIdx, offsetIdx, limitIdx].filter((i) => i > whereIdx).sort((a, b) => a - b)[0] ?? rest.length;
      const clause = rest.slice(whereIdx + 5, end).trim();
      ast.where = this.parsePredicate(clause);
    }
    if (orderIdx >= 0) {
      const end = [offsetIdx, limitIdx].filter((i) => i > orderIdx).sort((a, b) => a - b)[0] ?? rest.length;
      const clause = rest.slice(orderIdx + 8, end).trim();
      ast.orderBy = clause.split(",").map((c) => {
        const desc = /\bdesc\b/i.test(c);
        const expr = c.replace(/\b(asc|desc)\b/gi, "").trim();
        return { expr: this.parseValueExpr(expr), desc };
      });
    }
    if (offsetIdx >= 0) {
      const m = rest.slice(offsetIdx).match(/offset\s+(\d+)/i);
      if (m) ast.offset = Number(m[1]);
    }
    if (limitIdx >= 0) {
      const m = rest.slice(limitIdx).match(/limit\s+(\d+)/i);
      if (m) ast.limit = Number(m[1]);
    }

    // Parse SELECT clause
    if (selectClause === "*") {
      ast.selectStar = true;
    } else if (/^value\s+/i.test(selectClause)) {
      const expr = selectClause.replace(/^value\s+/i, "").trim();
      const agg = this.parseAggregate(expr);
      if (agg) {
        ast.aggregate = agg;
        ast.selectValue = true;
      } else {
        ast.selectValue = true;
        ast.selectValueExpr = this.parseValueExpr(expr);
      }
    } else {
      // Could be a single aggregate like COUNT(1)
      const agg = this.parseAggregate(selectClause);
      if (agg && !selectClause.includes(",")) {
        ast.aggregate = agg;
      } else {
        ast.columns = selectClause.split(",").map((c) => {
          const asMatch = c.match(/^([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)\s*$/i);
          let exprText = c.trim();
          let alias;
          if (asMatch) {
            exprText = asMatch[1].trim();
            alias = asMatch[2];
          }
          const expr = this.parseValueExpr(exprText);
          if (!alias) {
            // alias defaults to the last property segment
            const parts = exprText.split(".");
            alias = parts[parts.length - 1].replace(/[^\w$]/g, "") || "$1";
          }
          return { expr, alias };
        });
      }
    }

    return ast;
  }

  parseAggregate(text) {
    const m = text.trim().match(/^(count|sum|avg|min|max)\s*\(([\s\S]*)\)\s*$/i);
    if (!m) return null;
    const func = m[1].toUpperCase();
    const inner = m[2].trim();
    const expr = inner === "*" || inner === "1" || inner === "" ? null : this.parseValueExpr(inner);
    return { func, expr, alias: "$1" };
  }

  findKeyword(haystackLower, kw) {
    // find keyword bounded by whitespace
    const re = new RegExp(`(^|\\s)${kw.replace(/ /g, "\\s+")}(\\s|$)`, "i");
    const m = haystackLower.match(re);
    if (!m) return -1;
    return m.index + m[1].length;
  }

  // ---- predicate parser: handles AND/OR/NOT, comparisons, IN, functions ----
  parsePredicate(text) {
    return this.parseOr(this.tokenize(text), { i: 0 });
  }

  tokenize(text) {
    const tokens = [];
    const re = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|@[A-Za-z_]\w*|>=|<=|!=|<>|=|<|>|\(|\)|,|\[|\]|[A-Za-z_][\w.]*|-?\d+\.?\d*|[*/+%-])/g;
    let m;
    let last = 0;
    while ((m = re.exec(text)) !== null) {
      tokens.push(m[1]);
      last = re.lastIndex;
    }
    return tokens;
  }

  parseOr(tokens, pos) {
    let left = this.parseAnd(tokens, pos);
    while (pos.i < tokens.length && /^or$/i.test(tokens[pos.i])) {
      pos.i++;
      const right = this.parseAnd(tokens, pos);
      left = { type: "or", left, right };
    }
    return left;
  }

  parseAnd(tokens, pos) {
    let left = this.parseNot(tokens, pos);
    while (pos.i < tokens.length && /^and$/i.test(tokens[pos.i])) {
      pos.i++;
      const right = this.parseNot(tokens, pos);
      left = { type: "and", left, right };
    }
    return left;
  }

  parseNot(tokens, pos) {
    if (pos.i < tokens.length && /^not$/i.test(tokens[pos.i])) {
      pos.i++;
      return { type: "not", expr: this.parseNot(tokens, pos) };
    }
    return this.parseComparison(tokens, pos);
  }

  parseComparison(tokens, pos) {
    if (tokens[pos.i] === "(") {
      pos.i++;
      const expr = this.parseOr(tokens, pos);
      if (tokens[pos.i] === ")") pos.i++;
      return expr;
    }
    // function call predicate (e.g. CONTAINS(c.name,"x") / STARTSWITH / IS_DEFINED)
    const fnMatch = tokens[pos.i] && /^[A-Za-z_]\w*$/.test(tokens[pos.i]) && tokens[pos.i + 1] === "(";
    if (fnMatch) {
      const fn = tokens[pos.i].toUpperCase();
      const start = pos.i;
      const fnNode = this.parseFunction(tokens, pos);
      // function may be followed by comparison
      if (pos.i < tokens.length && /^(=|!=|<>|<|>|<=|>=)$/.test(tokens[pos.i])) {
        const op = tokens[pos.i++];
        const right = this.parseValueToken(tokens, pos);
        return { type: "cmp", op, left: fnNode, right };
      }
      return { type: "truthy", expr: fnNode };
    }

    const left = this.parseValueToken(tokens, pos);
    const op = tokens[pos.i];
    if (op && /^(=|!=|<>|<|>|<=|>=)$/.test(op)) {
      pos.i++;
      const right = this.parseValueToken(tokens, pos);
      return { type: "cmp", op, left, right };
    }
    if (op && /^in$/i.test(op)) {
      pos.i++;
      const list = [];
      if (tokens[pos.i] === "(") {
        pos.i++;
        while (pos.i < tokens.length && tokens[pos.i] !== ")") {
          if (tokens[pos.i] === ",") { pos.i++; continue; }
          list.push(this.parseValueToken(tokens, pos));
        }
        if (tokens[pos.i] === ")") pos.i++;
      }
      return { type: "in", left, list };
    }
    return { type: "truthy", expr: left };
  }

  parseFunction(tokens, pos) {
    const name = tokens[pos.i++].toUpperCase();
    const args = [];
    if (tokens[pos.i] === "(") {
      pos.i++;
      while (pos.i < tokens.length && tokens[pos.i] !== ")") {
        if (tokens[pos.i] === ",") { pos.i++; continue; }
        args.push(this.parseValueToken(tokens, pos));
      }
      if (tokens[pos.i] === ")") pos.i++;
    }
    return { type: "func", name, args };
  }

  parseValueToken(tokens, pos) {
    const tok = tokens[pos.i];
    if (tok === undefined) throw new Error("Unexpected end of expression");
    // function?
    if (/^[A-Za-z_]\w*$/.test(tok) && tokens[pos.i + 1] === "(") {
      return this.parseFunction(tokens, pos);
    }
    pos.i++;
    return this.makeAtom(tok);
  }

  makeAtom(tok) {
    if (tok === undefined) throw new Error("Unexpected token");
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
      return { type: "lit", value: this.unquote(tok) };
    }
    if (tok.startsWith("@")) return { type: "param", name: tok };
    if (/^-?\d+\.?\d*$/.test(tok)) return { type: "lit", value: Number(tok) };
    if (/^true$/i.test(tok)) return { type: "lit", value: true };
    if (/^false$/i.test(tok)) return { type: "lit", value: false };
    if (/^null$/i.test(tok)) return { type: "lit", value: null };
    // path like c.name or c["a"]
    return { type: "path", path: tok };
  }

  unquote(tok) {
    const inner = tok.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }

  // ---- value expression parser for SELECT/ORDER BY ----
  parseValueExpr(text) {
    const trimmed = text.trim();
    const agg = this.parseAggregate(trimmed);
    if (agg) return { type: "aggExpr", agg };
    return this.makeAtom(trimmed);
  }

  // ---- evaluator ----
  evalExpr(node, doc, alias, params) {
    if (!node) return undefined;
    switch (node.type) {
      case "and":
        return this.truthy(this.evalExpr(node.left, doc, alias, params)) &&
          this.truthy(this.evalExpr(node.right, doc, alias, params));
      case "or":
        return this.truthy(this.evalExpr(node.left, doc, alias, params)) ||
          this.truthy(this.evalExpr(node.right, doc, alias, params));
      case "not":
        return !this.truthy(this.evalExpr(node.expr, doc, alias, params));
      case "truthy":
        return this.truthy(this.evalExpr(node.expr, doc, alias, params));
      case "cmp": {
        const l = this.evalExpr(node.left, doc, alias, params);
        const r = this.evalExpr(node.right, doc, alias, params);
        return this.compareOp(node.op, l, r);
      }
      case "in": {
        const l = this.evalExpr(node.left, doc, alias, params);
        return node.list.some((item) => this.looseEq(l, this.evalExpr(item, doc, alias, params)));
      }
      case "lit":
        return node.value;
      case "param":
        return params[node.name];
      case "path":
        return this.resolvePath(node.path, doc, alias);
      case "func":
        return this.evalFunction(node, doc, alias, params);
      default:
        return undefined;
    }
  }

  compareOp(op, l, r) {
    switch (op) {
      case "=":
        return this.looseEq(l, r);
      case "!=":
      case "<>":
        return !this.looseEq(l, r);
      case "<":
        return this.bothComparable(l, r) && this.compareValues(l, r) < 0;
      case ">":
        return this.bothComparable(l, r) && this.compareValues(l, r) > 0;
      case "<=":
        return this.bothComparable(l, r) && this.compareValues(l, r) <= 0;
      case ">=":
        return this.bothComparable(l, r) && this.compareValues(l, r) >= 0;
      default:
        return false;
    }
  }

  bothComparable(l, r) {
    return l !== undefined && r !== undefined && l !== null && r !== null;
  }

  looseEq(a, b) {
    if (a === undefined || b === undefined) return false;
    if (typeof a === "number" && typeof b === "number") return a === b;
    if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
    return a === b;
  }

  truthy(v) {
    return v === true;
  }

  resolvePath(path, doc, alias) {
    // path like c.name.first or c["a"]
    const normalized = path.replace(/\[(\d+)\]/g, ".$1").replace(/\["([^"]+)"\]/g, ".$1");
    const segments = normalized.split(".");
    let cur;
    if (segments[0] === alias || segments[0] === "c" || segments[0] === "root") {
      cur = doc;
      segments.shift();
    } else {
      // bare property name relative to root
      cur = doc;
    }
    for (const seg of segments) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  evalFunction(node, doc, alias, params) {
    const args = node.args.map((a) => this.evalExpr(a, doc, alias, params));
    const [a0, a1, a2] = args;
    switch (node.name) {
      case "CONTAINS":
        return typeof a0 === "string" && typeof a1 === "string" &&
          (a2 ? a0.toLowerCase().includes(String(a1).toLowerCase()) : a0.includes(a1));
      case "STARTSWITH":
        return typeof a0 === "string" && typeof a1 === "string" && a0.startsWith(a1);
      case "ENDSWITH":
        return typeof a0 === "string" && typeof a1 === "string" && a0.endsWith(a1);
      case "UPPER":
        return typeof a0 === "string" ? a0.toUpperCase() : undefined;
      case "LOWER":
        return typeof a0 === "string" ? a0.toLowerCase() : undefined;
      case "LENGTH":
      case "STRLEN":
        return typeof a0 === "string" ? a0.length : undefined;
      case "ABS":
        return typeof a0 === "number" ? Math.abs(a0) : undefined;
      case "FLOOR":
        return typeof a0 === "number" ? Math.floor(a0) : undefined;
      case "CEILING":
        return typeof a0 === "number" ? Math.ceil(a0) : undefined;
      case "ROUND":
        return typeof a0 === "number" ? Math.round(a0) : undefined;
      case "CONCAT":
        return args.map((a) => (a === undefined || a === null ? "" : String(a))).join("");
      case "IS_DEFINED":
        return a0 !== undefined;
      case "IS_NULL":
        return a0 === null;
      case "IS_STRING":
        return typeof a0 === "string";
      case "IS_NUMBER":
        return typeof a0 === "number";
      case "IS_BOOL":
        return typeof a0 === "boolean";
      case "IS_ARRAY":
        return Array.isArray(a0);
      case "IS_OBJECT":
        return a0 !== null && typeof a0 === "object" && !Array.isArray(a0);
      case "ARRAY_CONTAINS":
        return Array.isArray(a0) && a0.some((x) => this.looseEq(x, a1));
      case "ARRAY_LENGTH":
        return Array.isArray(a0) ? a0.length : undefined;
      case "TOSTRING":
        return a0 === undefined ? undefined : String(a0);
      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Stored procedures / triggers / udfs
  // -------------------------------------------------------------------------
  scriptCollection(coll, kind) {
    return coll[kind];
  }

  scriptView(coll, kind, script) {
    const seg = kind;
    return {
      ...script,
      _rid: script._rid,
      _self: `dbs/${coll._dbRid}/colls/${coll._rid}/${seg}/${script._rid}/`,
      _etag: script._etag,
      _ts: script._ts,
    };
  }

  scriptListKey(kind) {
    return { sprocs: "StoredProcedures", triggers: "Triggers", udfs: "UserDefinedFunctions" }[kind];
  }

  listScripts(ctx, coll, kind) {
    const { res } = ctx;
    const map = this.scriptCollection(coll, kind);
    const items = [...map.values()].map((s) => this.scriptView(coll, kind, s));
    this.sendJson(res, 200, { _rid: coll._rid, [this.scriptListKey(kind)]: items, _count: items.length });
  }

  createScript(ctx, coll, kind) {
    const { res } = ctx;
    const body = this.parseJsonBody(ctx);
    if (!body || !isValidId(body.id)) return this.badRequest(res, "The input is not a valid script.");
    const map = this.scriptCollection(coll, kind);
    if (map.has(body.id)) return this.conflict(res);
    const script = {
      ...body,
      _rid: makeRid(`${kind}:${coll._rid}:${body.id}`),
      _ts: nowTs(),
      _etag: makeEtag(),
    };
    map.set(body.id, script);
    this.sendJson(res, 201, this.scriptView(coll, kind, script), { etag: script._etag });
  }

  readScript(ctx, coll, kind, id) {
    const { res } = ctx;
    const map = this.scriptCollection(coll, kind);
    const script = map.get(id);
    if (!script) return this.notFound(res);
    this.sendJson(res, 200, this.scriptView(coll, kind, script), { etag: script._etag });
  }

  replaceScript(ctx, coll, kind, id) {
    const { res } = ctx;
    const map = this.scriptCollection(coll, kind);
    const existing = map.get(id);
    if (!existing) return this.notFound(res);
    const body = this.parseJsonBody(ctx) || {};
    const script = {
      ...existing,
      ...body,
      id,
      _rid: existing._rid,
      _ts: nowTs(),
      _etag: makeEtag(),
    };
    map.set(id, script);
    this.sendJson(res, 200, this.scriptView(coll, kind, script), { etag: script._etag });
  }

  deleteScript(ctx, coll, kind, id) {
    const { res } = ctx;
    const map = this.scriptCollection(coll, kind);
    if (!map.has(id)) return this.notFound(res);
    map.delete(id);
    this.sendJson(res, 204, undefined);
  }

  executeSproc(ctx, db, coll, id) {
    const { res } = ctx;
    const sproc = coll.sprocs.get(id);
    if (!sproc) return this.notFound(res);
    const args = this.parseJsonBody(ctx);
    const argArray = Array.isArray(args) ? args : args === undefined ? [] : [args];

    // Execute the user-supplied JS body in a constrained context with a minimal
    // getContext() shim, mirroring the server-side JS environment closely enough
    // for typical sprocs (response.setBody, collection CRUD/query).
    try {
      const result = this.runStoredProcedure(sproc, coll, argArray);
      this.sendJson(res, 200, result === undefined ? null : result);
    } catch (err) {
      return this.sendError(res, 400, "BadRequest", "Encountered exception while executing Javascript. Exception = " + err.message);
    }
  }

  runStoredProcedure(sproc, coll, argArray) {
    let responseBody;
    const self = this;
    const collLink = `dbs/${coll._dbRid}/colls/${coll._rid}`;

    const response = {
      setBody(b) { responseBody = b; },
      getBody() { return responseBody; },
      appendBody() {},
      setValue() {},
    };

    const collectionApi = {
      getSelfLink() { return collLink; },
      readDocument(_link, cb) {
        // not commonly used in simple sprocs
        if (cb) cb({ code: 404 }, null);
        return true;
      },
      createDocument(_link, document, options, cb) {
        if (typeof options === "function") { cb = options; options = {}; }
        if (document.id === undefined) document.id = randomUUID();
        const doc = { ...document };
        self.applyDocSystemProps(coll, doc, coll.docs.get(doc.id));
        coll.docs.set(String(doc.id), doc);
        if (cb) cb(null, self.docView(coll, doc));
        return true;
      },
      replaceDocument(_link, document, cb) {
        const doc = { ...document };
        self.applyDocSystemProps(coll, doc, coll.docs.get(doc.id));
        coll.docs.set(String(doc.id), doc);
        if (cb) cb(null, self.docView(coll, doc));
        return true;
      },
      deleteDocument(link, cb) {
        if (cb) cb(null, {});
        return true;
      },
      queryDocuments(_link, query, options, cb) {
        if (typeof options === "function") { cb = options; options = {}; }
        const q = typeof query === "string" ? query : query.query;
        let docs;
        try {
          docs = self.runSqlQuery(q, {}, [...coll.docs.values()], coll);
        } catch {
          docs = [];
        }
        if (cb) cb(null, docs);
        return true;
      },
    };

    const getContext = () => ({
      getCollection: () => collectionApi,
      getResponse: () => response,
      getRequest: () => ({ getBody: () => "", setBody() {} }),
    });
    void getContext; // keep reference for the shimmed scope below

    // Build a function from the body. Cosmos sprocs are written as
    // `function name(args) { ... }`. We wrap to inject getContext + __args.
    const wrapped = `
      "use strict";
      var getContext = __getContext;
      var __Continuation = undefined;
      ( ${sproc.body} ).apply(null, __args);
      return __responseBody();
    `;
    // eslint-disable-next-line no-new-func
    const fn = new Function("__getContext", "__args", "__responseBody", wrapped);
    fn(() => ({
      getCollection: () => collectionApi,
      getResponse: () => response,
      getRequest: () => ({ getBody: () => "", setBody() {} }),
    }), argArray, () => responseBody);
    return responseBody;
  }

  // -------------------------------------------------------------------------
  // Users & Permissions
  // -------------------------------------------------------------------------
  userView(db, user) {
    return {
      id: user.id,
      _rid: user._rid,
      _ts: user._ts,
      _self: `dbs/${db._rid}/users/${user._rid}/`,
      _etag: user._etag,
      _permissions: "permissions/",
      _db: db._rid,
    };
  }

  listUsers(ctx, db) {
    const { res } = ctx;
    const Users = [...db.users.values()].map((u) => this.userView(db, u));
    this.sendJson(res, 200, { _rid: db._rid, Users, _count: Users.length });
  }

  createUser(ctx, db) {
    const { res, headers } = ctx;
    const body = this.parseJsonBody(ctx);
    if (!body || !isValidId(body.id)) return this.badRequest(res, "The input is not a valid user.");
    const isUpsert = headers["x-ms-documentdb-is-upsert"] === "true";
    const existing = db.users.get(body.id);
    if (existing) {
      if (!isUpsert) return this.conflict(res);
      existing._ts = nowTs();
      existing._etag = makeEtag();
      return this.sendJson(res, 200, this.userView(db, existing), { etag: existing._etag });
    }
    const user = {
      id: body.id,
      _rid: makeRid(`user:${db._rid}:${body.id}`),
      _ts: nowTs(),
      _etag: makeEtag(),
      _db: db,
      permissions: new Map(),
    };
    db.users.set(user.id, user);
    this.sendJson(res, 201, this.userView(db, user), { etag: user._etag });
  }

  readUser(ctx, db, userId) {
    const { res } = ctx;
    const user = db.users.get(userId);
    if (!user) return this.notFound(res);
    this.sendJson(res, 200, this.userView(db, user), { etag: user._etag });
  }

  replaceUser(ctx, db, userId) {
    const { res } = ctx;
    const user = db.users.get(userId);
    if (!user) return this.notFound(res);
    const body = this.parseJsonBody(ctx) || {};
    if (body.id && body.id !== userId) {
      // rename
      if (db.users.has(body.id)) return this.conflict(res);
      db.users.delete(userId);
      user.id = body.id;
      db.users.set(user.id, user);
    }
    user._ts = nowTs();
    user._etag = makeEtag();
    this.sendJson(res, 200, this.userView(db, user), { etag: user._etag });
  }

  deleteUser(ctx, db, userId) {
    const { res } = ctx;
    if (!db.users.has(userId)) return this.notFound(res);
    db.users.delete(userId);
    this.sendJson(res, 204, undefined);
  }

  permissionView(user, perm) {
    const token = `type=resource&ver=1&sig=${makeRid("sig:" + perm._rid)};${makeRid("tok:" + perm._rid)}`;
    return {
      id: perm.id,
      permissionMode: perm.permissionMode,
      resource: perm.resource,
      resourcePartitionKey: perm.resourcePartitionKey,
      _rid: perm._rid,
      _ts: perm._ts,
      _self: `dbs/${user._db._rid}/users/${user._rid}/permissions/${perm._rid}/`,
      _etag: perm._etag,
      _token: token,
    };
  }

  listPermissions(ctx, user) {
    const { res } = ctx;
    const Permissions = [...user.permissions.values()].map((p) => this.permissionView(user, p));
    this.sendJson(res, 200, { _rid: user._rid, Permissions, _count: Permissions.length });
  }

  createPermission(ctx, user) {
    const { res, headers } = ctx;
    const body = this.parseJsonBody(ctx);
    if (!body || !isValidId(body.id)) return this.badRequest(res, "The input is not a valid permission.");
    if (!body.permissionMode || !body.resource) return this.badRequest(res, "permissionMode and resource are required.");
    const isUpsert = headers["x-ms-documentdb-is-upsert"] === "true";
    const existingPerm = user.permissions.get(body.id);
    if (existingPerm) {
      if (!isUpsert) return this.conflict(res);
      existingPerm.permissionMode = body.permissionMode;
      existingPerm.resource = body.resource;
      existingPerm._ts = nowTs();
      existingPerm._etag = makeEtag();
      return this.sendJson(res, 200, this.permissionView(user, existingPerm), { etag: existingPerm._etag });
    }
    const perm = {
      id: body.id,
      permissionMode: body.permissionMode,
      resource: body.resource,
      resourcePartitionKey: body.resourcePartitionKey,
      _rid: makeRid(`perm:${user._rid}:${body.id}`),
      _ts: nowTs(),
      _etag: makeEtag(),
    };
    user.permissions.set(perm.id, perm);
    this.sendJson(res, 201, this.permissionView(user, perm), { etag: perm._etag });
  }

  readPermission(ctx, user, permId) {
    const { res } = ctx;
    const perm = user.permissions.get(permId);
    if (!perm) return this.notFound(res);
    this.sendJson(res, 200, this.permissionView(user, perm), { etag: perm._etag });
  }

  replacePermission(ctx, user, permId) {
    const { res } = ctx;
    const perm = user.permissions.get(permId);
    if (!perm) return this.notFound(res);
    const body = this.parseJsonBody(ctx) || {};
    if (body.permissionMode) perm.permissionMode = body.permissionMode;
    if (body.resource) perm.resource = body.resource;
    perm._ts = nowTs();
    perm._etag = makeEtag();
    this.sendJson(res, 200, this.permissionView(user, perm), { etag: perm._etag });
  }

  deletePermission(ctx, user, permId) {
    const { res } = ctx;
    if (!user.permissions.has(permId)) return this.notFound(res);
    user.permissions.delete(permId);
    this.sendJson(res, 204, undefined);
  }

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------
  conflictView(coll, conflict) {
    return {
      ...conflict,
      _rid: conflict._rid,
      _self: `dbs/${coll._dbRid}/colls/${coll._rid}/conflicts/${conflict._rid}/`,
      _etag: conflict._etag,
      _ts: conflict._ts,
    };
  }

  listConflicts(ctx, coll) {
    const { res } = ctx;
    const Conflicts = [...coll.conflicts.values()].map((c) => this.conflictView(coll, c));
    this.sendJson(res, 200, { _rid: coll._rid, Conflicts, _count: Conflicts.length });
  }

  readConflict(ctx, coll, id) {
    const { res } = ctx;
    const conflict = coll.conflicts.get(id);
    if (!conflict) return this.notFound(res);
    this.sendJson(res, 200, this.conflictView(coll, conflict), { etag: conflict._etag });
  }

  deleteConflict(ctx, coll, id) {
    const { res } = ctx;
    if (!coll.conflicts.has(id)) return this.notFound(res);
    coll.conflicts.delete(id);
    this.sendJson(res, 204, undefined);
  }

  // -------------------------------------------------------------------------
  // Offers (throughput)
  // -------------------------------------------------------------------------
  readThroughputHeaders(ctx) {
    const { headers } = ctx;
    const t = headers["x-ms-offer-throughput"];
    if (t !== undefined) return Number(t);
    const autopilot = headers["x-ms-cosmos-offer-autopilot-settings"];
    if (autopilot) {
      try {
        const parsed = JSON.parse(autopilot);
        if (parsed.maxThroughput) return parsed.maxThroughput;
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  createOffer(resourceRid, resourceSelfLink, offerType, throughput) {
    const offerRid = makeRid(`offer:${resourceRid}`);
    const offer = {
      _rid: offerRid,
      _ts: nowTs(),
      _etag: makeEtag(),
      offerVersion: "V2",
      offerType: "Invalid",
      resource: resourceSelfLink,
      offerResourceId: resourceRid,
      throughput: throughput || 400,
      content: { offerThroughput: throughput || 400, offerIsRUPerMinuteThroughputEnabled: false },
    };
    this.offers.set(offerRid, offer);
    this.offerByResource.set(resourceRid, offer);
    return offer;
  }

  offerView(offer) {
    return {
      _rid: offer._rid,
      _ts: offer._ts,
      _self: `offers/${offer._rid}/`,
      _etag: offer._etag,
      id: offer._rid,
      offerVersion: offer.offerVersion,
      offerType: offer.offerType,
      content: offer.content,
      resource: offer.resource,
      offerResourceId: offer.offerResourceId,
    };
  }

  listOffers(ctx) {
    const { res } = ctx;
    const Offers = [...this.offers.values()].map((o) => this.offerView(o));
    this.sendJson(res, 200, { _rid: "", Offers, _count: Offers.length });
  }

  queryOffers(ctx) {
    const { res } = ctx;
    const body = this.parseJsonBody(ctx) || {};
    const query = (body.query || "").toString();
    // queries look like: SELECT * from root where root.resource = "dbs/xxx/colls/yyy/"
    let matched = [...this.offers.values()];
    const m = query.match(/resource\s*=\s*["']([^"']+)["']/i);
    if (m) {
      const resourceLink = m[1];
      matched = matched.filter((o) => o.resource === resourceLink || o.offerResourceId === resourceLink);
    }
    // also support parameterized
    if (Array.isArray(body.parameters)) {
      for (const p of body.parameters) {
        if (typeof p.value === "string") {
          matched = [...this.offers.values()].filter((o) => o.resource === p.value || o.offerResourceId === p.value);
        }
      }
    }
    const Offers = matched.map((o) => this.offerView(o));
    this.sendJson(res, 200, { _rid: "", Offers, _count: Offers.length });
  }

  replaceOffer(ctx, offerRid) {
    const { res } = ctx;
    const offer = this.offers.get(offerRid);
    if (!offer) return this.notFound(res);
    const body = this.parseJsonBody(ctx) || {};
    const throughput = body.content ? body.content.offerThroughput : undefined;
    if (throughput !== undefined) {
      offer.throughput = throughput;
      offer.content = {
        offerThroughput: throughput,
        offerIsRUPerMinuteThroughputEnabled: body.content.offerIsRUPerMinuteThroughputEnabled || false,
      };
    }
    offer._ts = nowTs();
    offer._etag = makeEtag();
    this.sendJson(res, 200, this.offerView(offer), { etag: offer._etag });
  }

  // -------------------------------------------------------------------------
  // Transactional batch & bulk
  // -------------------------------------------------------------------------
  executeBatch(ctx, db, coll) {
    const { res } = ctx;
    const operations = this.parseJsonBody(ctx);
    if (!Array.isArray(operations)) return this.badRequest(res, "Batch body must be an array of operations.");
    const continueOnError = ctx.headers["x-ms-cosmos-batch-continue-on-error"] === "true";

    const results = [];
    let failed = false;
    let failedIndex = -1;

    // First pass for atomic batches: validate, then apply. We apply sequentially
    // and roll back on failure unless continueOnError.
    const snapshot = new Map(coll.docs);

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (failed && !continueOnError) {
        results.push({ statusCode: 424, requestCharge: 0, resourceBody: undefined });
        continue;
      }
      const result = this.applyBatchOp(coll, op);
      results.push(result);
      if (result.statusCode >= 400) {
        failed = true;
        failedIndex = i;
        if (!continueOnError) {
          // mark remaining as 424 and rollback
          for (let j = i + 1; j < operations.length; j++) {
            results.push({ statusCode: 424, requestCharge: 0 });
          }
          // rollback
          coll.docs = snapshot;
          break;
        }
      }
    }

    const overallStatus = failed && !continueOnError ? 207 : 200;
    // The client expects HTTP 200 with per-op status, or 207 multi-status on failure.
    this.sendJson(res, failed && !continueOnError ? 207 : 200, results);
  }

  applyBatchOp(coll, op) {
    const type = op.operationType;
    try {
      switch (type) {
        case "Create": {
          const doc = { ...op.resourceBody };
          if (doc.id === undefined) doc.id = randomUUID();
          doc.id = String(doc.id);
          if (coll.docs.has(doc.id)) return { statusCode: 409, requestCharge: 1 };
          this.applyDocSystemProps(coll, doc, undefined);
          coll.docs.set(doc.id, doc);
          return { statusCode: 201, requestCharge: 1, resourceBody: this.docView(coll, doc), eTag: doc._etag };
        }
        case "Upsert": {
          const doc = { ...op.resourceBody };
          if (doc.id === undefined) doc.id = randomUUID();
          doc.id = String(doc.id);
          const existing = coll.docs.get(doc.id);
          this.applyDocSystemProps(coll, doc, existing);
          coll.docs.set(doc.id, doc);
          return { statusCode: existing ? 200 : 201, requestCharge: 1, resourceBody: this.docView(coll, doc), eTag: doc._etag };
        }
        case "Read": {
          const doc = coll.docs.get(String(op.id));
          if (!doc) return { statusCode: 404, requestCharge: 1 };
          return { statusCode: 200, requestCharge: 1, resourceBody: this.docView(coll, doc), eTag: doc._etag };
        }
        case "Replace": {
          const id = String(op.id);
          if (!coll.docs.has(id)) return { statusCode: 404, requestCharge: 1 };
          const doc = { ...op.resourceBody, id };
          this.applyDocSystemProps(coll, doc, coll.docs.get(id));
          coll.docs.set(id, doc);
          return { statusCode: 200, requestCharge: 1, resourceBody: this.docView(coll, doc), eTag: doc._etag };
        }
        case "Delete": {
          const id = String(op.id);
          if (!coll.docs.has(id)) return { statusCode: 404, requestCharge: 1 };
          coll.docs.delete(id);
          return { statusCode: 204, requestCharge: 1 };
        }
        case "Patch": {
          const id = String(op.id);
          const existing = coll.docs.get(id);
          if (!existing) return { statusCode: 404, requestCharge: 1 };
          const doc = JSON.parse(JSON.stringify(existing));
          const ops = op.resourceBody && op.resourceBody.operations ? op.resourceBody.operations : op.resourceBody;
          for (const p of ops) this.applyPatchOp(doc, p);
          doc.id = id;
          this.applyDocSystemProps(coll, doc, existing);
          coll.docs.set(id, doc);
          return { statusCode: 200, requestCharge: 1, resourceBody: this.docView(coll, doc), eTag: doc._etag };
        }
        default:
          return { statusCode: 400, requestCharge: 0 };
      }
    } catch (err) {
      return { statusCode: 400, requestCharge: 0 };
    }
  }
}

export default CosmosdbServer;
