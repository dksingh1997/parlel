// parlel/dynamodb — a lightweight, dependency-free fake of AWS DynamoDB.
//
// Speaks the AWS JSON 1.0 wire protocol so that application code using the real
// `@aws-sdk/client-dynamodb` client can run against it with zero cost and zero
// side effects. Pure Node.js, no external npm dependencies. State is in-memory
// and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-dynamodb v3):
//   * Requests are POST / with `X-Amz-Target: DynamoDB_20120810.<Operation>`
//     and `Content-Type: application/x-amz-json-1.0`. Body is JSON input.
//   * Attribute values use the typed format {S,N,B,BOOL,NULL,L,M,SS,NS,BS}.
//   * Success: 200, JSON output, `Content-Type: application/x-amz-json-1.0`.
//   * Error: non-2xx, JSON
//       `{ "__type": "com.amazonaws.dynamodb.v20120810#<Code>", "message": "" }`.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.0";
const DEFAULT_ACCOUNT_ID = "000000000000";
const TARGET_PREFIX = "DynamoDB_20120810";
const ERROR_TYPE_PREFIX = "com.amazonaws.dynamodb.v20120810#";

const ERROR_STATUS = {
  ResourceNotFoundException: 400,
  ResourceInUseException: 400,
  TableAlreadyExistsException: 400,
  TableNotFoundException: 400,
  ConditionalCheckFailedException: 400,
  ValidationException: 400,
  ProvisionedThroughputExceededException: 400,
  ItemCollectionSizeLimitExceededException: 400,
  LimitExceededException: 400,
  TransactionCanceledException: 400,
  TransactionConflictException: 400,
  IdempotentParameterMismatchException: 400,
  UnknownOperationException: 400,
  InternalServerError: 500,
  InternalFailure: 500,
};

// A handful of framework-level exceptions are thrown before the request reaches
// the DynamoDB service model, and carry the coral prefix rather than the
// dynamodb.v20120810 prefix. Real wire behavior, e.g. UnknownOperationException.
const CORAL_ERROR_PREFIX = "com.amazon.coral.service#";
const CORAL_ERRORS = new Set(["UnknownOperationException"]);

class DynamoError extends Error {
  constructor(code, message, status, extra) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
    this.extra = extra || {};
  }
}

// ---------------------------------------------------------------------------
// Attribute-value helpers
// ---------------------------------------------------------------------------

// Build a comparable scalar from a typed attribute value (for keys/comparisons).
function avToComparable(av) {
  if (av === undefined || av === null) return undefined;
  if ("S" in av) return { t: "S", v: String(av.S) };
  if ("N" in av) return { t: "N", v: Number(av.N) };
  if ("B" in av) return { t: "B", v: String(av.B) };
  if ("BOOL" in av) return { t: "BOOL", v: Boolean(av.BOOL) };
  if ("NULL" in av) return { t: "NULL", v: null };
  return { t: "?", v: JSON.stringify(av) };
}

// Compare two typed attribute values. Returns -1, 0, 1 or NaN if incomparable.
function compareAv(a, b) {
  const ca = avToComparable(a);
  const cb = avToComparable(b);
  if (!ca || !cb) return NaN;
  if (ca.t === "N" && cb.t === "N") {
    return ca.v < cb.v ? -1 : ca.v > cb.v ? 1 : 0;
  }
  // String/binary lexicographic comparison.
  const sa = String(ca.v);
  const sb = String(cb.v);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function avEquals(a, b) {
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Serialize a key (subset of an item) to a stable string for Map indexing.
function keyToString(keyAttrs, item) {
  return keyAttrs
    .map((name) => {
      const av = item[name];
      const c = avToComparable(av);
      return `${name}=${c ? c.t + ":" + c.v : ""}`;
    })
    .join("|");
}

// ---------------------------------------------------------------------------
// Expression parsing (tokenizer + recursive descent, subset of DynamoDB)
// ---------------------------------------------------------------------------

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const isWord = (c) => /[A-Za-z0-9_.#:[\]]/.test(c);
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      tokens.push({ type: c });
      i += 1;
      continue;
    }
    if (c === "<" || c === ">" || c === "=") {
      let op = c;
      if ((c === "<" || c === ">") && expr[i + 1] === "=") {
        op += "=";
        i += 1;
      }
      tokens.push({ type: "op", value: op });
      i += 1;
      continue;
    }
    if (isWord(c)) {
      let j = i;
      while (j < expr.length && isWord(expr[j])) j += 1;
      tokens.push({ type: "word", value: expr.slice(i, j) });
      i = j;
      continue;
    }
    // skip unknown char
    i += 1;
  }
  return tokens;
}

// Parse a condition/filter/key expression into an AST.
function parseExpression(expr) {
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isKeyword = (kw) => {
    const t = peek();
    return t && t.type === "word" && t.value.toUpperCase() === kw;
  };

  function parseOr() {
    let left = parseAnd();
    while (isKeyword("OR")) {
      next();
      const right = parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (isKeyword("AND")) {
      next();
      const right = parseNot();
      left = { type: "and", left, right };
    }
    return left;
  }

  function parseNot() {
    if (isKeyword("NOT")) {
      next();
      return { type: "not", child: parseNot() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) return { type: "true" };
    if (t.type === "(") {
      next();
      const inner = parseOr();
      if (peek() && peek().type === ")") next();
      return inner;
    }
    // function call: attribute_exists(x), begins_with(a,b), etc.
    if (t.type === "word") {
      const word = t.value;
      const lower = word.toLowerCase();
      const fnNames = [
        "attribute_exists",
        "attribute_not_exists",
        "begins_with",
        "contains",
        "attribute_type",
        "size",
      ];
      if (fnNames.includes(lower) && tokens[pos + 1] && tokens[pos + 1].type === "(") {
        next(); // fn name
        next(); // (
        const args = [];
        while (peek() && peek().type !== ")") {
          args.push(parseOperand());
          if (peek() && peek().type === ",") next();
        }
        if (peek() && peek().type === ")") next();
        return { type: "func", name: lower, args };
      }
    }
    // operand <op> operand | operand BETWEEN x AND y | operand IN (...)
    const left = parseOperand();
    if (isKeyword("BETWEEN")) {
      next();
      const low = parseOperand();
      // AND
      if (isKeyword("AND")) next();
      const high = parseOperand();
      return { type: "between", operand: left, low, high };
    }
    if (isKeyword("IN")) {
      next();
      if (peek() && peek().type === "(") next();
      const list = [];
      while (peek() && peek().type !== ")") {
        list.push(parseOperand());
        if (peek() && peek().type === ",") next();
      }
      if (peek() && peek().type === ")") next();
      return { type: "in", operand: left, list };
    }
    const opTok = peek();
    if (opTok && (opTok.type === "op")) {
      next();
      const right = parseOperand();
      return { type: "compare", op: opTok.value, left, right };
    }
    // bare operand (e.g. boolean attribute) -> treat as truthiness check
    return { type: "operand", operand: left };
  }

  function parseOperand() {
    const t = next();
    if (!t) return { kind: "literal", value: undefined };
    if (t.type === "word") {
      // size(attr) function used as operand
      if (t.value.toLowerCase() === "size" && peek() && peek().type === "(") {
        next();
        const inner = parseOperand();
        if (peek() && peek().type === ")") next();
        return { kind: "size", arg: inner };
      }
      return { kind: "name", value: t.value };
    }
    return { kind: "literal", value: undefined };
  }

  return parseOr();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class DynamodbServer {
  constructor(port = 4567, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // tables: Map<tableName, Table>
    //   Table = {
    //     name, arn, attributeDefinitions, keySchema, hashKey, rangeKey,
    //     gsis: [], lsis: [], billingMode, provisionedThroughput,
    //     createdAt, status, items: Map<keyStr, item>, tags: Map,
    //     streamSpecification, ttl: {enabled, attributeName}
    //   }
    this.tables = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new DynamoError("InternalServerError", error.message, 500));
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

  requestId() {
    return randomUUID();
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  tableArn(name) {
    return `arn:aws:dynamodb:${this.region}:${this.accountId}:table/${name}`;
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "dynamodb",
        tables: this.tables.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-dynamodb");

    if (method !== "POST") {
      return this.sendError(
        res,
        new DynamoError("ValidationException", "Only POST is supported by the parlel dynamodb fake.", 400),
      );
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new DynamoError("ValidationException", "Request body is not valid JSON.", 400));
    }

    try {
      const output = this.dispatch(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof DynamoError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    switch (operation) {
      case "CreateTable":
        return this.createTable(input);
      case "DescribeTable":
        return this.describeTable(input);
      case "ListTables":
        return this.listTables(input);
      case "DeleteTable":
        return this.deleteTable(input);
      case "UpdateTable":
        return this.updateTable(input);
      case "PutItem":
        return this.putItem(input);
      case "GetItem":
        return this.getItem(input);
      case "DeleteItem":
        return this.deleteItem(input);
      case "UpdateItem":
        return this.updateItem(input);
      case "Query":
        return this.query(input);
      case "Scan":
        return this.scan(input);
      case "BatchWriteItem":
        return this.batchWriteItem(input);
      case "BatchGetItem":
        return this.batchGetItem(input);
      case "TransactWriteItems":
        return this.transactWriteItems(input);
      case "TransactGetItems":
        return this.transactGetItems(input);
      case "TagResource":
        return this.tagResource(input);
      case "UntagResource":
        return this.untagResource(input);
      case "ListTagsOfResource":
        return this.listTagsOfResource(input);
      case "UpdateTimeToLive":
        return this.updateTimeToLive(input);
      case "DescribeTimeToLive":
        return this.describeTimeToLive(input);
      case "DescribeLimits":
        return {
          AccountMaxReadCapacityUnits: 80000,
          AccountMaxWriteCapacityUnits: 80000,
          TableMaxReadCapacityUnits: 40000,
          TableMaxWriteCapacityUnits: 40000,
        };
      case "DescribeEndpoints":
        return { Endpoints: [{ Address: `${this.host}:${this.port}`, CachePeriodInMinutes: 1440 }] };
      default:
        // Real DynamoDB returns UnknownOperationException (coral framework error,
        // HTTP 400 on the legacy 2012-08-10 endpoint) for an unknown/missing
        // X-Amz-Target operation — not ValidationException.
        // Source: AWS CommonErrors + observed wire behavior.
        throw new DynamoError(
          "UnknownOperationException",
          operation ? `Unknown operation: ${operation}` : "Operation could not be determined.",
          400,
        );
    }
  }

  // Real DynamoDB returns two distinct ResourceNotFoundException messages:
  //   * control-plane (Describe/Delete/UpdateTable, *TimeToLive):
  //       "Requested resource not found: Table: <name> not found"
  //   * data-plane (Get/Put/Update/Delete/Query/Scan/Batch/Transact):
  //       "Cannot do operations on a non-existent table"
  // Source: DynamoDB Developer Guide (Programming.Errors) + observed wire/DynamoDB Local.
  requireTable(name, scope = "data") {
    if (!name) throw new DynamoError("ValidationException", "TableName is required.");
    const table = this.tables.get(name);
    if (!table) {
      const message =
        scope === "control"
          ? `Requested resource not found: Table: ${name} not found`
          : "Cannot do operations on a non-existent table";
      throw new DynamoError("ResourceNotFoundException", message);
    }
    return table;
  }

  // -------------------------------------------------------------------------
  // Table lifecycle
  // -------------------------------------------------------------------------
  createTable(input) {
    const name = input.TableName;
    if (!name) throw new DynamoError("ValidationException", "TableName is required.");
    if (this.tables.has(name)) {
      throw new DynamoError("ResourceInUseException", `Table already exists: ${name}`);
    }
    const keySchema = input.KeySchema || [];
    if (!keySchema.length) {
      throw new DynamoError("ValidationException", "KeySchema is required and cannot be empty.");
    }
    const hashEntry = keySchema.find((k) => k.KeyType === "HASH");
    const rangeEntry = keySchema.find((k) => k.KeyType === "RANGE");
    if (!hashEntry) {
      throw new DynamoError("ValidationException", "No HASH key specified in KeySchema.");
    }

    const now = Math.floor(Date.now() / 1000);
    const table = {
      name,
      arn: this.tableArn(name),
      attributeDefinitions: input.AttributeDefinitions || [],
      keySchema,
      hashKey: hashEntry.AttributeName,
      rangeKey: rangeEntry ? rangeEntry.AttributeName : undefined,
      billingMode: input.BillingMode || "PROVISIONED",
      provisionedThroughput: input.ProvisionedThroughput || { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      gsis: (input.GlobalSecondaryIndexes || []).map((g) => this.buildIndex(g)),
      lsis: (input.LocalSecondaryIndexes || []).map((l) => this.buildIndex(l)),
      streamSpecification: input.StreamSpecification,
      createdAt: now,
      status: "ACTIVE",
      items: new Map(),
      tags: new Map(),
      ttl: { enabled: false, attributeName: undefined },
    };
    for (const t of input.Tags || []) {
      if (t && t.Key !== undefined) table.tags.set(t.Key, t.Value ?? "");
    }
    this.tables.set(name, table);
    return { TableDescription: this.tableDescription(table) };
  }

  buildIndex(idx) {
    const hashEntry = (idx.KeySchema || []).find((k) => k.KeyType === "HASH");
    const rangeEntry = (idx.KeySchema || []).find((k) => k.KeyType === "RANGE");
    return {
      name: idx.IndexName,
      keySchema: idx.KeySchema || [],
      hashKey: hashEntry ? hashEntry.AttributeName : undefined,
      rangeKey: rangeEntry ? rangeEntry.AttributeName : undefined,
      projection: idx.Projection || { ProjectionType: "ALL" },
      provisionedThroughput: idx.ProvisionedThroughput,
    };
  }

  tableDescription(table) {
    const desc = {
      TableName: table.name,
      TableArn: table.arn,
      TableId: table.tableId || (table.tableId = randomUUID()),
      TableStatus: table.status,
      CreationDateTime: table.createdAt,
      AttributeDefinitions: table.attributeDefinitions,
      KeySchema: table.keySchema,
      ItemCount: table.items.size,
      TableSizeBytes: 0,
      BillingModeSummary: { BillingMode: table.billingMode },
      ProvisionedThroughput: {
        ReadCapacityUnits: table.provisionedThroughput.ReadCapacityUnits || 0,
        WriteCapacityUnits: table.provisionedThroughput.WriteCapacityUnits || 0,
        NumberOfDecreasesToday: 0,
      },
    };
    if (table.gsis.length) {
      desc.GlobalSecondaryIndexes = table.gsis.map((g) => ({
        IndexName: g.name,
        KeySchema: g.keySchema,
        Projection: g.projection,
        IndexStatus: "ACTIVE",
        ItemCount: table.items.size,
        IndexSizeBytes: 0,
        IndexArn: `${table.arn}/index/${g.name}`,
        ...(g.provisionedThroughput
          ? {
              ProvisionedThroughput: {
                ReadCapacityUnits: g.provisionedThroughput.ReadCapacityUnits || 0,
                WriteCapacityUnits: g.provisionedThroughput.WriteCapacityUnits || 0,
                NumberOfDecreasesToday: 0,
              },
            }
          : {}),
      }));
    }
    if (table.lsis.length) {
      desc.LocalSecondaryIndexes = table.lsis.map((l) => ({
        IndexName: l.name,
        KeySchema: l.keySchema,
        Projection: l.projection,
        ItemCount: table.items.size,
        IndexSizeBytes: 0,
        IndexArn: `${table.arn}/index/${l.name}`,
      }));
    }
    if (table.streamSpecification && table.streamSpecification.StreamEnabled) {
      desc.StreamSpecification = table.streamSpecification;
      desc.LatestStreamLabel = `${new Date(table.createdAt * 1000).toISOString()}`;
      desc.LatestStreamArn = `${table.arn}/stream/${desc.LatestStreamLabel}`;
    }
    return desc;
  }

  describeTable(input) {
    const table = this.requireTable(input.TableName, "control");
    return { Table: this.tableDescription(table) };
  }

  listTables(input = {}) {
    const names = [...this.tables.keys()].sort();
    const limit = input.Limit ? Number(input.Limit) : 100;
    let start = 0;
    if (input.ExclusiveStartTableName) {
      const idx = names.indexOf(input.ExclusiveStartTableName);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = names.slice(start, start + limit);
    const out = { TableNames: page };
    if (start + limit < names.length) {
      out.LastEvaluatedTableName = page[page.length - 1];
    }
    return out;
  }

  deleteTable(input) {
    const table = this.requireTable(input.TableName, "control");
    this.tables.delete(table.name);
    const desc = this.tableDescription(table);
    desc.TableStatus = "DELETING";
    return { TableDescription: desc };
  }

  updateTable(input) {
    const table = this.requireTable(input.TableName, "control");
    if (input.BillingMode) table.billingMode = input.BillingMode;
    if (input.ProvisionedThroughput) {
      table.provisionedThroughput = {
        ...table.provisionedThroughput,
        ...input.ProvisionedThroughput,
      };
    }
    if (input.AttributeDefinitions) {
      const byName = new Map(table.attributeDefinitions.map((a) => [a.AttributeName, a]));
      for (const a of input.AttributeDefinitions) byName.set(a.AttributeName, a);
      table.attributeDefinitions = [...byName.values()];
    }
    if (input.StreamSpecification) table.streamSpecification = input.StreamSpecification;
    for (const gu of input.GlobalSecondaryIndexUpdates || []) {
      if (gu.Create) {
        table.gsis.push(this.buildIndex(gu.Create));
      } else if (gu.Delete) {
        table.gsis = table.gsis.filter((g) => g.name !== gu.Delete.IndexName);
      }
    }
    return { TableDescription: this.tableDescription(table) };
  }

  // -------------------------------------------------------------------------
  // Item key extraction
  // -------------------------------------------------------------------------
  keyAttrNames(table) {
    return table.rangeKey ? [table.hashKey, table.rangeKey] : [table.hashKey];
  }

  extractKey(table, item) {
    const key = {};
    for (const name of this.keyAttrNames(table)) {
      if (item[name] === undefined) {
        throw new DynamoError(
          "ValidationException",
          `One of the required keys was not given a value: ${name}`,
        );
      }
      key[name] = item[name];
    }
    return key;
  }

  // -------------------------------------------------------------------------
  // PutItem
  // -------------------------------------------------------------------------
  putItem(input) {
    const table = this.requireTable(input.TableName);
    const item = input.Item || {};
    const key = this.extractKey(table, item);
    const keyStr = keyToString(this.keyAttrNames(table), key);
    const existing = table.items.get(keyStr);

    this.checkCondition(input, existing, "PutItem");

    table.items.set(keyStr, { ...item });

    const out = {};
    if (input.ReturnValues === "ALL_OLD" && existing) out.Attributes = existing;
    return out;
  }

  // -------------------------------------------------------------------------
  // GetItem
  // -------------------------------------------------------------------------
  getItem(input) {
    const table = this.requireTable(input.TableName);
    const key = this.extractKey(table, input.Key || {});
    const keyStr = keyToString(this.keyAttrNames(table), key);
    const item = table.items.get(keyStr);
    const out = {};
    if (item) {
      out.Item = this.projectItem(item, input.ProjectionExpression, input.ExpressionAttributeNames);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // DeleteItem
  // -------------------------------------------------------------------------
  deleteItem(input) {
    const table = this.requireTable(input.TableName);
    const key = this.extractKey(table, input.Key || {});
    const keyStr = keyToString(this.keyAttrNames(table), key);
    const existing = table.items.get(keyStr);

    this.checkCondition(input, existing, "DeleteItem");

    table.items.delete(keyStr);
    const out = {};
    if (input.ReturnValues === "ALL_OLD" && existing) out.Attributes = existing;
    return out;
  }

  // -------------------------------------------------------------------------
  // UpdateItem
  // -------------------------------------------------------------------------
  updateItem(input) {
    const table = this.requireTable(input.TableName);
    const key = this.extractKey(table, input.Key || {});
    const keyStr = keyToString(this.keyAttrNames(table), key);
    const existing = table.items.get(keyStr);

    this.checkCondition(input, existing, "UpdateItem");

    const item = existing ? { ...existing } : { ...key };
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};

    if (input.UpdateExpression) {
      this.applyUpdateExpression(item, input.UpdateExpression, names, values);
    } else if (input.AttributeUpdates) {
      for (const [attr, action] of Object.entries(input.AttributeUpdates)) {
        if (!action || action.Action === "PUT" || action.Action === undefined) {
          item[attr] = action.Value;
        } else if (action.Action === "DELETE") {
          delete item[attr];
        } else if (action.Action === "ADD") {
          item[attr] = this.addValues(item[attr], action.Value);
        }
      }
    }

    table.items.set(keyStr, item);

    const out = {};
    if (input.ReturnValues === "ALL_NEW") out.Attributes = item;
    else if (input.ReturnValues === "ALL_OLD") out.Attributes = existing || {};
    else if (input.ReturnValues === "UPDATED_NEW" || input.ReturnValues === "UPDATED_OLD") {
      out.Attributes = item;
    }
    return out;
  }

  resolveName(token, names) {
    if (token.startsWith("#")) {
      if (!(token in names)) {
        throw new DynamoError(
          "ValidationException",
          `An expression attribute name used in the document path is not defined; attribute name: ${token}`,
        );
      }
      return names[token];
    }
    return token;
  }

  applyUpdateExpression(item, expr, names, values) {
    // Split into clauses by leading keywords SET/ADD/REMOVE/DELETE.
    const re = /(SET|ADD|REMOVE|DELETE)\s+/gi;
    const sections = [];
    let match;
    let lastIndex = 0;
    let lastKw = null;
    while ((match = re.exec(expr)) !== null) {
      if (lastKw) {
        sections.push({ kw: lastKw, body: expr.slice(lastIndex, match.index) });
      }
      lastKw = match[1].toUpperCase();
      lastIndex = re.lastIndex;
    }
    if (lastKw) sections.push({ kw: lastKw, body: expr.slice(lastIndex) });

    for (const section of sections) {
      const parts = this.splitTopLevel(section.body, ",");
      for (const raw of parts) {
        const clause = raw.trim();
        if (!clause) continue;
        if (section.kw === "SET") {
          const eq = clause.indexOf("=");
          const path = clause.slice(0, eq).trim();
          const valueExpr = clause.slice(eq + 1).trim();
          const attr = this.resolveName(path, names);
          item[attr] = this.evalUpdateValue(valueExpr, names, values, item);
        } else if (section.kw === "REMOVE") {
          const attr = this.resolveName(clause, names);
          delete item[attr];
        } else if (section.kw === "ADD") {
          const sp = clause.split(/\s+/);
          const attr = this.resolveName(sp[0], names);
          const valTok = sp[1];
          const addend = this.lookupValue(valTok, values);
          item[attr] = this.addValues(item[attr], addend);
        } else if (section.kw === "DELETE") {
          const sp = clause.split(/\s+/);
          const attr = this.resolveName(sp[0], names);
          const valTok = sp[1];
          const subtrahend = this.lookupValue(valTok, values);
          item[attr] = this.deleteFromSet(item[attr], subtrahend);
        }
      }
    }
  }

  splitTopLevel(str, sep) {
    const out = [];
    let depth = 0;
    let current = "";
    for (const c of str) {
      if (c === "(") depth += 1;
      if (c === ")") depth -= 1;
      if (c === sep && depth === 0) {
        out.push(current);
        current = "";
      } else {
        current += c;
      }
    }
    if (current) out.push(current);
    return out;
  }

  lookupValue(token, values) {
    token = token.trim();
    if (token.startsWith(":")) {
      if (!(token in values)) {
        throw new DynamoError(
          "ValidationException",
          `An expression attribute value used in expression is not defined; attribute value: ${token}`,
        );
      }
      return values[token];
    }
    return undefined;
  }

  evalUpdateValue(expr, names, values, item) {
    expr = expr.trim();
    // Support "a + b", "a - b", if_not_exists(path, :v)
    const ifNot = expr.match(/^if_not_exists\s*\(\s*([^,]+)\s*,\s*(.+)\)$/i);
    if (ifNot) {
      const path = this.resolveName(ifNot[1].trim(), names);
      if (item[path] !== undefined) return item[path];
      return this.evalUpdateValue(ifNot[2].trim(), names, values, item);
    }
    // arithmetic
    const plus = this.splitTopLevel(expr, "+");
    if (plus.length === 2) {
      const a = this.resolveOperandValue(plus[0].trim(), names, values, item);
      const b = this.resolveOperandValue(plus[1].trim(), names, values, item);
      return { N: String(Number(a.N || 0) + Number(b.N || 0)) };
    }
    const minus = this.splitTopLevel(expr, "-");
    if (minus.length === 2) {
      const a = this.resolveOperandValue(minus[0].trim(), names, values, item);
      const b = this.resolveOperandValue(minus[1].trim(), names, values, item);
      return { N: String(Number(a.N || 0) - Number(b.N || 0)) };
    }
    return this.resolveOperandValue(expr, names, values, item);
  }

  resolveOperandValue(token, names, values, item) {
    token = token.trim();
    if (token.startsWith(":")) return this.lookupValue(token, values);
    const attr = this.resolveName(token, names);
    return item[attr];
  }

  addValues(current, addend) {
    if (addend === undefined) return current;
    if (addend.N !== undefined) {
      const base = current && current.N !== undefined ? Number(current.N) : 0;
      return { N: String(base + Number(addend.N)) };
    }
    if (addend.SS !== undefined) {
      const set = new Set(current && current.SS ? current.SS : []);
      for (const v of addend.SS) set.add(v);
      return { SS: [...set] };
    }
    if (addend.NS !== undefined) {
      const set = new Set(current && current.NS ? current.NS : []);
      for (const v of addend.NS) set.add(v);
      return { NS: [...set] };
    }
    return addend;
  }

  deleteFromSet(current, subtrahend) {
    if (!current || !subtrahend) return current;
    if (subtrahend.SS !== undefined && current.SS) {
      const remove = new Set(subtrahend.SS);
      const remaining = current.SS.filter((v) => !remove.has(v));
      return remaining.length ? { SS: remaining } : undefined;
    }
    if (subtrahend.NS !== undefined && current.NS) {
      const remove = new Set(subtrahend.NS);
      const remaining = current.NS.filter((v) => !remove.has(v));
      return remaining.length ? { NS: remaining } : undefined;
    }
    return current;
  }

  // -------------------------------------------------------------------------
  // Condition expressions
  // -------------------------------------------------------------------------
  checkCondition(input, item, opName) {
    const expr = input.ConditionExpression;
    if (!expr) {
      // legacy Expected
      if (input.Expected) {
        const ok = this.evalLegacyExpected(input.Expected, item, input.ConditionalOperator);
        if (!ok) {
          throw new DynamoError(
            "ConditionalCheckFailedException",
            "The conditional request failed",
          );
        }
      }
      return;
    }
    const ast = parseExpression(expr);
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};
    const ok = this.evalConditionAst(ast, item || {}, names, values, item !== undefined);
    if (!ok) {
      throw new DynamoError("ConditionalCheckFailedException", "The conditional request failed");
    }
  }

  evalLegacyExpected(expected, item, op) {
    const results = [];
    for (const [attr, cond] of Object.entries(expected)) {
      if (cond.Exists === false) {
        results.push(!item || item[attr] === undefined);
      } else if (cond.Value !== undefined) {
        results.push(item && avEquals(item[attr], cond.Value));
      } else {
        results.push(true);
      }
    }
    return op === "OR" ? results.some(Boolean) : results.every(Boolean);
  }

  // Evaluate a condition AST against an item. itemExists indicates row presence.
  evalConditionAst(node, item, names, values, itemExists) {
    switch (node.type) {
      case "and":
        return (
          this.evalConditionAst(node.left, item, names, values, itemExists) &&
          this.evalConditionAst(node.right, item, names, values, itemExists)
        );
      case "or":
        return (
          this.evalConditionAst(node.left, item, names, values, itemExists) ||
          this.evalConditionAst(node.right, item, names, values, itemExists)
        );
      case "not":
        return !this.evalConditionAst(node.child, item, names, values, itemExists);
      case "func":
        return this.evalFunc(node, item, names, values, itemExists);
      case "compare": {
        const l = this.evalOperand(node.left, item, names, values);
        const r = this.evalOperand(node.right, item, names, values);
        return this.compareOp(node.op, l, r);
      }
      case "between": {
        const v = this.evalOperand(node.operand, item, names, values);
        const lo = this.evalOperand(node.low, item, names, values);
        const hi = this.evalOperand(node.high, item, names, values);
        if (v === undefined || lo === undefined || hi === undefined) return false;
        return compareAv(v, lo) >= 0 && compareAv(v, hi) <= 0;
      }
      case "in": {
        const v = this.evalOperand(node.operand, item, names, values);
        return node.list.some((o) => avEquals(v, this.evalOperand(o, item, names, values)));
      }
      case "operand": {
        const v = this.evalOperand(node.operand, item, names, values);
        return v && v.BOOL === true;
      }
      case "true":
        return true;
      default:
        return false;
    }
  }

  evalFunc(node, item, names, values) {
    const name = node.name;
    const firstArg = node.args[0];
    if (name === "attribute_exists") {
      const attr = this.resolveName(firstArg.value, names);
      return item[attr] !== undefined;
    }
    if (name === "attribute_not_exists") {
      const attr = this.resolveName(firstArg.value, names);
      return item[attr] === undefined;
    }
    if (name === "begins_with") {
      const v = this.evalOperand(firstArg, item, names, values);
      const prefix = this.evalOperand(node.args[1], item, names, values);
      if (!v || !prefix) return false;
      const sv = v.S !== undefined ? v.S : v.B;
      const sp = prefix.S !== undefined ? prefix.S : prefix.B;
      return typeof sv === "string" && typeof sp === "string" && sv.startsWith(sp);
    }
    if (name === "contains") {
      const v = this.evalOperand(firstArg, item, names, values);
      const target = this.evalOperand(node.args[1], item, names, values);
      if (!v || !target) return false;
      if (v.S !== undefined && target.S !== undefined) return v.S.includes(target.S);
      if (v.SS !== undefined && target.S !== undefined) return v.SS.includes(target.S);
      if (v.NS !== undefined && target.N !== undefined) return v.NS.includes(target.N);
      if (v.L !== undefined) return v.L.some((e) => avEquals(e, target));
      return false;
    }
    if (name === "attribute_type") {
      const attr = this.resolveName(firstArg.value, names);
      const typeArg = this.evalOperand(node.args[1], item, names, values);
      const want = typeArg && typeArg.S;
      const av = item[attr];
      return av !== undefined && want !== undefined && want in av;
    }
    return false;
  }

  evalOperand(operand, item, names, values) {
    if (!operand) return undefined;
    if (operand.kind === "literal") return operand.value;
    if (operand.kind === "name") {
      const token = operand.value;
      if (token.startsWith(":")) return values[token];
      const attr = this.resolveName(token, names);
      // support nested path a.b
      if (attr.includes(".")) {
        // best-effort: not deeply resolving nested maps for filters
        return item[attr];
      }
      return item[attr];
    }
    if (operand.kind === "size") {
      const inner = this.evalOperand(operand.arg, item, names, values);
      if (!inner) return { N: "0" };
      if (inner.S !== undefined) return { N: String(inner.S.length) };
      if (inner.L !== undefined) return { N: String(inner.L.length) };
      if (inner.M !== undefined) return { N: String(Object.keys(inner.M).length) };
      if (inner.SS !== undefined) return { N: String(inner.SS.length) };
      return { N: "0" };
    }
    return undefined;
  }

  compareOp(op, l, r) {
    if (l === undefined || r === undefined) return false;
    const cmp = compareAv(l, r);
    switch (op) {
      case "=":
        return avEquals(l, r);
      case "<>":
        return !avEquals(l, r);
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------
  query(input) {
    const table = this.requireTable(input.TableName);
    let hashKey = table.hashKey;
    let rangeKey = table.rangeKey;
    let source = [...table.items.values()];

    if (input.IndexName) {
      const idx =
        table.gsis.find((g) => g.name === input.IndexName) ||
        table.lsis.find((l) => l.name === input.IndexName);
      if (!idx) {
        throw new DynamoError(
          "ValidationException",
          `The table does not have the specified index: ${input.IndexName}`,
        );
      }
      hashKey = idx.hashKey;
      rangeKey = idx.rangeKey;
    }

    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};

    let keyCond = input.KeyConditionExpression;
    let conditions = [];
    if (keyCond) {
      conditions = this.parseKeyConditions(keyCond, names);
    } else if (input.KeyConditions) {
      for (const [attr, c] of Object.entries(input.KeyConditions)) {
        conditions.push({
          attr,
          op: c.ComparisonOperator,
          valueRefs: (c.AttributeValueList || []).map((v) => ({ literal: v })),
        });
      }
    }

    // Filter items by key conditions.
    let results = source.filter((item) =>
      conditions.every((cond) => this.matchKeyCondition(cond, item, names, values)),
    );

    // Sort by range key.
    if (rangeKey) {
      results.sort((a, b) => {
        const c = compareAv(a[rangeKey], b[rangeKey]);
        return Number.isNaN(c) ? 0 : c;
      });
    }
    if (input.ScanIndexForward === false) results.reverse();

    // Apply FilterExpression.
    if (input.FilterExpression) {
      const ast = parseExpression(input.FilterExpression);
      results = results.filter((item) => this.evalConditionAst(ast, item, names, values, true));
    }

    return this.paginate(table, input, results, "Query");
  }

  parseKeyConditions(expr, names) {
    // Split on AND at top level.
    const parts = this.splitTopLevel(expr, "&"); // won't be hit; AND keyword used
    const andParts = expr.split(/\s+AND\s+/i);
    const conds = [];
    for (const part of andParts) {
      const trimmed = part.trim();
      const bw = trimmed.match(/^begins_with\s*\(\s*([^,]+),\s*(.+)\)$/i);
      if (bw) {
        conds.push({ attrToken: bw[1].trim(), op: "BEGINS_WITH", valueTokens: [bw[2].trim()] });
        continue;
      }
      const between = trimmed.match(/^(\S+)\s+BETWEEN\s+(\S+)\s+AND\s+(\S+)$/i);
      if (between) {
        conds.push({
          attrToken: between[1].trim(),
          op: "BETWEEN",
          valueTokens: [between[2].trim(), between[3].trim()],
        });
        continue;
      }
      const m = trimmed.match(/^(\S+)\s*(=|<=|>=|<|>)\s*(\S+)$/);
      if (m) {
        const opMap = { "=": "EQ", "<": "LT", ">": "GT", "<=": "LE", ">=": "GE" };
        conds.push({ attrToken: m[1].trim(), op: opMap[m[2]], valueTokens: [m[3].trim()] });
      }
    }
    return conds.map((c) => ({
      attr: this.resolveName(c.attrToken, names),
      op: c.op,
      valueTokens: c.valueTokens,
    }));
  }

  matchKeyCondition(cond, item, names, values) {
    const attr = cond.attr || this.resolveName(cond.attrToken, names);
    const av = item[attr];
    if (av === undefined) return false;
    const resolveVal = (tok) => {
      if (cond.valueRefs) return tok.literal;
      if (typeof tok === "string" && tok.startsWith(":")) return values[tok];
      return tok;
    };
    const vals = (cond.valueTokens || cond.valueRefs || []).map(resolveVal);
    switch (cond.op) {
      case "EQ":
        return avEquals(av, vals[0]);
      case "LT":
        return compareAv(av, vals[0]) < 0;
      case "LE":
        return compareAv(av, vals[0]) <= 0;
      case "GT":
        return compareAv(av, vals[0]) > 0;
      case "GE":
        return compareAv(av, vals[0]) >= 0;
      case "BEGINS_WITH": {
        const s = av.S !== undefined ? av.S : av.B;
        const p = vals[0] && (vals[0].S !== undefined ? vals[0].S : vals[0].B);
        return typeof s === "string" && typeof p === "string" && s.startsWith(p);
      }
      case "BETWEEN":
        return compareAv(av, vals[0]) >= 0 && compareAv(av, vals[1]) <= 0;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------
  scan(input) {
    const table = this.requireTable(input.TableName);
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};
    let results = [...table.items.values()];

    if (input.FilterExpression) {
      const ast = parseExpression(input.FilterExpression);
      results = results.filter((item) => this.evalConditionAst(ast, item, names, values, true));
    } else if (input.ScanFilter) {
      results = results.filter((item) =>
        Object.entries(input.ScanFilter).every(([attr, c]) => {
          const cond = {
            attr,
            op: c.ComparisonOperator,
            valueRefs: (c.AttributeValueList || []).map((v) => ({ literal: v })),
          };
          return this.matchKeyCondition(cond, item, names, values);
        }),
      );
    }

    return this.paginate(table, input, results, "Scan");
  }

  paginate(table, input, results, op) {
    const keyAttrs = this.keyAttrNames(table);
    // ExclusiveStartKey
    let startIdx = 0;
    if (input.ExclusiveStartKey) {
      const startStr = keyToString(keyAttrs, input.ExclusiveStartKey);
      const idx = results.findIndex((item) => keyToString(keyAttrs, item) === startStr);
      startIdx = idx >= 0 ? idx + 1 : 0;
    }

    const limit = input.Limit ? Number(input.Limit) : undefined;
    const scanned = results.slice(startIdx);
    let page = limit ? scanned.slice(0, limit) : scanned;

    const count = page.length;

    let projected = page.map((item) =>
      this.projectItem(item, input.ProjectionExpression, input.ExpressionAttributeNames),
    );

    const out = {
      Count: count,
      ScannedCount: page.length,
    };
    if (input.Select === "COUNT") {
      // no Items
    } else {
      out.Items = projected;
    }
    if (limit && startIdx + limit < results.length) {
      const lastItem = page[page.length - 1];
      if (lastItem) {
        const lek = {};
        for (const name of keyAttrs) lek[name] = lastItem[name];
        out.LastEvaluatedKey = lek;
      }
    }
    return out;
  }

  projectItem(item, projectionExpr, names) {
    if (!projectionExpr) return item;
    const attrs = projectionExpr.split(",").map((s) => s.trim());
    const out = {};
    for (const a of attrs) {
      const resolved = names && a.startsWith("#") ? names[a] || a : a;
      if (item[resolved] !== undefined) out[resolved] = item[resolved];
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Batch
  // -------------------------------------------------------------------------
  batchWriteItem(input) {
    const requestItems = input.RequestItems || {};
    for (const [tableName, ops] of Object.entries(requestItems)) {
      const table = this.requireTable(tableName);
      for (const op of ops) {
        if (op.PutRequest) {
          const item = op.PutRequest.Item;
          const key = this.extractKey(table, item);
          const keyStr = keyToString(this.keyAttrNames(table), key);
          table.items.set(keyStr, { ...item });
        } else if (op.DeleteRequest) {
          const key = this.extractKey(table, op.DeleteRequest.Key);
          const keyStr = keyToString(this.keyAttrNames(table), key);
          table.items.delete(keyStr);
        }
      }
    }
    return { UnprocessedItems: {} };
  }

  batchGetItem(input) {
    const requestItems = input.RequestItems || {};
    const responses = {};
    for (const [tableName, spec] of Object.entries(requestItems)) {
      const table = this.requireTable(tableName);
      const items = [];
      for (const key of spec.Keys || []) {
        const k = this.extractKey(table, key);
        const keyStr = keyToString(this.keyAttrNames(table), k);
        const item = table.items.get(keyStr);
        if (item) {
          items.push(this.projectItem(item, spec.ProjectionExpression, spec.ExpressionAttributeNames));
        }
      }
      responses[tableName] = items;
    }
    return { Responses: responses, UnprocessedKeys: {} };
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------
  transactWriteItems(input) {
    const transactItems = input.TransactItems || [];
    // Validate all conditions first (snapshot semantics). Build a request-ordered
    // CancellationReasons array: {"Code":"None"} for actions that passed,
    // {"Code":"ConditionalCheckFailed","Message":"The conditional request failed"}
    // for any that failed. Only throw once, after evaluating the whole batch — this
    // matches the real TransactionCanceledException shape (reasons positionally
    // aligned to TransactItems). Source: API_TransactWriteItems.
    const plan = [];
    const reasons = [];
    let anyFailed = false;
    for (const ti of transactItems) {
      let spec;
      let existing;
      if (ti.Put) {
        const table = this.requireTable(ti.Put.TableName);
        const item = ti.Put.Item;
        const keyStr = keyToString(this.keyAttrNames(table), this.extractKey(table, item));
        existing = table.items.get(keyStr);
        spec = ti.Put;
        plan.push({ kind: "put", table, keyStr, item });
      } else if (ti.Delete) {
        const table = this.requireTable(ti.Delete.TableName);
        const keyStr = keyToString(this.keyAttrNames(table), this.extractKey(table, ti.Delete.Key));
        existing = table.items.get(keyStr);
        spec = ti.Delete;
        plan.push({ kind: "delete", table, keyStr });
      } else if (ti.Update) {
        const table = this.requireTable(ti.Update.TableName);
        const key = this.extractKey(table, ti.Update.Key);
        const keyStr = keyToString(this.keyAttrNames(table), key);
        existing = table.items.get(keyStr);
        spec = ti.Update;
        plan.push({ kind: "update", table, keyStr, key, spec: ti.Update, existing });
      } else if (ti.ConditionCheck) {
        const table = this.requireTable(ti.ConditionCheck.TableName);
        const keyStr = keyToString(this.keyAttrNames(table), this.extractKey(table, ti.ConditionCheck.Key));
        existing = table.items.get(keyStr);
        spec = ti.ConditionCheck;
      }

      if (spec && this.transactConditionFails(spec, existing)) {
        anyFailed = true;
        reasons.push({ Code: "ConditionalCheckFailed", Message: "The conditional request failed" });
      } else {
        reasons.push({ Code: "None" });
      }
    }

    if (anyFailed) {
      const codeList = reasons.map((r) => r.Code).join(", ");
      throw new DynamoError(
        "TransactionCanceledException",
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${codeList}]`,
        400,
        { CancellationReasons: reasons },
      );
    }

    // Apply.
    for (const step of plan) {
      if (step.kind === "put") step.table.items.set(step.keyStr, { ...step.item });
      else if (step.kind === "delete") step.table.items.delete(step.keyStr);
      else if (step.kind === "update") {
        const item = step.existing ? { ...step.existing } : { ...step.key };
        const names = step.spec.ExpressionAttributeNames || {};
        const values = step.spec.ExpressionAttributeValues || {};
        if (step.spec.UpdateExpression) {
          this.applyUpdateExpression(item, step.spec.UpdateExpression, names, values);
        }
        step.table.items.set(step.keyStr, item);
      }
    }
    return {};
  }

  // Returns true if the action's ConditionExpression FAILED (i.e. transaction must
  // be cancelled). Non-throwing so the caller can build a request-ordered
  // CancellationReasons array across all actions.
  transactConditionFails(spec, existing) {
    if (!spec.ConditionExpression) return false;
    const ast = parseExpression(spec.ConditionExpression);
    const names = spec.ExpressionAttributeNames || {};
    const values = spec.ExpressionAttributeValues || {};
    const ok = this.evalConditionAst(ast, existing || {}, names, values, existing !== undefined);
    return !ok;
  }

  transactGetItems(input) {
    const transactItems = input.TransactItems || [];
    const responses = [];
    for (const ti of transactItems) {
      const get = ti.Get;
      const table = this.requireTable(get.TableName);
      const keyStr = keyToString(this.keyAttrNames(table), this.extractKey(table, get.Key));
      const item = table.items.get(keyStr);
      responses.push(item ? { Item: this.projectItem(item, get.ProjectionExpression, get.ExpressionAttributeNames) } : {});
    }
    return { Responses: responses };
  }

  // -------------------------------------------------------------------------
  // Tagging
  // -------------------------------------------------------------------------
  tableByArn(arn) {
    for (const table of this.tables.values()) {
      if (table.arn === arn) return table;
    }
    throw new DynamoError("ResourceNotFoundException", `Requested resource not found: ${arn}`);
  }

  tagResource(input) {
    const table = this.tableByArn(input.ResourceArn);
    for (const t of input.Tags || []) {
      if (t && t.Key !== undefined) table.tags.set(t.Key, t.Value ?? "");
    }
    return {};
  }

  untagResource(input) {
    const table = this.tableByArn(input.ResourceArn);
    for (const k of input.TagKeys || []) table.tags.delete(k);
    return {};
  }

  listTagsOfResource(input) {
    const table = this.tableByArn(input.ResourceArn);
    return { Tags: [...table.tags.entries()].map(([Key, Value]) => ({ Key, Value })) };
  }

  // -------------------------------------------------------------------------
  // TTL
  // -------------------------------------------------------------------------
  updateTimeToLive(input) {
    const table = this.requireTable(input.TableName, "control");
    const spec = input.TimeToLiveSpecification || {};
    table.ttl = { enabled: Boolean(spec.Enabled), attributeName: spec.AttributeName };
    return { TimeToLiveSpecification: { Enabled: table.ttl.enabled, AttributeName: table.ttl.attributeName } };
  }

  describeTimeToLive(input) {
    const table = this.requireTable(input.TableName, "control");
    return {
      TimeToLiveDescription: {
        TimeToLiveStatus: table.ttl.enabled ? "ENABLED" : "DISABLED",
        ...(table.ttl.attributeName ? { AttributeName: table.ttl.attributeName } : {}),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServerError";
    const status = error.status || ERROR_STATUS[code] || 400;
    const prefix = CORAL_ERRORS.has(code) ? CORAL_ERROR_PREFIX : ERROR_TYPE_PREFIX;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", `${code}:`);
    // AWS JSON 1.0 error envelope: { "__type": "<prefix>#<Code>", "message": "..." }.
    // Real DynamoDB emits a lowercase `message` only.
    res.end(
      JSON.stringify({
        __type: `${prefix}${code}`,
        message: error.message || code,
        ...error.extra,
      }),
    );
  }
}

export default DynamodbServer;
