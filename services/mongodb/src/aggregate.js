// Minimal aggregation pipeline engine for the parlel mongodb fake.
import {
  matchDocument, applyProjection, applySort, getPath, compareValues, valuesEqual, deepClone,
} from "./query.js";

function resolve(doc, expr) {
  if (typeof expr === "string" && expr.startsWith("$")) {
    const vals = getPath(doc, expr.slice(1));
    return vals.length ? vals[0] : undefined;
  }
  if (expr == null || typeof expr !== "object" || Array.isArray(expr) || expr instanceof Date) {
    return expr;
  }
  const op = Object.keys(expr)[0];
  if (!op || !op.startsWith("$")) {
    const out = {};
    for (const k of Object.keys(expr)) out[k] = resolve(doc, expr[k]);
    return out;
  }
  const raw = expr[op];
  const args = Array.isArray(raw) ? raw.map((a) => resolve(doc, a)) : resolve(doc, raw);
  switch (op) {
    case "$add": return args.reduce((s, x) => s + Number(x), 0);
    case "$subtract": return Number(args[0]) - Number(args[1]);
    case "$multiply": return args.reduce((s, x) => s * Number(x), 1);
    case "$divide": return Number(args[0]) / Number(args[1]);
    case "$mod": return Number(args[0]) % Number(args[1]);
    case "$concat": return args.join("");
    case "$toUpper": return String(args).toUpperCase();
    case "$toLower": return String(args).toLowerCase();
    case "$eq": return compareValues(args[0], args[1]) === 0;
    case "$ne": return compareValues(args[0], args[1]) !== 0;
    case "$gt": return compareValues(args[0], args[1]) > 0;
    case "$gte": return compareValues(args[0], args[1]) >= 0;
    case "$lt": return compareValues(args[0], args[1]) < 0;
    case "$lte": return compareValues(args[0], args[1]) <= 0;
    case "$cond": {
      if (Array.isArray(raw)) return resolve(doc, raw[0]) ? args[1] : args[2];
      return resolve(doc, raw.if) ? resolve(doc, raw.then) : resolve(doc, raw.else);
    }
    case "$ifNull": return args[0] != null ? args[0] : args[1];
    case "$size": return Array.isArray(args) ? args.length : 0;
    case "$year": return args instanceof Date ? args.getUTCFullYear() : null;
    case "$month": return args instanceof Date ? args.getUTCMonth() + 1 : null;
    case "$dayOfMonth": return args instanceof Date ? args.getUTCDate() : null;
    default: return undefined;
  }
}

function accumulate(op, spec, docs) {
  const vals = docs.map((d) => resolve(d, spec));
  switch (op) {
    case "$sum":
      if (spec === 1 || spec === true) return docs.length;
      return vals.reduce((s, x) => s + (Number(x) || 0), 0);
    case "$avg": {
      const nums = vals.map(Number).filter((n) => !Number.isNaN(n));
      return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
    }
    case "$min": return vals.reduce((m, x) => (m === null || compareValues(x, m) < 0 ? x : m), null);
    case "$max": return vals.reduce((m, x) => (m === null || compareValues(x, m) > 0 ? x : m), null);
    case "$first": return vals.length ? vals[0] : null;
    case "$last": return vals.length ? vals[vals.length - 1] : null;
    case "$push": return vals;
    case "$addToSet": {
      const out = [];
      for (const v of vals) if (!out.some((e) => valuesEqual(e, v))) out.push(v);
      return out;
    }
    case "$count": return docs.length;
    default: return null;
  }
}

export function runPipeline(collection, pipeline) {
  let docs = collection.map(deepClone);

  for (const stage of pipeline) {
    const op = Object.keys(stage)[0];
    const arg = stage[op];

    switch (op) {
      case "$match":
        docs = docs.filter((d) => matchDocument(d, arg));
        break;
      case "$project":
        docs = docs.map((d) => {
          // support computed fields too
          const computed = {};
          let hasComputed = false;
          for (const k of Object.keys(arg)) {
            if (arg[k] !== 0 && arg[k] !== 1 && arg[k] !== false && arg[k] !== true) {
              computed[k] = resolve(d, arg[k]);
              hasComputed = true;
            }
          }
          const simpleProj = {};
          for (const k of Object.keys(arg)) {
            if (arg[k] === 0 || arg[k] === 1 || arg[k] === false || arg[k] === true) simpleProj[k] = arg[k];
          }
          let out = Object.keys(simpleProj).length ? applyProjection(d, simpleProj) : (hasComputed ? { _id: d._id } : d);
          if (hasComputed) out = { ...out, ...computed };
          return out;
        });
        break;
      case "$sort":
        docs = applySort(docs, arg);
        break;
      case "$limit":
        docs = docs.slice(0, arg);
        break;
      case "$skip":
        docs = docs.slice(arg);
        break;
      case "$count":
        docs = [{ [arg]: docs.length }];
        break;
      case "$group": {
        const groups = new Map();
        const order = [];
        for (const d of docs) {
          const idVal = resolve(d, arg._id);
          const key = JSON.stringify(idVal ?? null);
          if (!groups.has(key)) {
            groups.set(key, { _idVal: idVal, docs: [] });
            order.push(key);
          }
          groups.get(key).docs.push(d);
        }
        docs = order.map((key) => {
          const g = groups.get(key);
          const out = { _id: g._idVal ?? null };
          for (const field of Object.keys(arg)) {
            if (field === "_id") continue;
            const accOp = Object.keys(arg[field])[0];
            out[field] = accumulate(accOp, arg[field][accOp], g.docs);
          }
          return out;
        });
        break;
      }
      case "$unwind": {
        const path = typeof arg === "string" ? arg.slice(1) : arg.path.slice(1);
        const out = [];
        for (const d of docs) {
          const vals = getPath(d, path);
          const arr = vals.length && Array.isArray(vals[0]) ? vals[0] : (vals.length ? [vals[0]] : []);
          for (const item of arr) {
            const clone = deepClone(d);
            setSimplePath(clone, path, item);
            out.push(clone);
          }
        }
        docs = out;
        break;
      }
      case "$addFields":
      case "$set": {
        docs = docs.map((d) => {
          const clone = deepClone(d);
          for (const k of Object.keys(arg)) setSimplePath(clone, k, resolve(d, arg[k]));
          return clone;
        });
        break;
      }
      case "$lookup": {
        // not supported across collections in this minimal engine; passthrough
        break;
      }
      default:
        break;
    }
  }
  return docs;
}

function setSimplePath(doc, path, value) {
  const parts = path.split(".");
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
