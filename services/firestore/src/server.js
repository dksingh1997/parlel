// parlel/firestore — a lightweight, dependency-free fake of Google Cloud
// Firestore (Native mode).
//
// Speaks the Firestore v1 REST API (https://firestore.googleapis.com/v1) so
// that application code using the real `@google-cloud/firestore` client can run
// against it with zero cost and zero side effects. Pure Node.js, no external
// npm dependencies. State is in-memory and ephemeral (resettable via reset()
// or POST /_parlel/reset).
//
// Point the client at this server by setting:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:4581
// and constructing the client with `preferRest: true` (so it uses the HTTP/1.1
// REST transport instead of gRPC):
//   new Firestore({ projectId: "parlel", preferRest: true })
//
// The REST transport (google-gax fallback) transcodes RPCs to these endpoints:
//   GET    /v1/{name=projects/*/databases/*/documents/*/**}        GetDocument
//   GET    /v1/{parent=.../documents}/{collectionId}               ListDocuments
//   GET    /v1/{parent=.../documents/*/**}/{collectionId}          ListDocuments
//   POST   /v1/{parent=.../documents/**}/{collectionId}            CreateDocument
//   PATCH  /v1/{document.name=.../documents/*/**}                  UpdateDocument
//   DELETE /v1/{name=.../documents/*/**}                           DeleteDocument
//   POST   /v1/{database=.../databases/*}/documents:batchGet       BatchGetDocuments
//   POST   /v1/{database}/documents:beginTransaction               BeginTransaction
//   POST   /v1/{database}/documents:commit                         Commit
//   POST   /v1/{database}/documents:rollback                       Rollback
//   POST   /v1/{parent}/documents:runQuery                         RunQuery
//   POST   /v1/{parent}/documents:runAggregationQuery             RunAggregationQuery
//   POST   /v1/{parent}/documents:partitionQuery                   PartitionQuery
//   POST   /v1/{parent}/documents:listCollectionIds               ListCollectionIds
//   POST   /v1/{database}/documents:batchWrite                     BatchWrite
//   POST   /v1/{database}/documents:write    (streaming Write — unsupported)
//   POST   /v1/{database}/documents:listen   (gRPC-only — unsupported)

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// gRPC canonical status codes (used in error responses + BatchWrite status).
// ---------------------------------------------------------------------------
const GRPC = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};

// The google-gax REST fallback maps an error STRICTLY by the numeric
// `error.code` we place in the JSON body, via this HTTP->gRPC table:
//   400->INVALID_ARGUMENT(3) 401->UNAUTHENTICATED(16) 403->PERMISSION_DENIED(7)
//   404->NOT_FOUND(5) 409->ABORTED(10) 416->OUT_OF_RANGE(11)
//   429->RESOURCE_EXHAUSTED(8) 499->CANCELLED(1) 501->UNIMPLEMENTED(12)
//   503->UNAVAILABLE(14) 504->DEADLINE_EXCEEDED(4)
//   other 4xx->FAILED_PRECONDITION(9)  other 5xx->INTERNAL(13)
// We therefore pick a body `error.code` per gRPC code so the client decodes the
// intended canonical status. (Note: ALREADY_EXISTS has no HTTP code that maps
// to it through this table — 409 would decode as ABORTED, which the Firestore
// write-batch layer RETRIES — so create-conflicts are surfaced as
// FAILED_PRECONDITION via code 412, matching the non-retryable, rejecting
// behavior callers expect.)
const GRPC_TO_HTTP = {
  [GRPC.OK]: 200,
  [GRPC.CANCELLED]: 499,
  [GRPC.UNKNOWN]: 500,
  [GRPC.INVALID_ARGUMENT]: 400,
  [GRPC.DEADLINE_EXCEEDED]: 504,
  [GRPC.NOT_FOUND]: 404,
  [GRPC.ALREADY_EXISTS]: 412,
  [GRPC.PERMISSION_DENIED]: 403,
  [GRPC.RESOURCE_EXHAUSTED]: 429,
  [GRPC.FAILED_PRECONDITION]: 412,
  [GRPC.ABORTED]: 409,
  [GRPC.OUT_OF_RANGE]: 416,
  [GRPC.UNIMPLEMENTED]: 501,
  [GRPC.INTERNAL]: 500,
  [GRPC.UNAVAILABLE]: 503,
  [GRPC.DATA_LOSS]: 500,
  [GRPC.UNAUTHENTICATED]: 401,
};

const GRPC_STATUS_NAME = {
  [GRPC.OK]: "OK",
  [GRPC.CANCELLED]: "CANCELLED",
  [GRPC.UNKNOWN]: "UNKNOWN",
  [GRPC.INVALID_ARGUMENT]: "INVALID_ARGUMENT",
  [GRPC.DEADLINE_EXCEEDED]: "DEADLINE_EXCEEDED",
  [GRPC.NOT_FOUND]: "NOT_FOUND",
  [GRPC.ALREADY_EXISTS]: "ALREADY_EXISTS",
  [GRPC.PERMISSION_DENIED]: "PERMISSION_DENIED",
  [GRPC.RESOURCE_EXHAUSTED]: "RESOURCE_EXHAUSTED",
  [GRPC.FAILED_PRECONDITION]: "FAILED_PRECONDITION",
  [GRPC.ABORTED]: "ABORTED",
  [GRPC.OUT_OF_RANGE]: "OUT_OF_RANGE",
  [GRPC.UNIMPLEMENTED]: "UNIMPLEMENTED",
  [GRPC.INTERNAL]: "INTERNAL",
  [GRPC.UNAVAILABLE]: "UNAVAILABLE",
  [GRPC.DATA_LOSS]: "DATA_LOSS",
  [GRPC.UNAUTHENTICATED]: "UNAUTHENTICATED",
};

// Enum normalizers — the REST/proto3-JSON transport emits enum values as
// integers, while the gRPC/emulator transport uses the string names. We accept
// both and normalize to the canonical string name.
const FIELD_OP = {
  0: "OPERATOR_UNSPECIFIED",
  1: "LESS_THAN",
  2: "LESS_THAN_OR_EQUAL",
  3: "GREATER_THAN",
  4: "GREATER_THAN_OR_EQUAL",
  5: "EQUAL",
  6: "NOT_EQUAL",
  7: "ARRAY_CONTAINS",
  8: "IN",
  9: "ARRAY_CONTAINS_ANY",
  10: "NOT_IN",
};
const COMPOSITE_OP = { 0: "OPERATOR_UNSPECIFIED", 1: "AND", 2: "OR" };
const UNARY_OP = { 0: "OPERATOR_UNSPECIFIED", 2: "IS_NAN", 3: "IS_NULL", 4: "IS_NOT_NAN", 5: "IS_NOT_NULL" };
const DIRECTION = { 0: "DIRECTION_UNSPECIFIED", 1: "ASCENDING", 2: "DESCENDING" };
const SERVER_VALUE = { 0: "SERVER_VALUE_UNSPECIFIED", 1: "REQUEST_TIME" };

function normEnum(table, v) {
  if (typeof v === "number") return table[v] || String(v);
  return v;
}

function nowTimestamp() {
  // proto3 JSON Timestamp: RFC 3339 with nanosecond precision tolerated.
  return new Date().toISOString();
}

// A monotonic-ish timestamp generator so createTime/updateTime differ.
let TIME_COUNTER = 0;
function monoTimestamp() {
  TIME_COUNTER += 1;
  const ms = Date.now();
  // Encode the counter into the fractional nanos to keep ordering stable.
  const nanos = String((TIME_COUNTER % 1000) * 1000).padStart(9, "0");
  const iso = new Date(ms).toISOString().replace(/\.\d{3}Z$/, "");
  return `${iso}.${nanos.slice(0, 9)}Z`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export class FirestoreServer {
  constructor(port = 4581, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.projectId = options.projectId || "parlel";
    this.databaseId = options.databaseId || "(default)";
    this.server = null;
    this.reset();
  }

  reset() {
    // documents: Map<fullName, DocRecord>
    // DocRecord = { name, fields, createTime, updateTime }
    // fields is the proto3-JSON map of Value objects.
    this.documents = new Map();
    this.transactions = new Map(); // txId(base64) -> { readOnly, writes:[] }
  }

  databasePath() {
    return `projects/${this.projectId}/databases/${this.databaseId}`;
  }

  documentsRoot() {
    return `${this.databasePath()}/documents`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, 500, GRPC.INTERNAL, error.message || "internal error");
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
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = decodeURI(url.pathname);
    const q = url.searchParams;

    // Internal endpoints (not part of Firestore).
    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "firestore",
        documents: this.documents.size,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/_parlel/dump" && method === "GET") {
      return this.sendJson(res, 200, {
        documents: [...this.documents.values()],
      });
    }

    const rawBody = await this.readBody(req);
    let body = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return this.sendError(res, 400, GRPC.INVALID_ARGUMENT, "Invalid JSON body");
      }
    }

    if (!pathname.startsWith("/v1/")) {
      return this.sendError(res, 404, GRPC.NOT_FOUND, "Not Found");
    }

    const rest = pathname.slice("/v1/".length); // e.g. projects/p/databases/d/documents/...
    // Custom verb endpoints end in ":<verb>".
    const colon = rest.lastIndexOf(":");
    let verb = null;
    let resourcePath = rest;
    if (colon !== -1 && !rest.slice(colon + 1).includes("/")) {
      verb = rest.slice(colon + 1);
      resourcePath = rest.slice(0, colon);
    }

    try {
      if (verb) {
        switch (verb) {
          case "batchGet":
            return this.batchGetDocuments(res, body);
          case "beginTransaction":
            return this.beginTransaction(res, body);
          case "commit":
            return this.commit(res, body);
          case "rollback":
            return this.rollback(res, body);
          case "runQuery":
            return this.runQuery(res, resourcePath, body);
          case "runAggregationQuery":
            return this.runAggregationQuery(res, resourcePath, body);
          case "partitionQuery":
            return this.partitionQuery(res, resourcePath, body);
          case "listCollectionIds":
            return this.listCollectionIds(res, resourcePath, body, q);
          case "batchWrite":
            return this.batchWrite(res, body);
          case "write":
          case "listen":
            return this.sendError(
              res,
              501,
              GRPC.UNIMPLEMENTED,
              `${verb} requires gRPC streaming and is not supported by the parlel firestore fake`,
            );
          default:
            return this.sendError(res, 404, GRPC.NOT_FOUND, `Unknown verb: ${verb}`);
        }
      }

      // Resource-style endpoints.
      // resourcePath looks like: projects/p/databases/d/documents[/coll/doc/...]
      const docsRoot = this.documentsRoot();
      if (resourcePath === docsRoot || resourcePath === `${docsRoot}/`) {
        // /documents collection-level — only POST createDocument with parent==root.
        if (method === "POST") {
          return this.createDocumentTopLevel(res, q, body);
        }
        return this.sendError(res, 405, GRPC.INVALID_ARGUMENT, "Method Not Allowed");
      }

      if (!resourcePath.startsWith(`${docsRoot}/`)) {
        return this.sendError(res, 404, GRPC.NOT_FOUND, `Unsupported resource path: ${resourcePath}`);
      }

      const sub = resourcePath.slice(`${docsRoot}/`.length); // coll/doc/coll/doc...
      const segs = sub.split("/").filter((s) => s.length > 0);

      // Even number of segments => a document path.
      // Odd number of segments => a collection path.
      if (segs.length % 2 === 0) {
        // Document operations.
        const fullName = `${docsRoot}/${segs.join("/")}`;
        if (method === "GET") return this.getDocument(res, fullName, q);
        if (method === "PATCH") return this.updateDocument(res, fullName, body, q);
        if (method === "DELETE") return this.deleteDocument(res, fullName, q);
        return this.sendError(res, 405, GRPC.INVALID_ARGUMENT, "Method Not Allowed");
      } else {
        // Collection operations: GET listDocuments, POST createDocument.
        const collectionId = segs[segs.length - 1];
        const parentSegs = segs.slice(0, -1);
        const parent = parentSegs.length
          ? `${docsRoot}/${parentSegs.join("/")}`
          : docsRoot;
        if (method === "GET") return this.listDocuments(res, parent, collectionId, q);
        if (method === "POST") return this.createDocument(res, parent, collectionId, q, body);
        return this.sendError(res, 405, GRPC.INVALID_ARGUMENT, "Method Not Allowed");
      }
    } catch (err) {
      if (err && err.__fsError) {
        return this.sendError(res, err.httpStatus, err.grpcCode, err.message);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Document CRUD
  // -------------------------------------------------------------------------
  getDocument(res, fullName, q) {
    const rec = this.documents.get(fullName);
    if (!rec) {
      return this.sendError(res, 404, GRPC.NOT_FOUND, `Document not found: ${fullName}`);
    }
    const mask = this.parseMaskFromQuery(q);
    return this.sendJson(res, 200, this.docResource(rec, mask));
  }

  listDocuments(res, parent, collectionId, q) {
    const prefix = `${parent}/${collectionId}/`;
    const showMissing = q.get("showMissing") === "true";
    const pageSizeRaw = q.get("pageSize");
    const pageSize = pageSizeRaw ? parseInt(pageSizeRaw, 10) : 0;
    const orderBy = q.get("orderBy");
    const mask = this.parseMaskFromQuery(q);

    let docs = [...this.documents.values()].filter((rec) => {
      if (!rec.name.startsWith(prefix)) return false;
      // Direct children only (no deeper nesting): the part after prefix has no "/".
      const rel = rec.name.slice(prefix.length);
      return !rel.includes("/");
    });

    // Default order: by document name (ascending).
    docs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (orderBy && orderBy.includes("desc")) {
      docs.reverse();
    }

    // Pagination via pageToken (the document name to start after).
    const pageToken = q.get("pageToken");
    if (pageToken) {
      const idx = docs.findIndex((d) => d.name === pageToken);
      if (idx !== -1) docs = docs.slice(idx + 1);
    }

    let nextPageToken;
    if (pageSize > 0 && docs.length > pageSize) {
      nextPageToken = docs[pageSize - 1].name;
      docs = docs.slice(0, pageSize);
    }

    const out = { documents: docs.map((rec) => this.docResource(rec, mask)) };
    if (nextPageToken) out.nextPageToken = nextPageToken;
    if (showMissing) {
      // No soft-deleted/missing documents are tracked; nothing to add.
    }
    return this.sendJson(res, 200, out);
  }

  createDocumentTopLevel(res, q, body) {
    // POST /v1/{parent=.../documents}/{collectionId} where parent is the root.
    // But the top-level path has no collectionId — handled via collectionId query.
    return this.sendError(res, 400, GRPC.INVALID_ARGUMENT, "Missing collection id");
  }

  createDocument(res, parent, collectionId, q, body) {
    const docId = q.get("documentId");
    const name = docId
      ? `${parent}/${collectionId}/${docId}`
      : `${parent}/${collectionId}/${this.autoId()}`;

    if (this.documents.has(name)) {
      return this.sendError(res, 409, GRPC.ALREADY_EXISTS, `Document already exists: ${name}`);
    }
    const mask = this.parseMaskFromQuery(q);
    const ts = monoTimestamp();
    const rec = {
      name,
      fields: (body && body.fields) || {},
      createTime: ts,
      updateTime: ts,
    };
    this.documents.set(name, rec);
    return this.sendJson(res, 200, this.docResource(rec, mask));
  }

  updateDocument(res, fullName, body, q) {
    const updateMask = this.parseFieldPaths(q.getAll("updateMask.fieldPaths"));
    const mask = this.parseMaskFromQuery(q);
    const precondition = this.parsePreconditionFromQuery(q);

    const existing = this.documents.get(fullName);
    const exists = !!existing;

    // Evaluate precondition.
    const preErr = this.checkPrecondition(precondition, existing);
    if (preErr) return this.sendError(res, preErr.httpStatus, preErr.grpcCode, preErr.message);

    const incomingFields = (body && body.fields) || {};
    const ts = monoTimestamp();
    let rec;
    if (exists) {
      rec = existing;
      rec.updateTime = ts;
    } else {
      rec = { name: fullName, fields: {}, createTime: ts, updateTime: ts };
      this.documents.set(fullName, rec);
    }

    if (updateMask) {
      // Patch only the masked field paths. Absent masked paths => delete.
      for (const path of updateMask) {
        const val = this.getFieldByPath(incomingFields, path);
        if (val === undefined) {
          this.deleteFieldByPath(rec.fields, path);
        } else {
          this.setFieldByPath(rec.fields, path, val);
        }
      }
    } else {
      // Full replace of the document's fields.
      rec.fields = incomingFields;
    }

    return this.sendJson(res, 200, this.docResource(rec, mask));
  }

  deleteDocument(res, fullName, q) {
    const precondition = this.parsePreconditionFromQuery(q);
    const existing = this.documents.get(fullName);
    const preErr = this.checkPrecondition(precondition, existing);
    if (preErr) return this.sendError(res, preErr.httpStatus, preErr.grpcCode, preErr.message);
    // Delete is idempotent: returns empty {} even when the doc doesn't exist.
    this.documents.delete(fullName);
    return this.sendJson(res, 200, {});
  }

  // -------------------------------------------------------------------------
  // BatchGetDocuments (streaming -> JSON array of responses)
  // -------------------------------------------------------------------------
  batchGetDocuments(res, body) {
    const names = body.documents || [];
    const mask = body.mask ? body.mask.fieldPaths : null;
    const readTime = nowTimestamp();
    const responses = [];

    // If a new transaction was requested, emit one with the transaction token.
    let txToken;
    if (body.newTransaction) {
      txToken = this.newTransaction(body.newTransaction);
      responses.push({ transaction: txToken });
    }

    for (const name of names) {
      const rec = this.documents.get(name);
      if (rec) {
        responses.push({ found: this.docResource(rec, mask), readTime });
      } else {
        responses.push({ missing: name, readTime });
      }
    }
    return this.sendJson(res, 200, responses);
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------
  newTransaction(options) {
    const id = randomBytes(16).toString("base64");
    this.transactions.set(id, {
      readOnly: !!(options && options.readOnly),
      created: Date.now(),
    });
    return id;
  }

  beginTransaction(res, body) {
    const id = this.newTransaction(body.options);
    return this.sendJson(res, 200, { transaction: id });
  }

  rollback(res, body) {
    const id = body.transaction;
    if (!id || !this.transactions.has(id)) {
      return this.sendError(res, 400, GRPC.INVALID_ARGUMENT, "Invalid or unknown transaction");
    }
    this.transactions.delete(id);
    return this.sendJson(res, 200, {});
  }

  // -------------------------------------------------------------------------
  // Commit / BatchWrite — apply a list of Write operations.
  // -------------------------------------------------------------------------
  commit(res, body) {
    const writes = body.writes || [];
    if (body.transaction) {
      // Consume the transaction (best-effort; we don't enforce read isolation).
      this.transactions.delete(body.transaction);
    }
    const writeResults = [];
    try {
      for (const w of writes) {
        writeResults.push(this.applyWrite(w));
      }
    } catch (err) {
      if (err && err.__fsError) {
        return this.sendError(res, err.httpStatus, err.grpcCode, err.message);
      }
      throw err;
    }
    return this.sendJson(res, 200, {
      writeResults,
      commitTime: nowTimestamp(),
    });
  }

  batchWrite(res, body) {
    const writes = body.writes || [];
    const writeResults = [];
    const status = [];
    for (const w of writes) {
      try {
        writeResults.push(this.applyWrite(w));
        status.push({ code: GRPC.OK });
      } catch (err) {
        if (err && err.__fsError) {
          writeResults.push({});
          status.push({ code: err.grpcCode, message: err.message });
        } else {
          writeResults.push({});
          status.push({ code: GRPC.INTERNAL, message: err.message });
        }
      }
    }
    return this.sendJson(res, 200, { writeResults, status });
  }

  applyWrite(w) {
    const precondition = w.currentDocument;

    // Delete write.
    if (w.delete) {
      const existing = this.documents.get(w.delete);
      this.assertPrecondition(precondition, existing);
      this.documents.delete(w.delete);
      return { updateTime: nowTimestamp() };
    }

    // Update / set write (with optional updateMask + transforms).
    if (w.update) {
      const name = w.update.name;
      if (!name) {
        throw this.fsError(400, GRPC.INVALID_ARGUMENT, "Write.update.name is required");
      }
      const existing = this.documents.get(name);
      this.assertPrecondition(precondition, existing);

      const ts = monoTimestamp();
      let rec = existing;
      if (!rec) {
        rec = { name, fields: {}, createTime: ts, updateTime: ts };
        this.documents.set(name, rec);
      } else {
        rec.updateTime = ts;
      }

      const incoming = w.update.fields || {};
      if (w.updateMask) {
        // Masked update: patch exactly the listed field paths. Paths in the
        // mask but absent from `fields` are deleted. An empty mask touches no
        // fields directly (transform-only update) — existing fields persist.
        const paths = Array.isArray(w.updateMask.fieldPaths) ? w.updateMask.fieldPaths : [];
        for (const path of paths) {
          const segs = this.splitFieldPath(path);
          const val = this.getFieldByPath(incoming, segs);
          if (val === undefined) {
            this.deleteFieldByPath(rec.fields, segs);
          } else {
            this.setFieldByPath(rec.fields, segs, val);
          }
        }
      } else {
        // No mask => full replace of the document's fields (set without merge).
        rec.fields = incoming;
      }

      const transformResults = this.applyTransforms(rec, w.updateTransforms || (w.transform && w.transform.fieldTransforms));
      rec.updateTime = ts;
      const result = { updateTime: ts };
      if (transformResults && transformResults.length) result.transformResults = transformResults;
      return result;
    }

    // Transform-only write (legacy).
    if (w.transform) {
      const name = w.transform.document;
      const existing = this.documents.get(name);
      this.assertPrecondition(precondition, existing);
      const ts = monoTimestamp();
      let rec = existing;
      if (!rec) {
        rec = { name, fields: {}, createTime: ts, updateTime: ts };
        this.documents.set(name, rec);
      } else {
        rec.updateTime = ts;
      }
      const transformResults = this.applyTransforms(rec, w.transform.fieldTransforms);
      const result = { updateTime: ts };
      if (transformResults && transformResults.length) result.transformResults = transformResults;
      return result;
    }

    throw this.fsError(400, GRPC.INVALID_ARGUMENT, "Write must contain update, delete, or transform");
  }

  applyTransforms(rec, fieldTransforms) {
    if (!fieldTransforms || !fieldTransforms.length) return [];
    const results = [];
    for (const ft of fieldTransforms) {
      const path = this.splitFieldPath(ft.fieldPath);
      let resultValue;

      if (normEnum(SERVER_VALUE, ft.setToServerValue) === "REQUEST_TIME") {
        const v = { timestampValue: nowTimestamp() };
        this.setFieldByPath(rec.fields, path, v);
        resultValue = v;
      } else if (ft.increment !== undefined) {
        const current = this.getFieldByPath(rec.fields, path);
        resultValue = this.numericOp(current, ft.increment, (a, b) => a + b);
        this.setFieldByPath(rec.fields, path, resultValue);
      } else if (ft.maximum !== undefined) {
        const current = this.getFieldByPath(rec.fields, path);
        resultValue = this.numericOp(current, ft.maximum, (a, b) => Math.max(a, b));
        this.setFieldByPath(rec.fields, path, resultValue);
      } else if (ft.minimum !== undefined) {
        const current = this.getFieldByPath(rec.fields, path);
        resultValue = this.numericOp(current, ft.minimum, (a, b) => Math.min(a, b));
        this.setFieldByPath(rec.fields, path, resultValue);
      } else if (ft.appendMissingElements !== undefined) {
        const current = this.getFieldByPath(rec.fields, path);
        const arr = current && current.arrayValue ? [...(current.arrayValue.values || [])] : [];
        const toAdd = (ft.appendMissingElements.values || []);
        for (const el of toAdd) {
          if (!arr.some((existingEl) => valuesEqual(existingEl, el))) arr.push(el);
        }
        const v = { arrayValue: { values: arr } };
        this.setFieldByPath(rec.fields, path, v);
        resultValue = { nullValue: null }; // transform result for array ops is null
      } else if (ft.removeAllFromArray !== undefined) {
        const current = this.getFieldByPath(rec.fields, path);
        const arr = current && current.arrayValue ? [...(current.arrayValue.values || [])] : [];
        const toRemove = (ft.removeAllFromArray.values || []);
        const filtered = arr.filter((el) => !toRemove.some((r) => valuesEqual(el, r)));
        const v = { arrayValue: { values: filtered } };
        this.setFieldByPath(rec.fields, path, v);
        resultValue = { nullValue: null };
      } else {
        resultValue = { nullValue: null };
      }
      results.push(resultValue);
    }
    return results;
  }

  numericOp(current, operand, fn) {
    const a = current ? numericValue(current) : 0;
    const b = numericValue(operand);
    const result = fn(a, b);
    // Preserve integer type if both inputs are integers.
    const isInt =
      (current ? "integerValue" in current : true) && "integerValue" in operand && Number.isInteger(result);
    if (isInt && !("doubleValue" in operand)) {
      return { integerValue: String(result) };
    }
    return { doubleValue: result };
  }

  // -------------------------------------------------------------------------
  // RunQuery (streaming -> JSON array)
  // -------------------------------------------------------------------------
  runQuery(res, resourcePath, body) {
    const parent = `${"/v1/".length ? "" : ""}${resourcePath}`; // already the resource path
    const sq = body.structuredQuery || {};
    const responses = [];

    let txToken;
    if (body.newTransaction) {
      txToken = this.newTransaction(body.newTransaction);
    }

    const results = this.executeStructuredQuery(parent, sq);
    const readTime = nowTimestamp();

    if (results.length === 0) {
      // Firestore emits a single empty response (with readTime) for empty results.
      const empty = { readTime };
      if (txToken) empty.transaction = txToken;
      responses.push(empty);
    } else {
      results.forEach((rec, i) => {
        const r = { document: this.docResource(rec, sqSelectMask(sq)), readTime };
        if (txToken && i === 0) r.transaction = txToken;
        responses.push(r);
      });
    }
    return this.sendJson(res, 200, responses);
  }

  // -------------------------------------------------------------------------
  // RunAggregationQuery (streaming -> JSON array)
  // -------------------------------------------------------------------------
  runAggregationQuery(res, resourcePath, body) {
    const saq = body.structuredAggregationQuery || {};
    const sq = saq.structuredQuery || {};
    const aggregations = saq.aggregations || [];

    let txToken;
    if (body.newTransaction) {
      txToken = this.newTransaction(body.newTransaction);
    }

    const matched = this.executeStructuredQuery(resourcePath, sq);
    const aggFields = {};
    for (const agg of aggregations) {
      const alias = agg.alias || `field_${Object.keys(aggFields).length + 1}`;
      if (agg.count) {
        let n = matched.length;
        if (agg.count.upTo) {
          const cap = Number(agg.count.upTo);
          if (n > cap) n = cap;
        }
        aggFields[alias] = { integerValue: String(n) };
      } else if (agg.sum) {
        const fp = this.splitFieldPath(agg.sum.field.fieldPath);
        let sum = 0;
        let anyDouble = false;
        for (const rec of matched) {
          const v = this.getFieldByPath(rec.fields, fp);
          if (v && ("integerValue" in v || "doubleValue" in v)) {
            if ("doubleValue" in v) anyDouble = true;
            sum += numericValue(v);
          }
        }
        aggFields[alias] = anyDouble || !Number.isInteger(sum)
          ? { doubleValue: sum }
          : { integerValue: String(sum) };
      } else if (agg.avg) {
        const fp = this.splitFieldPath(agg.avg.field.fieldPath);
        let sum = 0;
        let count = 0;
        for (const rec of matched) {
          const v = this.getFieldByPath(rec.fields, fp);
          if (v && ("integerValue" in v || "doubleValue" in v)) {
            sum += numericValue(v);
            count += 1;
          }
        }
        aggFields[alias] = count === 0 ? { nullValue: null } : { doubleValue: sum / count };
      }
    }

    const response = {
      result: { aggregateFields: aggFields },
      readTime: nowTimestamp(),
    };
    if (txToken) response.transaction = txToken;
    return this.sendJson(res, 200, [response]);
  }

  // -------------------------------------------------------------------------
  // PartitionQuery
  // -------------------------------------------------------------------------
  partitionQuery(res, resourcePath, body) {
    // We keep everything in one partition: return no cursors (single partition).
    return this.sendJson(res, 200, { partitions: [] });
  }

  // -------------------------------------------------------------------------
  // ListCollectionIds
  // -------------------------------------------------------------------------
  listCollectionIds(res, resourcePath, body, q) {
    // resourcePath is the parent: either the documents root or a document.
    const parent = resourcePath;
    const isRoot = parent === this.documentsRoot();
    const prefix = isRoot ? `${parent}/` : `${parent}/`;

    const ids = new Set();
    for (const rec of this.documents.values()) {
      if (!rec.name.startsWith(prefix)) continue;
      const rel = rec.name.slice(prefix.length);
      const firstSeg = rel.split("/")[0];
      if (firstSeg) ids.add(firstSeg);
    }
    const collectionIds = [...ids].sort();
    return this.sendJson(res, 200, { collectionIds });
  }

  // -------------------------------------------------------------------------
  // Query execution engine
  // -------------------------------------------------------------------------
  executeStructuredQuery(parentResource, sq) {
    const from = sq.from || [];
    if (from.length === 0) return [];
    const selector = from[0];
    const collectionId = selector.collectionId;
    const allDescendants = !!selector.allDescendants;

    const parentPrefix = `${parentResource}/`;

    let docs = [...this.documents.values()].filter((rec) => {
      if (!rec.name.startsWith(parentPrefix) && parentResource !== this.documentsRoot()) {
        // For subcollection queries the parent is a document; ensure descendant.
        if (!rec.name.startsWith(parentPrefix)) return false;
      }
      if (parentResource === this.documentsRoot() && !rec.name.startsWith(parentPrefix)) {
        return false;
      }
      const rel = rec.name.slice(parentPrefix.length);
      const segs = rel.split("/");
      if (allDescendants) {
        // Any collection segment matching collectionId, doc is leaf within it.
        // segs alternate: coll/doc/coll/doc...; check any even index === collectionId.
        for (let i = 0; i < segs.length; i += 2) {
          if (segs[i] === collectionId && i + 1 === segs.length - 1) return true;
        }
        return false;
      }
      // Direct child collection: rel === "<collectionId>/<docId>"
      return segs.length === 2 && segs[0] === collectionId;
    });

    // WHERE filter.
    if (sq.where) {
      docs = docs.filter((rec) => this.evalFilter(sq.where, rec));
    }

    // ORDER BY.
    const orders = sq.orderBy || [];
    if (orders.length > 0) {
      docs.sort((a, b) => this.compareByOrders(a, b, orders));
    } else {
      // Implicit order by __name__ ascending when none specified.
      docs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    // Cursors (startAt / endAt). Requires orderBy to be meaningful.
    docs = this.applyCursors(docs, sq, orders);

    // OFFSET.
    if (sq.offset && sq.offset > 0) {
      docs = docs.slice(sq.offset);
    }

    // LIMIT (proto3 wraps Int32Value -> number in JSON).
    if (sq.limit !== undefined && sq.limit !== null) {
      const lim = typeof sq.limit === "object" ? sq.limit.value : sq.limit;
      if (typeof lim === "number") docs = docs.slice(0, lim);
    }

    return docs;
  }

  evalFilter(filter, rec) {
    if (filter.compositeFilter) {
      const op = normEnum(COMPOSITE_OP, filter.compositeFilter.op);
      const subs = filter.compositeFilter.filters || [];
      if (op === "OR") return subs.some((f) => this.evalFilter(f, rec));
      // default AND
      return subs.every((f) => this.evalFilter(f, rec));
    }
    if (filter.unaryFilter) {
      const fp = this.splitFieldPath(filter.unaryFilter.field.fieldPath);
      const v = this.getFieldByPath(rec.fields, fp);
      switch (normEnum(UNARY_OP, filter.unaryFilter.op)) {
        case "IS_NULL":
          return !!v && "nullValue" in v;
        case "IS_NOT_NULL":
          return !!v && !("nullValue" in v);
        case "IS_NAN":
          return !!v && "doubleValue" in v && Number.isNaN(v.doubleValue);
        case "IS_NOT_NAN":
          return !!v && "doubleValue" in v && !Number.isNaN(v.doubleValue);
        default:
          return false;
      }
    }
    if (filter.fieldFilter) {
      return this.evalFieldFilter(filter.fieldFilter, rec);
    }
    return true;
  }

  evalFieldFilter(ff, rec) {
    const fp = this.splitFieldPath(ff.field.fieldPath);
    const isName = ff.field.fieldPath === "__name__";
    const v = isName ? { referenceValue: rec.name } : this.getFieldByPath(rec.fields, fp);
    const target = ff.value;
    const op = normEnum(FIELD_OP, ff.op);

    if (v === undefined && op !== "NOT_EQUAL" && op !== "NOT_IN") return false;

    switch (op) {
      case "EQUAL":
        return v !== undefined && valuesEqual(v, target);
      case "NOT_EQUAL":
        return v !== undefined && !valuesEqual(v, target);
      case "LESS_THAN":
        return v !== undefined && compareValues(v, target) < 0;
      case "LESS_THAN_OR_EQUAL":
        return v !== undefined && compareValues(v, target) <= 0;
      case "GREATER_THAN":
        return v !== undefined && compareValues(v, target) > 0;
      case "GREATER_THAN_OR_EQUAL":
        return v !== undefined && compareValues(v, target) >= 0;
      case "ARRAY_CONTAINS":
        return !!v && !!v.arrayValue && (v.arrayValue.values || []).some((el) => valuesEqual(el, target));
      case "ARRAY_CONTAINS_ANY": {
        if (!v || !v.arrayValue) return false;
        const wanted = (target.arrayValue && target.arrayValue.values) || [];
        return (v.arrayValue.values || []).some((el) => wanted.some((w) => valuesEqual(el, w)));
      }
      case "IN": {
        const options = (target.arrayValue && target.arrayValue.values) || [];
        return v !== undefined && options.some((o) => valuesEqual(v, o));
      }
      case "NOT_IN": {
        const options = (target.arrayValue && target.arrayValue.values) || [];
        return v !== undefined && !options.some((o) => valuesEqual(v, o));
      }
      default:
        return false;
    }
  }

  compareByOrders(a, b, orders) {
    for (const order of orders) {
      const desc = normEnum(DIRECTION, order.direction) === "DESCENDING";
      const isName = order.field.fieldPath === "__name__";
      const fp = this.splitFieldPath(order.field.fieldPath);
      const va = isName ? { referenceValue: a.name } : this.getFieldByPath(a.fields, fp);
      const vb = isName ? { referenceValue: b.name } : this.getFieldByPath(b.fields, fp);
      let cmp;
      if (va === undefined && vb === undefined) cmp = 0;
      else if (va === undefined) cmp = -1;
      else if (vb === undefined) cmp = 1;
      else cmp = compareValues(va, vb);
      if (cmp !== 0) return desc ? -cmp : cmp;
    }
    return 0;
  }

  applyCursors(docs, sq, orders) {
    if (!sq.startAt && !sq.endAt) return docs;
    const orderFields = orders.length
      ? orders
      : [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }];

    const cursorVals = (cursor) => cursor.values || [];

    const cmpToCursor = (rec, cursor) => {
      const vals = cursorVals(cursor);
      for (let i = 0; i < orderFields.length && i < vals.length; i += 1) {
        const of = orderFields[i];
        const isName = of.field.fieldPath === "__name__";
        const recVal = isName
          ? { referenceValue: rec.name }
          : this.getFieldByPath(rec.fields, this.splitFieldPath(of.field.fieldPath));
        let cmp;
        if (recVal === undefined) cmp = -1;
        else cmp = compareValues(recVal, vals[i]);
        if (normEnum(DIRECTION, of.direction) === "DESCENDING") cmp = -cmp;
        if (cmp !== 0) return cmp;
      }
      return 0;
    };

    let result = docs;
    if (sq.startAt) {
      const before = !!sq.startAt.before;
      result = result.filter((rec) => {
        const c = cmpToCursor(rec, sq.startAt);
        return before ? c >= 0 : c > 0;
      });
    }
    if (sq.endAt) {
      const before = !!sq.endAt.before;
      result = result.filter((rec) => {
        const c = cmpToCursor(rec, sq.endAt);
        return before ? c < 0 : c <= 0;
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Preconditions
  // -------------------------------------------------------------------------
  checkPrecondition(precondition, existing) {
    if (!precondition) return null;
    if (precondition.exists === true && !existing) {
      return { httpStatus: 404, grpcCode: GRPC.NOT_FOUND, message: "No document to update" };
    }
    if (precondition.exists === false && existing) {
      return {
        httpStatus: 409,
        grpcCode: GRPC.ALREADY_EXISTS,
        message: "Document already exists",
      };
    }
    if (precondition.updateTime && existing) {
      if (existing.updateTime !== precondition.updateTime) {
        return {
          httpStatus: 412,
          grpcCode: GRPC.FAILED_PRECONDITION,
          message: "Precondition failed: updateTime mismatch",
        };
      }
    }
    return null;
  }

  assertPrecondition(precondition, existing) {
    const err = this.checkPrecondition(precondition, existing);
    if (err) throw this.fsError(err.httpStatus, err.grpcCode, err.message);
  }

  fsError(httpStatus, grpcCode, message) {
    const e = new Error(message);
    e.__fsError = true;
    e.httpStatus = httpStatus;
    e.grpcCode = grpcCode;
    return e;
  }

  // -------------------------------------------------------------------------
  // Field path helpers (proto3-JSON field maps).
  // -------------------------------------------------------------------------
  splitFieldPath(path) {
    if (Array.isArray(path)) return path;
    // Firestore field paths may be backtick-escaped; we keep it simple and split
    // on unescaped dots.
    return path.split(".");
  }

  getFieldByPath(fields, path) {
    const segs = Array.isArray(path) ? path : this.splitFieldPath(path);
    let cur = fields;
    for (let i = 0; i < segs.length; i += 1) {
      if (!cur) return undefined;
      const val = cur[segs[i]];
      if (val === undefined) return undefined;
      if (i === segs.length - 1) return val;
      if (val.mapValue && val.mapValue.fields) cur = val.mapValue.fields;
      else return undefined;
    }
    return undefined;
  }

  setFieldByPath(fields, path, value) {
    const segs = Array.isArray(path) ? path : this.splitFieldPath(path);
    let cur = fields;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i];
      if (!cur[seg] || !cur[seg].mapValue) {
        cur[seg] = { mapValue: { fields: {} } };
      }
      if (!cur[seg].mapValue.fields) cur[seg].mapValue.fields = {};
      cur = cur[seg].mapValue.fields;
    }
    cur[segs[segs.length - 1]] = value;
  }

  deleteFieldByPath(fields, path) {
    const segs = Array.isArray(path) ? path : this.splitFieldPath(path);
    let cur = fields;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i];
      if (!cur[seg] || !cur[seg].mapValue || !cur[seg].mapValue.fields) return;
      cur = cur[seg].mapValue.fields;
    }
    delete cur[segs[segs.length - 1]];
  }

  parseFieldPaths(arr) {
    if (!arr || arr.length === 0) return null;
    return arr.map((p) => this.splitFieldPath(p));
  }

  parseMaskFromQuery(q) {
    const paths = q.getAll("mask.fieldPaths");
    if (!paths || paths.length === 0) return null;
    return paths;
  }

  parsePreconditionFromQuery(q) {
    const exists = q.get("currentDocument.exists");
    const updateTime = q.get("currentDocument.updateTime");
    if (exists === null && updateTime === null) return null;
    const p = {};
    if (exists !== null) p.exists = exists === "true";
    if (updateTime !== null) p.updateTime = updateTime;
    return p;
  }

  // -------------------------------------------------------------------------
  // Resource serialization
  // -------------------------------------------------------------------------
  docResource(rec, mask) {
    const out = {
      name: rec.name,
      createTime: rec.createTime,
      updateTime: rec.updateTime,
    };
    if (mask && mask.length) {
      const fields = {};
      for (const p of mask) {
        const segs = this.splitFieldPath(p);
        const v = this.getFieldByPath(rec.fields, segs);
        if (v !== undefined) this.setFieldByPath(fields, segs, v);
      }
      out.fields = fields;
    } else {
      out.fields = rec.fields || {};
    }
    return out;
  }

  autoId() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    const bytes = randomBytes(20);
    for (let i = 0; i < 20; i += 1) id += chars[bytes[i] % chars.length];
    return id;
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    const data = JSON.stringify(obj);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(data);
  }

  // Callers pass (res, httpStatusHint, grpcCode, message). The grpcCode is the
  // source of truth: we derive the body `error.code` so the gax REST decoder
  // recovers the intended canonical gRPC status, and set the HTTP response
  // status to match.
  sendError(res, _httpStatusHint, grpcCode, message) {
    const bodyCode = GRPC_TO_HTTP[grpcCode] || 500;
    const status = GRPC_STATUS_NAME[grpcCode] || "UNKNOWN";
    const payload = {
      error: {
        code: bodyCode,
        message,
        status,
      },
    };
    res.statusCode = bodyCode;
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Value helpers — proto3 JSON Value comparison + equality.
// ---------------------------------------------------------------------------

// Firestore type ordering for cross-type comparison.
const TYPE_ORDER = {
  nullValue: 0,
  booleanValue: 1,
  integerValue: 2,
  doubleValue: 2,
  timestampValue: 3,
  stringValue: 4,
  bytesValue: 5,
  referenceValue: 6,
  geoPointValue: 7,
  arrayValue: 8,
  mapValue: 9,
};

function valueType(v) {
  for (const k of Object.keys(TYPE_ORDER)) {
    if (k in v) return k;
  }
  return "nullValue";
}

function numericValue(v) {
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  return 0;
}

function valuesEqual(a, b) {
  if (a === undefined || b === undefined) return false;
  return compareValues(a, b) === 0 && valueType(a) === valueTypeForEq(a, b);
}

// Equality must treat 1 (int) === 1.0 (double); but null/NaN handling differs.
function valueTypeForEq(a, b) {
  const ta = valueType(a);
  const tb = valueType(b);
  if ((ta === "integerValue" || ta === "doubleValue") && (tb === "integerValue" || tb === "doubleValue")) {
    return ta;
  }
  return ta === tb ? ta : "__mismatch__";
}

function compareValues(a, b) {
  const ta = valueType(a);
  const tb = valueType(b);
  const oa = TYPE_ORDER[ta];
  const ob = TYPE_ORDER[tb];
  if (oa !== ob) return oa < ob ? -1 : 1;

  switch (ta) {
    case "nullValue":
      return 0;
    case "booleanValue": {
      const x = a.booleanValue ? 1 : 0;
      const y = b.booleanValue ? 1 : 0;
      return x - y;
    }
    case "integerValue":
    case "doubleValue": {
      const x = numericValue(a);
      const y = numericValue(b);
      if (Number.isNaN(x) && Number.isNaN(y)) return 0;
      if (Number.isNaN(x)) return -1;
      if (Number.isNaN(y)) return 1;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "timestampValue": {
      const x = Date.parse(tsString(a.timestampValue));
      const y = Date.parse(tsString(b.timestampValue));
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "stringValue":
      return a.stringValue < b.stringValue ? -1 : a.stringValue > b.stringValue ? 1 : 0;
    case "bytesValue":
      return a.bytesValue < b.bytesValue ? -1 : a.bytesValue > b.bytesValue ? 1 : 0;
    case "referenceValue":
      return a.referenceValue < b.referenceValue ? -1 : a.referenceValue > b.referenceValue ? 1 : 0;
    case "geoPointValue": {
      const ga = a.geoPointValue || {};
      const gb = b.geoPointValue || {};
      const la = ga.latitude || 0;
      const lb = gb.latitude || 0;
      if (la !== lb) return la < lb ? -1 : 1;
      const na = ga.longitude || 0;
      const nb = gb.longitude || 0;
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    case "arrayValue": {
      const xa = (a.arrayValue && a.arrayValue.values) || [];
      const xb = (b.arrayValue && b.arrayValue.values) || [];
      const len = Math.min(xa.length, xb.length);
      for (let i = 0; i < len; i += 1) {
        const c = compareValues(xa[i], xb[i]);
        if (c !== 0) return c;
      }
      return xa.length - xb.length;
    }
    case "mapValue": {
      const fa = (a.mapValue && a.mapValue.fields) || {};
      const fb = (b.mapValue && b.mapValue.fields) || {};
      const ka = Object.keys(fa).sort();
      const kb = Object.keys(fb).sort();
      const len = Math.min(ka.length, kb.length);
      for (let i = 0; i < len; i += 1) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
        const c = compareValues(fa[ka[i]], fb[kb[i]]);
        if (c !== 0) return c;
      }
      return ka.length - kb.length;
    }
    default:
      return 0;
  }
}

function tsString(t) {
  // timestampValue may be an ISO string (proto3 JSON) already.
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && "seconds" in t) {
    const seconds = Number(t.seconds || 0);
    const nanos = Number(t.nanos || 0);
    return new Date(seconds * 1000 + nanos / 1e6).toISOString();
  }
  return new Date(0).toISOString();
}

function sqSelectMask(sq) {
  if (sq.select && Array.isArray(sq.select.fields)) {
    const paths = sq.select.fields.map((f) => f.fieldPath).filter((p) => p && p !== "__name__");
    return paths.length ? paths : null;
  }
  return null;
}

export default FirestoreServer;
