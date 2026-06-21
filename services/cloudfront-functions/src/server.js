// parlel/cloudfront-functions — a lightweight, dependency-free fake of the
// AWS CloudFront Functions control plane plus CloudFront KeyValueStore.
//
// Control plane speaks REST/XML (API version 2020-05-31): functions are created
// at POST /2020-05-31/function, published, described, tested. KeyValueStores
// are managed under /2020-05-31/key-value-store, and a simple data-plane
// key/value put/get is exposed per store. State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";

const NAMESPACE = "http://cloudfront.amazonaws.com/doc/2020-05-31/";
const API_VERSION = "2020-05-31";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  InvalidArgument: 400,
  NoSuchFunctionExists: 404,
  FunctionAlreadyExists: 409,
  NoSuchResource: 404,
  EntityAlreadyExists: 409,
  EntityNotFound: 404,
  InternalError: 500,
};

class CffError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

export class CloudfrontFunctionsServer {
  constructor(port = 4713, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.functions = new Map(); // name -> fn
    this.keyValueStores = new Map(); // name -> store
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new CffError("InternalError", error.message, 500));
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
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "cloudfront-functions",
        functions: this.functions.size,
        keyValueStores: this.keyValueStores.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-cloudfront-functions");

    const body = (await this.readBody(req)).toString("utf8");
    try {
      return this.route(method, path, body, res);
    } catch (error) {
      if (error instanceof CffError) return this.sendError(res, error);
      throw error;
    }
  }

  parseJson(body) {
    try {
      return body.length ? JSON.parse(body) : {};
    } catch {
      return null;
    }
  }

  route(method, path, body, res) {
    const base = `/${API_VERSION}`;
    if (!path.startsWith(base)) {
      throw new CffError("InvalidArgument", `Unknown path ${path}`, 404);
    }
    const sub = path.slice(base.length);

    // test-function
    if (sub === "/test-function" && method === "POST") {
      return this.testFunction(body, res);
    }

    // /function
    if (sub === "/function") {
      if (method === "POST") return this.createFunction(body, res);
      if (method === "GET") return this.listFunctions(res);
    }

    // /function/{name}/publish
    const publishMatch = sub.match(/^\/function\/([^/]+)\/publish$/);
    if (publishMatch && method === "POST") {
      return this.publishFunction(decodeURIComponent(publishMatch[1]), res);
    }

    // /function/{name}
    const fnMatch = sub.match(/^\/function\/([^/]+)$/);
    if (fnMatch) {
      const name = decodeURIComponent(fnMatch[1]);
      if (method === "GET") return this.describeFunction(name, res);
      if (method === "DELETE") return this.deleteFunction(name, res);
    }

    // /key-value-store/{name}/keys/{key}  (data plane)
    const kvKeyMatch = sub.match(/^\/key-value-store\/([^/]+)\/keys\/([^/]+)$/);
    if (kvKeyMatch) {
      const storeName = decodeURIComponent(kvKeyMatch[1]);
      const key = decodeURIComponent(kvKeyMatch[2]);
      if (method === "PUT") return this.putKey(storeName, key, body, res);
      if (method === "GET") return this.getKey(storeName, key, res);
      if (method === "DELETE") return this.deleteKey(storeName, key, res);
    }

    // /key-value-store/{name}/keys  (data plane list)
    const kvKeysMatch = sub.match(/^\/key-value-store\/([^/]+)\/keys$/);
    if (kvKeysMatch && method === "GET") {
      return this.listKeys(decodeURIComponent(kvKeysMatch[1]), res);
    }

    // /key-value-store
    if (sub === "/key-value-store") {
      if (method === "POST") return this.createKeyValueStore(body, res);
      if (method === "GET") return this.listKeyValueStores(res);
    }

    throw new CffError("InvalidArgument", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------
  createFunction(body, res) {
    // Accept JSON ({ Name, FunctionConfig, FunctionCode }) or XML.
    const json = this.parseJson(body);
    let name, comment, runtime, code;
    if (json && json.Name) {
      name = json.Name;
      comment = (json.FunctionConfig && json.FunctionConfig.Comment) || "";
      runtime = (json.FunctionConfig && json.FunctionConfig.Runtime) || "cloudfront-js-2.0";
      code = json.FunctionCode || "";
    } else {
      name = tagText(body, "Name");
      comment = tagText(body, "Comment") || "";
      runtime = tagText(body, "Runtime") || "cloudfront-js-2.0";
      code = tagText(body, "FunctionCode") || "";
    }
    if (!name) throw new CffError("InvalidArgument", "Name is required");
    if (this.functions.has(name)) {
      throw new CffError("FunctionAlreadyExists", `Function ${name} already exists`, 409);
    }
    const etag = randomBytes(7).toString("hex").toUpperCase();
    const arn = `arn:aws:cloudfront::${this.accountId}:function/${name}`;
    const fn = {
      name,
      arn,
      etag,
      comment,
      runtime,
      code,
      stage: "DEVELOPMENT",
      status: "UNPUBLISHED",
      createdTime: new Date().toISOString(),
      lastModifiedTime: new Date().toISOString(),
    };
    this.functions.set(name, fn);
    res.setHeader("ETag", etag);
    res.setHeader(
      "Location",
      `https://cloudfront.amazonaws.com/${API_VERSION}/function/${encodeURIComponent(name)}`,
    );
    const xml = `<FunctionSummary xmlns="${NAMESPACE}">${this.fnSummaryInner(fn)}</FunctionSummary>`;
    return this.sendXml(res, 201, xml);
  }

  fnSummaryInner(fn) {
    return (
      `<Name>${xmlEscape(fn.name)}</Name>` +
      `<FunctionConfig><Comment>${xmlEscape(fn.comment)}</Comment><Runtime>${fn.runtime}</Runtime></FunctionConfig>` +
      `<FunctionMetadata>` +
      `<FunctionARN>${fn.arn}</FunctionARN>` +
      `<Stage>${fn.stage}</Stage>` +
      `<CreatedTime>${fn.createdTime}</CreatedTime>` +
      `<LastModifiedTime>${fn.lastModifiedTime}</LastModifiedTime>` +
      `</FunctionMetadata>` +
      `<Status>${fn.status}</Status>`
    );
  }

  listFunctions(res) {
    const items = [...this.functions.values()]
      .map((f) => `<FunctionSummary>${this.fnSummaryInner(f)}</FunctionSummary>`)
      .join("");
    const xml =
      `<FunctionList xmlns="${NAMESPACE}">` +
      `<MaxItems>100</MaxItems><Quantity>${this.functions.size}</Quantity>` +
      `<Items>${items}</Items>` +
      `</FunctionList>`;
    return this.sendXml(res, 200, xml);
  }

  requireFunction(name) {
    const fn = this.functions.get(name);
    if (!fn) {
      throw new CffError("NoSuchFunctionExists", `Function ${name} does not exist`, 404);
    }
    return fn;
  }

  describeFunction(name, res) {
    const fn = this.requireFunction(name);
    res.setHeader("ETag", fn.etag);
    const xml = `<DescribeFunctionResult xmlns="${NAMESPACE}"><FunctionSummary>${this.fnSummaryInner(fn)}</FunctionSummary></DescribeFunctionResult>`;
    return this.sendXml(res, 200, xml);
  }

  publishFunction(name, res) {
    const fn = this.requireFunction(name);
    fn.stage = "LIVE";
    fn.status = "DEPLOYED";
    fn.lastModifiedTime = new Date().toISOString();
    const xml = `<PublishFunctionResult xmlns="${NAMESPACE}"><FunctionSummary>${this.fnSummaryInner(fn)}</FunctionSummary></PublishFunctionResult>`;
    return this.sendXml(res, 200, xml);
  }

  deleteFunction(name, res) {
    this.requireFunction(name);
    this.functions.delete(name);
    res.statusCode = 204;
    res.end();
  }

  testFunction(body, res) {
    const json = this.parseJson(body);
    let name, eventObject;
    if (json && json.Name) {
      name = json.Name;
      eventObject = json.EventObject;
    } else {
      name = tagText(body, "Name");
      eventObject = tagText(body, "EventObject");
    }
    const fn = this.requireFunction(name);
    // Best-effort execution: try to run the function with a synthetic event.
    let output;
    let errorMsg = "";
    try {
      let event = {};
      if (eventObject) {
        try {
          event = JSON.parse(eventObject);
        } catch {
          event = {};
        }
      }
      if (!event.request) {
        event.request = { uri: "/", method: "GET", headers: {}, querystring: {} };
      }
      // Run the code in a sandboxed Function; handler is named `handler`.
      const runner = new Function(
        "event",
        `${fn.code}\nif (typeof handler === 'function') { return handler(event); } return event.request;`,
      );
      const result = runner(event);
      output = JSON.stringify(result);
    } catch (err) {
      errorMsg = String(err && err.message ? err.message : err);
      output = JSON.stringify({});
    }
    const xml =
      `<TestFunctionResult xmlns="${NAMESPACE}">` +
      `<TestResult>` +
      `<FunctionSummary>${this.fnSummaryInner(fn)}</FunctionSummary>` +
      `<ComputeUtilization>15</ComputeUtilization>` +
      `<FunctionExecutionLogs/>` +
      `<FunctionErrorMessage>${xmlEscape(errorMsg)}</FunctionErrorMessage>` +
      `<FunctionOutput>${xmlEscape(output)}</FunctionOutput>` +
      `</TestResult>` +
      `</TestFunctionResult>`;
    return this.sendXml(res, 200, xml);
  }

  // -------------------------------------------------------------------------
  // Key value stores (control plane)
  // -------------------------------------------------------------------------
  createKeyValueStore(body, res) {
    const json = this.parseJson(body);
    let name, comment;
    if (json && json.Name) {
      name = json.Name;
      comment = json.Comment || "";
    } else {
      name = tagText(body, "Name");
      comment = tagText(body, "Comment") || "";
    }
    if (!name) throw new CffError("InvalidArgument", "Name is required");
    if (this.keyValueStores.has(name)) {
      throw new CffError("EntityAlreadyExists", `KeyValueStore ${name} already exists`, 409);
    }
    const id = randomUUID();
    const etag = randomBytes(7).toString("hex").toUpperCase();
    const arn = `arn:aws:cloudfront::${this.accountId}:key-value-store/${id}`;
    const store = {
      name,
      id,
      arn,
      etag,
      comment,
      status: "READY",
      lastModifiedTime: new Date().toISOString(),
      data: new Map(),
    };
    this.keyValueStores.set(name, store);
    res.setHeader("ETag", etag);
    const xml = `<KeyValueStore xmlns="${NAMESPACE}">${this.kvsInner(store)}</KeyValueStore>`;
    return this.sendXml(res, 201, xml);
  }

  kvsInner(s) {
    return (
      `<Name>${xmlEscape(s.name)}</Name>` +
      `<Id>${s.id}</Id>` +
      `<ARN>${s.arn}</ARN>` +
      `<Comment>${xmlEscape(s.comment)}</Comment>` +
      `<Status>${s.status}</Status>` +
      `<LastModifiedTime>${s.lastModifiedTime}</LastModifiedTime>`
    );
  }

  listKeyValueStores(res) {
    const items = [...this.keyValueStores.values()]
      .map((s) => `<KeyValueStore>${this.kvsInner(s)}</KeyValueStore>`)
      .join("");
    const xml =
      `<KeyValueStoreList xmlns="${NAMESPACE}">` +
      `<MaxItems>100</MaxItems><Quantity>${this.keyValueStores.size}</Quantity>` +
      `<Items>${items}</Items>` +
      `</KeyValueStoreList>`;
    return this.sendXml(res, 200, xml);
  }

  requireStore(name) {
    const store = this.keyValueStores.get(name);
    if (!store) {
      throw new CffError("EntityNotFound", `KeyValueStore ${name} does not exist`, 404);
    }
    return store;
  }

  // -------------------------------------------------------------------------
  // Key value store (data plane) — simple JSON key/value
  // -------------------------------------------------------------------------
  putKey(storeName, key, body, res) {
    const store = this.requireStore(storeName);
    const json = this.parseJson(body);
    const value = json && json.Value !== undefined ? json.Value : body;
    store.data.set(key, String(value));
    return this.sendJson(res, 200, { ItemCount: store.data.size });
  }

  getKey(storeName, key, res) {
    const store = this.requireStore(storeName);
    if (!store.data.has(key)) {
      throw new CffError("EntityNotFound", `Key ${key} not found`, 404);
    }
    return this.sendJson(res, 200, { Key: key, Value: store.data.get(key) });
  }

  deleteKey(storeName, key, res) {
    const store = this.requireStore(storeName);
    store.data.delete(key);
    return this.sendJson(res, 200, { ItemCount: store.data.size });
  }

  listKeys(storeName, res) {
    const store = this.requireStore(storeName);
    const items = [...store.data.entries()].map(([Key, Value]) => ({ Key, Value }));
    return this.sendJson(res, 200, { Items: items, ItemCount: items.length });
  }

  // -------------------------------------------------------------------------
  sendXml(res, status, xml) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalError";
    const status = error.status || ERROR_STATUS[code] || 400;
    const requestId = res.getHeader("x-amzn-RequestId") || this.requestId();
    res.statusCode = status;
    res.setHeader("Content-Type", "text/xml");
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<ErrorResponse xmlns="${NAMESPACE}">` +
      `<Error><Type>Sender</Type><Code>${xmlEscape(code)}</Code>` +
      `<Message>${xmlEscape(error.message || code)}</Message></Error>` +
      `<RequestId>${requestId}</RequestId></ErrorResponse>`;
    res.end(xml);
  }
}

export default CloudfrontFunctionsServer;
export const API_VERSION_CLOUDFRONT_FUNCTIONS = API_VERSION;
