import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/monday — a tiny, dependency-free fake of the monday.com GraphQL API.
//
// POST /v2 only. We implement a *minimal but real* GraphQL parser: the query
// string is tokenised, the operation type (query/mutation) and the top-level
// selection fields + arguments are extracted, $variables are substituted, and
// each field is dispatched to an in-memory resolver. State is in-memory and
// ephemeral. Responses carry { data, account_id }.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Minimal GraphQL parsing (shared shape with the linear fake).
// ---------------------------------------------------------------------------
function tokenize(query) {
  const tokens = [];
  let i = 0;
  const n = query.length;
  while (i < n) {
    const c = query[i];
    if (c === "#") {
      while (i < n && query[i] !== "\n") i += 1;
      continue;
    }
    if (/\s/.test(c) || c === ",") { i += 1; continue; }
    if (c === '"') {
      let str = "";
      i += 1;
      while (i < n && query[i] !== '"') {
        if (query[i] === "\\") { str += query[i + 1]; i += 2; continue; }
        str += query[i];
        i += 1;
      }
      i += 1;
      tokens.push({ type: "string", value: str });
      continue;
    }
    if ("{}()[]:$@!=".includes(c)) {
      tokens.push({ type: "punct", value: c });
      i += 1;
      continue;
    }
    let name = "";
    while (i < n && /[A-Za-z0-9_.\-]/.test(query[i])) { name += query[i]; i += 1; }
    if (name) tokens.push({ type: "name", value: name });
    else i += 1;
  }
  return tokens;
}

function parseOperation(query, variables) {
  const tokens = tokenize(query);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  let opType = "query";
  if (peek() && peek().type === "name" && (peek().value === "query" || peek().value === "mutation" || peek().value === "subscription")) {
    opType = next().value;
    if (peek() && peek().type === "name") next();
    if (peek() && peek().value === "(") skipBalanced("(", ")");
  }
  if (!peek() || peek().value !== "{") return { type: opType, fields: [] };
  next();
  const fields = parseSelectionSet();
  return { type: opType, fields };

  function skipBalanced(open, close) {
    let depth = 0;
    do {
      const t = next();
      if (!t) break;
      if (t.value === open) depth += 1;
      else if (t.value === close) depth -= 1;
    } while (depth > 0);
  }

  function parseValue() {
    const t = next();
    if (!t) return null;
    if (t.type === "string") return t.value;
    if (t.value === "$") {
      const varName = next().value;
      return variables ? variables[varName] : undefined;
    }
    if (t.value === "{") {
      const obj = {};
      while (peek() && peek().value !== "}") {
        const key = next().value;
        if (peek() && peek().value === ":") next();
        obj[key] = parseValue();
      }
      next();
      return obj;
    }
    if (t.value === "[") {
      const arr = [];
      while (peek() && peek().value !== "]") arr.push(parseValue());
      next();
      return arr;
    }
    if (t.value === "true") return true;
    if (t.value === "false") return false;
    if (t.value === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(t.value)) return Number(t.value);
    return t.value;
  }

  function parseArgs() {
    const args = {};
    next();
    while (peek() && peek().value !== ")") {
      const argName = next().value;
      if (peek() && peek().value === ":") next();
      args[argName] = parseValue();
    }
    next();
    return args;
  }

  function parseSelectionSet() {
    const result = [];
    while (peek() && peek().value !== "}") {
      const t = next();
      if (t.type !== "name") continue;
      let fieldName = t.value;
      if (peek() && peek().value === ":") {
        next();
        fieldName = next().value;
      }
      const field = { name: fieldName, args: {}, selection: [] };
      if (peek() && peek().value === "(") field.args = parseArgs();
      if (peek() && peek().value === "{") {
        next();
        field.selection = parseSelectionSet();
      }
      result.push(field);
    }
    if (peek() && peek().value === "}") next();
    return result;
  }
}

export class MondayServer {
  constructor(port = 4791, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.boards = new Map();
    this.items = new Map();
    this.idCounter = 1000000000;
    this._seedDefaults();
  }

  _nextId() {
    this.idCounter += 1;
    return String(this.idCounter);
  }

  _seedDefaults() {
    this.accountId = "12345678";
    this.me = {
      id: this._nextId(),
      name: "Parlel User",
      email: "parlel@example.com",
    };
    const boardId = this._nextId();
    this.boards.set(boardId, {
      id: boardId,
      name: "Parlel Board",
      state: "active",
      board_kind: "public",
    });
    this.defaultBoard = boardId;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 200, { errors: [{ message: error.message || "Internal server error" }], account_id: this.accountId });
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
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, API-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-monday");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // POST /v2 ONLY.
    if (parts[0] === "v2" && req.method === "POST") {
      if (!this.isAuthorized(req)) {
        return this.send(res, 401, { errors: [{ message: "Not Authenticated" }], status_code: 401 });
      }
      return this.handleGraphql(res, body);
    }

    return this.send(res, 404, { errors: [{ message: "not found" }] });
  }

  handleGraphql(res, body) {
    const query = typeof body.query === "string" ? body.query : "";
    const variables = isPlainObject(body.variables) ? body.variables : {};
    let op;
    try {
      op = parseOperation(query, variables);
    } catch (error) {
      return this.send(res, 200, { errors: [{ message: `Parse error: ${error.message}` }], account_id: this.accountId });
    }

    const data = {};
    const errors = [];
    for (const field of op.fields) {
      try {
        data[field.name] = this.resolveField(op.type, field);
      } catch (error) {
        errors.push({ message: error.message });
      }
    }
    const out = { data, account_id: this.accountId };
    if (errors.length) out.errors = errors;
    return this.send(res, 200, out);
  }

  resolveField(opType, field) {
    const name = field.name;
    if (opType === "mutation") {
      if (name === "create_item") return this.createItem(field.args);
      if (name === "create_board") return this.createBoard(field.args);
      if (name === "delete_item") return this.deleteItem(field.args);
      throw new Error(`Unknown mutation field: ${name}`);
    }
    if (name === "me") return clone(this.me);
    if (name === "boards") return this.boardsQuery(field.args);
    if (name === "items") return this.itemsQuery(field.args);
    throw new Error(`Unknown query field: ${name}`);
  }

  createItem(args) {
    if (!args.item_name) throw new Error("item_name is required");
    const boardId = args.board_id != null ? String(args.board_id) : this.defaultBoard;
    if (!this.boards.has(boardId)) {
      this.boards.set(boardId, { id: boardId, name: `Board ${boardId}`, state: "active", board_kind: "public" });
    }
    const id = this._nextId();
    const item = {
      id,
      name: String(args.item_name),
      board: { id: boardId },
      group: { id: args.group_id ? String(args.group_id) : "topics" },
      column_values: [],
      created_at: new Date().toISOString(),
    };
    this.items.set(id, item);
    return { id, name: item.name };
  }

  createBoard(args) {
    if (!args.board_name) throw new Error("board_name is required");
    const id = this._nextId();
    const board = {
      id,
      name: String(args.board_name),
      state: "active",
      board_kind: args.board_kind ? String(args.board_kind) : "public",
    };
    this.boards.set(id, board);
    return { id, name: board.name };
  }

  deleteItem(args) {
    const id = args.item_id != null ? String(args.item_id) : null;
    if (id && this.items.has(id)) {
      this.items.delete(id);
      return { id };
    }
    return { id };
  }

  boardsQuery(args) {
    let boards = [...this.boards.values()];
    if (args && args.ids) {
      const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String);
      boards = boards.filter((b) => ids.includes(b.id));
    }
    return boards.map(clone);
  }

  itemsQuery(args) {
    let items = [...this.items.values()];
    if (args && args.ids) {
      const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String);
      items = items.filter((i) => ids.includes(i.id));
    }
    return items.map(clone);
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { errors: [{ message: "not found" }] });
  }

  root() {
    return {
      name: "monday",
      version: "1",
      protocol: "monday-graphql",
      documentation: "/docs/monday.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return auth.trim().length > 0;
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { errors: [{ message: "Bad request body" }] });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { errors: [{ message: "Bad request body" }] });
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
