// MongoDB query/update/projection engine for the parlel mongodb fake.
// Implements the operator subset the official driver and common app code rely on.

import { ObjectId, Long, Int32, Double, MinKey, MaxKey, Binary } from "./bson.js";

// ---- BSON-aware value comparison & equality ----

function typeRank(v) {
  if (v === null || v === undefined) return 1;
  if (v instanceof MinKey) return 0;
  if (v instanceof MaxKey) return 100;
  if (typeof v === "number" || v instanceof Long || v instanceof Int32 || v instanceof Double) return 10;
  if (typeof v === "string") return 15;
  if (typeof v === "boolean") return 25;
  if (v instanceof Date) return 30;
  if (v instanceof ObjectId) return 35;
  if (Array.isArray(v)) return 40;
  if (Buffer.isBuffer(v) || v instanceof Binary) return 45;
  if (typeof v === "object") return 20;
  return 50;
}

function numericValue(v) {
  if (typeof v === "number") return v;
  if (v instanceof Long) return Number(v.value);
  if (v instanceof Int32) return v.value;
  if (v instanceof Double) return v.value;
  return null;
}

export function compareValues(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;

  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) {
    return na < nb ? -1 : na > nb ? 1 : 0;
  }

  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime() < 0 ? -1 : a.getTime() === b.getTime() ? 0 : 1;
  }
  if (a instanceof ObjectId && b instanceof ObjectId) {
    return Buffer.compare(a.id, b.id);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const c = compareValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return 0;
}

export function valuesEqual(a, b) {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof ObjectId || b instanceof ObjectId) {
    if (a instanceof ObjectId && typeof b === "string") return a.toHexString() === b;
    if (b instanceof ObjectId && typeof a === "string") return b.toHexString() === a;
    return false;
  }
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) return na === nb;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object" &&
      !Array.isArray(a) && !Array.isArray(b) && !(a instanceof Date) && !(b instanceof Date)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => valuesEqual(a[k], b[k]));
  }
  return a === b;
}

// ---- Path access (supports dotted paths and arrays) ----

export function getPath(doc, path) {
  const parts = path.split(".");
  let current = [doc];
  for (const part of parts) {
    const next = [];
    for (const c of current) {
      if (c == null) continue;
      if (Array.isArray(c)) {
        if (/^\d+$/.test(part)) {
          if (c[Number(part)] !== undefined) next.push(c[Number(part)]);
        } else {
          for (const el of c) {
            if (el && typeof el === "object" && !Array.isArray(el) && part in el) {
              next.push(el[part]);
            }
          }
        }
      } else if (typeof c === "object" && part in c) {
        next.push(c[part]);
      }
    }
    current = next;
  }
  return current;
}

function setPath(doc, path, value) {
  const parts = path.split(".");
  let current = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] == null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function unsetPath(doc, path) {
  const parts = path.split(".");
  let current = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== "object") return;
    current = current[parts[i]];
  }
  delete current[parts[parts.length - 1]];
}

// ---- Filter matching ----

export function matchDocument(doc, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;

  for (const key of Object.keys(filter)) {
    const condition = filter[key];

    if (key === "$and") {
      if (!condition.every((sub) => matchDocument(doc, sub))) return false;
      continue;
    }
    if (key === "$or") {
      if (!condition.some((sub) => matchDocument(doc, sub))) return false;
      continue;
    }
    if (key === "$nor") {
      if (condition.some((sub) => matchDocument(doc, sub))) return false;
      continue;
    }
    if (key === "$expr") {
      if (!evalExpr(doc, condition)) return false;
      continue;
    }
    if (key === "$text" || key === "$where" || key === "$comment") {
      continue;
    }

    const values = getPath(doc, key);
    if (!matchCondition(values, condition, doc)) return false;
  }
  return true;
}

function matchCondition(values, condition, doc) {
  // condition is either a literal (equality) or an operator object
  if (isOperatorObject(condition)) {
    for (const op of Object.keys(condition)) {
      if (!matchOperator(values, op, condition[op], condition, doc)) return false;
    }
    return true;
  }
  // direct equality (array contains OR direct equal)
  return valueMatchesEquality(values, condition);
}

function valueMatchesEquality(values, target) {
  for (const v of values) {
    if (valuesEqual(v, target)) return true;
    if (Array.isArray(v) && v.some((el) => valuesEqual(el, target))) return true;
  }
  if (values.length === 0 && target === null) return true;
  return false;
}

function isOperatorObject(obj) {
  if (obj == null || typeof obj !== "object") return false;
  if (Array.isArray(obj) || obj instanceof ObjectId || obj instanceof Date ||
      obj instanceof Long || obj instanceof Int32 || obj instanceof Double ||
      Buffer.isBuffer(obj) || obj instanceof Binary) return false;
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

function matchOperator(values, op, operand, condition, doc) {
  switch (op) {
    case "$eq":
      return valueMatchesEquality(values, operand);
    case "$ne":
      return !valueMatchesEquality(values, operand);
    case "$gt":
      return values.some((v) => compareValues(v, operand) > 0);
    case "$gte":
      return values.some((v) => compareValues(v, operand) >= 0);
    case "$lt":
      return values.some((v) => compareValues(v, operand) < 0);
    case "$lte":
      return values.some((v) => compareValues(v, operand) <= 0);
    case "$in":
      return values.some((v) =>
        operand.some((o) => valuesEqual(v, o) || (Array.isArray(v) && v.some((e) => valuesEqual(e, o))))
      );
    case "$nin":
      return !values.some((v) =>
        operand.some((o) => valuesEqual(v, o) || (Array.isArray(v) && v.some((e) => valuesEqual(e, o))))
      );
    case "$exists": {
      const exists = values.length > 0;
      return operand ? exists : !exists;
    }
    case "$type":
      return values.some((v) => matchType(v, operand));
    case "$regex": {
      const re = operand instanceof RegExp
        ? operand
        : new RegExp(operand, condition.$options || "");
      return values.some((v) => typeof v === "string" && re.test(v));
    }
    case "$options":
      return true;
    case "$mod":
      return values.some((v) => {
        const n = numericValue(v);
        return n !== null && n % operand[0] === operand[1];
      });
    case "$all":
      return operand.every((o) =>
        values.some((v) => valuesEqual(v, o) || (Array.isArray(v) && v.some((e) => valuesEqual(e, o))))
      );
    case "$size":
      return values.some((v) => Array.isArray(v) && v.length === operand);
    case "$elemMatch":
      return values.some(
        (v) => Array.isArray(v) && v.some((el) => {
          if (isOperatorObject(operand)) return matchCondition([el], operand, doc);
          return matchDocument(el, operand);
        })
      );
    case "$not": {
      if (operand instanceof RegExp) {
        return !values.some((v) => typeof v === "string" && operand.test(v));
      }
      return !matchCondition(values, operand, doc);
    }
    default:
      return false;
  }
}

function matchType(v, type) {
  const map = {
    double: () => typeof v === "number" && !Number.isInteger(v),
    string: () => typeof v === "string",
    object: () => v && typeof v === "object" && !Array.isArray(v),
    array: () => Array.isArray(v),
    bool: () => typeof v === "boolean",
    date: () => v instanceof Date,
    null: () => v === null,
    objectId: () => v instanceof ObjectId,
    int: () => typeof v === "number" && Number.isInteger(v),
    long: () => v instanceof Long,
    number: () => numericValue(v) !== null,
  };
  const numMap = {
    1: "double", 2: "string", 3: "object", 4: "array", 7: "objectId",
    8: "bool", 9: "date", 10: "null", 16: "int", 18: "long",
  };
  const name = typeof type === "number" ? numMap[type] : type;
  return map[name] ? map[name]() : false;
}

// ---- $expr evaluation (subset) ----

function evalExpr(doc, expr) {
  const v = evalExprValue(doc, expr);
  return !!v;
}

function evalExprValue(doc, expr) {
  if (typeof expr === "string" && expr.startsWith("$")) {
    const vals = getPath(doc, expr.slice(1));
    return vals.length ? vals[0] : undefined;
  }
  if (expr == null || typeof expr !== "object" || Array.isArray(expr)) return expr;

  const op = Object.keys(expr)[0];
  const args = expr[op];
  const a = Array.isArray(args) ? args.map((x) => evalExprValue(doc, x)) : evalExprValue(doc, args);

  switch (op) {
    case "$eq": return compareValues(a[0], a[1]) === 0;
    case "$ne": return compareValues(a[0], a[1]) !== 0;
    case "$gt": return compareValues(a[0], a[1]) > 0;
    case "$gte": return compareValues(a[0], a[1]) >= 0;
    case "$lt": return compareValues(a[0], a[1]) < 0;
    case "$lte": return compareValues(a[0], a[1]) <= 0;
    case "$and": return a.every(Boolean);
    case "$or": return a.some(Boolean);
    case "$not": return !a[0];
    case "$add": return a.reduce((s, x) => s + numericValue(x), 0);
    case "$subtract": return numericValue(a[0]) - numericValue(a[1]);
    case "$multiply": return a.reduce((s, x) => s * numericValue(x), 1);
    case "$divide": return numericValue(a[0]) / numericValue(a[1]);
    case "$mod": return numericValue(a[0]) % numericValue(a[1]);
    default: return undefined;
  }
}

// ---- Projection ----

export function applyProjection(doc, projection) {
  if (!projection || Object.keys(projection).length === 0) return doc;

  const keys = Object.keys(projection).filter((k) => k !== "_id");
  const includeMode = keys.some((k) => isTruthy(projection[k]));

  const result = {};

  if (includeMode) {
    for (const key of Object.keys(projection)) {
      if (key === "_id") continue;
      if (isTruthy(projection[key])) {
        const vals = getPath(doc, key);
        if (vals.length > 0) setPath(result, key, vals[0]);
      }
    }
    // _id included by default unless explicitly excluded
    if (!("_id" in projection) || isTruthy(projection._id)) {
      if ("_id" in doc) result._id = doc._id;
    }
  } else {
    Object.assign(result, deepClone(doc));
    for (const key of Object.keys(projection)) {
      if (!isTruthy(projection[key])) {
        unsetPath(result, key);
      }
    }
  }
  return result;
}

function isTruthy(v) {
  return v === 1 || v === true || v === "1";
}

// ---- Sort ----

export function applySort(docs, sort) {
  if (!sort || Object.keys(sort).length === 0) return docs;
  const keys = Object.keys(sort);
  return [...docs].sort((a, b) => {
    for (const key of keys) {
      const dir = numericValue(sort[key]) < 0 ? -1 : 1;
      const av = getPath(a, key);
      const bv = getPath(b, key);
      const avv = av.length ? av[0] : null;
      const bvv = bv.length ? bv[0] : null;
      const c = compareValues(avv, bvv);
      if (c !== 0) return c * dir;
    }
    return 0;
  });
}

// ---- Update operators ----

export function applyUpdate(doc, update, isUpsert = false) {
  const hasOperators = Object.keys(update).some((k) => k.startsWith("$"));

  if (!hasOperators) {
    // full replacement, keep _id
    const id = doc._id;
    for (const k of Object.keys(doc)) delete doc[k];
    Object.assign(doc, deepClone(update));
    if (!("_id" in doc) && id !== undefined) doc._id = id;
    return doc;
  }

  for (const op of Object.keys(update)) {
    const fields = update[op];
    switch (op) {
      case "$set":
        for (const path of Object.keys(fields)) setPath(doc, path, deepClone(fields[path]));
        break;
      case "$unset":
        for (const path of Object.keys(fields)) unsetPath(doc, path);
        break;
      case "$inc":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          const base = cur.length ? numericValue(cur[0]) || 0 : 0;
          setPath(doc, path, base + numericValue(fields[path]));
        }
        break;
      case "$mul":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          const base = cur.length ? numericValue(cur[0]) || 0 : 0;
          setPath(doc, path, base * numericValue(fields[path]));
        }
        break;
      case "$min":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          if (!cur.length || compareValues(fields[path], cur[0]) < 0) setPath(doc, path, fields[path]);
        }
        break;
      case "$max":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          if (!cur.length || compareValues(fields[path], cur[0]) > 0) setPath(doc, path, fields[path]);
        }
        break;
      case "$rename":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          if (cur.length) {
            setPath(doc, fields[path], cur[0]);
            unsetPath(doc, path);
          }
        }
        break;
      case "$setOnInsert":
        if (isUpsert) {
          for (const path of Object.keys(fields)) setPath(doc, path, deepClone(fields[path]));
        }
        break;
      case "$currentDate":
        for (const path of Object.keys(fields)) setPath(doc, path, new Date());
        break;
      case "$push":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          let arr = cur.length && Array.isArray(cur[0]) ? cur[0] : [];
          if (!cur.length || !Array.isArray(cur[0])) setPath(doc, path, arr);
          const spec = fields[path];
          if (spec && typeof spec === "object" && "$each" in spec) {
            let toPush = spec.$each.slice();
            if ("$sort" in spec) toPush = applySort(toPush, typeof spec.$sort === "object" ? spec.$sort : {});
            arr.push(...toPush);
            if ("$slice" in spec) {
              if (spec.$slice >= 0) arr.splice(spec.$slice);
              else setPath(doc, path, arr.slice(spec.$slice));
            }
          } else {
            arr.push(spec);
          }
        }
        break;
      case "$addToSet":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          let arr = cur.length && Array.isArray(cur[0]) ? cur[0] : [];
          if (!cur.length || !Array.isArray(cur[0])) setPath(doc, path, arr);
          const spec = fields[path];
          const toAdd = spec && typeof spec === "object" && "$each" in spec ? spec.$each : [spec];
          for (const item of toAdd) {
            if (!arr.some((e) => valuesEqual(e, item))) arr.push(item);
          }
        }
        break;
      case "$pull":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          if (cur.length && Array.isArray(cur[0])) {
            const cond = fields[path];
            const filtered = cur[0].filter((el) => {
              if (isOperatorObject(cond)) return !matchCondition([el], cond, doc);
              if (cond && typeof cond === "object" && !Array.isArray(cond)) return !matchDocument(el, cond);
              return !valuesEqual(el, cond);
            });
            setPath(doc, path, filtered);
          }
        }
        break;
      case "$pullAll":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          if (cur.length && Array.isArray(cur[0])) {
            const filtered = cur[0].filter((el) => !fields[path].some((x) => valuesEqual(el, x)));
            setPath(doc, path, filtered);
          }
        }
        break;
      case "$pop":
        for (const path of Object.keys(fields)) {
          const cur = getPath(doc, path);
          if (cur.length && Array.isArray(cur[0])) {
            if (fields[path] === -1) cur[0].shift();
            else cur[0].pop();
          }
        }
        break;
      default:
        break;
    }
  }
  return doc;
}

export function deepClone(value) {
  if (value == null) return value;
  if (value instanceof ObjectId) return new ObjectId(value.id);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Long) return new Long(value.value);
  if (value instanceof Int32) return new Int32(value.value);
  if (value instanceof Double) return new Double(value.value);
  if (value instanceof MinKey) return new MinKey();
  if (value instanceof MaxKey) return new MaxKey();
  if (value instanceof Binary) return new Binary(Buffer.from(value.buffer), value.subType);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(deepClone);
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
    return out;
  }
  return value;
}
