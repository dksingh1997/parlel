import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/linear — a tiny, dependency-free fake of the Linear GraphQL API.
//
// POST /graphql only. We implement a *minimal but real* GraphQL parser: the
// query string is tokenised, the operation type (query/mutation) and the
// top-level selection fields + arguments are extracted, and each field is
// dispatched to an in-memory resolver. Variables ($var) are substituted from
// the request `variables` map. State is in-memory and ephemeral.
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
// Minimal GraphQL parsing
// ---------------------------------------------------------------------------

// Strip comments / commas, return a token stream of the operation body.
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
      // string literal (handle triple-quote block strings minimally)
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
    // name / number
    let name = "";
    while (i < n && /[A-Za-z0-9_.\-]/.test(query[i])) { name += query[i]; i += 1; }
    if (name) tokens.push({ type: "name", value: name });
    else i += 1;
  }
  return tokens;
}

// Parse the top-level operation into { type, fields: [{ name, args, selection }] }.
function parseOperation(query, variables) {
  const tokens = tokenize(query);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  let opType = "query";
  // Optional operation keyword + name + variable definitions.
  if (peek() && peek().type === "name" && (peek().value === "query" || peek().value === "mutation" || peek().value === "subscription")) {
    opType = next().value;
    // optional operation name
    if (peek() && peek().type === "name") next();
    // optional variable definitions ( ... )
    if (peek() && peek().value === "(") skipBalanced("(", ")");
  }
  // Expect top-level selection set.
  if (!peek() || peek().value !== "{") return { type: opType, fields: [] };
  next(); // consume {
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
      // object literal
      const obj = {};
      while (peek() && peek().value !== "}") {
        const key = next().value;
        if (peek() && peek().value === ":") next();
        obj[key] = parseValue();
      }
      next(); // }
      return obj;
    }
    if (t.value === "[") {
      const arr = [];
      while (peek() && peek().value !== "]") arr.push(parseValue());
      next(); // ]
      return arr;
    }
    // scalar name / number / boolean / null
    if (t.value === "true") return true;
    if (t.value === "false") return false;
    if (t.value === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(t.value)) return Number(t.value);
    return t.value; // enum / bare name
  }

  function parseArgs() {
    const args = {};
    next(); // consume (
    while (peek() && peek().value !== ")") {
      const argName = next().value;
      if (peek() && peek().value === ":") next();
      args[argName] = parseValue();
    }
    next(); // consume )
    return args;
  }

  function parseSelectionSet() {
    const result = [];
    while (peek() && peek().value !== "}") {
      const t = next();
      if (t.type !== "name") continue;
      // alias?
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

export class LinearServer {
  constructor(port = 4788, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.issues = new Map();
    this.teams = new Map();
    this.comments = new Map();
    this.issueCounter = 0;
    this.syncCounter = 0;
    this._seedDefaults();
  }

  // Linear returns a monotonically-increasing `lastSyncId` (a sync cursor) on
  // every mutation payload. We mimic the shape with a simple counter.
  _nextSyncId() {
    this.syncCounter += 1;
    return this.syncCounter;
  }

  _seedDefaults() {
    this.viewer = {
      id: randomUUID(),
      name: "Parlel User",
      email: "parlel@example.com",
      displayName: "parlel",
    };
    const teamId = randomUUID();
    this.teams.set(teamId, {
      id: teamId,
      name: "Parlel",
      key: "PAR",
    });
    this.defaultTeamId = teamId;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 200, { errors: [{ message: error.message || "Internal server error" }] });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-linear");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // POST /graphql ONLY.
    if (parts[0] === "graphql" && req.method === "POST") {
      if (!this.isAuthorized(req)) {
        // Real Linear returns HTTP 400 (not 401) with a GraphQL-style errors
        // envelope whose extensions.type is "authentication error".
        return this.send(res, 400, {
          errors: [
            {
              message: "Authentication required - not authenticated",
              extensions: {
                type: "authentication error",
                userError: true,
                userPresentableMessage: "You need to authenticate to access this resource.",
              },
            },
          ],
        });
      }
      return this.handleGraphql(res, body);
    }

    return this.send(res, 404, { errors: [{ message: "not found" }] });
  }

  handleGraphql(res, body) {
    const query = typeof body.query === "string" ? body.query : "";
    // Real Linear rejects a request with no/blank `query` attribute with HTTP 400.
    if (!query) {
      return this.send(res, 400, {
        errors: [{ message: "Must provide query string." }],
      });
    }
    const variables = isPlainObject(body.variables) ? body.variables : {};
    let op;
    try {
      op = parseOperation(query, variables);
    } catch (error) {
      return this.send(res, 200, { errors: [{ message: `Parse error: ${error.message}` }] });
    }

    const data = {};
    const errors = [];
    for (const field of op.fields) {
      try {
        data[field.name] = this.resolveField(op.type, field);
      } catch (error) {
        const entry = { message: error.message, path: [field.name] };
        // Real Linear attaches an `extensions.type` to resolver errors. We
        // classify entity-not-found vs validation to match the envelope shape.
        if (error.extensions) entry.extensions = error.extensions;
        else if (/Entity not found/i.test(error.message)) {
          entry.extensions = { type: "invalid input", userError: true };
        } else if (/Validation Error|is required/i.test(error.message)) {
          entry.extensions = { type: "invalid input", userError: true };
        }
        errors.push(entry);
        data[field.name] = null;
      }
    }
    const out = { data };
    if (errors.length) out.errors = errors;
    return this.send(res, 200, out);
  }

  resolveField(opType, field) {
    const name = field.name;
    if (opType === "mutation") {
      if (name === "issueCreate") return this.issueCreate(field.args);
      if (name === "issueUpdate") return this.issueUpdate(field.args);
      if (name === "issueDelete") return this.issueDelete(field.args);
      if (name === "commentCreate") return this.commentCreate(field.args);
      throw new Error(`Unknown mutation field: ${name}`);
    }
    // queries
    if (name === "viewer") return clone(this.viewer);
    if (name === "issues") return this.issuesConnection();
    if (name === "issue") return this.issueById(field.args);
    if (name === "teams") return this.teamsConnection();
    if (name === "comment") return this.commentById(field.args);
    throw new Error(`Unknown query field: ${name}`);
  }

  // Priority -> human label, matching Linear's `priorityLabel` field.
  _priorityLabel(priority) {
    return ["No priority", "Urgent", "High", "Medium", "Low"][priority] || "No priority";
  }

  issueCreate(args) {
    const input = isPlainObject(args.input) ? args.input : {};
    if (typeof input.title !== "string" || !input.title) {
      throw new Error("Argument Validation Error: title is required");
    }
    const teamId = input.teamId || this.defaultTeamId;
    const team = this.teams.get(teamId) || this.teams.get(this.defaultTeamId);
    this.issueCounter += 1;
    const id = randomUUID();
    const number = this.issueCounter;
    const identifier = `${team.key}-${number}`;
    const now = new Date().toISOString();
    const priority = typeof input.priority === "number" ? input.priority : 0;
    const issue = {
      id,
      identifier,
      number,
      title: input.title,
      description: input.description || null,
      priority,
      priorityLabel: this._priorityLabel(priority),
      teamId: team.id,
      team: { id: team.id },
      assignee: input.assigneeId ? { id: input.assigneeId } : null,
      creator: { id: this.viewer.id },
      state: { id: randomUUID(), name: "Todo", type: "unstarted" },
      branchName: `${this.viewer.displayName}/${identifier.toLowerCase()}-${this._slug(input.title)}`,
      url: `https://linear.app/parlel/issue/${identifier}`,
      createdAt: now,
      updatedAt: now,
    };
    this.issues.set(id, issue);
    return {
      success: true,
      lastSyncId: this._nextSyncId(),
      issue: clone(issue),
    };
  }

  _slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  issueUpdate(args) {
    const issue = this.issues.get(args.id);
    // Real Linear raises a GraphQL entity-not-found error (not a silent
    // { success: false }) when the target issue does not exist.
    if (!issue) throw new Error(`Entity not found: Issue - Could not find referenced Issue.`);
    const input = isPlainObject(args.input) ? args.input : {};
    if (typeof input.title === "string") issue.title = input.title;
    if (typeof input.description === "string") issue.description = input.description;
    if (typeof input.priority === "number") {
      issue.priority = input.priority;
      issue.priorityLabel = this._priorityLabel(input.priority);
    }
    if (typeof input.assigneeId === "string") issue.assignee = { id: input.assigneeId };
    issue.updatedAt = new Date().toISOString();
    return {
      success: true,
      lastSyncId: this._nextSyncId(),
      issue: clone(issue),
    };
  }

  issueDelete(args) {
    // Real Linear's issueDelete archives the issue and returns an
    // IssueArchivePayload { success, lastSyncId }. Unknown id -> GraphQL error.
    if (!this.issues.has(args.id)) {
      throw new Error(`Entity not found: Issue - Could not find referenced Issue.`);
    }
    this.issues.delete(args.id);
    return {
      success: true,
      lastSyncId: this._nextSyncId(),
    };
  }

  commentCreate(args) {
    const input = isPlainObject(args.input) ? args.input : {};
    if (typeof input.body !== "string" || !input.body) {
      throw new Error("Argument Validation Error: body is required");
    }
    if (typeof input.issueId !== "string" || !this.issues.has(input.issueId)) {
      throw new Error(`Entity not found: Issue - Could not find referenced Issue.`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const comment = {
      id,
      body: input.body,
      issue: { id: input.issueId },
      user: { id: this.viewer.id },
      createdAt: now,
      updatedAt: now,
    };
    this.comments.set(id, comment);
    return {
      success: true,
      lastSyncId: this._nextSyncId(),
      comment: clone(comment),
    };
  }

  commentById(args) {
    const comment = this.comments.get(args.id);
    return comment ? clone(comment) : null;
  }

  issueById(args) {
    const issue = this.issues.get(args.id);
    return issue ? clone(issue) : null;
  }

  _pageInfo() {
    return {
      startCursor: null,
      endCursor: null,
      hasPreviousPage: false,
      hasNextPage: false,
    };
  }

  issuesConnection() {
    const nodes = [...this.issues.values()].map(clone);
    return {
      nodes,
      pageInfo: this._pageInfo(),
    };
  }

  teamsConnection() {
    const nodes = [...this.teams.values()].map(clone);
    return {
      nodes,
      pageInfo: this._pageInfo(),
    };
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
      name: "linear",
      version: "1",
      protocol: "linear-graphql",
      documentation: "/docs/linear.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    // Linear accepts a raw API key in Authorization, or "Bearer <token>".
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
