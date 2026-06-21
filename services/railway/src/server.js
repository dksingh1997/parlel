import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/railway — a tiny, dependency-free fake of the Railway GraphQL API.
//
// Implements POST /graphql/v2 with a minimal *real* GraphQL dispatch:
//   * me { id email }
//   * projects { edges { node { id name } } }
//   * mutation projectCreate(input: { name: "..." }) { id name }
//
// The GraphQL layer tokenizes + parses the incoming document (including object
// and variable arguments + nested selection sets) and resolves it against an
// in-memory model. State is in-memory and ephemeral. Responses: { data: {...} }.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

// --- GraphQL parser ---------------------------------------------------------
function tokenizeGraphQL(query) {
  const tokens = [];
  const re =
    /\s*(?:("(?:[^"\\]|\\.)*")|(\$[A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|([{}()\[\]:,!]))/g;
  let m;
  while ((m = re.exec(query)) !== null) {
    if (m[1] !== undefined) tokens.push({ type: "string", value: JSON.parse(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: "var", value: m[2] });
    else if (m[3] !== undefined) {
      const v = m[3];
      if (v === "true") tokens.push({ type: "bool", value: true });
      else if (v === "false") tokens.push({ type: "bool", value: false });
      else if (v === "null") tokens.push({ type: "null", value: null });
      else tokens.push({ type: "name", value: v });
    } else if (m[4] !== undefined) tokens.push({ type: "number", value: Number(m[4]) });
    else if (m[5] !== undefined) tokens.push({ type: "punct", value: m[5] });
  }
  return tokens;
}

function parseGraphQL(query, variables = {}) {
  const tokens = tokenizeGraphQL(query);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseValue() {
    const t = peek();
    if (!t) return null;
    if (t.value === "{") return parseObject();
    if (t.value === "[") return parseArray();
    next();
    if (t.type === "var") {
      const name = t.value.slice(1);
      return variables[name];
    }
    return t.value;
  }

  function parseObject() {
    const obj = {};
    next(); // {
    while (peek() && peek().value !== "}") {
      const key = next().value;
      if (peek() && peek().value === ":") next();
      obj[key] = parseValue();
      if (peek() && peek().value === ",") next();
    }
    if (peek() && peek().value === "}") next();
    return obj;
  }

  function parseArray() {
    const arr = [];
    next(); // [
    while (peek() && peek().value !== "]") {
      arr.push(parseValue());
      if (peek() && peek().value === ",") next();
    }
    if (peek() && peek().value === "]") next();
    return arr;
  }

  function parseArgs() {
    const args = {};
    if (!peek() || peek().value !== "(") return args;
    next(); // (
    while (peek() && peek().value !== ")") {
      const name = next().value;
      if (peek() && peek().value === ":") next();
      args[name] = parseValue();
      if (peek() && peek().value === ",") next();
    }
    if (peek() && peek().value === ")") next();
    return args;
  }

  function parseSelectionSet() {
    const selections = [];
    if (!peek() || peek().value !== "{") return selections;
    next(); // {
    while (peek() && peek().value !== "}") {
      const nameTok = next();
      if (!nameTok || nameTok.type !== "name") continue;
      const field = { name: nameTok.value, args: {}, selections: [] };
      if (peek() && peek().value === "(") field.args = parseArgs();
      if (peek() && peek().value === "{") field.selections = parseSelectionSet();
      selections.push(field);
      if (peek() && peek().value === ",") next();
    }
    if (peek() && peek().value === "}") next();
    return selections;
  }

  let operation = "query";
  if (peek() && peek().type === "name" && (peek().value === "query" || peek().value === "mutation")) {
    operation = next().value;
    if (peek() && peek().type === "name") next(); // op name
    if (peek() && peek().value === "(") {
      // variable definitions: ($x: Type!, ...) — consume to matching ).
      let depth = 0;
      do {
        const t = next();
        if (t.value === "(") depth++;
        else if (t.value === ")") depth--;
      } while (peek() && depth > 0);
    }
  }
  return { operation, selections: parseSelectionSet() };
}

export class RailwayServer {
  constructor(port = 4882, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.me = { id: randomUUID(), email: "parlel@parlel.dev", name: "Parlel" };
    this.projects = new Map();
    // Seed one project so `projects` returns something.
    const id = randomUUID();
    this.projects.set(id, { id, name: "parlel-demo", createdAt: new Date().toISOString() });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { errors: [{ message: error.message || "Internal server error" }] });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-railway");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { errors: [{ message: "Not Authorized" }] });
    }

    // POST /graphql/v2
    if (parts[0] === "graphql" && parts[1] === "v2" && req.method === "POST") {
      return this.handleGraphQL(res, body);
    }

    return this.send(res, 404, { errors: [{ message: "Not Found" }] });
  }

  handleGraphQL(res, body) {
    const query = body && typeof body.query === "string" ? body.query : "";
    const variables = (body && body.variables) || {};
    if (!query) {
      return this.send(res, 400, { errors: [{ message: "Missing query" }] });
    }
    let parsed;
    try {
      parsed = parseGraphQL(query, variables);
    } catch (e) {
      return this.send(res, 200, { errors: [{ message: "Parse error: " + e.message }] });
    }
    const data = {};
    for (const field of parsed.selections) {
      data[field.name] = this.resolveTop(field);
    }
    return this.send(res, 200, { data });
  }

  resolveTop(field) {
    const { name, args, selections } = field;
    if (name === "me") {
      return this.pick(this.me, selections, ["id", "email", "name"]);
    }
    if (name === "projects") {
      const nodes = Array.from(this.projects.values());
      return this.resolveConnection(nodes, selections);
    }
    if (name === "projectCreate") {
      const input = (args && args.input) || {};
      const id = randomUUID();
      const project = {
        id,
        name: input.name || "new-project",
        createdAt: new Date().toISOString(),
      };
      this.projects.set(id, project);
      return this.pick(project, selections, ["id", "name"]);
    }
    if (name === "projectDelete") {
      const id = args && args.id;
      const existed = this.projects.delete(id);
      return existed;
    }
    // Unknown field
    if (selections && selections.length) {
      const out = {};
      for (const sub of selections) out[sub.name] = null;
      return out;
    }
    return null;
  }

  resolveConnection(nodes, selections) {
    // selections may include edges { node { ... } }
    const result = {};
    for (const sel of selections) {
      if (sel.name === "edges") {
        const nodeSel = (sel.selections.find((s) => s.name === "node") || {}).selections || [];
        result.edges = nodes.map((n) => ({ node: this.pick(n, nodeSel, ["id", "name", "createdAt"]) }));
      } else if (sel.name === "pageInfo") {
        result.pageInfo = { hasNextPage: false, endCursor: null };
      }
    }
    if (!Object.keys(result).length) {
      result.edges = nodes.map((n) => ({ node: this.pick(n, [], ["id", "name"]) }));
    }
    return result;
  }

  // Return only the requested subfields (or the default set if none specified).
  pick(obj, selections, defaults) {
    const fields = selections && selections.length ? selections.map((s) => s.name) : defaults;
    const out = {};
    for (const f of fields) {
      out[f] = obj[f] !== undefined ? obj[f] : null;
    }
    return out;
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
      name: "railway",
      version: "2",
      protocol: "railway-graphql",
      documentation: "/docs/railway.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    // Railway also accepts a bare project/team token in Authorization.
    return typeof req.headers.authorization === "string" && req.headers.authorization.length > 0;
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
          this.send(res, 400, { errors: [{ message: "Invalid JSON body" }] });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { errors: [{ message: "Invalid JSON body" }] });
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
