import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/new-relic — a tiny, dependency-free fake of New Relic.
//
// Implements:
//   * NerdGraph (POST /graphql) with a minimal *real* GraphQL dispatch:
//       - actor { user { name } }
//       - actor { account(id: N) { nrql(query: "...") { results } } }
//   * Insights event insert (POST /v1/accounts/:id/events)
//
// The GraphQL layer tokenizes + parses the incoming query into a field tree
// and resolves it against an in-memory model, so responses faithfully mirror
// the selection set the client asked for. State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

// ---------------------------------------------------------------------------
// Minimal GraphQL parser. Supports nested selection sets, field arguments
// (int, string, enum/ident), and ignores fragments/variables/aliases beyond
// what these queries need. Produces a tree of { name, args, selections }.
// ---------------------------------------------------------------------------
function tokenizeGraphQL(query) {
  const tokens = [];
  const re = /\s*(?:("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|([{}():,]))/g;
  let m;
  let lastIndex = 0;
  while ((m = re.exec(query)) !== null) {
    if (m.index !== lastIndex) {
      // skip non-matching whitespace handled by \s*; otherwise unknown char
    }
    if (m[1] !== undefined) tokens.push({ type: "string", value: JSON.parse(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: "name", value: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: "number", value: Number(m[3]) });
    else if (m[4] !== undefined) tokens.push({ type: "punct", value: m[4] });
    lastIndex = re.lastIndex;
  }
  return tokens;
}

function parseGraphQL(query) {
  const tokens = tokenizeGraphQL(query);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseArgs() {
    const args = {};
    if (!peek() || peek().value !== "(") return args;
    next(); // (
    while (peek() && peek().value !== ")") {
      const nameTok = next(); // arg name
      if (peek() && peek().value === ":") next(); // colon
      const valTok = next();
      args[nameTok.value] = valTok ? valTok.value : null;
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

  // Optional leading "query"/"mutation" keyword + operation name.
  if (peek() && peek().type === "name" && (peek().value === "query" || peek().value === "mutation")) {
    next();
    if (peek() && peek().type === "name") next(); // op name
    if (peek() && peek().value === "(") parseArgs(); // variable defs (ignored)
  }
  return parseSelectionSet();
}

export class NewRelicServer {
  constructor(port = 4878, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.user = { id: 1000001, name: "Parlel User", email: "parlel@parlel.dev" };
    this.accounts = new Map();
    this.accounts.set(1, { id: 1, name: "Parlel Account" });
    // Captured Insights events, keyed by account id.
    this.events = new Map();
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
    res.setHeader("Access-Control-Allow-Headers", "API-Key, Api-Key, X-Insert-Key, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-new-relic");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { errors: [{ message: "Invalid API key" }] });
    }

    // POST /graphql — NerdGraph
    if (parts[0] === "graphql" && req.method === "POST") {
      return this.handleGraphQL(res, body);
    }

    // POST /v1/accounts/:id/events — Insights insert
    if (parts[0] === "v1" && parts[1] === "accounts" && parts[3] === "events" && req.method === "POST") {
      const accountId = Number(parts[2]);
      const list = this.events.get(accountId) || [];
      const incoming = Array.isArray(body) ? body : [body];
      for (const ev of incoming) list.push(ev);
      this.events.set(accountId, list);
      return this.send(res, 200, { success: true });
    }

    return this.send(res, 404, { errors: [{ message: "Not Found" }] });
  }

  handleGraphQL(res, body) {
    const query = body && typeof body.query === "string" ? body.query : "";
    if (!query) {
      return this.send(res, 400, { errors: [{ message: "Missing query" }] });
    }
    let selections;
    try {
      selections = parseGraphQL(query);
    } catch (e) {
      return this.send(res, 200, { errors: [{ message: "Parse error: " + e.message }] });
    }
    const data = this.resolveSelections(selections, { root: true });
    return this.send(res, 200, { data });
  }

  // Resolve a selection set against the in-memory model.
  resolveSelections(selections, ctx) {
    const out = {};
    for (const field of selections) {
      out[field.name] = this.resolveField(field, ctx);
    }
    return out;
  }

  resolveField(field, ctx) {
    const { name, args, selections } = field;

    if (ctx.root && name === "actor") {
      return this.resolveSelections(selections, { actor: true });
    }
    if (ctx.actor && name === "user") {
      // Resolve only requested subfields.
      const userObj = {};
      for (const sub of selections.length ? selections : [{ name: "name" }]) {
        if (sub.name === "id") userObj.id = this.user.id;
        else if (sub.name === "name") userObj.name = this.user.name;
        else if (sub.name === "email") userObj.email = this.user.email;
      }
      return userObj;
    }
    if (ctx.actor && name === "account") {
      const accountId = Number(args.id);
      const account = this.accounts.get(accountId) || { id: accountId, name: `Account ${accountId}` };
      return this.resolveSelections(selections, { account, accountId });
    }
    if (ctx.account && name === "name") {
      return ctx.account.name;
    }
    if (ctx.account && name === "id") {
      return ctx.account.id;
    }
    if (ctx.account && name === "nrql") {
      const nrql = args.query || "";
      return this.resolveNrql(nrql, ctx.accountId, selections);
    }
    // Default: recurse or null.
    if (selections.length) return this.resolveSelections(selections, ctx);
    return null;
  }

  resolveNrql(nrqlQuery, accountId, selections) {
    const events = this.events.get(accountId) || [];
    // Deterministic synthetic result. If a COUNT is requested, return a count.
    const upper = nrqlQuery.toUpperCase();
    let results;
    if (upper.includes("COUNT(")) {
      results = [{ count: events.length }];
    } else {
      results = events.slice(0, 100).map((e) => ({ ...e }));
      if (results.length === 0) {
        results = [{ count: 0 }];
      }
    }
    const node = { results, query: nrqlQuery };
    // Only emit requested subfields if a selection set was provided.
    if (selections && selections.length) {
      const out = {};
      for (const sub of selections) {
        if (sub.name === "results") out.results = results;
        else if (sub.name === "query") out.query = nrqlQuery;
        else if (sub.name === "totalResult") out.totalResult = { count: events.length };
        else if (sub.name === "nrql") out.nrql = nrqlQuery;
      }
      if (Object.keys(out).length) return out;
    }
    return node;
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "events") {
      const all = {};
      for (const [k, v] of this.events) all[k] = v;
      return this.send(res, 200, { events: all });
    }
    return this.send(res, 404, { errors: [{ message: "not found" }] });
  }

  root() {
    return {
      name: "new-relic",
      version: "1",
      protocol: "nerdgraph",
      documentation: "/docs/new-relic.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const key = req.headers["api-key"] || req.headers["x-insert-key"];
    return typeof key === "string" && key.length > 0;
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
