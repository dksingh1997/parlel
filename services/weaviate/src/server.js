import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/weaviate — a tiny, dependency-free fake of the Weaviate REST + GraphQL
// API. Speaks enough of the wire protocol used by `weaviate-ts-client` /
// `weaviate-client` so application code can run against it with zero cost.
//
// Vectors are stored in memory and a REAL cosine-similarity nearest-neighbor
// search is implemented over them (via GraphQL Get { ... nearVector }).
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashOf(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

function uuid(seed) {
  const h = hashOf(`${seed}:${Date.now()}:${Math.random()}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

// Cosine similarity in [-1, 1].
function cosine(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

function wvError(message, status = 422) {
  return { error: [{ message }] };
}

// -------------------------------------------------------------------------
// Faithful Weaviate `where` filter parsing + evaluation.
// Grammar (inline GraphQL): where: { path:["field"], operator: Equal,
//   valueText/valueInt/valueNumber/valueBoolean: X } or
//   { operator: And|Or, operands: [ {...}, {...} ] }.
// -------------------------------------------------------------------------
function parseWhere(query) {
  const idx = query.indexOf("where:");
  const idx2 = idx === -1 ? query.indexOf("where :") : idx;
  if (idx2 === -1) return null;
  const braceStart = query.indexOf("{", idx2);
  if (braceStart === -1) return null;
  // Balance braces to extract the where object literal.
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < query.length; i++) {
    if (query[i] === "{") depth++;
    else if (query[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  return parseWhereLiteral(query.slice(braceStart, end + 1));
}

function parseWhereLiteral(text) {
  const opMatch = text.match(/operator\s*:\s*([A-Za-z]+)/);
  const operator = opMatch ? opMatch[1] : null;
  if (operator === "And" || operator === "Or") {
    const operands = [];
    // Find operands: [ {...}, {...} ]
    const opIdx = text.indexOf("operands");
    if (opIdx !== -1) {
      const arrStart = text.indexOf("[", opIdx);
      let depth = 0;
      let i = arrStart;
      let objStart = -1;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === "[") depth++;
        else if (c === "]") { depth--; if (depth === 0) break; }
        else if (c === "{") {
          if (depth === 1 && objStart === -1) objStart = i;
          let d2 = 0;
          for (let j = i; j < text.length; j++) {
            if (text[j] === "{") d2++;
            else if (text[j] === "}") { d2--; if (d2 === 0) { operands.push(parseWhereLiteral(text.slice(i, j + 1))); i = j; break; } }
          }
        }
      }
    }
    return { operator, operands };
  }
  const pathMatch = text.match(/path\s*:\s*\[([^\]]*)\]/);
  const path = pathMatch ? (pathMatch[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, "")) : [];
  let value;
  let vt;
  const vText = text.match(/valueText\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const vString = text.match(/valueString\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const vInt = text.match(/valueInt\s*:\s*(-?\d+)/);
  const vNum = text.match(/valueNumber\s*:\s*(-?\d+(?:\.\d+)?)/);
  const vBool = text.match(/valueBoolean\s*:\s*(true|false)/);
  if (vText) { value = vText[1]; vt = "text"; }
  else if (vString) { value = vString[1]; vt = "text"; }
  else if (vInt) { value = parseInt(vInt[1], 10); vt = "num"; }
  else if (vNum) { value = parseFloat(vNum[1]); vt = "num"; }
  else if (vBool) { value = vBool[1] === "true"; vt = "bool"; }
  return { operator, path, value, vt };
}

function evalWhere(properties, filter) {
  if (!filter) return true;
  if (filter.operator === "And") return (filter.operands || []).every((f) => evalWhere(properties, f));
  if (filter.operator === "Or") return (filter.operands || []).some((f) => evalWhere(properties, f));
  const field = filter.path && filter.path[0];
  if (!field) return true;
  const actual = properties ? properties[field] : undefined;
  const v = filter.value;
  switch (filter.operator) {
    case "Equal": return actual === v;
    case "NotEqual": return actual !== v;
    case "GreaterThan": return actual > v;
    case "GreaterThanEqual": return actual >= v;
    case "LessThan": return actual < v;
    case "LessThanEqual": return actual <= v;
    case "Like": return typeof actual === "string" && likeMatch(actual, String(v));
    case "ContainsAny": return Array.isArray(actual) ? actual.includes(v) : actual === v;
    default: return true;
  }
}

function likeMatch(actual, pattern) {
  // Weaviate Like uses * wildcard; translate to a regex.
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return re.test(actual);
}

export class WeaviateServer {
  constructor(port = 4859, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    // Weaviate auth is optional and accepts any bearer (anonymous access allowed).
    this.requireAuth = options.requireAuth === true;
    this.server = null;
    this.reset();
  }

  reset() {
    this.classes = new Map(); // className -> class definition
    this.objects = new Map(); // id -> object { class, id, properties, vector }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, wvError(error.message || "Internal server error", 500));
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-weaviate");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      const body = await this.readBody(req, res);
      if (body === SENTINEL_BAD_JSON) return;
      return this.handleControl(req, res, parts);
    }

    if (parts[0] !== "v1") return this.send(res, 404, wvError("not found", 404));

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, wvError("anonymous access not enabled", 401));
    }

    const route = parts.slice(1);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    // Liveness/readiness
    if (req.method === "GET" && route[0] === "meta") {
      return this.send(res, 200, { hostname: `http://${this.host}:${this.port}`, version: "1.24.0-parlel", modules: {} });
    }
    if (req.method === "GET" && (route[0] === ".well-known")) {
      return this.send(res, 200, { status: "ok" });
    }

    // Schema
    if (route[0] === "schema") return this.handleSchema(req, res, route, body);

    // Objects
    if (route[0] === "objects") return this.handleObjects(req, res, route, body);

    // GraphQL
    if (req.method === "POST" && route[0] === "graphql") return this.handleGraphql(res, body);

    return this.send(res, 404, wvError("not found", 404));
  }

  // -------------------------------------------------------------------------
  // Schema: POST /v1/schema, GET /v1/schema, GET/DELETE /v1/schema/:className
  // -------------------------------------------------------------------------
  handleSchema(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, { classes: Array.from(this.classes.values()) });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.class !== "string" || !body.class) {
          return this.send(res, 422, wvError("class name is required"));
        }
        const def = {
          class: body.class,
          description: body.description || "",
          vectorizer: body.vectorizer || "none",
          properties: Array.isArray(body.properties) ? body.properties : [],
        };
        this.classes.set(def.class, def);
        return this.send(res, 200, def);
      }
      return this.send(res, 405, wvError("method not allowed", 405));
    }
    // /v1/schema/:className
    const className = route[1];
    if (req.method === "GET") {
      const def = this.classes.get(className);
      if (!def) return this.send(res, 404, wvError("class not found", 404));
      return this.send(res, 200, def);
    }
    if (req.method === "DELETE") {
      this.classes.delete(className);
      for (const [id, obj] of this.objects) if (obj.class === className) this.objects.delete(id);
      return this.send(res, 200, null);
    }
    return this.send(res, 405, wvError("method not allowed", 405));
  }

  // -------------------------------------------------------------------------
  // Objects: POST /v1/objects, GET/DELETE /v1/objects/:className/:id
  // -------------------------------------------------------------------------
  handleObjects(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.class !== "string" || !body.class) {
          return this.send(res, 422, wvError("class is required"));
        }
        const id = typeof body.id === "string" && body.id ? body.id : uuid(JSON.stringify(body.properties || {}));
        const obj = {
          class: body.class,
          id,
          properties: isPlainObject(body.properties) ? body.properties : {},
          vector: Array.isArray(body.vector) ? body.vector.map(Number) : undefined,
          creationTimeUnix: Date.now(),
          lastUpdateTimeUnix: Date.now(),
        };
        this.objects.set(id, obj);
        return this.send(res, 200, this.viewObject(obj));
      }
      if (req.method === "GET") {
        return this.send(res, 200, {
          objects: Array.from(this.objects.values()).map((o) => this.viewObject(o)),
          totalResults: this.objects.size,
        });
      }
      return this.send(res, 405, wvError("method not allowed", 405));
    }

    // /v1/objects/:className/:id
    if (route.length === 3) {
      const [, className, id] = route;
      const obj = this.objects.get(id);
      if (!obj || obj.class !== className) return this.send(res, 404, wvError("object not found", 404));
      if (req.method === "GET") return this.send(res, 200, this.viewObject(obj));
      if (req.method === "DELETE") {
        this.objects.delete(id);
        return this.send(res, 204, null);
      }
      if (req.method === "PUT") {
        if (isPlainObject(body)) {
          if (isPlainObject(body.properties)) obj.properties = body.properties;
          if (Array.isArray(body.vector)) obj.vector = body.vector.map(Number);
          obj.lastUpdateTimeUnix = Date.now();
        }
        return this.send(res, 200, this.viewObject(obj));
      }
      return this.send(res, 405, wvError("method not allowed", 405));
    }

    // /v1/objects/:id (no class)
    if (route.length === 2) {
      const id = route[1];
      const obj = this.objects.get(id);
      if (!obj) return this.send(res, 404, wvError("object not found", 404));
      if (req.method === "GET") return this.send(res, 200, this.viewObject(obj));
      if (req.method === "DELETE") {
        this.objects.delete(id);
        return this.send(res, 204, null);
      }
    }

    return this.send(res, 404, wvError("not found", 404));
  }

  viewObject(o) {
    return {
      class: o.class,
      id: o.id,
      properties: o.properties,
      vector: o.vector,
      creationTimeUnix: o.creationTimeUnix,
      lastUpdateTimeUnix: o.lastUpdateTimeUnix,
    };
  }

  // -------------------------------------------------------------------------
  // GraphQL: POST /v1/graphql — supports Get { Class(nearVector:{...}) {...} }
  // -------------------------------------------------------------------------
  handleGraphql(res, body) {
    const query = isPlainObject(body) ? body.query : null;
    if (typeof query !== "string" || !query) {
      return this.send(res, 200, { data: null, errors: [{ message: "query is required" }] });
    }

    // Only "Get" queries are implemented.
    const getMatch = query.match(/Get\s*\{([\s\S]*)\}\s*\}?\s*$/);
    if (!/\bGet\b/.test(query)) {
      return this.send(res, 200, { data: { Get: {} } });
    }

    // Identify the class name following Get {
    const classMatch = query.match(/Get\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (!classMatch) return this.send(res, 200, { data: { Get: {} } });
    const className = classMatch[1];

    // Parse nearVector { vector: [ ... ] }
    let queryVector = null;
    const nv = query.match(/nearVector\s*:\s*\{[\s\S]*?vector\s*:\s*\[([^\]]*)\]/);
    if (nv) {
      queryVector = nv[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    }

    // Parse bm25 { query: "..." [, properties: ["a","b"]] }
    let bm25 = null;
    const bm = query.match(/bm25\s*:\s*\{([\s\S]*?)\}/);
    if (bm) {
      const qm = bm[1].match(/query\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const pm = bm[1].match(/properties\s*:\s*\[([^\]]*)\]/);
      bm25 = {
        terms: qm ? qm[1].toLowerCase().split(/\s+/).filter(Boolean) : [],
        properties: pm ? pm[1].match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) || null : null,
      };
    }

    // Parse where { ... } (faithful Weaviate filter grammar).
    const whereFilter = parseWhere(query);

    // Parse limit
    let limit = Infinity;
    const lm = query.match(/limit\s*:\s*(\d+)/);
    if (lm) limit = parseInt(lm[1], 10);

    // Parse requested fields inside the class block.
    const fieldsBlock = query.match(new RegExp(`${className}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*)`));
    const wantId = /_additional\s*\{[^}]*\bid\b/.test(query) || /\bid\b/.test(query);
    const wantDistance = /_additional\s*\{[^}]*\bdistance\b/.test(query);
    const wantCertainty = /_additional\s*\{[^}]*\bcertainty\b/.test(query);
    const wantScore = /_additional\s*\{[^}]*\bscore\b/.test(query);
    // Extract plain property names (best-effort): words inside the block excluding keywords.
    const propNames = new Set();
    if (fieldsBlock) {
      const inner = fieldsBlock[1];
      const tokens = inner.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      const skip = new Set(["_additional", "id", "distance", "certainty", "vector"]);
      for (const t of tokens) if (!skip.has(t)) propNames.add(t);
    }

    let items = Array.from(this.objects.values()).filter((o) => o.class === className);

    // Apply where filter (affects all search modes).
    if (whereFilter) items = items.filter((o) => evalWhere(o.properties, whereFilter));

    if (queryVector && queryVector.length) {
      items = items
        .filter((o) => Array.isArray(o.vector))
        .map((o) => {
          const sim = cosine(queryVector, o.vector);
          // Weaviate cosine distance = 1 - cosine_similarity; certainty = (sim+1)/2.
          return { obj: o, distance: 1 - sim, certainty: (sim + 1) / 2 };
        })
        .sort((a, b) => a.distance - b.distance);
    } else if (bm25) {
      // Keyword BM25-style scoring: rank by summed term frequency across
      // the requested (or all string) properties. Non-matching docs drop out.
      items = items
        .map((o) => {
          const fields = bm25.properties || Object.keys(o.properties);
          const text = fields
            .map((f) => (typeof o.properties[f] === "string" ? o.properties[f] : ""))
            .join(" ")
            .toLowerCase();
          let score = 0;
          for (const term of bm25.terms) {
            const matches = text.split(term).length - 1;
            score += matches;
          }
          return { obj: o, distance: null, certainty: null, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
    } else {
      items = items.map((o) => ({ obj: o, distance: null, certainty: null }));
    }

    if (Number.isFinite(limit)) items = items.slice(0, limit);

    const rows = items.map(({ obj, distance, certainty, score }) => {
      const row = {};
      // Include requested properties (or all if none parsed).
      const props = propNames.size ? Array.from(propNames) : Object.keys(obj.properties);
      for (const p of props) {
        if (p in obj.properties) row[p] = obj.properties[p];
      }
      const additional = {};
      if (wantId) additional.id = obj.id;
      if (wantDistance) additional.distance = distance;
      if (wantCertainty) additional.certainty = certainty;
      if (wantScore && score !== undefined) additional.score = String(score);
      if (Object.keys(additional).length) row._additional = additional;
      return row;
    });

    return this.send(res, 200, { data: { Get: { [className]: rows } } });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "objects") {
      return this.send(res, 200, {
        objects: Array.from(this.objects.values()).map((o) => this.viewObject(o)),
        count: this.objects.size,
      });
    }
    return this.send(res, 404, wvError("not found", 404));
  }

  root() {
    return { name: "weaviate", version: "1", protocol: "weaviate-v1", documentation: "/docs/weaviate.md" };
  }

  isAuthorized(req) {
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, wvError("invalid JSON body", 400));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, wvError("invalid JSON body", 400));
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
