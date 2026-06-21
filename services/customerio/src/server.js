import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/customerio — a tiny, dependency-free fake of the Customer.io
// Journeys REST API (Track API + App API + Pipelines API).
//
// It speaks the exact wire protocol used by the official `customerio-node`
// package (TrackClient, APIClient, PipelinesClient) so application code and AI
// agents can run against it with zero cost and zero side effects. State is
// in-memory and ephemeral; everything that flows through is captured for
// inspection and assertions, and can be reset.
//
// Route layout (all on one port, dispatched by path prefix):
//   Track API     (Basic auth)  -> /api/v1/...
//   Track API v2  (Basic auth)  -> /api/v2/batch
//   App API       (Bearer auth) -> /v1/send/*, /v1/customers, /v1/campaigns/*,
//                                  /v1/exports/*
//   Pipelines API (Basic auth)  -> /v1/identify|track|page|screen|group|alias|batch
//   parlel control (no auth)    -> /__parlel/*
//
// The App API and Pipelines API both live under /v1 in the real product but on
// different hosts (api.customer.io vs cdp.customer.io). Here they share /v1 and
// are disambiguated by their distinct sub-paths, which never collide.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyId(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return !Number.isFinite(value);
  return false;
}

// Customer.io error envelope: { meta: { error: "..." } } for a single error,
// { meta: { errors: ["...", ...] } } for multiple. The client's
// CustomerIORequestError.composeMessage reads exactly these shapes.
function cioError(message) {
  return { meta: { error: message } };
}

function cioErrors(messages) {
  return { meta: { errors: messages } };
}

function newId(prefix, bytes = 8) {
  return `${prefix}${randomBytes(bytes).toString("hex")}`;
}

export class CustomerioServer {
  constructor(port = 4668, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // Identified people keyed by their identifier (id / email / cio_<cio_id>).
    this.customers = new Map();
    // Per-customer device registry: Map<customerId, Map<deviceId, device>>.
    this.devices = new Map();
    // Every event captured (track, page, anonymous, push lifecycle).
    this.events = [];
    // Suppressed customer identifiers.
    this.suppressed = new Set();
    // Every transactional send captured (email/push/sms/inbox/in_app).
    this.deliveries = [];
    // Every broadcast trigger captured.
    this.broadcastTriggers = [];
    // Merge operations captured.
    this.merges = [];
    // Track API v2 / Pipelines batch submissions captured.
    this.batches = [];
    // Pipelines events captured (identify/track/page/screen/group/alias).
    this.pipelineEvents = [];
    // Exports store keyed by numeric id.
    this.exports = new Map();
    this._cioIdCounter = 0;
    this._deliveryCounter = 0;
    this._exportCounter = 0;
    this._broadcastActionCounter = 0;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, cioError(error.message || "Internal server error"));
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

  // -------------------------------------------------------------------------
  // request dispatch
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return; // response already sent

    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-customerio");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Unauthenticated infrastructure endpoints.
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    // parlel inspection + control endpoints (not part of Customer.io).
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body, url);

    // Track API v1 + v2 (Basic auth).
    if (parts[0] === "api" && (parts[1] === "v1" || parts[1] === "v2")) {
      if (!this.isBasicAuthorized(req)) return this.unauthorized(res);
      return this.handleTrack(req, res, parts[1], parts.slice(2), body, url);
    }

    // App API + Pipelines API both live under /v1.
    if (parts[0] === "v1") {
      const route = parts.slice(1);
      // Pipelines endpoints (Basic auth with write key).
      const pipelinesRoutes = new Set([
        "identify", "track", "page", "screen", "group", "alias", "batch",
      ]);
      if (route.length === 1 && pipelinesRoutes.has(route[0])) {
        if (!this.isBasicAuthorized(req)) return this.unauthorized(res);
        return this.handlePipelines(req, res, route, body);
      }
      // Otherwise App API (Bearer auth).
      if (!this.isBearerAuthorized(req)) return this.unauthorized(res);
      return this.handleApp(req, res, route, body, url);
    }

    return this.send(res, 404, cioError("not found"));
  }

  // -------------------------------------------------------------------------
  // Track API: /api/v1/... and /api/v2/batch
  // -------------------------------------------------------------------------
  handleTrack(req, res, version, route, body, url) {
    // ----- Track API v2 batch -----
    if (version === "v2") {
      if (req.method === "POST" && route[0] === "batch" && route.length === 1) {
        const operations = isPlainObject(body) ? body.batch : undefined;
        if (!Array.isArray(operations) || operations.length === 0) {
          return this.send(res, 400, cioErrors(["batch must be a non-empty array"]));
        }
        const record = { received_at: now(), operations: clone(operations) };
        this.batches.push(record);
        // Apply person-identify operations so they materialize as customers.
        for (const op of operations) {
          if (isPlainObject(op) && op.type === "person" && op.action === "identify" && isPlainObject(op.identifiers)) {
            const id = op.identifiers.id ?? op.identifiers.email ?? op.identifiers.cio_id;
            if (!isEmptyId(id)) this._upsertCustomer(String(id), op.attributes || {});
          }
        }
        return this.send(res, 200, {});
      }
      return this.send(res, 404, cioError("not found"));
    }

    // ----- Track API v1 -----

    // POST /api/v1/events  (trackAnonymous)
    if (req.method === "POST" && route[0] === "events" && route.length === 1) {
      if (!isPlainObject(body) || isEmptyId(body.name)) {
        return this.send(res, 400, cioErrors(["name is required"]));
      }
      const event = {
        id: newId("evt_"),
        kind: "anonymous",
        anonymous_id: body.anonymous_id ?? null,
        name: body.name,
        type: body.type || "event",
        data: clone(body.data) || {},
        timestamp: body.timestamp || unixNow(),
        received_at: now(),
      };
      this.events.push(event);
      return this.send(res, 200, {});
    }

    // POST /api/v1/push/events  (trackPush)
    if (req.method === "POST" && route[0] === "push" && route[1] === "events" && route.length === 2) {
      const event = {
        id: newId("push_"),
        kind: "push",
        delivery_id: body?.delivery_id ?? null,
        device_id: body?.device_id ?? null,
        event: body?.event ?? null,
        timestamp: body?.timestamp ?? unixNow(),
        received_at: now(),
      };
      this.events.push(event);
      return this.send(res, 200, {});
    }

    // POST /api/v1/merge_customers
    if (req.method === "POST" && route[0] === "merge_customers" && route.length === 1) {
      if (!isPlainObject(body) || !isPlainObject(body.primary) || !isPlainObject(body.secondary)) {
        return this.send(res, 400, cioErrors(["primary and secondary identifiers are required"]));
      }
      const primaryId = body.primary.id ?? body.primary.email ?? body.primary.cio_id;
      const secondaryId = body.secondary.id ?? body.secondary.email ?? body.secondary.cio_id;
      // Secondary is permanently deleted; primary survives.
      if (!isEmptyId(secondaryId)) {
        this.customers.delete(String(secondaryId));
        this.devices.delete(String(secondaryId));
      }
      this.merges.push({
        primary: clone(body.primary),
        secondary: clone(body.secondary),
        received_at: now(),
      });
      return this.send(res, 200, {});
    }

    // /api/v1/customers/{id}/...
    if (route[0] === "customers") {
      const customerId = route[1];

      if (route.length === 2) {
        // PUT /customers/{id}  (identify)
        if (req.method === "PUT") {
          if (isEmptyId(customerId)) {
            return this.send(res, 400, cioErrors(["customer id is required"]));
          }
          this._upsertCustomer(customerId, isPlainObject(body) ? body : {});
          return this.send(res, 200, {});
        }
        // DELETE /customers/{id}  (destroy)
        if (req.method === "DELETE") {
          this.customers.delete(customerId);
          this.devices.delete(customerId);
          return this.send(res, 200, {});
        }
        return this.send(res, 405, cioError("method not allowed"));
      }

      // POST /customers/{id}/suppress
      if (route[2] === "suppress" && route.length === 3 && req.method === "POST") {
        this.suppressed.add(customerId);
        this.customers.delete(customerId);
        return this.send(res, 200, {});
      }
      // POST /customers/{id}/unsuppress
      if (route[2] === "unsuppress" && route.length === 3 && req.method === "POST") {
        this.suppressed.delete(customerId);
        return this.send(res, 200, {});
      }

      // POST /customers/{id}/events  (track / page)
      if (route[2] === "events" && route.length === 3 && req.method === "POST") {
        if (!isPlainObject(body) || isEmptyId(body.name)) {
          return this.send(res, 400, cioErrors(["name is required"]));
        }
        const event = {
          id: newId("evt_"),
          kind: body.type === "page" ? "page" : "event",
          customer_id: customerId,
          name: body.name,
          type: body.type || "event",
          data: clone(body.data) || {},
          timestamp: body.timestamp || unixNow(),
          received_at: now(),
        };
        this.events.push(event);
        return this.send(res, 200, {});
      }

      // PUT /customers/{id}/devices  (addDevice)
      if (route[2] === "devices" && route.length === 3 && req.method === "PUT") {
        const device = isPlainObject(body) ? body.device : undefined;
        if (!isPlainObject(device) || isEmptyId(device.id)) {
          return this.send(res, 400, cioErrors(["device.id is required"]));
        }
        if (!this.devices.has(customerId)) this.devices.set(customerId, new Map());
        const stored = {
          id: device.id,
          platform: device.platform || null,
          last_used: device.last_used ?? null,
          attributes: clone(device.attributes) || {},
          customer_id: customerId,
          received_at: now(),
        };
        this.devices.get(customerId).set(String(device.id), stored);
        return this.send(res, 200, {});
      }

      // DELETE /customers/{id}/devices/{token}  (deleteDevice)
      if (route[2] === "devices" && route.length === 4 && req.method === "DELETE") {
        const token = route[3];
        const map = this.devices.get(customerId);
        if (map) map.delete(String(token));
        return this.send(res, 200, {});
      }
    }

    return this.send(res, 404, cioError("not found"));
  }

  _upsertCustomer(customerId, attributes) {
    const key = String(customerId);
    const existing = this.customers.get(key);
    if (existing) {
      existing.attributes = { ...existing.attributes, ...clone(attributes) };
      existing.updated_at = now();
    } else {
      this._cioIdCounter += 1;
      this.customers.set(key, {
        id: key,
        cio_id: String(this._cioIdCounter),
        identifiers: {
          id: key,
          cio_id: String(this._cioIdCounter),
          ...(attributes && attributes.email ? { email: attributes.email } : {}),
        },
        attributes: clone(attributes) || {},
        created_at: now(),
        updated_at: now(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // App API: /v1/...
  // -------------------------------------------------------------------------
  handleApp(req, res, route, body, url) {
    // POST /v1/send/{email|push|sms|inbox_message|in_app}
    if (route[0] === "send" && route.length === 2 && req.method === "POST") {
      const channel = route[1];
      const valid = new Set(["email", "push", "sms", "inbox_message", "in_app"]);
      if (!valid.has(channel)) return this.send(res, 404, cioError("not found"));
      if (!isPlainObject(body)) {
        return this.send(res, 400, cioErrors(["request body is required"]));
      }
      // Email requires either a transactional_message_id or inline body+subject+from.
      if (channel === "email") {
        const hasTemplate = !isEmptyId(body.transactional_message_id);
        const hasInline =
          typeof body.body === "string" && typeof body.subject === "string" && typeof body.from === "string";
        if (!hasTemplate && !hasInline) {
          return this.send(res, 400, cioErrors([
            "you must specify a transactional_message_id or a body, subject, and from",
          ]));
        }
      } else {
        if (isEmptyId(body.transactional_message_id)) {
          return this.send(res, 400, cioErrors(["transactional_message_id is required"]));
        }
      }

      this._deliveryCounter += 1;
      const deliveryId = newId("del_", 12);
      const delivery = {
        delivery_id: deliveryId,
        channel,
        message: clone(body),
        received_at: now(),
      };
      this.deliveries.push(delivery);
      // The real API responds 200 with delivery_id (+ queued).
      return this.send(res, 200, { delivery_id: deliveryId, queued: true });
    }

    // GET /v1/customers?email=...  (getCustomersByEmail)
    if (route[0] === "customers" && route.length === 1 && req.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) {
        return this.send(res, 400, cioErrors(["email query parameter is required"]));
      }
      const results = [];
      for (const customer of this.customers.values()) {
        if (customer.attributes && customer.attributes.email === email) {
          results.push({
            id: customer.id,
            cio_id: customer.cio_id,
            email,
            identifiers: customer.identifiers,
          });
        }
      }
      return this.send(res, 200, { results });
    }

    // GET /v1/customers/{id}/attributes?id_type=...  (getAttributes)
    if (route[0] === "customers" && route[2] === "attributes" && route.length === 3 && req.method === "GET") {
      const idType = url.searchParams.get("id_type") || "id";
      const lookupId = route[1];
      let customer = null;
      if (idType === "email") {
        for (const c of this.customers.values()) {
          if (c.attributes && c.attributes.email === lookupId) { customer = c; break; }
        }
      } else if (idType === "cio_id") {
        for (const c of this.customers.values()) {
          if (c.cio_id === lookupId) { customer = c; break; }
        }
      } else {
        customer = this.customers.get(String(lookupId)) || null;
      }
      if (!customer) {
        return this.send(res, 404, cioError("customer not found"));
      }
      return this.send(res, 200, {
        customer: {
          id: customer.id,
          cio_id: customer.cio_id,
          identifiers: customer.identifiers,
          attributes: customer.attributes,
          timestamps: { cio_id: customer.cio_id, created_at: customer.created_at },
          unsubscribed: false,
        },
      });
    }

    // POST /v1/campaigns/{id}/triggers  (triggerBroadcast)
    if (route[0] === "campaigns" && route[2] === "triggers" && route.length === 3 && req.method === "POST") {
      const campaignId = route[1];
      this._broadcastActionCounter += 1;
      const trigger = {
        id: this._broadcastActionCounter,
        campaign_id: campaignId,
        payload: clone(body) || {},
        received_at: now(),
      };
      this.broadcastTriggers.push(trigger);
      return this.send(res, 200, { id: trigger.id });
    }

    // ----- Exports -----
    if (route[0] === "exports") {
      // GET /v1/exports  (listExports)
      if (route.length === 1 && req.method === "GET") {
        return this.send(res, 200, {
          exports: Array.from(this.exports.values()).map((e) => clone(e)),
        });
      }
      // POST /v1/exports/customers  (createCustomersExport)
      if (route.length === 2 && route[1] === "customers" && req.method === "POST") {
        if (!isPlainObject(body) || body.filters == null) {
          return this.send(res, 400, cioErrors(["filters is required"]));
        }
        return this.send(res, 200, { export: this._createExport("customers", { filters: clone(body.filters) }) });
      }
      // POST /v1/exports/deliveries  (createDeliveriesExport)
      if (route.length === 2 && route[1] === "deliveries" && req.method === "POST") {
        if (!isPlainObject(body) || isEmptyId(body.newsletter_id)) {
          return this.send(res, 400, cioErrors(["newsletter_id is required"]));
        }
        return this.send(res, 200, { export: this._createExport("deliveries", clone(body)) });
      }
      // GET /v1/exports/{id}/download  (downloadExport)
      if (route.length === 3 && route[2] === "download" && req.method === "GET") {
        const exp = this.exports.get(Number(route[1]));
        if (!exp) return this.send(res, 404, cioError("export not found"));
        return this.send(res, 200, {
          export: { ...clone(exp), signed_url: `http://${this.host}:${this.port}/__parlel/exports/${exp.id}/download` },
          link: `http://${this.host}:${this.port}/__parlel/exports/${exp.id}/download`,
        });
      }
      // GET /v1/exports/{id}  (getExport)
      if (route.length === 2 && req.method === "GET") {
        const exp = this.exports.get(Number(route[1]));
        if (!exp) return this.send(res, 404, cioError("export not found"));
        return this.send(res, 200, { export: clone(exp) });
      }
    }

    return this.send(res, 404, cioError("not found"));
  }

  _createExport(type, params) {
    this._exportCounter += 1;
    const exp = {
      id: this._exportCounter,
      type,
      status: "ready",
      params,
      created_at: unixNow(),
      updated_at: unixNow(),
    };
    this.exports.set(exp.id, exp);
    return clone(exp);
  }

  // -------------------------------------------------------------------------
  // Pipelines API: /v1/{identify|track|page|screen|group|alias|batch}
  // -------------------------------------------------------------------------
  handlePipelines(req, res, route, body) {
    if (req.method !== "POST") return this.send(res, 405, cioError("method not allowed"));
    const type = route[0];

    if (type === "batch") {
      const items = isPlainObject(body) ? body.batch : undefined;
      if (!Array.isArray(items) || items.length === 0) {
        return this.send(res, 400, cioErrors(["batch must be a non-empty array"]));
      }
      this.batches.push({ source: "pipelines", received_at: now(), operations: clone(items) });
      for (const item of items) {
        if (isPlainObject(item)) {
          this.pipelineEvents.push({ ...clone(item), received_at: now() });
        }
      }
      return this.send(res, 200, { success: true });
    }

    if (!isPlainObject(body)) {
      return this.send(res, 400, cioErrors(["request body is required"]));
    }
    // Minimal validation matching the SDK's client-side guards (server side,
    // these are also enforced by the real API in strict mode).
    if (type === "track" && isEmptyId(body.event)) {
      return this.send(res, 400, cioErrors(["event is required"]));
    }
    if (type === "group" && isEmptyId(body.groupId)) {
      return this.send(res, 400, cioErrors(["groupId is required"]));
    }
    if (type === "alias" && (isEmptyId(body.userId) || isEmptyId(body.previousId))) {
      return this.send(res, 400, cioErrors(["userId and previousId are required"]));
    }

    this.pipelineEvents.push({ type, ...clone(body), received_at: now() });
    return this.send(res, 200, { success: true });
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection endpoints (not part of Customer.io).
  // -------------------------------------------------------------------------
  handleControl(req, res, parts, body, url) {
    // POST /__parlel/reset
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }

    // GET /__parlel/customers — all identified people.
    if (req.method === "GET" && parts[1] === "customers" && parts.length === 2) {
      return this.send(res, 200, {
        customers: Array.from(this.customers.values()).map(clone),
        count: this.customers.size,
      });
    }
    // GET /__parlel/customers/{id}
    if (req.method === "GET" && parts[1] === "customers" && parts.length === 3) {
      const customer = this.customers.get(parts[2]);
      if (!customer) return this.send(res, 404, cioError("customer not found"));
      return this.send(res, 200, clone(customer));
    }

    // GET /__parlel/events — all captured events.
    if (req.method === "GET" && parts[1] === "events" && parts.length === 2) {
      return this.send(res, 200, { events: clone(this.events), count: this.events.length });
    }

    // GET /__parlel/deliveries — all transactional sends.
    if (req.method === "GET" && parts[1] === "deliveries" && parts.length === 2) {
      return this.send(res, 200, { deliveries: clone(this.deliveries), count: this.deliveries.length });
    }
    // GET /__parlel/deliveries/{delivery_id}
    if (req.method === "GET" && parts[1] === "deliveries" && parts.length === 3) {
      const match = this.deliveries.find((d) => d.delivery_id === parts[2]);
      if (!match) return this.send(res, 404, cioError("delivery not found"));
      return this.send(res, 200, clone(match));
    }

    // GET /__parlel/devices — all registered devices (flattened).
    if (req.method === "GET" && parts[1] === "devices" && parts.length === 2) {
      const all = [];
      for (const map of this.devices.values()) {
        for (const d of map.values()) all.push(clone(d));
      }
      return this.send(res, 200, { devices: all, count: all.length });
    }

    // GET /__parlel/suppressed — suppressed customer ids.
    if (req.method === "GET" && parts[1] === "suppressed" && parts.length === 2) {
      return this.send(res, 200, { suppressed: Array.from(this.suppressed) });
    }

    // GET /__parlel/broadcasts — captured broadcast triggers.
    if (req.method === "GET" && parts[1] === "broadcasts" && parts.length === 2) {
      return this.send(res, 200, { broadcasts: clone(this.broadcastTriggers), count: this.broadcastTriggers.length });
    }

    // GET /__parlel/merges — captured merge operations.
    if (req.method === "GET" && parts[1] === "merges" && parts.length === 2) {
      return this.send(res, 200, { merges: clone(this.merges), count: this.merges.length });
    }

    // GET /__parlel/batches — captured batch submissions.
    if (req.method === "GET" && parts[1] === "batches" && parts.length === 2) {
      return this.send(res, 200, { batches: clone(this.batches), count: this.batches.length });
    }

    // GET /__parlel/pipeline-events — captured Pipelines API events.
    if (req.method === "GET" && parts[1] === "pipeline-events" && parts.length === 2) {
      return this.send(res, 200, { events: clone(this.pipelineEvents), count: this.pipelineEvents.length });
    }

    // GET /__parlel/exports/{id}/download — signed-link download stub.
    if (req.method === "GET" && parts[1] === "exports" && parts[3] === "download" && parts.length === 4) {
      const exp = this.exports.get(Number(parts[2]));
      if (!exp) return this.send(res, 404, cioError("export not found"));
      return this.send(res, 200, { id: exp.id, type: exp.type, rows: [] });
    }

    return this.send(res, 404, cioError("not found"));
  }

  root() {
    return {
      name: "customerio",
      version: "1.0",
      protocol: "customerio-rest",
      apis: ["track", "app", "pipelines"],
      documentation: "/docs/customerio.md",
    };
  }

  // -------------------------------------------------------------------------
  // auth helpers
  // -------------------------------------------------------------------------
  isBasicAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Basic\s+\S+/i.test(req.headers.authorization || "");
  }

  isBearerAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
  }

  unauthorized(res) {
    return this.send(res, 401, cioErrors(["Unauthorized"]));
  }

  // -------------------------------------------------------------------------
  // io helpers
  // -------------------------------------------------------------------------
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
          this.send(res, 400, cioErrors(["Invalid JSON body"]));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, cioErrors(["Invalid request body"]));
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

// Allow `node server.js` to run a standalone instance.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 4668;
  const server = new CustomerioServer(port);
  server.start().then(() => {
    // eslint-disable-next-line no-console
    console.log(`parlel/customerio listening on http://127.0.0.1:${port}`);
  });
}
