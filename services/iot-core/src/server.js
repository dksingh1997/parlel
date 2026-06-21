// parlel/iot-core — a lightweight, dependency-free fake of AWS IoT Core.
// Covers the control-plane Thing registry (REST/JSON) and the device shadow
// REST surface. MQTT-over-WebSocket is not implemented (see docs).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "000000000000";

class IotError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

export class IotCoreServer {
  constructor(port = 4743, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    this.things = new Map();
    // shadows: Map<thingName, Map<shadowName, shadowDoc>>
    this.shadows = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new IotError("InternalFailureException", error.message, 500));
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

  thingArn(name) {
    return `arn:aws:iot:${this.region}:${this.accountId}:thing/${name}`;
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (path === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "iot-core",
        things: this.things.size,
      });
    }
    if (path === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", randomUUID());
    res.setHeader("Server", "parlel-iot-core");

    const bodyBuf = await this.readBody(req);
    let body = {};
    if (bodyBuf.length) {
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        return this.sendError(res, new IotError("InvalidRequestException", "Invalid JSON body."));
      }
    }

    try {
      return this.route(method, path, body, url, res);
    } catch (error) {
      if (error instanceof IotError) return this.sendError(res, error);
      throw error;
    }
  }

  route(method, path, body, url, res) {
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent);

    if (seg[0] === "things") {
      if (seg.length === 1 && method === "GET") {
        return this.sendJson(res, 200, this.listThings());
      }
      if (seg.length === 2) {
        const name = seg[1];
        if (method === "POST") return this.sendJson(res, 200, this.createThing(name, body));
        if (method === "GET") return this.sendJson(res, 200, this.describeThing(name));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteThing(name));
        if (method === "PATCH") return this.sendJson(res, 200, this.updateThing(name, body));
      }
      if (seg.length === 3 && seg[2] === "shadow") {
        const name = seg[1];
        const shadowName = url.searchParams.get("name") || "$default";
        if (method === "GET") return this.sendJson(res, 200, this.getShadow(name, shadowName));
        if (method === "POST") return this.sendJson(res, 200, this.updateShadow(name, shadowName, body));
        if (method === "DELETE") return this.sendJson(res, 200, this.deleteShadow(name, shadowName));
      }
    }
    throw new IotError("InvalidRequestException", `Unsupported ${method} ${path}`, 404);
  }

  // -------------------------------------------------------------------------
  // Things
  // -------------------------------------------------------------------------
  createThing(name, body) {
    if (this.things.has(name)) {
      throw new IotError("ResourceAlreadyExistsException", `Thing ${name} already exists.`, 409);
    }
    const id = randomUUID();
    const thing = {
      thingName: name,
      thingId: id,
      thingArn: this.thingArn(name),
      thingTypeName: body.thingTypeName,
      attributes: (body.attributePayload && body.attributePayload.attributes) || {},
      version: 1,
    };
    this.things.set(name, thing);
    return {
      thingName: name,
      thingArn: thing.thingArn,
      thingId: id,
    };
  }

  requireThing(name) {
    const t = this.things.get(name);
    if (!t) throw new IotError("ResourceNotFoundException", `Thing ${name} not found.`, 404);
    return t;
  }

  describeThing(name) {
    const t = this.requireThing(name);
    return {
      thingName: t.thingName,
      thingId: t.thingId,
      thingArn: t.thingArn,
      thingTypeName: t.thingTypeName,
      attributes: t.attributes,
      version: t.version,
      defaultClientId: t.thingName,
    };
  }

  listThings() {
    return {
      things: [...this.things.values()].map((t) => ({
        thingName: t.thingName,
        thingArn: t.thingArn,
        thingTypeName: t.thingTypeName,
        attributes: t.attributes,
        version: t.version,
      })),
    };
  }

  updateThing(name, body) {
    const t = this.requireThing(name);
    if (body.attributePayload && body.attributePayload.attributes) {
      if (body.attributePayload.merge) {
        Object.assign(t.attributes, body.attributePayload.attributes);
      } else {
        t.attributes = body.attributePayload.attributes;
      }
    }
    if (body.thingTypeName !== undefined) t.thingTypeName = body.thingTypeName;
    t.version += 1;
    return {};
  }

  deleteThing(name) {
    this.requireThing(name);
    this.things.delete(name);
    this.shadows.delete(name);
    return {};
  }

  // -------------------------------------------------------------------------
  // Device shadows
  // -------------------------------------------------------------------------
  computeDelta(desired, reported) {
    const delta = {};
    for (const [k, v] of Object.entries(desired || {})) {
      if (JSON.stringify(reported && reported[k]) !== JSON.stringify(v)) {
        delta[k] = v;
      }
    }
    return delta;
  }

  shadowMap(thingName) {
    this.requireThing(thingName);
    if (!this.shadows.has(thingName)) this.shadows.set(thingName, new Map());
    return this.shadows.get(thingName);
  }

  getShadow(thingName, shadowName) {
    const map = this.shadowMap(thingName);
    const doc = map.get(shadowName);
    if (!doc) {
      throw new IotError("ResourceNotFoundException", "No shadow exists with name: " + shadowName, 404);
    }
    return this.shadowView(doc);
  }

  shadowView(doc) {
    const delta = this.computeDelta(doc.desired, doc.reported);
    const state = {};
    if (doc.desired && Object.keys(doc.desired).length) state.desired = doc.desired;
    if (doc.reported && Object.keys(doc.reported).length) state.reported = doc.reported;
    if (Object.keys(delta).length) state.delta = delta;
    return {
      state,
      metadata: doc.metadata || {},
      version: doc.version,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  updateShadow(thingName, shadowName, body) {
    const map = this.shadowMap(thingName);
    let doc = map.get(shadowName);
    if (!doc) {
      doc = { desired: {}, reported: {}, version: 0, metadata: {} };
      map.set(shadowName, doc);
    }
    const state = body.state || {};
    if (state.desired) {
      for (const [k, v] of Object.entries(state.desired)) {
        if (v === null) delete doc.desired[k];
        else doc.desired[k] = v;
      }
    }
    if (state.reported) {
      for (const [k, v] of Object.entries(state.reported)) {
        if (v === null) delete doc.reported[k];
        else doc.reported[k] = v;
      }
    }
    doc.version += 1;
    return this.shadowView(doc);
  }

  deleteShadow(thingName, shadowName) {
    const map = this.shadowMap(thingName);
    if (!map.has(shadowName)) {
      throw new IotError("ResourceNotFoundException", "No shadow exists with name: " + shadowName, 404);
    }
    const doc = map.get(shadowName);
    map.delete(shadowName);
    return { version: doc.version, timestamp: Math.floor(Date.now() / 1000) };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    res.statusCode = error.status || 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-amzn-errortype", error.code || "InvalidRequestException");
    res.end(JSON.stringify({ __type: error.code, message: error.message, Message: error.message }));
  }
}

export default IotCoreServer;
