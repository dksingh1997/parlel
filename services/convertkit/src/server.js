import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/convertkit — a tiny, dependency-free fake of the ConvertKit (Kit) v3
// REST API.
//
// It speaks the exact wire protocol used by application code that calls the
// ConvertKit HTTP REST API directly with `axios` (the documented integration
// path), so app code and AI agents can run against it with zero cost and zero
// side effects. State is in-memory, ephemeral and resettable.
//
// Wire conventions replicated:
//   * Base path is `/v3`.
//   * Plain JSON request/response bodies (NOT JSON:API).
//   * Authentication:
//       - `api_key`    (public)  — forms/sequences/tags subscribe, reads.
//       - `api_secret` (private) — subscriber data, broadcasts, purchases,
//                                  webhooks, custom field writes.
//     Both may be supplied as a query-string parameter OR a JSON body field,
//     which is exactly how the real API accepts them.
//   * List responses are paginated with { total_subscribers / total_*,
//     page, total_pages } style envelopes where the real API uses them.
//   * Errors use the ConvertKit error envelope:
//       { error: "<Title>", message: "<detail>" }
//     or, for validation collections: { errors: ["msg", ...] }.
//
// Implemented surface (grouped):
//   Account        GET  /v3/account
//                  GET  /v3/account/creator_profile
//                  GET  /v3/account/growth_stats
//   Forms          GET  /v3/forms
//                  POST /v3/forms/{id}/subscribe
//                  GET  /v3/forms/{id}/subscriptions
//   Sequences      GET  /v3/sequences
//                  POST /v3/sequences/{id}/subscribe
//                  GET  /v3/sequences/{id}/subscriptions
//   Tags           GET  /v3/tags
//                  POST /v3/tags  (single or bulk)
//                  POST /v3/tags/{id}/subscribe
//                  POST /v3/tags/{id}/unsubscribe
//                  GET  /v3/tags/{id}/subscriptions
//   Subscribers    GET  /v3/subscribers (list + filter by email_address)
//                  GET  /v3/subscribers/{id}
//                  PUT  /v3/subscribers/{id}
//                  GET  /v3/subscribers/{id}/tags
//                  POST /v3/unsubscribe
//   Custom Fields  GET  /v3/custom_fields
//                  POST /v3/custom_fields (single or bulk)
//                  PUT  /v3/custom_fields/{id}
//                  DELETE /v3/custom_fields/{id}
//   Broadcasts     GET  /v3/broadcasts
//                  POST /v3/broadcasts
//                  GET  /v3/broadcasts/{id}
//                  PUT  /v3/broadcasts/{id}
//                  DELETE /v3/broadcasts/{id}
//                  GET  /v3/broadcasts/{id}/stats
//   Webhooks       POST /v3/automations/hooks
//                  DELETE /v3/automations/hooks/{id}
//   Purchases      GET  /v3/purchases
//                  GET  /v3/purchases/{id}
//                  POST /v3/purchases
//
// Plus parlel control/inspection endpoints under /__parlel.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ConvertkitServer {
  constructor(port = 4667, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.apiKey = options.apiKey || "parlel_test_public_api_key";
    this.apiSecret = options.apiSecret || "parlel_test_secret_api_key";
    this.server = null;
    this.reset();
  }

  reset() {
    this._seq = 1; // monotonic numeric id source
    this.subscribers = new Map(); // id(number) -> subscriber record
    this.subscribersByEmail = new Map(); // lowercased email -> id
    this.forms = new Map(); // id -> form record
    this.sequences = new Map(); // id -> sequence record
    this.tags = new Map(); // id -> tag record
    this.customFields = new Map(); // id -> custom field record
    this.broadcasts = new Map(); // id -> broadcast record
    this.webhooks = new Map(); // id -> webhook record
    this.purchases = new Map(); // id -> purchase record
    this.formSubs = new Map(); // formId -> Map(subscriberId -> subscription record)
    this.sequenceSubs = new Map(); // sequenceId -> Map(subscriberId -> subscription record)
    this.tagSubs = new Map(); // tagId -> Map(subscriberId -> subscription record)
    this._seedDefaults();
  }

  _nextId() {
    return this._seq++;
  }

  _seedDefaults() {
    // ConvertKit accounts always have at least one form and one sequence so
    // the subscribe endpoints have a default target. Seed a couple.
    this._newForm({ name: "Newsletter Signup", type: "embed" });
    this._newForm({ name: "Landing Page", type: "hosted" });
    this._newSequence({ name: "Welcome Course" });
  }

  _newForm(attrs) {
    const id = this._nextId();
    const rec = {
      id,
      name: attrs.name || `Form ${id}`,
      created_at: nowIso(),
      type: attrs.type || "embed",
      format: attrs.format || null,
      embed_js: `https://parlel.test/forms/${id}/index.js`,
      embed_url: `https://parlel.test/forms/${id}/index.html`,
      archived: false,
      uid: randomUUID().replace(/-/g, "").slice(0, 16),
    };
    this.forms.set(id, rec);
    this.formSubs.set(id, new Map());
    return rec;
  }

  _newSequence(attrs) {
    const id = this._nextId();
    const rec = {
      id,
      name: attrs.name || `Sequence ${id}`,
      hold: false,
      repeat: false,
      created_at: nowIso(),
    };
    this.sequences.set(id, rec);
    this.sequenceSubs.set(id, new Map());
    return rec;
  }

  _newTag(name) {
    const id = this._nextId();
    const rec = { id, name: String(name), created_at: nowIso() };
    this.tags.set(id, rec);
    this.tagSubs.set(id, new Map());
    return rec;
  }

  _newSubscriber(attrs) {
    const id = this._nextId();
    const email = attrs.email_address ? String(attrs.email_address) : null;
    const rec = {
      id,
      first_name: attrs.first_name ?? null,
      email_address: email,
      state: attrs.state || "active",
      created_at: nowIso(),
      fields: isPlainObject(attrs.fields) ? { ...attrs.fields } : {},
    };
    this.subscribers.set(id, rec);
    if (email) this.subscribersByEmail.set(email.toLowerCase(), id);
    return rec;
  }

  // Upsert subscriber by email (the implicit behaviour of every subscribe call).
  _upsertSubscriber({ email, first_name, fields, state }) {
    const lower = email ? String(email).toLowerCase() : null;
    let rec;
    if (lower && this.subscribersByEmail.has(lower)) {
      rec = this.subscribers.get(this.subscribersByEmail.get(lower));
      if (first_name !== undefined && first_name !== null) rec.first_name = first_name;
      if (isPlainObject(fields)) rec.fields = { ...rec.fields, ...fields };
      if (state) rec.state = state;
    } else {
      rec = this._newSubscriber({ email_address: email, first_name, fields, state });
    }
    return rec;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { error: "Internal Server Error", message: error.message || "Unexpected error." });
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

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-convertkit");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Health (unauthenticated).
    if (req.method === "GET" && parts.length === 1 && parts[0] === "health") {
      return this.send(res, 200, { status: "ok" });
    }

    // parlel inspection / control endpoints (unauthenticated).
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // The v3 surface lives under /v3.
    if (parts[0] === "v3") {
      return this.routeV3(req, res, parts.slice(1), body, url);
    }

    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  // =========================================================================
  // Auth helpers
  // =========================================================================
  // Returns provided api_key / api_secret from query string or JSON body.
  _creds(body, url) {
    const fromQuery = {
      api_key: url.searchParams.get("api_key"),
      api_secret: url.searchParams.get("api_secret"),
    };
    const b = isPlainObject(body) ? body : {};
    return {
      api_key: fromQuery.api_key ?? (typeof b.api_key === "string" ? b.api_key : null),
      api_secret: fromQuery.api_secret ?? (typeof b.api_secret === "string" ? b.api_secret : null),
    };
  }

  _requireKey(res, body, url) {
    if (!this.requireAuth) return true;
    const { api_key, api_secret } = this._creds(body, url);
    if ((api_key && api_key === this.apiKey) || (api_secret && api_secret === this.apiSecret)) return true;
    this.send(res, 401, { error: "Authorization Failed", message: "You do not have access to this resource." });
    return false;
  }

  _requireSecret(res, body, url) {
    if (!this.requireAuth) return true;
    const { api_secret } = this._creds(body, url);
    if (api_secret && api_secret === this.apiSecret) return true;
    this.send(res, 401, { error: "Authorization Failed", message: "You do not have access to this resource." });
    return false;
  }

  // =========================================================================
  // /v3 router
  // =========================================================================
  routeV3(req, res, parts, body, url) {
    const head = parts[0];
    switch (head) {
      case "account":
        return this.routeAccount(req, res, parts, body, url);
      case "forms":
        return this.routeForms(req, res, parts, body, url);
      case "sequences":
      case "courses": // legacy alias for sequences
        return this.routeSequences(req, res, parts, body, url);
      case "tags":
        return this.routeTags(req, res, parts, body, url);
      case "subscribers":
        return this.routeSubscribers(req, res, parts, body, url);
      case "unsubscribe":
        return this.unsubscribe(req, res, body, url);
      case "custom_fields":
        return this.routeCustomFields(req, res, parts, body, url);
      case "broadcasts":
        return this.routeBroadcasts(req, res, parts, body, url);
      case "automations":
        return this.routeAutomations(req, res, parts, body, url);
      case "purchases":
        return this.routePurchases(req, res, parts, body, url);
      default:
        return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
    }
  }

  // =========================================================================
  // Account
  // =========================================================================
  routeAccount(req, res, parts, body, url) {
    if (req.method !== "GET") return this.methodNotAllowed(res);
    if (!this._requireSecret(res, body, url)) return;
    if (parts.length === 1) {
      return this.send(res, 200, {
        name: "Parlel Test",
        primary_email_address: "test@parlel.test",
        plan_type: "free",
      });
    }
    if (parts.length === 2 && parts[1] === "creator_profile") {
      return this.send(res, 200, {
        profile: {
          name: "Parlel Test",
          byline: "Testing ConvertKit with parlel",
          bio: "A parlel fake creator profile.",
          image_url: "https://parlel.test/avatar.png",
          profile_url: "https://parlel.test/creator",
        },
      });
    }
    if (parts.length === 2 && parts[1] === "growth_stats") {
      const cancellations = 0;
      const subscribers = this.subscribers.size;
      return this.send(res, 200, {
        stats: {
          cancellations,
          net_new_subscribers: subscribers,
          new_subscribers: subscribers,
          subscribers,
          unsubscribes: Array.from(this.subscribers.values()).filter((s) => s.state === "cancelled").length,
          starting_subscriber_count: 0,
          ending_subscriber_count: subscribers,
          starting: url.searchParams.get("starting") || null,
          ending: url.searchParams.get("ending") || null,
        },
      });
    }
    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  // =========================================================================
  // Forms
  // =========================================================================
  routeForms(req, res, parts, body, url) {
    // GET /v3/forms
    if (parts.length === 1) {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      if (!this._requireKey(res, body, url)) return;
      return this.send(res, 200, { forms: Array.from(this.forms.values()).map(clone) });
    }
    const id = Number(parts[1]);
    const form = this.forms.get(id);

    // POST /v3/forms/{id}/subscribe
    if (parts.length === 3 && parts[2] === "subscribe") {
      if (req.method !== "POST") return this.methodNotAllowed(res);
      if (!this._requireKey(res, body, url)) return;
      if (!form) return this.send(res, 404, { error: "Not Found", message: "Form not found" });
      const email = body && body.email;
      if (!email || !EMAIL_RE.test(String(email))) {
        return this.send(res, 400, { error: "Bad Request", message: "Email address is invalid" });
      }
      const sub = this._upsertSubscriber({
        email,
        first_name: body.first_name,
        fields: body.fields,
      });
      // attach tags if provided
      this._attachTags(sub, body.tags);
      const subscription = this._recordSubscription(this.formSubs.get(id), sub, { referrer: body.referrer || null });
      return this.send(res, 200, {
        subscription: this._subscriptionView(subscription, sub, "form", id),
      });
    }

    // GET /v3/forms/{id}/subscriptions
    if (parts.length === 3 && parts[2] === "subscriptions") {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      if (!form) return this.send(res, 404, { error: "Not Found", message: "Form not found" });
      return this._listSubscriptions(res, this.formSubs.get(id), "form", id, url);
    }

    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  // =========================================================================
  // Sequences (a.k.a. Courses)
  // =========================================================================
  routeSequences(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      if (!this._requireKey(res, body, url)) return;
      return this.send(res, 200, { courses: Array.from(this.sequences.values()).map(clone) });
    }
    const id = Number(parts[1]);
    const seq = this.sequences.get(id);

    if (parts.length === 3 && parts[2] === "subscribe") {
      if (req.method !== "POST") return this.methodNotAllowed(res);
      if (!this._requireKey(res, body, url)) return;
      if (!seq) return this.send(res, 404, { error: "Not Found", message: "Sequence not found" });
      const email = body && body.email;
      if (!email || !EMAIL_RE.test(String(email))) {
        return this.send(res, 400, { error: "Bad Request", message: "Email address is invalid" });
      }
      const sub = this._upsertSubscriber({ email, first_name: body.first_name, fields: body.fields });
      this._attachTags(sub, body.tags);
      const subscription = this._recordSubscription(this.sequenceSubs.get(id), sub, {});
      return this.send(res, 200, {
        subscription: this._subscriptionView(subscription, sub, "course", id),
      });
    }

    if (parts.length === 3 && parts[2] === "subscriptions") {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      if (!seq) return this.send(res, 404, { error: "Not Found", message: "Sequence not found" });
      return this._listSubscriptions(res, this.sequenceSubs.get(id), "course", id, url);
    }

    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  // =========================================================================
  // Tags
  // =========================================================================
  routeTags(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        if (!this._requireKey(res, body, url)) return;
        return this.send(res, 200, { tags: Array.from(this.tags.values()).map(clone) });
      }
      if (req.method === "POST") {
        if (!this._requireSecret(res, body, url)) return;
        return this.createTags(res, body);
      }
      return this.methodNotAllowed(res);
    }
    const id = Number(parts[1]);
    const tag = this.tags.get(id);

    // POST /v3/tags/{id}/subscribe
    if (parts.length === 3 && parts[2] === "subscribe") {
      if (req.method !== "POST") return this.methodNotAllowed(res);
      if (!this._requireKey(res, body, url)) return;
      if (!tag) return this.send(res, 404, { error: "Not Found", message: "Tag not found" });
      const email = body && body.email;
      if (!email || !EMAIL_RE.test(String(email))) {
        return this.send(res, 400, { error: "Bad Request", message: "Email address is invalid" });
      }
      const sub = this._upsertSubscriber({ email, first_name: body.first_name, fields: body.fields });
      const subscription = this._recordSubscription(this.tagSubs.get(id), sub, {});
      return this.send(res, 200, {
        subscription: this._subscriptionView(subscription, sub, "tag", id),
      });
    }

    // POST /v3/tags/{id}/unsubscribe
    if (parts.length === 3 && parts[2] === "unsubscribe") {
      if (req.method !== "POST") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      if (!tag) return this.send(res, 404, { error: "Not Found", message: "Tag not found" });
      const email = body && body.email;
      if (!email || !EMAIL_RE.test(String(email))) {
        return this.send(res, 400, { error: "Bad Request", message: "Email address is invalid" });
      }
      const lower = String(email).toLowerCase();
      const sid = this.subscribersByEmail.get(lower);
      if (sid !== undefined) this.tagSubs.get(id).delete(sid);
      const sub = sid !== undefined ? this.subscribers.get(sid) : { id: null, email_address: email, first_name: null, state: "active", created_at: nowIso(), fields: {} };
      return this.send(res, 200, { subscriber: this._subscriberView(sub) });
    }

    // GET /v3/tags/{id}/subscriptions
    if (parts.length === 3 && parts[2] === "subscriptions") {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      if (!tag) return this.send(res, 404, { error: "Not Found", message: "Tag not found" });
      return this._listSubscriptions(res, this.tagSubs.get(id), "tag", id, url);
    }

    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  createTags(res, body) {
    // Accept { tag: { name } }, { tag: [{name},...] }, or { tags: [...] }.
    let input = body && (body.tag ?? body.tags);
    if (input === undefined || input === null) {
      return this.send(res, 400, { error: "Bad Request", message: "You must provide a tag name" });
    }
    const list = Array.isArray(input) ? input : [input];
    const created = [];
    for (const item of list) {
      const name = isPlainObject(item) ? item.name : item;
      if (!name || !String(name).trim()) {
        return this.send(res, 400, { error: "Bad Request", message: "You must provide a tag name" });
      }
      // ConvertKit returns the existing tag if the name already exists.
      const existing = Array.from(this.tags.values()).find((t) => t.name === String(name));
      created.push(existing || this._newTag(name));
    }
    // Single create returns an object; bulk returns array.
    const payload = Array.isArray(input) ? created.map(clone) : clone(created[0]);
    return this.send(res, 201, payload);
  }

  // =========================================================================
  // Subscribers
  // =========================================================================
  routeSubscribers(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      return this.listSubscribers(res, url);
    }
    const id = Number(parts[1]);
    if (parts.length === 2) {
      if (req.method === "GET") {
        if (!this._requireSecret(res, body, url)) return;
        const rec = this.subscribers.get(id);
        if (!rec) return this.send(res, 404, { error: "Not Found", message: "Subscriber not found" });
        return this.send(res, 200, { subscriber: this._subscriberView(rec) });
      }
      if (req.method === "PUT") {
        if (!this._requireSecret(res, body, url)) return;
        return this.updateSubscriber(res, id, body);
      }
      return this.methodNotAllowed(res);
    }
    // GET /v3/subscribers/{id}/tags
    if (parts.length === 3 && parts[2] === "tags") {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      const rec = this.subscribers.get(id);
      if (!rec) return this.send(res, 404, { error: "Not Found", message: "Subscriber not found" });
      const tags = [];
      for (const [tagId, members] of this.tagSubs.entries()) {
        if (members.has(id)) {
          const t = this.tags.get(tagId);
          const sub = members.get(id);
          tags.push({ id: t.id, name: t.name, created_at: t.created_at, subscribed_at: sub.created_at });
        }
      }
      return this.send(res, 200, { tags });
    }
    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  listSubscribers(res, url) {
    let data = Array.from(this.subscribers.values());
    const email = url.searchParams.get("email_address");
    if (email) {
      const lower = email.toLowerCase();
      data = data.filter((s) => (s.email_address || "").toLowerCase() === lower);
    }
    const sortField = url.searchParams.get("sort_field");
    const sortOrder = url.searchParams.get("sort_order");
    if (sortField === "cancelled_at" || sortField === "created_at") {
      data = data.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    if (sortOrder === "desc") data = data.slice().reverse();

    const perPage = 50;
    const totalPages = Math.max(1, Math.ceil(data.length / perPage));
    let page = parseInt(url.searchParams.get("page") || "1", 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    const start = (page - 1) * perPage;
    const pageItems = data.slice(start, start + perPage).map((s) => this._subscriberView(s));
    return this.send(res, 200, {
      total_subscribers: data.length,
      page,
      total_pages: totalPages,
      subscribers: pageItems,
    });
  }

  updateSubscriber(res, id, body) {
    const rec = this.subscribers.get(id);
    if (!rec) return this.send(res, 404, { error: "Not Found", message: "Subscriber not found" });
    if (typeof body.first_name === "string") rec.first_name = body.first_name;
    if (body.email_address) {
      if (!EMAIL_RE.test(String(body.email_address))) {
        return this.send(res, 400, { error: "Bad Request", message: "Email address is invalid" });
      }
      if (rec.email_address) this.subscribersByEmail.delete(rec.email_address.toLowerCase());
      rec.email_address = String(body.email_address);
      this.subscribersByEmail.set(rec.email_address.toLowerCase(), id);
    }
    if (isPlainObject(body.fields)) rec.fields = { ...rec.fields, ...body.fields };
    return this.send(res, 200, { subscriber: this._subscriberView(rec) });
  }

  unsubscribe(req, res, body, url) {
    if (req.method !== "PUT" && req.method !== "POST") return this.methodNotAllowed(res);
    if (!this._requireSecret(res, body, url)) return;
    const email = body && body.email;
    if (!email || !EMAIL_RE.test(String(email))) {
      return this.send(res, 400, { error: "Bad Request", message: "Email address is invalid" });
    }
    const lower = String(email).toLowerCase();
    const sid = this.subscribersByEmail.get(lower);
    if (sid === undefined) {
      return this.send(res, 404, { error: "Not Found", message: "Subscriber not found" });
    }
    const rec = this.subscribers.get(sid);
    rec.state = "cancelled";
    return this.send(res, 200, { subscriber: this._subscriberView(rec) });
  }

  // =========================================================================
  // Custom Fields
  // =========================================================================
  routeCustomFields(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        if (!this._requireKey(res, body, url)) return;
        return this.send(res, 200, { custom_fields: Array.from(this.customFields.values()).map(clone) });
      }
      if (req.method === "POST") {
        if (!this._requireSecret(res, body, url)) return;
        return this.createCustomFields(res, body);
      }
      return this.methodNotAllowed(res);
    }
    const id = Number(parts[1]);
    if (parts.length === 2) {
      const rec = this.customFields.get(id);
      if (req.method === "PUT") {
        if (!this._requireSecret(res, body, url)) return;
        if (!rec) return this.send(res, 404, { error: "Not Found", message: "Custom field not found" });
        const label = body && body.label;
        if (!label || !String(label).trim()) {
          return this.send(res, 400, { error: "Bad Request", message: "Label can't be blank" });
        }
        rec.label = String(label);
        return this.send(res, 204, null);
      }
      if (req.method === "DELETE") {
        if (!this._requireSecret(res, body, url)) return;
        if (!rec) return this.send(res, 404, { error: "Not Found", message: "Custom field not found" });
        this.customFields.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  createCustomFields(res, body) {
    let input = body && (body.label ?? body.custom_fields);
    if (input === undefined || input === null) {
      return this.send(res, 400, { error: "Bad Request", message: "Label can't be blank" });
    }
    const labels = Array.isArray(input) ? input : [input];
    const created = [];
    for (const label of labels) {
      const name = isPlainObject(label) ? label.label : label;
      if (!name || !String(name).trim()) {
        return this.send(res, 400, { error: "Bad Request", message: "Label can't be blank" });
      }
      const id = this._nextId();
      const key = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const rec = { id, label: String(name), key, name: `ck_field_${id}_${key}`, type: "text" };
      this.customFields.set(id, rec);
      created.push(rec);
    }
    const payload = Array.isArray(input) ? created.map(clone) : clone(created[0]);
    return this.send(res, 201, payload);
  }

  // =========================================================================
  // Broadcasts
  // =========================================================================
  routeBroadcasts(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        if (!this._requireSecret(res, body, url)) return;
        const all = Array.from(this.broadcasts.values()).map((b) => ({ id: b.id, created_at: b.created_at, subject: b.subject }));
        return this.send(res, 200, { broadcasts: all });
      }
      if (req.method === "POST") {
        if (!this._requireSecret(res, body, url)) return;
        return this.createBroadcast(res, body);
      }
      return this.methodNotAllowed(res);
    }
    const id = Number(parts[1]);
    const rec = this.broadcasts.get(id);
    if (parts.length === 2) {
      if (req.method === "GET") {
        if (!this._requireSecret(res, body, url)) return;
        if (!rec) return this.send(res, 404, { error: "Not Found", message: "Broadcast not found" });
        return this.send(res, 200, { broadcast: this._broadcastView(rec) });
      }
      if (req.method === "PUT") {
        if (!this._requireSecret(res, body, url)) return;
        if (!rec) return this.send(res, 404, { error: "Not Found", message: "Broadcast not found" });
        for (const key of ["subject", "content", "description", "public", "published_at", "send_at", "email_address", "thumbnail_alt", "thumbnail_url", "preview_text"]) {
          if (key in body) rec[key] = body[key];
        }
        return this.send(res, 200, { broadcast: this._broadcastView(rec) });
      }
      if (req.method === "DELETE") {
        if (!this._requireSecret(res, body, url)) return;
        if (!rec) return this.send(res, 404, { error: "Not Found", message: "Broadcast not found" });
        this.broadcasts.delete(id);
        return this.send(res, 204, null);
      }
      return this.methodNotAllowed(res);
    }
    // GET /v3/broadcasts/{id}/stats
    if (parts.length === 3 && parts[2] === "stats") {
      if (req.method !== "GET") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      if (!rec) return this.send(res, 404, { error: "Not Found", message: "Broadcast not found" });
      const recipients = this.subscribers.size;
      return this.send(res, 200, {
        broadcast: {
          id: rec.id,
          stats: {
            recipients,
            open_rate: 0,
            click_rate: 0,
            unsubscribes: 0,
            total_clicks: 0,
            show_total_clicks: false,
            status: "draft",
            progress: 0,
            open_tracking: true,
            click_tracking: true,
            unsubscribes_count: 0,
            bounces: 0,
            spam_complaints: 0,
            total_opens: 0,
          },
        },
      });
    }
    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  createBroadcast(res, body) {
    const id = this._nextId();
    const rec = {
      id,
      created_at: nowIso(),
      subject: body.subject ?? "",
      content: body.content ?? null,
      description: body.description ?? null,
      public: body.public ?? false,
      published_at: body.published_at ?? null,
      send_at: body.send_at ?? null,
      thumbnail_alt: body.thumbnail_alt ?? null,
      thumbnail_url: body.thumbnail_url ?? null,
      email_address: body.email_address ?? null,
      preview_text: body.preview_text ?? null,
    };
    this.broadcasts.set(id, rec);
    return this.send(res, 201, { broadcast: this._broadcastView(rec) });
  }

  _broadcastView(rec) {
    return clone(rec);
  }

  // =========================================================================
  // Automations / Webhooks
  // =========================================================================
  routeAutomations(req, res, parts, body, url) {
    // POST /v3/automations/hooks  ,  DELETE /v3/automations/hooks/{id}
    if (parts[1] !== "hooks") {
      return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
    }
    if (parts.length === 2) {
      if (req.method !== "POST") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      const target = body && body.target_url;
      if (!target) {
        return this.send(res, 400, { error: "Bad Request", message: "target_url can't be blank" });
      }
      const id = this._nextId();
      const event = body.event || { name: "subscriber.subscriber_activate" };
      const rec = { id, account_id: 1, event, target_url: String(target) };
      this.webhooks.set(id, rec);
      return this.send(res, 200, { rule: clone(rec) });
    }
    if (parts.length === 3) {
      if (req.method !== "DELETE") return this.methodNotAllowed(res);
      if (!this._requireSecret(res, body, url)) return;
      const id = Number(parts[2]);
      if (!this.webhooks.has(id)) {
        return this.send(res, 404, { error: "Not Found", message: "Webhook not found" });
      }
      this.webhooks.delete(id);
      return this.send(res, 200, { success: true });
    }
    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  // =========================================================================
  // Purchases
  // =========================================================================
  routePurchases(req, res, parts, body, url) {
    if (parts.length === 1) {
      if (req.method === "GET") {
        if (!this._requireSecret(res, body, url)) return;
        const all = Array.from(this.purchases.values()).map(clone);
        const perPage = 50;
        const totalPages = Math.max(1, Math.ceil(all.length / perPage));
        let page = parseInt(url.searchParams.get("page") || "1", 10);
        if (!Number.isFinite(page) || page < 1) page = 1;
        const start = (page - 1) * perPage;
        return this.send(res, 200, {
          total_purchases: all.length,
          page,
          total_pages: totalPages,
          purchases: all.slice(start, start + perPage),
        });
      }
      if (req.method === "POST") {
        if (!this._requireSecret(res, body, url)) return;
        return this.createPurchase(res, body);
      }
      return this.methodNotAllowed(res);
    }
    const id = Number(parts[1]);
    if (parts.length === 2 && req.method === "GET") {
      if (!this._requireSecret(res, body, url)) return;
      const rec = this.purchases.get(id);
      if (!rec) return this.send(res, 404, { error: "Not Found", message: "Purchase not found" });
      return this.send(res, 200, clone(rec));
    }
    return this.send(res, 404, { error: "Not Found", message: "The requested resource was not found." });
  }

  createPurchase(res, body) {
    const purchase = body && body.purchase;
    if (!isPlainObject(purchase)) {
      return this.send(res, 422, { error: "Unprocessable Entity", message: "purchase is required" });
    }
    if (!purchase.email_address || !EMAIL_RE.test(String(purchase.email_address))) {
      return this.send(res, 422, { error: "Unprocessable Entity", message: "Email address is invalid" });
    }
    if (!purchase.transaction_id) {
      return this.send(res, 422, { error: "Unprocessable Entity", message: "Transaction ID can't be blank" });
    }
    // Upsert subscriber from purchase email.
    this._upsertSubscriber({ email: purchase.email_address, first_name: purchase.first_name });
    const id = this._nextId();
    const products = Array.isArray(purchase.products) ? purchase.products : [];
    const rec = {
      id,
      transaction_id: String(purchase.transaction_id),
      status: "paid",
      email_address: String(purchase.email_address),
      currency: purchase.currency || "USD",
      transaction_time: purchase.transaction_time || nowIso(),
      subtotal: purchase.subtotal ?? 0,
      tax: purchase.tax ?? 0,
      shipping: purchase.shipping ?? 0,
      discount: purchase.discount ?? 0,
      total: purchase.total ?? 0,
      products: products.map((p) => ({
        name: p.name ?? null,
        sku: p.sku ?? null,
        pid: p.pid ?? null,
        lid: p.lid ?? null,
        unit_price: p.unit_price ?? 0,
        quantity: p.quantity ?? 1,
      })),
      first_name: purchase.first_name ?? null,
    };
    this.purchases.set(id, rec);
    return this.send(res, 201, clone(rec));
  }

  // =========================================================================
  // Subscription / view helpers
  // =========================================================================
  _attachTags(subscriber, tags) {
    if (!Array.isArray(tags)) return;
    for (const t of tags) {
      const tagId = Number(t);
      if (this.tags.has(tagId)) {
        this._recordSubscription(this.tagSubs.get(tagId), subscriber, {});
      }
    }
  }

  _recordSubscription(store, subscriber, extra) {
    const existing = store.get(subscriber.id);
    if (existing) return existing;
    const sub = {
      id: this._nextId(),
      state: "active",
      created_at: nowIso(),
      source: null,
      referrer: extra.referrer ?? null,
      subscribable_id: null,
      subscribable_type: null,
      _subscriberId: subscriber.id,
    };
    store.set(subscriber.id, sub);
    return sub;
  }

  _subscriptionView(subscription, subscriber, kind, targetId) {
    return {
      id: subscription.id,
      state: subscription.state,
      created_at: subscription.created_at,
      source: subscription.source,
      referrer: subscription.referrer,
      subscribable_id: targetId,
      subscribable_type: kind,
      subscriber: this._subscriberView(subscriber),
    };
  }

  _listSubscriptions(res, store, kind, targetId, url) {
    const sortOrder = url.searchParams.get("sort_order");
    let entries = Array.from(store.values());
    if (sortOrder === "desc") entries = entries.slice().reverse();
    const perPage = 50;
    const totalPages = Math.max(1, Math.ceil(entries.length / perPage));
    let page = parseInt(url.searchParams.get("page") || "1", 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    const start = (page - 1) * perPage;
    const subscriptions = entries.slice(start, start + perPage).map((s) =>
      this._subscriptionView(s, this.subscribers.get(s._subscriberId), kind, targetId)
    );
    return this.send(res, 200, {
      total_subscriptions: entries.length,
      page,
      total_pages: totalPages,
      subscriptions,
    });
  }

  _subscriberView(rec) {
    return {
      id: rec.id,
      first_name: rec.first_name ?? null,
      email_address: rec.email_address,
      state: rec.state,
      created_at: rec.created_at,
      fields: clone(rec.fields || {}),
    };
  }

  // =========================================================================
  // parlel control / inspection
  // =========================================================================
  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "state") {
      return this.send(res, 200, {
        subscribers: this.subscribers.size,
        forms: this.forms.size,
        sequences: this.sequences.size,
        tags: this.tags.size,
        custom_fields: this.customFields.size,
        broadcasts: this.broadcasts.size,
        webhooks: this.webhooks.size,
        purchases: this.purchases.size,
      });
    }
    if (req.method === "POST" && parts[1] === "seed") {
      const kind = parts[2];
      const attrs = (body && body.attributes) || {};
      if (kind === "form") return this.send(res, 200, { form: clone(this._newForm(attrs)) });
      if (kind === "sequence") return this.send(res, 200, { sequence: clone(this._newSequence(attrs)) });
      if (kind === "tag") return this.send(res, 200, { tag: clone(this._newTag(attrs.name || "Seeded Tag")) });
      if (kind === "subscriber") return this.send(res, 200, { subscriber: this._subscriberView(this._newSubscriber(attrs)) });
      return this.send(res, 400, { error: "Bad Request", message: "Unknown seed kind." });
    }
    return this.send(res, 404, { error: "Not Found", message: "Not found." });
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  methodNotAllowed(res) {
    return this.send(res, 405, { error: "Method Not Allowed", message: "The method is not allowed for the requested resource." });
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
          this.send(res, 400, { error: "Bad Request", message: "The request body is not valid JSON." });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { error: "Bad Request", message: "Error reading request body." });
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

// Allow `node server.js` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || process.env.CONVERTKIT_PORT || 4667);
  const server = new ConvertkitServer(port);
  server.start().then(() => {
    // eslint-disable-next-line no-console
    console.log(`parlel/convertkit listening on http://127.0.0.1:${port}`);
  });
}

export default ConvertkitServer;
